"use server";

import { db } from "@cap/database";
import { comments } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";
import { eq, and } from "drizzle-orm";

export async function deleteComment({
  commentId,
  videoId,
}: {
  commentId: string;
  videoId: string;
}) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("User not authenticated");
  }

  if (!commentId || !videoId) {
    throw new Error("Comment ID and video ID are required");
  }

  // First, verify the comment exists and belongs to the current user
  const existingComment = await db()
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.authorId, user.id)))
    .limit(1);

  if (existingComment.length === 0) {
    throw new Error(
      "Comment not found or you don't have permission to delete it"
    );
  }

  // Delete the comment
  await db()
    .delete(comments)
    .where(and(eq(comments.id, commentId), eq(comments.authorId, user.id)));

  revalidatePath(`/s/${videoId}`);

  return { success: true, commentId };
}
