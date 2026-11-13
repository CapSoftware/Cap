import { db } from "@cap/database";
import { developerAppDomains, developerVideos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import {
	DEVELOPER_EMBED_PATH,
	embedFrameAncestors,
	withFrameAncestors,
} from "./infra-embed-ancestors";

export const EMBED_ORIGINS_CACHE_MS = 60_000;
const EMBED_ORIGINS_CACHE_MAX = 5_000;

// Every embed load passes through here, so each instance keeps the answer for
// a minute. A change to an app's list reaches every embed within that minute.
const cached = new Map<string, { origins: string[]; expiresAt: number }>();

export function clearEmbedOriginsCache() {
	cached.clear();
}

export async function findEmbedOrigins(playbackId: string): Promise<string[]> {
	const now = Date.now();
	const hit = cached.get(playbackId);
	if (hit && hit.expiresAt > now) return hit.origins;

	const rows = await db()
		.select({ domain: developerAppDomains.domain })
		.from(developerVideos)
		.innerJoin(
			developerAppDomains,
			eq(developerAppDomains.appId, developerVideos.appId),
		)
		.where(eq(developerVideos.playbackId, playbackId));
	const origins = rows.map((row) => row.domain);

	cached.delete(playbackId);
	if (cached.size >= EMBED_ORIGINS_CACHE_MAX) {
		const oldest = cached.keys().next().value;
		if (oldest !== undefined) cached.delete(oldest);
	}
	cached.set(playbackId, {
		origins,
		expiresAt: now + EMBED_ORIGINS_CACHE_MS,
	});
	return origins;
}

// An app with no allowed sites gets the response untouched, so its embed can
// be framed anywhere exactly as before the list was enforced.
export async function restrictEmbedFraming(
	path: string,
	response: NextResponse,
): Promise<NextResponse> {
	const playbackId = DEVELOPER_EMBED_PATH.exec(path)?.[1];
	if (!playbackId) return response;

	let origins: string[];
	try {
		origins = await findEmbedOrigins(playbackId);
	} catch (error) {
		console.error("Could not read the embed's allowed sites:", error);
		return response;
	}

	const frameAncestors = embedFrameAncestors(origins);
	if (!frameAncestors) return response;
	response.headers.set(
		"Content-Security-Policy",
		withFrameAncestors(
			response.headers.get("Content-Security-Policy"),
			frameAncestors,
		),
	);
	return response;
}
