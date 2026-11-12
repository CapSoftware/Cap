const MIN_PART_BYTES = 16 * 1024 * 1024;
const TARGET_PARTS = 200;
const PRESIGN_BATCH = 20;
const DEFAULT_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export function partBytesFor(fileBytes: number) {
	const even = Math.ceil(fileBytes / TARGET_PARTS / MIN_PART_BYTES);
	return Math.max(1, even) * MIN_PART_BYTES;
}

export function presignBatch(partNumber: number, totalParts: number) {
	const last = Math.min(totalParts, partNumber + PRESIGN_BATCH - 1);
	const numbers: number[] = [];
	for (let number = partNumber; number <= last; number++) numbers.push(number);
	return numbers;
}

export function retryAfterMs(header: string | null) {
	const seconds = header === null ? Number.NaN : Number(header.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_MS;
	return Math.min(MAX_RETRY_MS, Math.ceil(seconds * 1000));
}

export const COMPLETION_IN_PROGRESS = "completion_in_progress";
export const BUSY_COMPLETE_ATTEMPTS = 8;
const BUSY_RETRY_MS = 3_000;

export function isDefinitiveRejection(status: number, code?: string | null) {
	if (code === COMPLETION_IN_PROGRESS) return false;
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function completeRetryPlan(
	attempt: number,
	code: string | null | undefined,
	attempts: number,
) {
	const busy = code === COMPLETION_IN_PROGRESS;
	return {
		retry: attempt < (busy ? BUSY_COMPLETE_ATTEMPTS : attempts),
		waitMs: busy ? BUSY_RETRY_MS : 1500 * attempt,
	};
}
