"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";

export async function getUploadProgress({ videoId }: { videoId: string }) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	const [result] = await db()
		.select({
			progress: Db.uploads.progress,
			startedAt: Db.uploads.startedAt,
			updatedAt: Db.uploads.updatedAt,
		})
		.from(Db.uploads)
		.innerJoin(Db.videos, Dz.eq(Db.uploads.videoId, Db.videos.id))
		.where(
			Dz.and(
				Dz.eq(Db.uploads.videoId, videoId),
				Dz.eq(Db.videos.ownerId, user.id),
			),
		);

	return result || null;
}
