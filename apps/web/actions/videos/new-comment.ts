"use server";

import { db } from "@cap/database";
import { comments } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";
import { nanoId } from "@cap/database/helpers";

export async function newComment(formData: FormData) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("User not authenticated");
  }

  const content = formData.get("content") as string;
  const videoId = formData.get("videoId") as string;
  const type = formData.get("type") as "text" | "emoji";

  if (!content || !videoId) {
    throw new Error("Content and videoId are required");
  }
  const id = nanoId();

  const newComment = {
    id: id,
    authorId: user.id,
    type: type,
    content: content,
    videoId: videoId,
    timestamp: null,
    parentCommentId: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db().insert(comments).values(newComment);

  // Add author name to the returned data
  const commentWithAuthor = {
    ...newComment,
    authorName: user.name,
    sending: false,
  };

  revalidatePath(`/s/${videoId}`);

  return commentWithAuthor;
}
