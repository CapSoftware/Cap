"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	isTranscriptSpeakerId,
	isTranscriptSpeakerName,
	MAX_TRANSCRIPT_SPEAKERS,
	parseTranscriptSpeakerNames,
	type TranscriptSpeakerNames,
} from "@/lib/transcript-speakers";

export async function renameTranscriptSpeaker(
	videoId: Video.VideoId,
	speaker: string,
	name: string,
): Promise<{
	success: boolean;
	message: string;
	names?: TranscriptSpeakerNames;
}> {
	const user = await getCurrentUser();
	if (
		!user ||
		!videoId ||
		!isTranscriptSpeakerId(speaker) ||
		!isTranscriptSpeakerName(name)
	) {
		return { success: false, message: "Invalid speaker name" };
	}
	try {
		const result = await db().transaction(async (tx) => {
			const [video] = await tx
				.select()
				.from(videos)
				.where(eq(videos.id, videoId))
				.for("update");
			if (!video || video.ownerId !== user.id) {
				return {
					success: false,
					message: "You don't have permission to edit this transcript",
				};
			}
			const names = parseTranscriptSpeakerNames(
				video.metadata?.transcriptSpeakerNames,
			);
			if (name.trim()) names[speaker] = name.trim();
			else delete names[speaker];
			if (Object.keys(names).length > MAX_TRANSCRIPT_SPEAKERS) {
				return { success: false, message: "Too many speaker names" };
			}
			await tx
				.update(videos)
				.set({
					metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.transcriptSpeakerNames', CAST(${JSON.stringify(names)} AS JSON))`,
					updatedAt: video.updatedAt,
				})
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
			return { success: true, message: "Speaker name saved", names };
		});
		if (result.success) revalidatePath(`/s/${videoId}`);
		return result;
	} catch {
		return { success: false, message: "Failed to save speaker name" };
	}
}
