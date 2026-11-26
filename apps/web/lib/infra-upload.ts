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

export const MAX_UPLOAD_DURATION_SECS = 4 * 60 * 60;
export const STORED_BYTES_PER_SECOND = 2_500_000;
// A file is billed for at least its size at STORED_BYTES_PER_SECOND, and for
// at most MAX_UPLOAD_DURATION_SECS. Past this size the two meet, so every
// further byte would be stored without being billed.
export const MAX_UPLOAD_BYTES =
	MAX_UPLOAD_DURATION_SECS * STORED_BYTES_PER_SECOND;
export const VIDEO_TOO_LONG_MESSAGE = "Video is longer than the 4 hour limit";

export function fileTooLargeMessage(limit: number = MAX_UPLOAD_BYTES) {
	return limit < MAX_UPLOAD_BYTES
		? `The file is larger than the ${limit} byte limit set for this upload`
		: `The file is larger than the ${MAX_UPLOAD_BYTES / 1e9} GB upload limit`;
}

export const COMPLETION_IN_PROGRESS = "completion_in_progress";
// How long the server lets one request hold a completion before another may
// take it over.
export const STALE_UPLOAD_CLAIM_MS = 15 * 60 * 1000;
const BUSY_COMPLETE_WINDOW_MS = STALE_UPLOAD_CLAIM_MS + 60_000;

export function isDefinitiveRejection(status: number, code?: string | null) {
	if (code === COMPLETION_IN_PROGRESS) return false;
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function completeRetryPlan({
	attempt,
	code,
	attempts,
	retryAfter,
	busyWaitedMs,
}: {
	attempt: number;
	code: string | null | undefined;
	attempts: number;
	retryAfter: string | null;
	busyWaitedMs: number;
}) {
	if (code === COMPLETION_IN_PROGRESS) {
		const waitMs = retryAfterMs(retryAfter);
		return {
			retry: busyWaitedMs + waitMs <= BUSY_COMPLETE_WINDOW_MS,
			waitMs,
			busy: true,
		};
	}
	return { retry: attempt < attempts, waitMs: 1500 * attempt, busy: false };
}

export const EMPTY_FILE_MESSAGE = "That file is empty.";

const NOT_VIDEO_SIGNATURES: readonly (readonly number[])[] = [
	[0x89, 0x50, 0x4e, 0x47],
	[0xff, 0xd8, 0xff],
	[0x47, 0x49, 0x46, 0x38],
	[0x25, 0x50, 0x44, 0x46],
];

export function startsLikeAnImageOrDocument(bytes: Uint8Array) {
	return NOT_VIDEO_SIGNATURES.some((signature) =>
		signature.every((byte, index) => bytes[index] === byte),
	);
}
