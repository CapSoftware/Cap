import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	type LoomRedriveOutcome,
	redriveLoomImport,
} from "@/lib/loom-import-redrive";

const MAX_VIDEOS_PER_REQUEST = 25;
const CONCURRENCY = 5;

const bodySchema = z.object({
	videoIds: z
		.array(z.string().regex(/^[a-z0-9]{15}$/))
		.min(1)
		.max(MAX_VIDEOS_PER_REQUEST),
});

function isAuthorized(request: NextRequest) {
	const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	const header = request.headers.get("x-media-server-secret");
	if (!secret || !header) return false;
	const digest = (value: string) =>
		createHash("sha256").update(value, "utf8").digest();
	return timingSafeEqual(digest(header), digest(secret));
}

export async function POST(request: NextRequest) {
	if (!isAuthorized(request))
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return NextResponse.json(
			{ error: "Invalid request", details: parsed.error.issues },
			{ status: 400 },
		);
	const videoIds = [...new Set(parsed.data.videoIds)];
	const results: LoomRedriveOutcome[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, videoIds.length) }, async () => {
			while (next < videoIds.length) {
				const videoId = videoIds[next++];
				if (!videoId) continue;
				results.push(
					await redriveLoomImport(videoId).catch((error) => ({
						videoId,
						status: "failed" as const,
						reason: error instanceof Error ? error.message : String(error),
					})),
				);
			}
		}),
	);
	return NextResponse.json({ results });
}
