"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
	type AiContent,
	chaptersEqual,
	MAX_CHAPTER_TITLE_LENGTH,
	MAX_CHAPTERS,
	MAX_SUMMARY_LENGTH,
	normalizeAiContent,
	validateAiContent,
} from "@/lib/ai-content";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";

const chapterSchema = z.object({
	title: z.string().max(MAX_CHAPTER_TITLE_LENGTH),
	start: z.number().finite().nonnegative(),
});

const aiContentSchema = z.object({
	summary: z.string().max(MAX_SUMMARY_LENGTH),
	chapters: z.array(chapterSchema).max(MAX_CHAPTERS),
});

const editAiContentSchema = z.object({
	value: aiContentSchema,
	expected: aiContentSchema,
});

type EditResult =
	| { success: true; data: AiContent }
	| { success: false; message: string };

export async function editAiContent(
	videoId: Video.VideoId,
	input: unknown,
): Promise<EditResult> {
	const user = await getCurrentUser();
	if (!user) return { success: false, message: "Sign in to edit this video." };
	if (!isAiGenerationEnabledForUser(user)) {
		return {
			success: false,
			message: "Cap Pro is required to edit AI content.",
		};
	}
	const parsed = editAiContentSchema.safeParse(input);
	if (typeof videoId !== "string" || !videoId || !parsed.success) {
		return { success: false, message: "Invalid summary or chapter data." };
	}
	const { expected } = parsed.data;
	const value = normalizeAiContent(parsed.data.value);
	const normalizedExpected = normalizeAiContent(expected);
	const summaryChanged = value.summary !== normalizedExpected.summary;
	const chaptersChanged = !chaptersEqual(
		value.chapters,
		normalizedExpected.chapters,
	);

	try {
		const result = await db().transaction(async (tx): Promise<EditResult> => {
			const [video] = await tx
				.select({
					metadata: videos.metadata,
					duration: videos.duration,
					transcriptionStatus: videos.transcriptionStatus,
				})
				.from(videos)
				.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)))
				.for("update");
			if (!video) {
				return {
					success: false,
					message: "You don't have permission to edit this video.",
				};
			}
			const metadata = video.metadata ?? {};
			if (
				video.transcriptionStatus === "PROCESSING" ||
				metadata.aiGenerationStatus === "QUEUED" ||
				metadata.aiGenerationStatus === "PROCESSING"
			) {
				return {
					success: false,
					message: "Wait for AI generation to finish before editing.",
				};
			}
			const current = {
				summary: metadata.summary || "",
				chapters: metadata.chapters ?? [],
			};
			if (
				(summaryChanged && current.summary !== expected.summary) ||
				(chaptersChanged && !chaptersEqual(current.chapters, expected.chapters))
			) {
				return {
					success: false,
					message:
						"This content changed since you started editing. Copy your changes, then cancel and reopen the editor to load the latest version.",
				};
			}
			const next = {
				summary: summaryChanged ? value.summary : current.summary,
				chapters: chaptersChanged ? value.chapters : current.chapters,
			};
			const validationError = validateAiContent(next, video.duration);
			if (validationError) return { success: false, message: validationError };
			let updatedMetadata = sql`COALESCE(${videos.metadata}, JSON_OBJECT())`;
			if (summaryChanged) {
				updatedMetadata = sql`JSON_SET(${updatedMetadata}, '$.summary', ${next.summary}, '$.summaryManuallyEdited', CAST('true' AS JSON))`;
			}
			if (chaptersChanged) {
				updatedMetadata = sql`JSON_SET(${updatedMetadata}, '$.chapters', CAST(${JSON.stringify(next.chapters)} AS JSON), '$.chaptersManuallyEdited', CAST('true' AS JSON))`;
			}
			if (summaryChanged || chaptersChanged) {
				await tx
					.update(videos)
					.set({ metadata: updatedMetadata })
					.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
			}
			return { success: true, data: next };
		});
		if (result.success) revalidatePath(`/s/${videoId}`);
		return result;
	} catch (error) {
		console.error("Failed to edit AI content", { videoId, error });
		return {
			success: false,
			message: "Couldn't save your changes. Please try again.",
		};
	}
}
