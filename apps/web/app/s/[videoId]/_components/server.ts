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
			uploaded: Db.videoUploads.uploaded,
			total: Db.videoUploads.total,
			startedAt: Db.videoUploads.startedAt,
			updatedAt: Db.videoUploads.updatedAt,
		})
		.from(Db.videoUploads)
		.innerJoin(Db.videos, Dz.eq(Db.videoUploads.videoId, Db.videos.id))
		.where(
			Dz.and(
				Dz.eq(Db.videoUploads.videoId, videoId),
				Dz.eq(Db.videos.ownerId, user.id),
			),
		);

	return result || null;
}
