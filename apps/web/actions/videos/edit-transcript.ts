"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { updateVttEntryText } from "@/lib/transcript-vtt";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function editTranscriptEntry(
	videoId: Video.VideoId,
	entryId: number,
	newText: string,
): Promise<{ success: boolean; message: string }> {
	const user = await getCurrentUser();

	if (!user || !videoId || entryId === undefined || !newText?.trim()) {
		return {
			success: false,
			message: "Missing required data for updating transcript entry",
		};
	}

	const userId = user.id;
	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video not found" };
	}

	const result = query[0];
	if (!result?.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (video.ownerId !== userId) {
		return {
			success: false,
			message: "You don't have permission to edit this transcript",
		};
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	try {
		const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;

		const vttContent = await bucket.getObject(transcriptKey).pipe(runPromise);
		if (Option.isNone(vttContent))
			return { success: false, message: "Transcript file not found" };

		const { content: updatedVttContent, updated } = updateVttEntryText(
			vttContent.value,
			entryId,
			newText,
		);
		if (!updated) {
			return { success: false, message: "Transcript entry not found" };
		}

		await bucket
			.putObject(transcriptKey, updatedVttContent, {
				contentType: "text/vtt",
			})
			.pipe(runPromise);

		revalidatePath(`/s/${videoId}`);

		return {
			success: true,
			message: "Transcript entry updated successfully",
		};
	} catch (error) {
		console.error("Error updating transcript entry:", {
			error: error instanceof Error ? error.message : error,
			videoId,
			entryId,
			userId,
		});
		return {
			success: false,
			message: "Failed to update transcript entry",
		};
	}
}
