"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { MAX_ARCHIVE_ITEMS } from "@/lib/video-archive";

function affectedRows(result: unknown) {
	const header = Array.isArray(result) ? result[0] : result;
	return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

// Archiving only hides a Cap from its owner's library. The share link, space
// and organization sharing, comments and files all stay exactly as they were,
// so only the owner may do it and nothing else is touched.
export async function setVideosArchived(input: {
	videoIds: Video.VideoId[];
	archived: boolean;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const videoIds = Array.isArray(input.videoIds)
		? [...new Set(input.videoIds.filter((id) => typeof id === "string"))]
		: [];
	if (videoIds.length === 0) return { updated: 0 };
	if (videoIds.length > MAX_ARCHIVE_ITEMS)
		throw new Error(`You can archive up to ${MAX_ARCHIVE_ITEMS} Caps at once`);
	const archived = input.archived === true;

	const result = await db()
		.update(videos)
		.set({
			archivedAt: archived ? new Date() : null,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.ownerId, user.id),
				inArray(videos.id, videoIds),
				archived ? isNull(videos.archivedAt) : isNotNull(videos.archivedAt),
			),
		);

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/caps/archived");
	revalidatePath("/dashboard/folder/[id]", "page");
	return { updated: affectedRows(result) };
}
