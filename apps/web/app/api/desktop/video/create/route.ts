import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { s3Buckets, videos, users } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { cookies } from "next/headers";
import { dub } from "@/utils/dub";
import { eq } from "drizzle-orm";
import { getS3Bucket, getS3Config } from "@/utils/s3";
import { clientEnv, NODE_ENV } from "@cap/env";

const allowedOrigins = [
  clientEnv.NEXT_PUBLIC_WEB_URL,
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
  const duration = params.get("duration")
    ? parseFloat(params.get("duration")!)
    : null;

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

  // Check if user is on free plan and video is over 5 minutes
  const isUpgraded = user.stripeSubscriptionStatus === "active";

  if (!isUpgraded && duration && duration > 300) {
    return new Response(JSON.stringify({ error: "upgrade_required" }), {
      status: 403,
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

  const s3Config = await getS3Config(bucket);
  const bucketName = await getS3Bucket(bucket);

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
          "Access-Control-Allow-Headers":
            "Authorization, sentry-trace, baggage",
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
          "Access-Control-Allow-Headers":
            "Authorization, sentry-trace, baggage",
        },
      }
    );
  }

  const videoData = {
    id: id,
    name: `Cap ${isScreenshot ? "Screenshot" : "Recording"} - ${formattedDate}`,
    ownerId: user.id,
    awsRegion: s3Config.region,
    awsBucket: bucketName,
    source:
      recordingMode === "hls"
        ? { type: "local" as const }
        : recordingMode === "desktopMP4"
        ? { type: "desktopMP4" as const }
        : undefined,
    isScreenshot,
    bucket: bucket?.id,
  };

  await db.insert(videos).values(videoData);

  if (clientEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
    await dub.links.create({
      url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/s/${id}`,
      domain: "cap.link",
      key: id,
    });
  }

  return new Response(
    JSON.stringify({
      id,
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
