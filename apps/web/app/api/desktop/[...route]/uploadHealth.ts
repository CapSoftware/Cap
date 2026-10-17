export const MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES = 512 * 1024;

export class UploadHealthProbeTooLargeError extends Error {
	constructor() {
		super("Upload health probe body is too large");
		this.name = "UploadHealthProbeTooLargeError";
	}
}

export async function readUploadHealthProbeBytes(
	request: Request,
	maxBytes = MAX_DESKTOP_UPLOAD_HEALTH_PROBE_BYTES,
) {
	if (!request.body) return 0;

	let receivedBytes = 0;
	const reader = request.body.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			receivedBytes += value.byteLength;
			if (receivedBytes > maxBytes) {
				await reader.cancel();
				throw new UploadHealthProbeTooLargeError();
			}
		}
	} finally {
		reader.releaseLock();
	}

	return receivedBytes;
}
