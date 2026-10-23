import { createHash } from "node:crypto";

type RecordingPart = { partNumber: number; etag: string; size: number };

export const hasCompleteRecordingParts = (parts: RecordingPart[]) => {
	if (parts.length === 0 || parts.length > 10_000) return false;
	const sorted = [...parts].sort(
		(left, right) => left.partNumber - right.partNumber,
	);
	return (
		sorted.every(
			(part, index) =>
				part.partNumber === index + 1 &&
				Number.isSafeInteger(part.size) &&
				part.size > 0 &&
				part.etag.length > 0,
		) &&
		Number.isSafeInteger(parts.reduce((total, part) => total + part.size, 0))
	);
};

export const matchesCompletedRecordingParts = (
	head: { ETag?: string; ContentLength?: number },
	parts: RecordingPart[],
) => {
	if (!hasCompleteRecordingParts(parts) || !head.ETag) return false;
	if (
		head.ContentLength !== parts.reduce((total, part) => total + part.size, 0)
	)
		return false;
	const sorted = [...parts].sort(
		(left, right) => left.partNumber - right.partNumber,
	);
	const etags = sorted.map((part) => part.etag.replace(/^"|"$/g, ""));
	if (etags.some((etag) => !/^[a-f\d]{32}$/i.test(etag))) return false;
	const digest = createHash("md5")
		.update(Buffer.concat(etags.map((etag) => Buffer.from(etag, "hex"))))
		.digest("hex");
	return (
		head.ETag.replace(/^"|"$/g, "").toLowerCase() ===
		`${digest}-${parts.length}`
	);
};
