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

	if (typeof metadata !== "object" || Array.isArray(metadata)) {
		return Response.json({ error: true }, { status: 400 });
	}

	const { agentUpload: _agentUpload, ...clientMetadata } = metadata;
	const storedAgentUpload = result.metadata?.agentUpload;

	await db()
		.update(videos)
		.set({
			metadata: storedAgentUpload
				? { ...clientMetadata, agentUpload: storedAgentUpload }
				: clientMetadata,
		})
		.where(eq(videos.id, videoId));

	return Response.json(true, { status: 200 });
}
