export const MAX_UPLOAD_PROBE_BYTES = 8 * 1024 * 1024;

export type CountedRequestBody = {
	receivedBytes: number;
	truncated: boolean;
};

// Counts an upload probe without persisting anything. The body is bounded so a
// caller cannot stream unbounded data through the function.
export async function countRequestBodyBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number = MAX_UPLOAD_PROBE_BYTES,
): Promise<CountedRequestBody> {
	if (!body) return { receivedBytes: 0, truncated: false };

	let receivedBytes = 0;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value?.byteLength ?? 0;
			if (receivedBytes > maxBytes) {
				await reader.cancel();
				return { receivedBytes, truncated: true };
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { receivedBytes, truncated: false };
}
