import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  S3Client,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { getHeaders } from "@/utils/helpers";

export const revalidate = 3599;

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin") as string;

  return new Response(null, {
    status: 200,
    headers: getHeaders(origin),
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("userId") || "";
  const videoId = searchParams.get("screenshotId") || "";
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const video = query[0];

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.id !== video.ownerId) {
      return new Response(
        JSON.stringify({ error: true, message: "Video is not public" }),
        {
          status: 401,
          headers: getHeaders(origin),
        }
      );
    }
  }

  const bucket = process.env.NEXT_PUBLIC_CAP_AWS_BUCKET || "";
  const screenshotPrefix = `${userId}/${videoId}/`;

  try {
    const s3Client = new S3Client({
      region: process.env.NEXT_PUBLIC_CAP_AWS_REGION || "",
      credentials: {
        accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
        secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
      },
    });

    const objectsCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: screenshotPrefix,
      MaxKeys: 1,
    });

    const objects = await s3Client.send(objectsCommand);

    const screenshot = objects.Contents?.find((object) =>
      object.Key?.endsWith(".png")
    );

    if (!screenshot) {
      return new Response(
        JSON.stringify({ error: true, message: "Screenshot not found" }),
        {
          status: 404,
          headers: getHeaders(origin),
        }
      );
    }

    const screenshotUrl = `https://v.cap.so/${screenshot.Key}`;

    return new Response(
      JSON.stringify({ url: screenshotUrl }),
      {
        status: 200,
        headers: getHeaders(origin),
      }
    );
  } catch (error) {
    console.error("Error generating screenshot URL", error);
    return new Response(
      JSON.stringify({ error: error, message: "Error generating screenshot URL" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}