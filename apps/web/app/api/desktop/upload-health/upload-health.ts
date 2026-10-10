import { createHash } from "node:crypto";

export const MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES = 512 * 1024;
export const DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS = 12_000;

export class UploadHealthProbeTooLargeError extends Error {
	constructor() {
		super("Upload health probe body is too large");
		this.name = "UploadHealthProbeTooLargeError";
	}
}

export class UploadHealthProbeEmptyError extends Error {
	constructor() {
		super("Upload health probe body is empty");
		this.name = "UploadHealthProbeEmptyError";
	}
}

export class UploadHealthProbeTimeoutError extends Error {
	constructor() {
		super("Upload health probe body read timed out");
		this.name = "UploadHealthProbeTimeoutError";
	}
}

export async function readUploadHealthProbe(
	request: Request,
	{ signal }: { signal?: AbortSignal } = {},
) {
	if (!request.body) throw new UploadHealthProbeEmptyError();

	let receivedBytes = 0;
	const hash = createHash("sha256");
	const reader = request.body.getReader();
	let stopped: Error | undefined;
	let cancelled = false;
	const cancel = (reason: unknown) => {
		if (cancelled) return;
		cancelled = true;
		// Cancelling closes pending reads before the underlying source settles.
		void reader.cancel(reason).catch(() => undefined);
	};
	const stop = (error: Error) => {
		stopped ??= error;
		cancel(stopped);
	};
	const abort = () =>
		stop(new DOMException("Upload health probe was aborted", "AbortError"));
	const timeout = setTimeout(
		() => stop(new UploadHealthProbeTimeoutError()),
		DESKTOP_UPLOAD_HEALTH_READ_TIMEOUT_MS,
	);
	request.signal.addEventListener("abort", abort, { once: true });
	signal?.addEventListener("abort", abort, { once: true });

	try {
		if (request.signal.aborted || signal?.aborted) abort();
		while (true) {
			if (stopped) throw stopped;
			const { done, value } = await reader.read();
			if (stopped) throw stopped;
			if (done) break;

			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES) {
				throw new UploadHealthProbeTooLargeError();
			}
			hash.update(value);
		}
	} catch (error) {
		cancel(error);
		throw error;
	} finally {
		clearTimeout(timeout);
		request.signal.removeEventListener("abort", abort);
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}

	if (receivedBytes === 0) throw new UploadHealthProbeEmptyError();
	return { receivedBytes, sha256: hash.digest("hex") };
}
