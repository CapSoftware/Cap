import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import {
	assertRecordingObjectIdentity,
	type RecordingOutput,
	type RecordingUploadReceipt,
	type RecordingVerification,
	readCompletedRecordingManifest,
	recordingUploadReceiptSchema,
	validateRecordingOutput,
} from "@/lib/desktop-recording-verification";
import * as EffectRuntime from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function validateDesktopRecordingRequest(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
) {
	const [bucket] = await EffectRuntime.runPromise(
		Effect.gen(function* () {
			return yield* Storage.getAccessForVideo(decodeStorageVideo(video));
		}),
	);
	if (request.artifact.kind === "mp4") {
		return {
			bucket,
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
		expected: {
			fileSize: undefined,
			duration: manifest.duration,
			requiredAudio: request.requiredAudio || manifest.hasAudio,
		},
	};
}

export async function createVerifiedRecordingReceipt(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
	output: RecordingOutput,
	fullDecode: boolean,
	objectIdentity?: string,
): Promise<RecordingUploadReceipt> {
	if (!fullDecode || !objectIdentity)
		throw new Error("Recording content and identity were not fully verified");
	if (
		request.artifact.kind === "mp4" &&
		request.artifact.objectIdentity !== objectIdentity
	)
		throw new Error("Verified recording does not match its upload receipt");
	const { bucket, expected } = await validateDesktopRecordingRequest(
		video,
		request,
	);
	validateRecordingOutput(output, expected);
	const head = await EffectRuntime.runPromise(
		bucket.headObject(`${video.ownerId}/${video.id}/result.mp4`),
	);
	if (!head.ETag || head.ContentLength !== output.fileSize) {
		throw new Error("Final recording object is not fully uploaded");
	}
	if (head.ETag !== objectIdentity) {
		throw new Error("Recording changed while its content was verified");
	}
	return {
		version: 1,
		artifact: request.artifact,
		fileSize: output.fileSize,
		duration: output.duration,
		hasAudio: Boolean(output.audioCodec),
		fullDecode: true,
		objectIdentity: head.ETag,
	};
}

export async function verifyDesktopRecordingUpload(
	video: typeof videos.$inferSelect,
	request: RecordingVerification,
) {
	const receipt = recordingUploadReceiptSchema.safeParse(
		video.metadata?.desktopRecordingUpload,
	);
	if (
		!receipt.success ||
		JSON.stringify(receipt.data.artifact) !== JSON.stringify(request.artifact)
	) {
		return null;
	}
	const { bucket, expected } = await validateDesktopRecordingRequest(
		video,
		request,
	);
	if (expected.requiredAudio && !receipt.data.hasAudio) return null;
	const head = await EffectRuntime.runPromise(
		bucket.headObject(`${video.ownerId}/${video.id}/result.mp4`),
	);
	try {
		assertRecordingObjectIdentity(head, receipt.data);
	} catch {
		return null;
	}
	return {
		version: 1 as const,
		videoId: video.id,
		artifact: request.artifact,
		fileSize: receipt.data.fileSize,
		duration: receipt.data.duration,
		hasAudio: receipt.data.hasAudio,
		fullDecode: true,
	};
}
