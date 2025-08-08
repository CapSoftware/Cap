"use server";

import { db } from "@cap/database";
import { comments } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";
import { nanoId } from "@cap/database/helpers";
import { createNotification } from "@/lib/Notification";

export async function newComment(data: {
  content: string;
  videoId: string;
  type: "text" | "emoji";
  parentCommentId: string;
}) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("User not authenticated");
  }

  const content = data.content;
  const videoId = data.videoId;
  const type = data.type;
  const parentCommentId = data.parentCommentId;
  const conditionalType = parentCommentId
    ? "reply"
    : type === "emoji"
    ? "reaction"
    : "comment";

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
    parentCommentId: parentCommentId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db().insert(comments).values(newComment);

  try {
    await createNotification({
      type: conditionalType,
      videoId,
      authorId: user.id,
      comment: { id, content },
    });
  } catch (error) {
    console.error("Failed to create notification:", error);
  }

  // Add author name to the returned data
  const commentWithAuthor = {
    ...newComment,
    authorName: user.name,
    sending: false,
  };

  revalidatePath(`/s/${videoId}`);

  return commentWithAuthor;
}
