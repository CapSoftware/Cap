import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

const expiryPresets = ["7d", "30d", "never"] as const;
type ExpiryPreset = (typeof expiryPresets)[number];

function isExpiryPreset(value: unknown): value is ExpiryPreset {
	return (
		typeof value === "string" && expiryPresets.includes(value as ExpiryPreset)
	);
}

function getExpiresAt(preset: ExpiryPreset) {
	if (preset === "never") return null;

	const days = preset === "7d" ? 7 : 30;
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function PUT(request: NextRequest) {
	const user = await getCurrentUser();

	if (!user) {
		return Response.json({ error: true }, { status: 401 });
	}

	const { videoId, preset } = await request.json();

	if (!videoId || !isExpiryPreset(preset)) {
		return Response.json({ error: true }, { status: 400 });
	}

	const [video] = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)))
		.limit(1);

	if (!video) {
		return Response.json({ error: true }, { status: 404 });
	}

	const expiresAt = getExpiresAt(preset);

	await db().update(videos).set({ expiresAt }).where(eq(videos.id, videoId));

	return Response.json(
		{ expiresAt: expiresAt?.toISOString() ?? null },
		{ status: 200 },
	);
}
