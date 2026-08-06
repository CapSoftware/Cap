import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function PUT(request: NextRequest) {
	const user = await getCurrentUser();
	const { videoId, metadata } = await request.json();
	const userId = user?.id as string;

	if (!user || !videoId || !metadata) {
		console.error("Missing required data in /api/video/metadata/route.ts");

		return Response.json({ error: true }, { status: 401 });
	}

	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		return Response.json({ error: true }, { status: 401 });
	}

	const result = query[0];
	if (!result) {
		return Response.json({ error: true }, { status: 401 });
	}

	if (result.ownerId !== userId) {
		return Response.json({ error: true }, { status: 401 });
	}

	await db()
		.update(videos)
		.set({
			metadata: metadata,
		})
		.where(eq(videos.id, videoId));

	return Response.json(true, { status: 200 });
}

export async function GET(request: NextRequest) {
	const { searchParams } = new URL(request.url);
	const videoId = searchParams.get("videoId");

	if (!videoId) {
		return Response.json({ error: "Missing videoId parameter" }, { status: 400 });
	}

	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const video = query[0];
	const user = await getCurrentUser();

	if (!video.public && video.ownerId !== user?.id) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const meta = (video.metadata as Record<string, any>) ?? {};

	return Response.json({
		videoId: video.id,
		title: video.title || meta.aiTitle || null,
		aiTitle: meta.aiTitle || null,
		summary: meta.summary || null,
		chapters: meta.chapters || [],
		aiGenerationStatus: meta.aiGenerationStatus || "SKIPPED",
	});
}
