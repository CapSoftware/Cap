import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import {
	assertRecordingObjectIdentity,
	type RecordingOutput,
	type RecordingSourceProof,
	type RecordingUploadReceipt,
	type RecordingVerification,
	readCompletedRecordingManifest,
	recordingObjectIdentitySchema,
	recordingOutputKeySchema,
	recordingOutputSha256Schema,
	recordingSourceProofSchema,
	recordingUploadReceiptSchema,
	recordingVerificationSchema,
	validateRecordingOutput,
} from "@/lib/desktop-recording-verification";
import * as EffectRuntime from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

async function getRecordingStorage(video: typeof videos.$inferSelect) {
	const [bucket] = await EffectRuntime.runPromise(
		Effect.gen(function* () {
			return yield* Storage.getAccessForVideo(decodeStorageVideo(video));
		}),
	);
	return bucket;
}

export async function validateDesktopRecordingRequest(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
) {
	recordingVerificationSchema.parse(request);
	const bucket = await getRecordingStorage(video);
	if (request.artifact.kind === "mp4") {
		return {
			bucket,
			manifest: null,
			expected: {
				fileSize: request.artifact.fileSize,
				duration: request.artifact.duration,
				requiredAudio: request.requiredAudio,
			},
		};
	}
	const source = new Video.SegmentsSource({
		videoId: video.id,
		ownerId: video.ownerId,
	});
	const content = await EffectRuntime.runPromise(
		bucket.getObject(source.getManifestKey()),
	);
	if (Option.isNone(content))
		throw new Error("Final recording manifest is missing");
	const manifest = readCompletedRecordingManifest(content.value);
	if (
		manifest.manifestSha256 !== request.artifact.manifestSha256 ||
		(request.requiredAudio && !manifest.hasAudio)
	) {
		throw new Error("Final recording manifest does not match the upload");
	}
	return {
		bucket,
		manifest,
		expected: {
			fileSize: undefined,
			duration: undefined,
			requiredAudio: request.requiredAudio || manifest.hasAudio,
		},
	};
}

export type RecordingReceiptOptions = {
	outputKey?: string;
	outputSha256?: string;
	sourceProof?: RecordingSourceProof;
	sourceObjectIdentity?: string;
};

function resolveRecordingOutputKey(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
	outputKey?: string,
) {
	const prefix = `${video.ownerId}/${video.id}/`;
	const key = recordingOutputKeySchema.parse(
		outputKey ??
			(request.artifact.kind === "mp4" ? `${prefix}result.mp4` : undefined),
	);
	if (!key.startsWith(prefix)) {
		throw new Error("Recording output key does not belong to this recording");
	}
	return key;
}

export async function createVerifiedRecordingReceipt(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
	output: RecordingOutput,
	fullDecode: boolean,
	objectIdentity?: string,
	options: RecordingReceiptOptions = {},
): Promise<RecordingUploadReceipt> {
	recordingVerificationSchema.parse(request);
	if (!fullDecode || !objectIdentity)
		throw new Error("Recording content and identity were not fully verified");
	const sourceObjectIdentity = recordingObjectIdentitySchema
		.optional()
		.parse(options.sourceObjectIdentity);
	if (
		request.artifact.kind === "mp4" &&
		request.artifact.objectIdentity !== (sourceObjectIdentity ?? objectIdentity)
	)
		throw new Error("Verified recording does not match its upload receipt");
	const outputKey = resolveRecordingOutputKey(
		video,
		request,
		options.outputKey,
	);
	const outputSha256 = recordingOutputSha256Schema
		.optional()
		.parse(options.outputSha256);
	const sourceProof = recordingSourceProofSchema
		.optional()
		.parse(options.sourceProof);
	if (
		sourceObjectIdentity !== undefined &&
		(request.artifact.kind !== "mp4" || !options.outputKey || !outputSha256)
	) {
		throw new Error(
			"Source upload identity requires an immutable verified output",
		);
	}
	let requiredAudioVerified = request.requiredAudio;
	if (request.artifact.kind === "segments") {
		if (
			!sourceProof ||
			!outputSha256 ||
			sourceProof.manifestSha256 !== request.artifact.manifestSha256 ||
			sourceProof.hasAudio !== Boolean(output.audioCodec) ||
			((request.requiredAudio || sourceProof.hasAudio) &&
				!sourceProof.audioVerified)
		) {
			throw new Error("Recording source preservation was not fully verified");
		}
		validateRecordingOutput(output, {
			duration: sourceProof.videoDuration,
			requiredAudio: request.requiredAudio || sourceProof.hasAudio,
		});
		requiredAudioVerified = sourceProof.audioVerified;
	} else {
		if (sourceProof) {
			throw new Error(
				"MP4 upload cannot use segmented source preservation proof",
			);
		}
		validateRecordingOutput(output, {
			fileSize: request.artifact.fileSize,
			duration: request.artifact.duration,
			requiredAudio: request.requiredAudio,
		});
	}
	const bucket = await getRecordingStorage(video);
	const head = await EffectRuntime.runPromise(bucket.headObject(outputKey));
	if (!head.ETag || head.ContentLength !== output.fileSize) {
		throw new Error("Final recording object is not fully uploaded");
	}
	if (head.ETag !== objectIdentity) {
		throw new Error("Recording changed while its content was verified");
	}
	return recordingUploadReceiptSchema.parse({
		version: 1,
		artifact: request.artifact,
		fileSize: output.fileSize,
		duration: output.duration,
		hasAudio: Boolean(output.audioCodec),
		fullDecode: true,
		requiredAudioVerified,
		objectIdentity: head.ETag,
		outputKey,
		...(outputSha256 === undefined ? {} : { outputSha256 }),
		...(sourceProof === undefined ? {} : { sourceProof }),
		...(sourceObjectIdentity === undefined ? {} : { sourceObjectIdentity }),
	});
}

export async function verifyDesktopRecordingUpload(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
) {
	const verification = recordingVerificationSchema.parse(request);
	const receipt = recordingUploadReceiptSchema.safeParse(
		video.metadata?.desktopRecordingUpload,
	);
	if (
		!receipt.success ||
		JSON.stringify(receipt.data.artifact) !==
			JSON.stringify(verification.artifact)
	) {
		return null;
	}
	if (
		(verification.requiredAudio || receipt.data.sourceProof?.hasAudio) &&
		(!receipt.data.hasAudio || !receipt.data.requiredAudioVerified)
	)
		return null;
	let outputKey: string;
	try {
		outputKey = resolveRecordingOutputKey(
			video,
			verification,
			receipt.data.outputKey,
		);
	} catch {
		return null;
	}
	if (
		((verification.artifact.kind === "segments" ||
			receipt.data.sourceObjectIdentity !== undefined) &&
			(video.source?.type !== "desktopMP4" ||
				video.source.outputKey !== outputKey)) ||
		(video.source?.type === "desktopMP4" &&
			video.source.outputKey !== undefined &&
			video.source.outputKey !== outputKey)
	) {
		return null;
	}
	const bucket = await getRecordingStorage(video);
	const head = await EffectRuntime.runPromise(bucket.headObject(outputKey));
	try {
		assertRecordingObjectIdentity(head, receipt.data);
	} catch {
		return null;
	}
	return {
		version: 1 as const,
		videoId: video.id,
		artifact: verification.artifact,
		fileSize: receipt.data.fileSize,
		duration: receipt.data.duration,
		hasAudio: receipt.data.hasAudio,
		fullDecode: true,
		requiredAudioVerified: receipt.data.requiredAudioVerified,
	};
}
