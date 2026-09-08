import { createHash } from "node:crypto";

const DRIVE_CONTENT_IDENTITY_PREFIX = '"cap-drive-content-v1:';

export type RecordingObjectHead = {
	ETag?: string;
	RecordingContentETag?: string | null;
};

export class RecordingObjectReadError extends Error {
	readonly _tag = "RecordingObjectReadError";

	constructor(
		readonly status: 412 | 503,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export function getRecordingObjectIdentity(
	head: RecordingObjectHead,
	expectedIdentity?: string,
) {
	if (expectedIdentity !== undefined) {
		return expectedIdentity.startsWith(DRIVE_CONTENT_IDENTITY_PREFIX)
			? (head.RecordingContentETag ?? undefined)
			: head.ETag;
	}
	return "RecordingContentETag" in head
		? (head.RecordingContentETag ?? undefined)
		: head.ETag;
}

export function getGoogleDriveRecordingIdentity(file: {
	id: string;
	size?: string;
	sha256Checksum?: string;
	headRevisionId?: string;
}) {
	if (
		!file.id ||
		!file.headRevisionId ||
		!file.size ||
		!/^\d+$/.test(file.size) ||
		!Number.isSafeInteger(Number(file.size)) ||
		Number(file.size) <= 0 ||
		!file.sha256Checksum ||
		!/^[a-fA-F0-9]{64}$/.test(file.sha256Checksum)
	) {
		return null;
	}
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				file.id,
				Number(file.size),
				file.sha256Checksum.toLowerCase(),
			]),
		)
		.digest("hex");
	return `${DRIVE_CONTENT_IDENTITY_PREFIX}${digest}"`;
}
