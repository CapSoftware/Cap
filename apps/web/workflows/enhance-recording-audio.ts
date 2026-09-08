import { createHash } from "node:crypto";
import { db } from "@cap/database";
import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { getStepMetadata } from "workflow";
import { z } from "zod";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const responseSchema = z.object({
	status: z.literal("verified"),
	version: z.literal("audio-quality-v3"),
	sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
	outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
	outputIdentity: z.string().min(1),
	outputSize: z.number().int().positive().safe(),
	inputLufs: z.number().finite(),
	outputLufs: z.number().finite().max(-14),
	truePeak: z.number().finite().max(-1),
});

export async function enhanceRecordingAudio(videoId: string, userId: string) {
	"use step";

	try {
		const env = serverEnv();
		if (!env.MEDIA_SERVER_URL || !env.MEDIA_SERVER_WEBHOOK_SECRET) return;
		const id = Video.VideoId.make(videoId);
		const [video] = await db().select().from(videos).where(eq(videos.id, id));
		if (
			!video ||
			video.ownerId !== userId ||
			video.source.type !== "desktopMP4" ||
			video.source.audioLevelOutputKey ||
			!video.duration ||
			video.duration > 900
		)
			return;
		const sourceKey = Video.getRetainedRecordingOutputKey(
			userId,
			videoId,
			video.source.outputKey,
		);
		if (!sourceKey) return;
		const source = video.source;
		const [job] = await db()
			.select()
			.from(videoProcessingJobs)
			.where(eq(videoProcessingJobs.videoId, id));
		if (job?.state !== "verified") return;
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);
		if (bucket.provider !== "s3") return;
		const sourceHead = await bucket
			.headObject(sourceKey)
			.pipe(runWorkflowPromise);
		if (
			!sourceHead.ETag ||
			!sourceHead.ContentLength ||
			sourceHead.ContentLength > 256 * 1024 * 1024
		)
			return;
		const token = createHash("sha256")
			.update(`${sourceKey}:${sourceHead.ETag}:${getStepMetadata().stepId}`)
			.digest("hex");
		const outputKey = `${userId}/${videoId}/.recording/outputs/audio-quality-v3/${token}.mp4`;
		const [sourceUrl, outputUrl, verificationUrl] = await Promise.all([
			bucket
				.getInternalSignedObjectUrl(sourceKey, { expiresIn: 600 })
				.pipe(runWorkflowPromise),
			bucket
				.getInternalPresignedPutUrl(
					outputKey,
					{ ContentType: "video/mp4", IfNoneMatch: "*" },
					{ expiresIn: 600 },
				)
				.pipe(runWorkflowPromise),
			bucket
				.getInternalSignedObjectUrl(outputKey, { expiresIn: 600 })
				.pipe(runWorkflowPromise),
		]);
		const response = await fetch(`${env.MEDIA_SERVER_URL}/audio/levels`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": env.MEDIA_SERVER_WEBHOOK_SECRET,
			},
			body: JSON.stringify({
				sourceUrl,
				sourceIdentity: sourceHead.ETag,
				sourceSize: sourceHead.ContentLength,
				outputUrl,
				verificationUrl,
			}),
			signal: AbortSignal.timeout(135_000),
		});
		if (!response.ok) return;
		const payload: unknown = await response.json();
		const parsed = responseSchema.safeParse(payload);
		if (!parsed.success) {
			const skipped = z
				.object({ status: z.literal("unchanged"), reason: z.string().max(100) })
				.safeParse(payload);
			console.info("[audio-levels] Original retained", {
				videoId,
				reason: skipped.success ? skipped.data.reason : "invalid-response",
			});
			return;
		}
		const result = parsed.data;
		const [currentSource, output] = await Promise.all([
			bucket.headObject(sourceKey).pipe(runWorkflowPromise),
			bucket.headObject(outputKey).pipe(runWorkflowPromise),
		]);
		if (
			currentSource.ETag !== sourceHead.ETag ||
			currentSource.ContentLength !== sourceHead.ContentLength ||
			output.ETag !== result.outputIdentity ||
			output.ContentLength !== result.outputSize
		)
			return;
		const published = await db().transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(videos)
				.where(eq(videos.id, id))
				.for("update");
			if (
				!current ||
				current.ownerId !== userId ||
				current.orgId !== video.orgId ||
				JSON.stringify(current.source) !== JSON.stringify(video.source) ||
				current.bucket !== video.bucket ||
				current.storageIntegrationId !== video.storageIntegrationId
			)
				return false;
			const [upload] = await tx
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, id));
			if (upload) return false;
			await tx
				.update(videos)
				.set({
					source: {
						...source,
						audioLevelSourceKey: sourceKey,
						audioLevelOutputKey: outputKey,
					},
				})
				.where(and(eq(videos.id, id), eq(videos.ownerId, video.ownerId)));
			return true;
		});
		console.info("[audio-levels] Result", { videoId, published, ...result });
	} catch {
		console.warn("[audio-levels] Original retained", { videoId });
	}
}
