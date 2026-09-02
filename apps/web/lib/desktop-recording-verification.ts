import { createHash } from "node:crypto";
import { z } from "zod";

const positiveNumber = z.number().finite().positive();
const positiveSize = positiveNumber.int().max(Number.MAX_SAFE_INTEGER);

export const recordingVerificationSchema = z.object({
	version: z.literal(1),
	artifact: z.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("segments"),
			manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
		}),
		z.object({
			kind: z.literal("mp4"),
			fileSize: positiveSize,
			duration: positiveNumber,
			objectIdentity: z
				.string()
				.max(1_024)
				.regex(/^"[\x21\x23-\x7E\x80-\xFF]+"$/),
		}),
	]),
	requiredAudio: z.boolean(),
});

export type RecordingVerification = z.infer<typeof recordingVerificationSchema>;

const segmentSchema = z.union([
	z.number().int().positive(),
	z.object({ index: z.number().int().positive(), duration: positiveNumber }),
]);

const completedManifestSchema = z.object({
	version: z.number().int().positive(),
	video_init_uploaded: z.literal(true),
	audio_init_uploaded: z.boolean(),
	video_segments: z.array(segmentSchema).min(1),
	audio_segments: z.array(segmentSchema),
	is_complete: z.literal(true),
});

export function readCompletedRecordingManifest(json: string) {
	const manifest = completedManifestSchema.parse(JSON.parse(json));
	const normalize = (entry: z.infer<typeof segmentSchema>) =>
		typeof entry === "number" ? { index: entry, duration: 3 } : entry;
	const video = manifest.video_segments.map(normalize);
	const audio = manifest.audio_segments.map(normalize);
	for (const segments of [video, audio]) {
		if (segments.some((segment, index) => segment.index !== index + 1)) {
			throw new Error(
				"Recording manifest contains missing or unordered segments",
			);
		}
	}
	if (manifest.audio_init_uploaded !== audio.length > 0) {
		throw new Error("Recording manifest contains incomplete audio");
	}
	return {
		manifestSha256: createHash("sha256").update(json).digest("hex"),
		duration: video.reduce((total, segment) => total + segment.duration, 0),
		hasAudio: audio.length > 0,
	};
}

export const recordingOutputSchema = z.object({
	fileSize: positiveSize,
	duration: positiveNumber,
	width: positiveNumber.int(),
	height: positiveNumber.int(),
	videoCodec: z.string().min(1),
	audioCodec: z.string().min(1).nullable(),
});

export type RecordingOutput = z.infer<typeof recordingOutputSchema>;

export function validateRecordingOutput(
	output: RecordingOutput,
	expected: { fileSize?: number; duration: number; requiredAudio: boolean },
) {
	recordingOutputSchema.parse(output);
	const durationTolerance = Math.max(
		0.5,
		Math.min(5, expected.duration * 0.01),
	);
	if (
		!Number.isFinite(expected.duration) ||
		expected.duration <= 0 ||
		Math.abs(output.duration - expected.duration) > durationTolerance ||
		(expected.fileSize !== undefined &&
			output.fileSize !== expected.fileSize) ||
		(expected.requiredAudio && !output.audioCodec)
	) {
		throw new Error("Uploaded recording does not match its final local media");
	}
}

export const recordingUploadReceiptSchema = z
	.object({
		version: z.literal(1),
		artifact: recordingVerificationSchema.shape.artifact,
		fileSize: positiveSize,
		duration: positiveNumber,
		hasAudio: z.boolean(),
		fullDecode: z.literal(true),
		requiredAudioVerified: z.boolean().default(false),
		objectIdentity: z.string().min(1),
	})
	.refine(
		(receipt) =>
			receipt.artifact.kind !== "mp4" ||
			receipt.artifact.objectIdentity === receipt.objectIdentity,
		"Receipt does not match the completed upload identity",
	);

export type RecordingUploadReceipt = z.infer<
	typeof recordingUploadReceiptSchema
>;

export function assertRecordingObjectIdentity(
	head: { ContentLength?: number; ETag?: string },
	expected: { fileSize: number; objectIdentity: string },
) {
	if (
		head.ContentLength !== expected.fileSize ||
		!head.ETag ||
		head.ETag !== expected.objectIdentity
	) {
		throw new Error("Uploaded recording object changed or is incomplete");
	}
}
