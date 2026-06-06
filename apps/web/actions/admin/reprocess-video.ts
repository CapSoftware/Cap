"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { MESSENGER_ADMIN_EMAIL } from "@/lib/messenger/constants";
import { adminReprocessVideoWorkflow } from "@/workflows/admin-reprocess-video";

async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || user.email !== MESSENGER_ADMIN_EMAIL) {
		throw new Error("Unauthorized");
	}
	return user;
}

function parseVideoId(input: string) {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Enter a video ID or share URL");
	}

	try {
		const url = new URL(trimmed);
		const pathMatch = url.pathname.match(/\/s\/([^/?#]+)/);
		if (pathMatch?.[1]) {
			return Video.VideoId.make(pathMatch[1]);
		}
		const lastSegment = url.pathname.split("/").filter(Boolean).at(-1);
		if (lastSegment) {
			return Video.VideoId.make(lastSegment);
		}
	} catch {}

	return Video.VideoId.make(trimmed);
}

export async function adminReprocessVideo(input: string) {
	await requireAdmin();
	const videoId = parseVideoId(input);

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
