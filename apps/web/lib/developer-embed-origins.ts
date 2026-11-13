import { db } from "@cap/database";
import { developerAppDomains, developerVideos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import type { NextResponse } from "next/server";
import {
	DEVELOPER_EMBED_PATH,
	embedFrameAncestors,
	withFrameAncestors,
} from "./infra-embed-ancestors";

export async function findEmbedOrigins(playbackId: string): Promise<string[]> {
	const rows = await db()
		.select({ domain: developerAppDomains.domain })
		.from(developerVideos)
		.innerJoin(
			developerAppDomains,
			eq(developerAppDomains.appId, developerVideos.appId),
		)
		.where(eq(developerVideos.playbackId, playbackId));
	return rows.map((row) => row.domain);
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
