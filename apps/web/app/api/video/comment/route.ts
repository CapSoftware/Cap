import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments } from "@cap/database/schema";
import { db } from "@cap/database";
import { rateLimitMiddleware } from "@/utils/helpers";
import { headers } from "next/headers";
import { clientEnv } from "@cap/env";

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

    // Trigger email notification for new comment
    if (type === "text" && userId !== "anonymous") {
      try {
        // Don't await this to avoid blocking the response
        const absoluteUrl = new URL(
          "/api/email/new-comment",
          clientEnv.NEXT_PUBLIC_WEB_URL
        ).toString();
        fetch(absoluteUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            commentId: id,
          }),
        });
      } catch (error) {
        console.error("Error triggering comment notification:", error);
        // Don't fail the comment creation if notification fails
      }
    }

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

export async function GET() {
  return Response.json({ error: true }, { status: 405 });
}
