import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  MediaConvertClient,
  GetJobCommand,
} from "@aws-sdk/client-mediaconvert";
import { serverEnv, clientEnv } from "@cap/env";

const allowedOrigins = [
  clientEnv.NEXT_PUBLIC_WEB_URL,
  "http://localhost:3001",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "https://cap.link",
  "https://cap.so",
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

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const videoId = searchParams.get("videoId") || "";
  const userId = searchParams.get("userId") || "";
  const origin = request.headers.get("origin") as string;

  if (!videoId || !userId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "videoId not supplied or user not logged in",
      }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const video = query[0];
  if (!video) {
    return new Response(
      JSON.stringify({ error: true, message: "Video not found" }),
      {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const jobId = video.jobId;

  if (!jobId) {
    return new Response(
      JSON.stringify({ error: true, message: "Job ID not found" }),
      {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }

  const mediaConvertClient = new MediaConvertClient({
    region: clientEnv.NEXT_PUBLIC_CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: serverEnv.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: serverEnv.CAP_AWS_SECRET_KEY || "",
    },
  });

  try {
    const getJobCommand = new GetJobCommand({
      Id: jobId,
    });

    const jobResponse = await mediaConvertClient.send(getJobCommand);
    const jobStatus = jobResponse.Job?.Status;

    await db.update(videos).set({ jobStatus }).where(eq(videos.id, videoId));

    return new Response(JSON.stringify({ jobStatus: jobStatus }), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
          ? origin
          : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  } catch (error) {
    console.error("Error checking MediaConvert job status", error);
    return new Response(
      JSON.stringify({ error: error, message: "Error checking job status" }),
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
            ? origin
            : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      }
    );
  }
}
