"use server";

import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { parseAdminVideoId, requireAdmin } from "@/lib/admin-access";
import { adminReprocessVideoWorkflow } from "@/workflows/admin-reprocess-video";

export async function adminReprocessVideo(input: string) {
	await requireAdmin();
	const videoId = parseAdminVideoId(input);

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
		})
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) {
		throw new Error("Video not found");
	}

	const resultKey = `${video.ownerId}/${video.id}/result.mp4`;
	await db()
		.insert(videoUploads)
		.values({
			videoId: video.id,
			uploaded: 0,
			total: 0,
			mode: "singlepart",
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Queued admin reprocess...",
			processingError: null,
			rawFileKey: resultKey,
			updatedAt: new Date(),
		})
		.onDuplicateKeyUpdate({
			set: {
				uploaded: 0,
				total: 0,
				mode: "singlepart",
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Queued admin reprocess...",
				processingError: null,
				rawFileKey: resultKey,
				updatedAt: new Date(),
			},
		});

	await start(adminReprocessVideoWorkflow, [{ videoId }]);

	return {
		videoId,
		name: video.name,
		shareUrl: `${serverEnv().WEB_URL}/s/${videoId}`,
	};
}
