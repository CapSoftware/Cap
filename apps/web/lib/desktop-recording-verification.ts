import { createHash } from "node:crypto";
import {
	getRecordingObjectIdentity,
	type RecordingObjectHead,
} from "@cap/web-backend/src/Storage/recording-object-identity";
import { z } from "zod";

const positiveNumber = z.number().finite().positive();
const positiveSize = positiveNumber.int().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const recordingObjectIdentitySchema = z
	.string()
	.max(1_024)
	.regex(/^"[\x21\x23-\x7E\x80-\xFF]+"$/);

export const recordingOutputKeySchema = z
	.string()
	.min(1)
	.max(1_024)
	.refine(
		(key) =>
			!key.includes("\\") &&
			!key.includes("%") &&
			!Array.from(key).some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			}) &&
			key
				.split("/")
				.every((part) => part.length > 0 && part !== "." && part !== ".."),
		"Recording output key is invalid",
	);

export const recordingVerificationSchema = z.object({
	version: z.literal(1),
	artifact: z.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("segments"),
			manifestSha256: sha256,
		}),
		z.object({
			kind: z.literal("mp4"),
			fileSize: positiveSize,
			duration: positiveNumber,
			objectIdentity: recordingObjectIdentitySchema,
		}),
	]),
	requiredAudio: z.boolean(),
});

export type RecordingVerification = z.infer<typeof recordingVerificationSchema>;

export const recordingSourceProofSchema = z
	.object({
		version: z.literal(1),
		manifestSha256: sha256,
		inventorySha256: sha256,
		sourcePreserved: z.literal(true),
		videoDuration: positiveNumber,
		hasAudio: z.boolean(),
		audioVerified: z.boolean(),
	})
	.refine(
		(proof) => !proof.audioVerified || proof.hasAudio,
		"Audio preservation requires a source audio track",
	);

export type RecordingSourceProof = z.infer<typeof recordingSourceProofSchema>;

export const recordingOutputSha256Schema = sha256;

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
		typeof entry === "number" ? entry : entry.index;
	const video = manifest.video_segments.map(normalize);
	const audio = manifest.audio_segments.map(normalize);
	for (const segments of [video, audio]) {
		if (segments.some((segment, index) => segment !== index + 1)) {
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
		hasAudio: audio.length > 0,
		videoSegments: video,
		audioSegments: audio,
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

function recordingDurationMatches(duration: number, expected: number) {
	return (
		Number.isFinite(expected) &&
		expected > 0 &&
		Math.abs(duration - expected) <= Math.max(0.5, Math.min(5, expected * 0.01))
	);
}

export function validateRecordingOutput(
	output: RecordingOutput,
	expected: { fileSize?: number; duration: number; requiredAudio: boolean },
) {
	recordingOutputSchema.parse(output);
	if (
		!recordingDurationMatches(output.duration, expected.duration) ||
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
		objectIdentity: recordingObjectIdentitySchema,
		sourceObjectIdentity: recordingObjectIdentitySchema.optional(),
		outputKey: recordingOutputKeySchema.optional(),
		outputSha256: sha256.optional(),
		sourceProof: recordingSourceProofSchema.optional(),
	})
	.superRefine((receipt, context) => {
		if (receipt.artifact.kind === "mp4") {
			if (
				receipt.artifact.objectIdentity !==
					(receipt.sourceObjectIdentity ?? receipt.objectIdentity) ||
				receipt.artifact.fileSize !== receipt.fileSize ||
				!recordingDurationMatches(
					receipt.duration,
					receipt.artifact.duration,
				) ||
				receipt.sourceProof !== undefined ||
				(receipt.sourceObjectIdentity !== undefined &&
					(!receipt.outputKey || !receipt.outputSha256))
			) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Receipt does not match the completed upload identity",
				});
			}
			return;
		}
		const proof = receipt.sourceProof;
		if (
			!proof ||
			!receipt.outputKey ||
			!receipt.outputSha256 ||
			receipt.sourceObjectIdentity !== undefined ||
			proof.manifestSha256 !== receipt.artifact.manifestSha256 ||
			!recordingDurationMatches(receipt.duration, proof.videoDuration) ||
			proof.hasAudio !== receipt.hasAudio ||
			(proof.hasAudio &&
				(!proof.audioVerified || !receipt.requiredAudioVerified)) ||
			(receipt.requiredAudioVerified && !proof.audioVerified)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"Receipt is missing matching recording source preservation proof",
			});
		}
	});

export type RecordingUploadReceipt = z.infer<
	typeof recordingUploadReceiptSchema
>;

export function assertRecordingObjectIdentity(
	head: RecordingObjectHead & { ContentLength?: number },
	expected: { fileSize: number; objectIdentity: string },
) {
	if (
		head.ContentLength !== expected.fileSize ||
		getRecordingObjectIdentity(head, expected.objectIdentity) !==
			expected.objectIdentity
	) {
		throw new Error("Uploaded recording object changed or is incomplete");
	}
}
