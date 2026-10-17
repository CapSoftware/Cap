export const MAX_UPLOAD_PROBE_BYTES = 8 * 1024 * 1024;

export type CountedRequestBody = {
	receivedBytes: number;
	truncated: boolean;
};

export type UploadProbeBody = CountedRequestBody & {
	bytes: Uint8Array;
};

export async function readUploadProbeBody(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number = MAX_UPLOAD_PROBE_BYTES,
): Promise<UploadProbeBody> {
	if (!body) {
		return {
			bytes: new Uint8Array(),
			receivedBytes: 0,
			truncated: false,
		};
	}

	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value?.byteLength ?? 0;
			if (receivedBytes > maxBytes) {
				await reader.cancel();
				return {
					bytes: new Uint8Array(),
					receivedBytes,
					truncated: true,
				};
			}
			if (value) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(receivedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, receivedBytes, truncated: false };
}

export async function countRequestBodyBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number = MAX_UPLOAD_PROBE_BYTES,
): Promise<CountedRequestBody> {
	const { receivedBytes, truncated } = await readUploadProbeBody(body, maxBytes);
	return { receivedBytes, truncated };
}
