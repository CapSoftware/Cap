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

class RemuxRefused extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(`Media server remux failed: ${status} ${detail}`);
	}
}

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
		throw new RemuxRefused(response.status, errorText);
	}
}

// A full or restarting media server answers 5xx, and one that cannot be
// reached throws. Both pass. A 4xx is an answer about this request and would
// be the same again.
const mayClear = (error: unknown) =>
	!(error instanceof RemuxRefused) ||
	error.status >= 500 ||
	error.status === 429;

const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function retryFaststartRemux(
	send: (signal: AbortSignal) => Promise<void>,
	videoId: string,
	delaysMs: readonly number[],
): Promise<boolean> {
	for (const delay of delaysMs) {
		await pause(delay * (0.75 + Math.random() / 2));
		try {
			await send(AbortSignal.timeout(RETRY_ATTEMPT_TIMEOUT_MS));
			return true;
		} catch (error) {
			if (!mayClear(error)) {
				console.error("Failed to queue faststart remux:", error);
				return false;
			}
		}
	}
	console.error("Failed to queue faststart remux after retries:", videoId);
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
	try {
		await send();
		return "queued";
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		console.error("Failed to queue faststart remux:", error);
		if (!mayClear(error)) return "failed";
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
