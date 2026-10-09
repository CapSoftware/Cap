import { z } from "zod";

export const SOURCE_COMMIT_PAGE_SIZE = 16;
export const SOURCE_COMMIT_PART_BATCH_SIZE = 4;
export const SOURCE_COMMIT_PART_PAGE_SIZE = 64;
export const SOURCE_COMMIT_MAX_OBJECTS = 100_002;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const sourceCommitReferenceSchema = z.object({
	key: z.string().min(1),
	sha256,
});
export const sourceCommitPageReferenceSchema =
	sourceCommitReferenceSchema.extend({
		start: z.number().int().nonnegative().max(SOURCE_COMMIT_MAX_OBJECTS),
		count: z.number().int().positive().max(SOURCE_COMMIT_MAX_OBJECTS),
		level: z.number().int().nonnegative().max(17),
	});
export const sourceCommitPartSchema = z.object({
	ETag: z.string().min(1),
	PartNumber: z.number().int().min(1).max(10_000),
});
const forest = z.array(sourceCommitPageReferenceSchema).max(18);

export const desktopRecordingSourceCheckpointSchema = z.object({
	kind: z.literal("desktop-recording-source-commit"),
	version: z.literal(1),
	generation: identifier,
	snapshotId: identifier,
	revision: z.number().int().nonnegative(),
	phase: z.enum(["plan", "enumerate", "copy", "verify", "finalize"]),
	plan: sourceCommitReferenceSchema.optional(),
	cursor: z.number().int().nonnegative().max(SOURCE_COMMIT_MAX_OBJECTS),
	planRoots: forest,
	receiptRoots: forest,
	multipart: z
		.object({
			position: z.number().int().nonnegative().max(SOURCE_COMMIT_MAX_OBJECTS),
			key: z.string().min(1),
			originalIdentity: z.string().min(1),
			size: z.number().int().positive().safe(),
			uploadId: z.string().min(1),
			partSize: z.number().int().positive().safe(),
			nextPartNumber: z.number().int().min(1).max(10_001),
			partRoots: forest,
			pendingParts: z
				.array(sourceCommitPartSchema)
				.max(SOURCE_COMMIT_PART_PAGE_SIZE),
		})
		.optional(),
});

export type SourceCommitReference = z.infer<typeof sourceCommitReferenceSchema>;
export type SourceCommitPageReference = z.infer<
	typeof sourceCommitPageReferenceSchema
>;
export type DesktopRecordingSourceCheckpoint = z.infer<
	typeof desktopRecordingSourceCheckpointSchema
>;
