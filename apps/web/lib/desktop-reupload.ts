import {
	CloudFrontClient,
	CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import type { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { AwsCredentials } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { retireDesktopRecordingJobForOutputReplacement } from "@/lib/desktop-recording-jobs";
import {
	assertDesktopReuploadTarget,
	type DesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { runPromise } from "@/lib/server";

type ReuploadedVideo = Pick<
	Video.Video,
	"id" | "ownerId" | "bucketId" | "storageIntegrationId"
>;

export async function prepareDesktopReupload(
	tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
	video: ReuploadedVideo,
	token: DesktopReuploadToken,
) {
	await tx
		.select({ videoId: videoProcessingJobs.videoId })
		.from(videoProcessingJobs)
		.where(eq(videoProcessingJobs.videoId, video.id))
		.for("update");
	const [locked] = await tx
		.select()
		.from(videos)
		.where(eq(videos.id, video.id))
		.for("update");
	if (
		!locked ||
		locked.id !== video.id ||
		locked.ownerId !== video.ownerId ||
		locked.bucket !== Option.getOrNull(video.bucketId) ||
		locked.storageIntegrationId !== Option.getOrNull(video.storageIntegrationId)
	) {
		throw new Error("Recording storage changed during reupload");
	}
	assertDesktopReuploadTarget(
		token,
		{ ...video, source: locked.source },
		`${video.ownerId}/${video.id}/result.mp4`,
	);
	if (
		(locked.source.type === "desktopMP4" || locked.source.type === "webMP4") &&
		locked.source.outputKey === token.outputKey
	) {
		return null;
	}
	const [upload] = await tx
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, video.id))
		.for("update");
	if (upload?.rawFileKey !== token.outputKey) {
		throw new Error("Replacement upload was canceled or superseded");
	}
	await retireDesktopRecordingJobForOutputReplacement(tx, {
		videoId: video.id,
		userId: video.ownerId,
	});
	const metadata = { ...(locked.metadata ?? {}) };
	delete metadata.desktopRecordingUpload;
	delete metadata.summary;
	delete metadata.chapters;
	delete metadata.aiGenerationStatus;
	Reflect.deleteProperty(metadata, "editProcessing");
	Reflect.deleteProperty(metadata, "completedVideoEdit");
	return {
		source:
			locked.source.type === "webMP4"
				? { type: "webMP4" as const, outputKey: token.outputKey }
				: { type: "desktopMP4" as const, outputKey: token.outputKey },
		metadata,
		transcriptionStatus: null,
	};
}

export async function invalidateReuploadedVideo(video: ReuploadedVideo) {
	if (
		Option.isSome(video.bucketId) ||
		Option.isSome(video.storageIntegrationId)
	)
		return;
	const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return;
	const client = new CloudFrontClient({
		region: serverEnv().CAP_AWS_REGION || "us-east-1",
		credentials: await runPromise(
			Effect.map(AwsCredentials, (value) => value.credentials),
		),
	});
	try {
		await client.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					CallerReference: crypto.randomUUID(),
					Paths: { Quantity: 1, Items: [`/${video.ownerId}/${video.id}/*`] },
				},
			}),
		);
	} finally {
		client.destroy();
	}
}
