import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  const allowedOrigins = [
    process.env.NEXT_PUBLIC_URL,
    "http://localhost:3001",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ];

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization",
    },
  });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const awsRegion = process.env.CAP_AWS_REGION;
  const awsBucket = process.env.CAP_AWS_BUCKET;
  const origin = req.nextUrl.origin;

  if (!user) {
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization",
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
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization",
      },
    }
  );
}
