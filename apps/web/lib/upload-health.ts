export const MAX_UPLOAD_PROBE_BYTES = 8 * 1024 * 1024;
export const UPLOAD_PROBE_RATE_LIMIT_WINDOW_MS = 60_000;
export const UPLOAD_PROBE_RATE_LIMIT_MAX_REQUESTS = 12;

export type CountedRequestBody = {
	receivedBytes: number;
	truncated: boolean;
};

export type UploadProbeBody = CountedRequestBody & {
	bytes: Uint8Array;
	receiveDurationMs: number;
};

const userProbeTimestamps = new Map<string, number[]>();

export function checkUploadProbeRateLimit(
	key: string,
	nowMs: number = Date.now(),
): boolean {
	const cutoff = nowMs - UPLOAD_PROBE_RATE_LIMIT_WINDOW_MS;
	const recent = (userProbeTimestamps.get(key) ?? []).filter(
		(ts) => ts > cutoff,
	);
	if (recent.length >= UPLOAD_PROBE_RATE_LIMIT_MAX_REQUESTS) {
		userProbeTimestamps.set(key, recent);
		return true;
	}
	recent.push(nowMs);
	userProbeTimestamps.set(key, recent);
	return false;
}

export function resetUploadProbeRateLimitForTests(): void {
	userProbeTimestamps.clear();
}

export async function readUploadProbeBody(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number = MAX_UPLOAD_PROBE_BYTES,
): Promise<UploadProbeBody> {
	if (!body) {
		return {
			bytes: new Uint8Array(),
			receivedBytes: 0,
			receiveDurationMs: 0,
			truncated: false,
		};
	}

	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	let firstChunkAt: number | null = null;
	const streamStartedAt = performance.now();
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (firstChunkAt === null) {
				firstChunkAt = performance.now();
			}
			receivedBytes += value?.byteLength ?? 0;
			if (receivedBytes > maxBytes) {
				await reader.cancel();
				return {
					bytes: new Uint8Array(),
					receivedBytes,
					receiveDurationMs: Math.max(
						0,
						performance.now() - (firstChunkAt ?? streamStartedAt),
					),
					truncated: true,
				};
			}
			if (value) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const receiveDurationMs = Math.max(
		0,
		performance.now() - (firstChunkAt ?? streamStartedAt),
	);
	const bytes = new Uint8Array(receivedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, receivedBytes, receiveDurationMs, truncated: false };
}

export async function countRequestBodyBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number = MAX_UPLOAD_PROBE_BYTES,
): Promise<CountedRequestBody> {
	const { receivedBytes, truncated } = await readUploadProbeBody(
		body,
		maxBytes,
	);
	return { receivedBytes, truncated };
}
