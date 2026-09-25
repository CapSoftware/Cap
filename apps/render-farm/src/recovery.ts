import { createHash } from "node:crypto";
import type { S3 } from "./s3";

export const PART_RANGES = 6;

export function reservePartRange(chunk: {
	dispatches: number;
	firstPart: number;
	partLimit: number;
}) {
	if (chunk.dispatches >= PART_RANGES) {
		throw new Error(
			"chunk exhausted its upload ranges; refusing to reuse live parts",
		);
	}
	const range = chunk.dispatches++;
	return { range, firstPart: chunk.firstPart + range * chunk.partLimit };
}

export function acceptOnce(
	pending: Map<string, Promise<void>>,
	key: string,
	accept: () => Promise<void>,
) {
	const existing = pending.get(key);
	if (existing) return existing;
	const result = accept().finally(() => pending.delete(key));
	pending.set(key, result);
	return result;
}

export async function completeUpload(
	s3: Pick<S3, "head" | "getRange" | "uploadPart" | "completeMultipart">,
	upload: {
		key: string;
		uploadId: string;
		header: Uint8Array;
		payloadSize: number;
		parts: { partNumber: number; etag: string }[];
	},
	persist: (intent: string) => Promise<void>,
) {
	const { key, uploadId, header, parts } = upload;
	const size = upload.payloadSize + header.byteLength;
	const hash = (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex");
	const headerHash = hash(header);
	const completed = async () => {
		const object = await s3.head(key);
		if (!object) return false;
		if (
			object.size !== size ||
			hash(await s3.getRange(key, 0, header.byteLength - 1)) !== headerHash
		) {
			throw new Error("completed object does not match the accepted media");
		}
		return true;
	};
	if (await completed()) return size;
	await persist(JSON.stringify({ uploadId, size, headerHash }));
	try {
		const etag = await s3.uploadPart(key, uploadId, 1, header);
		await s3.completeMultipart(
			key,
			uploadId,
			[...parts, { partNumber: 1, etag }].sort(
				(a, b) => a.partNumber - b.partNumber,
			),
		);
	} catch (error) {
		// Completion can commit in S3 even when its response never reaches us.
		if (!(await completed())) throw error;
	}
	return size;
}
