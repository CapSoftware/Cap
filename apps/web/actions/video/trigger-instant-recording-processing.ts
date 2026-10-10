"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { startRecordingRender } from "@/lib/render-recording";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export async function triggerInstantRecordingProcessing({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	const rawFileKey = `${user.id}/${videoId}/result.mp4`;
	if (!video.metadata?.editorSources) {
		const sourcePatch = JSON.stringify({
			editorSources: {
				version: 1,
				display: {
					key: rawFileKey,
					contentType: "video/mp4",
				},
			},
		});
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_MERGE_PATCH(COALESCE(${videos.metadata}, JSON_OBJECT()), ${sourcePatch})`,
			})
			.where(
				and(
					eq(videos.id, videoId),
					eq(videos.ownerId, user.id),
					sql`JSON_EXTRACT(${videos.metadata}, '$.editorSources') IS NULL`,
				),
			);
	}

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId: video.bucket ?? null,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video uploaded, but processing could not start.",
		mode: "singlepart",
	});

	const requestHeaders = await headers();
	const host = (
		requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host")
	)
		?.split(",")[0]
		?.trim();
	if (host) {
		const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
		await startRecordingRender(videoId, `${protocol}://${host}`).catch(
			(error) =>
				console.error(
					"Failed to start the render of a finished recording",
					error,
				),
		);
	}

	return { success: true };
}
