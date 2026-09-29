"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import {
	type ImportEditorSource,
	importEditorSourcesPatch,
} from "@/lib/import-editor-source";
import { runPromise } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { decodeStorageVideo } from "@/lib/video-storage";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

async function verifyRawFileUploaded(
	video: typeof videos.$inferSelect,
	rawFileKey: string,
) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	const head = await bucket
		.headObject(rawFileKey)
		.pipe(
			Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
			runPromise,
		);

	if ((head.ContentLength ?? 0) <= 0) {
		throw new Error("Uploaded video file is empty");
	}
	return head;
}

async function registerImportEditorSource(
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	video: typeof videos.$inferSelect,
	source: ImportEditorSource,
	head: Awaited<ReturnType<typeof verifyRawFileUploaded>>,
) {
	const [upload] = await db()
		.select({ phase: videoUploads.phase, rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, video.id));
	const patch = importEditorSourcesPatch({
		ownerId: video.ownerId,
		videoId: video.id,
		isPro: userIsPro(user),
		source,
		upload: upload ?? null,
		existingSources: video.metadata?.editorSources,
		head: {
			size: head.ContentLength,
			identity: getRecordingObjectIdentity(head),
		},
	});
	if (!patch) return;
	const sourcePatch = JSON.stringify({ editorSources: patch.editorSources });
	await db()
		.update(videos)
		.set({
			duration: sql`COALESCE(${videos.duration}, ${patch.duration})`,
			metadata: sql`JSON_MERGE_PATCH(COALESCE(${videos.metadata}, JSON_OBJECT()), ${sourcePatch})`,
		})
		.where(
			and(
				eq(videos.id, video.id),
				eq(videos.ownerId, user.id),
				sql`JSON_EXTRACT(${videos.metadata}, '$.editorSources') IS NULL`,
			),
		);
}

export async function triggerVideoProcessing({
	videoId,
	rawFileKey,
	bucketId,
	editorSource,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
	/** Opens the import in the editor from its upload; see import-editor-source. */
	editorSource?: ImportEditorSource | null;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	const head = await verifyRawFileUploaded(video, rawFileKey);

	if (editorSource && isWebStudioEnabledForEmail(user.email)) {
		await registerImportEditorSource(user, video, editorSource, head).catch(
			(error) =>
				console.error("Import will open in the editor after processing", error),
		);
	}

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video processing could not start.",
	});

	return { success: true };
}
