import { db } from "@cap/database";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

// The only metadata an owner sets through this route. Everything else is
// written by the server and kept as stored.
const CLIENT_KEYS = ["customCreatedAt", "sourceName"] as const;

export async function PUT(request: NextRequest) {
	const user = isCrossSiteCookieWrite(request) ? null : await getCurrentUser();
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

	const clientMetadata: Record<string, unknown> = {};
	for (const key of CLIENT_KEYS) {
		if (!(key in metadata)) continue;
		const value = (metadata as Record<string, unknown>)[key];
		if (value !== null && typeof value !== "string")
			return Response.json({ error: true }, { status: 400 });
		clientMetadata[key] = value;
	}

	await db().transaction(async (tx) => {
		const [locked] = await tx
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");

		const next: Record<string, unknown> = { ...(locked?.metadata ?? {}) };
		for (const [key, value] of Object.entries(clientMetadata)) {
			if (value === null) delete next[key];
			else next[key] = value;
		}

		await tx
			.update(videos)
			.set({ metadata: next })
			.where(eq(videos.id, videoId));
	});

	return Response.json(true, { status: 200 });
}
