"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { comments, notifications } from "@inflight/database/schema";
import type { Comment, Video } from "@inflight/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function deleteComment({
	commentId,
	parentId,
	videoId,
}: {
	commentId: Comment.CommentId;
	parentId: Comment.CommentId | null;
	videoId: Video.VideoId;
}) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("User not authenticated");
	}

	if (!commentId || !videoId) {
		throw new Error("Comment ID and video ID are required");
	}

	try {
		await db().transaction(async (tx) => {
			// First, verify the comment exists and belongs to the current user
			const [existingComment] = await tx
				.select({ id: comments.id })
				.from(comments)
				.where(and(eq(comments.id, commentId), eq(comments.authorId, user.id)))
				.limit(1);

			if (!existingComment) {
				throw new Error(
					"Comment not found or you don't have permission to delete it",
				);
			}

			await tx
				.delete(comments)
				.where(and(eq(comments.id, commentId), eq(comments.authorId, user.id)));

			// Delete related notifications
			if (parentId) {
				await tx
					.delete(notifications)
					.where(
						and(
							eq(notifications.type, "reply"),
							sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
						),
					);
			} else {
				await tx
					.delete(notifications)
					.where(
						and(
							eq(notifications.type, "comment"),
							sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
						),
					);

				await tx
					.delete(notifications)
					.where(
						and(
							eq(notifications.type, "reply"),
							sql`JSON_EXTRACT(${notifications.data}, '$.comment.parentCommentId') = ${commentId}`,
						),
					);
			}
		});

		revalidatePath(`/s/${videoId}`);
		return { success: true };
	} catch (error) {
		console.error("Error deleting comment:", error);
		throw error;
	}
}
