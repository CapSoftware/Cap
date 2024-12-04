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
  const parentCommentIdSanitized = parentCommentId ? parentCommentId.replace("temp-", "") : null;

  console.log("type", type);
  console.log("content", content);
  console.log("videoId", videoId);
  console.log("timestamp", timestamp);
  console.log("parentCommentIdSanitized", parentCommentIdSanitized);

  if (!type || !content || !videoId) {
    console.error("Missing required data in /api/video/comment/route.ts");

    return new Response(JSON.stringify({ 
      error: true,
      message: "Missing required fields: type, content, or videoId" 
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const id = nanoId();

  try {
    await db.insert(comments).values({
      id: id,
      authorId: userId,
      type: type,
      content: content,
      videoId: videoId,
      timestamp: timestamp || null,
      parentCommentId: parentCommentIdSanitized || null,
    });

    return new Response(
      JSON.stringify({
        success: true,
        commentId: id
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error creating comment:", error);
    return new Response(
      JSON.stringify({ 
        error: true,
        message: "Failed to create comment" 
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}

export const POST = (request: NextRequest) => {
  const headersList = headers();
  return rateLimitMiddleware(10, handlePost(request), headersList);
};
