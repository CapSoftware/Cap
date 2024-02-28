import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const awsRegion = process.env.CAP_AWS_REGION;
  const awsBucket = process.env.CAP_AWS_BUCKET;

  const allowedOrigins = [
    process.env.NEXT_PUBLIC_URL,
    "tauri://localhost",
    "http://localhost:3001",
  ];
  const requestOrigin = req.headers.get("origin") || "";
  const allowedOrigin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : false;

  if (!user) {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...(allowedOrigin && { "Access-Control-Allow-Origin": allowedOrigin }),
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  const id = nanoId();

  await db.insert(videos).values({
    id: id,
    ownerId: user.userId,
    awsRegion: awsRegion,
    awsBucket: awsBucket,
  });

  return new Response(
    JSON.stringify({
      id: id,
      user_id: user.userId,
      aws_region: awsRegion,
      aws_bucket: awsBucket,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...(allowedOrigin && { "Access-Control-Allow-Origin": allowedOrigin }),
        "Access-Control-Allow-Credentials": "true",
      },
    }
  );
}
