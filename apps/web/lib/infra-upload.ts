const MIN_PART_BYTES = 16 * 1024 * 1024;
const TARGET_PARTS = 200;
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export function partBytesFor(fileBytes: number) {
	const even = Math.ceil(fileBytes / TARGET_PARTS / MIN_PART_BYTES);
	return Math.max(1, even) * MIN_PART_BYTES;
}

export function retryAfterMs(header: string | null) {
	const seconds = header === null ? Number.NaN : Number(header.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_MS;
	return Math.min(MAX_RETRY_MS, Math.ceil(seconds * 1000));
}

export function isDefinitiveRejection(status: number) {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
