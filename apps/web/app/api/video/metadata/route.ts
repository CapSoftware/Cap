import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { hasDirectoryAccess } from "@cap/database/directory-sync/access";
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

	if (
		result.ownerId !== userId ||
		!(await hasDirectoryAccess(userId, result.orgId))
	) {
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
