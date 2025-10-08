"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Folder, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function getFolderVideoIds(folderId: Folder.FolderId) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!folderId) {
			throw new Error("Folder ID is required");
		}

		const rows = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.folderId, folderId));

		return {
			success: true,
			data: rows.map((r) => r.id as Video.VideoId),
		};
	} catch (error) {
		console.error("Error fetching folder video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch folder videos",
		};
	}
}
