import { after } from "next/server";

export type FaststartRemuxStart = "queued" | "retrying" | "failed";

export interface FaststartRemuxRequest {
	videoId: string;
	userId: string;
	videoUrl: string;
	outputPresignedUrl: string;
	previewGifPresignedUrl: string;
}

// Retries run after the response, and transcription waits until they settle
// (the remux writes back to the file transcription reads), so the whole retry
// budget stays far inside the function's time limit. The media server
// answers busy in milliseconds, so an attempt that takes 10 s is not coming
// back.
export const FASTSTART_REMUX_RETRY = {
	delaysMs: [2_000, 6_000, 15_000],
	attemptTimeoutMs: 10_000,
	maxRetryAfterMs: 20_000,
	budgetMs: 60_000,
} as const;

class RemuxRefused extends Error {
	constructor(
		readonly status: number,
		detail: string,
		readonly retryAfterMs: number | null = null,
	) {
		super(`Media server remux failed: ${status} ${detail}`);
	}
}

const parseRetryAfter = (header: string | null): number | null => {
	if (!header) return null;
	const seconds = Number(header);
	const ms = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(header) - Date.now();
	if (!Number.isFinite(ms) || ms <= 0) return null;
	return Math.min(ms, FASTSTART_REMUX_RETRY.maxRetryAfterMs);
};

async function sendFaststartRemux(
	mediaServerUrl: string,
	webhookSecret: string | undefined,
	request: FaststartRemuxRequest,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch(`${mediaServerUrl}/video/process`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(webhookSecret ? { "x-media-server-secret": webhookSecret } : {}),
		},
		body: JSON.stringify({
			videoId: request.videoId,
			userId: request.userId,
			videoUrl: request.videoUrl,
			outputPresignedUrl: request.outputPresignedUrl,
			previewGifPresignedUrl: request.previewGifPresignedUrl,
			remuxOnly: true,
		}),
		...(signal ? { signal } : {}),
	});
	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new RemuxRefused(
			response.status,
			errorText,
			parseRetryAfter(response.headers.get("retry-after")),
		);
	}
}

// Only answers that prove the job was not taken are sent again, because the
// media server starts a new job for every request it accepts. A full or
// draining media server refuses with 503 (or 429). A fetch that failed while
// connecting never delivered the request. A reset connection, a timeout, a
// gateway 502 or 504, or any other answer may follow a job that was taken, or
// would be the same again, so none of them is retried.
const RETRYABLE_STATUSES = new Set([429, 503]);
const CONNECT_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

const errorCode = (value: unknown) =>
	typeof value === "object" && value !== null && "code" in value
		? value.code
		: undefined;

const failedToConnect = (error: TypeError) => {
	const cause = error.cause;
	if (CONNECT_ERROR_CODES.has(String(errorCode(cause)))) return true;
	return (
		cause instanceof AggregateError &&
		cause.errors.length > 0 &&
		cause.errors.every((inner) =>
			CONNECT_ERROR_CODES.has(String(errorCode(inner))),
		)
	);
};

const mayClear = (error: unknown) =>
	error instanceof RemuxRefused
		? RETRYABLE_STATUSES.has(error.status)
		: error instanceof TypeError && failedToConnect(error);

const reasonOf = (error: unknown) =>
	error instanceof RemuxRefused
		? `status ${error.status}`
		: error instanceof Error
			? String(errorCode(error.cause) ?? error.name)
			: String(error);

const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sendWithTimeout(
	send: (signal: AbortSignal) => Promise<void>,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException("The remux request timed out", "TimeoutError"),
			),
		timeoutMs,
	);
	try {
		await send(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

async function retryFaststartRemux(
	send: (signal: AbortSignal) => Promise<void>,
	videoId: string,
	firstError: unknown,
	firstFailedAt: number,
	delaysMs: readonly number[],
): Promise<boolean> {
	const { attemptTimeoutMs, budgetMs } = FASTSTART_REMUX_RETRY;
	const deadline = firstFailedAt + budgetMs;
	let lastError = firstError;
	let outOfTime = false;
	for (const [index, delay] of delaysMs.entries()) {
		// Never sooner than the media server asked, with jitter above that.
		const asked =
			lastError instanceof RemuxRefused ? (lastError.retryAfterMs ?? 0) : 0;
		const waitMs = Math.round(
			Math.max(
				delay * (0.75 + Math.random() / 2),
				asked * (1 + Math.random() / 4),
			),
		);
		if (Date.now() + waitMs + attemptTimeoutMs > deadline) {
			outOfTime = true;
			break;
		}
		console.warn("[faststart-remux] retrying", {
			videoId,
			attempt: index + 2,
			waitMs,
			after: reasonOf(lastError),
		});
		await pause(waitMs);
		try {
			await sendWithTimeout(send, attemptTimeoutMs);
			return true;
		} catch (error) {
			lastError = error;
			if (!mayClear(error)) break;
		}
	}
	console.error("[faststart-remux] gave up", {
		videoId,
		reason: reasonOf(lastError),
		outOfTime,
		error: lastError,
	});
	return false;
}

// The first attempt runs as it always has, inside the request. Only when it
// fails in a way that may clear is it tried again, after the response has
// been sent, so an upload is never slowed or failed by a busy media server.
export async function startFaststartRemux(input: {
	mediaServerUrl: string;
	webhookSecret: string | undefined;
	request: FaststartRemuxRequest;
	onRetriesSettled: (queued: boolean) => Promise<void>;
	retryDelaysMs?: readonly number[];
	defer?: (work: Promise<void>) => void;
}): Promise<FaststartRemuxStart> {
	const send = (signal?: AbortSignal) =>
		sendFaststartRemux(
			input.mediaServerUrl,
			input.webhookSecret,
			input.request,
			signal,
		);
	let firstError: Error;
	let firstFailedAt: number;
	try {
		await send();
		return "queued";
	} catch (cause) {
		firstFailedAt = Date.now();
		firstError = cause instanceof Error ? cause : new Error(String(cause));
		console.error("Failed to queue faststart remux:", firstError);
		if (!mayClear(firstError)) return "failed";
	}

	const defer = input.defer ?? after;
	let begin: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		begin = resolve;
	});
	const work = started
		.then(() =>
			retryFaststartRemux(
				send,
				input.request.videoId,
				firstError,
				firstFailedAt,
				input.retryDelaysMs ?? FASTSTART_REMUX_RETRY.delaysMs,
			),
		)
		.then(input.onRetriesSettled)
		.catch((error) => {
			console.error("Failed to settle faststart remux retries:", error);
		});
	try {
		defer(work);
	} catch {
		return "failed";
	}
	begin();
	return "retrying";
}
