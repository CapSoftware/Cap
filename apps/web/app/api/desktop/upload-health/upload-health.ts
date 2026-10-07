import { createHash } from "node:crypto";

export const MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES = 512 * 1024;

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

export async function readUploadHealthProbe(
	request: Request,
	maxBytes = MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
) {
	if (!request.body) throw new UploadHealthProbeEmptyError();

	let receivedBytes = 0;
	const hash = createHash("sha256");
	const reader = request.body.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			receivedBytes += value.byteLength;
			if (receivedBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new UploadHealthProbeTooLargeError();
			}
			hash.update(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (receivedBytes === 0) throw new UploadHealthProbeEmptyError();
	return { receivedBytes, sha256: hash.digest("hex") };
}
