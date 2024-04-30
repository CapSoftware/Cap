import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments } from "@cap/database/schema";
import { db } from "@cap/database";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  const { type, content, videoId, timestamp, parentCommentId } =
    await request.json();
  const userId = user?.id as string;

  if (!type || !content || !videoId) {
    console.error("Missing required data in /api/video/comment/route.ts");

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  const id = nanoId();

  await db.insert(comments).values({
    id: id,
    authorId: userId ?? "anonymous",
    type: type,
    content: content,
    videoId: videoId,
    timestamp: timestamp || null,
    parentCommentId: parentCommentId || null,
  });

  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
