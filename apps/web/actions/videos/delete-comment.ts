"use server";

import { db } from "@cap/database";
import { comments, notifications } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";
import { eq, and, sql } from "drizzle-orm";

export async function deleteComment({
  commentId,
  parentId,
  videoId,
}: {
  commentId: string;
  parentId?: string;
  videoId: string;
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
          "Comment not found or you don't have permission to delete it"
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
              sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`
            )
          );
      } else {
        await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.type, "comment"),
              sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`
            )
          );

        await tx
          .delete(notifications)
          .where(
            and(
              eq(notifications.type, "reply"),
              sql`JSON_EXTRACT(${notifications.data}, '$.comment.parentCommentId') = ${commentId}`
            )
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
