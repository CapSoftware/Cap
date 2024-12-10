import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments } from "@cap/database/schema";
import { db } from "@cap/database";
import { rateLimitMiddleware } from "@/utils/helpers";
import { headers } from "next/headers";

async function handlePost(request: NextRequest) {
  const user = await getCurrentUser();
  const { type, content, videoId, timestamp, parentCommentId } =
    await request.json();

  const userId = user?.id || "anonymous";
  const parentCommentIdSanitized = parentCommentId
    ? parentCommentId.replace("temp-", "")
    : null;

  if (!type || !content || !videoId) {
    console.error("Missing required data in /api/video/comment/route.ts");

    return Response.json(
      {
        error: true,
        message: "Missing required fields: type, content, or videoId",
      },
      { status: 400 }
    );
  }

  const id = nanoId();

  try {
    const newComment = {
      id: id,
      authorId: userId,
      type: type,
      content: content,
      videoId: videoId,
      timestamp: timestamp || null,
      parentCommentId: parentCommentIdSanitized || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(comments).values(newComment);

    return Response.json(
      {
        ...newComment,
        authorName: user?.name || "Anonymous",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error creating comment:", error);
    return Response.json(
      {
        error: true,
        message: "Failed to create comment",
      },
      { status: 500 }
    );
  }
}

export const POST = (request: NextRequest) => {
  const headersList = headers();
  return rateLimitMiddleware(10, handlePost(request), headersList);
};
