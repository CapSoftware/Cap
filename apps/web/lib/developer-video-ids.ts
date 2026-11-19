import { db } from "@cap/database";
import { developerVideos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
	developerVideoIdForIdempotencyKey,
	legacyDeveloperVideoIdForIdempotencyKey,
} from "@/lib/developer-ids";

export async function keyedDeveloperVideoId(appId: string, key: string) {
	const legacyId = legacyDeveloperVideoIdForIdempotencyKey(appId, key);
	const [legacy] = await db()
		.select({ id: developerVideos.id })
		.from(developerVideos)
		.where(eq(developerVideos.id, legacyId))
		.limit(1);
	return legacy ? legacyId : developerVideoIdForIdempotencyKey(appId, key);
}
