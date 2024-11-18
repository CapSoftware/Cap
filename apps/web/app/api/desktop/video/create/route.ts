import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { cookies } from "next/headers";
import { dub } from "@/utils/dub";
import { eq } from "drizzle-orm";
import { getS3Bucket, getS3Config } from "@/utils/s3";

const allowedOrigins = [
  process.env.NEXT_PUBLIC_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

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
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
}

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.split(" ")[1];
  if (token) {
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  }

  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  const user = await getCurrentUser();
  console.log("/api/desktop/video/create user", user);

  if (!user) {
    console.log("User not authenticated, returning 401");
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
      },
    });
  }

  const recordingMode: "hls" | "desktopMP4" | null = params.get(
    "recordingMode"
  ) as any;
  const isScreenshot = params.get("isScreenshot") === "true";

  const [bucket] = await db
    .select()
    .from(s3Buckets)
    .where(eq(s3Buckets.ownerId, user.id));

  const s3Config = getS3Config(bucket);
  const bucketName = getS3Bucket(bucket);

  const id = nanoId();
  const date = new Date();
  const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
    month: "long",
  })} ${date.getFullYear()}`;

  const videoId = params.get("videoId");

  if (videoId) {
    const [video] = await db
      .select()
      .from(videos)
      .where(eq(videos.id, videoId));

    if (!video) {
      return new Response(JSON.stringify({ error: "Video not found" }), {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
        },
      });
    }

    return new Response(
      JSON.stringify({
        id: video.id,
        user_id: user.id,
        aws_region: video.awsRegion,
        aws_bucket: video.awsBucket,
      }),
      {
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
          "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
        },
      }
    );
  }

  await db.insert(videos).values({
    id: id,
    name: `Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`,
    ownerId: user.id,
    awsRegion: s3Config.region,
    awsBucket: bucketName,
    source:
      recordingMode === "hls"
        ? { type: "local" }
        : recordingMode === "desktopMP4"
        ? { type: "desktopMP4" }
        : undefined,
    isScreenshot: isScreenshot,
    bucket: bucket?.id,
  });

  if (
    process.env.NEXT_PUBLIC_IS_CAP &&
    process.env.NEXT_PUBLIC_ENVIRONMENT === "production"
  ) {
    await dub.links.create({
      url: `${process.env.NEXT_PUBLIC_URL}/s/${id}`,
      domain: "cap.link",
      key: id,
    });
  }

  return new Response(
    JSON.stringify({
      id: id,
      user_id: user.id,
      aws_region: s3Config.region,
      aws_bucket: bucketName,
    }),
    {
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
        "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
      },
    }
  );
}
