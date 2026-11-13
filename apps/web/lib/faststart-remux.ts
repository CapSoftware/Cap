import { after } from "next/server";

export type FaststartRemuxStart = "queued" | "retrying" | "failed";

export interface FaststartRemuxRequest {
	videoId: string;
	userId: string;
	videoUrl: string;
	outputPresignedUrl: string;
	previewGifPresignedUrl: string;
}

const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];
const RETRY_ATTEMPT_TIMEOUT_MS = 30_000;

const MAX_RETRY_AFTER_MS = 60_000;

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
	return Math.min(ms, MAX_RETRY_AFTER_MS);
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

async function retryFaststartRemux(
	send: (signal: AbortSignal) => Promise<void>,
	videoId: string,
	firstError: unknown,
	delaysMs: readonly number[],
): Promise<boolean> {
	let lastError = firstError;
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
		console.warn("[faststart-remux] retrying", {
			videoId,
			attempt: index + 2,
			waitMs,
			after: reasonOf(lastError),
		});
		await pause(waitMs);
		try {
			await send(AbortSignal.timeout(RETRY_ATTEMPT_TIMEOUT_MS));
			return true;
		} catch (error) {
			lastError = error;
			if (!mayClear(error)) break;
		}
	}
	console.error("[faststart-remux] gave up", {
		videoId,
		reason: reasonOf(lastError),
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
	try {
		await send();
		return "queued";
	} catch (cause) {
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
				input.retryDelaysMs ?? RETRY_DELAYS_MS,
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
