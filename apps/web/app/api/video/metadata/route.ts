import { db } from "@cap/database";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

// Written only by the server, so the owner cannot change how uploads and
// plan limits treat the video.
const SERVER_OWNED_KEYS = [
	"agentUpload",
	"freePlanMeasure",
	"freePlanUploadOpenUntil",
	"loomDeferredProcessing",
] as const;
type ServerOwnedKey = (typeof SERVER_OWNED_KEYS)[number];

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

	const clientMetadata = Object.fromEntries(
		Object.entries(metadata).filter(
			([key]) => !SERVER_OWNED_KEYS.includes(key as ServerOwnedKey),
		),
	);

	await db().transaction(async (tx) => {
		const [locked] = await tx
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId))
			.for("update");

		const stored = locked?.metadata ?? {};
		const serverOwned = Object.fromEntries(
			SERVER_OWNED_KEYS.filter((key) => stored[key] !== undefined).map(
				(key) => [key, stored[key]],
			),
		);

		await tx
			.update(videos)
			.set({ metadata: { ...clientMetadata, ...serverOwned } })
			.where(eq(videos.id, videoId));
	});

	return Response.json(true, { status: 200 });
}
