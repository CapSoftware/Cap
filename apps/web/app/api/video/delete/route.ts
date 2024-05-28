import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { db } from "@cap/database";
import { and, eq } from "drizzle-orm";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  const { searchParams } = request.nextUrl;
  const videoId = searchParams.get("videoId") || "";
  const userId = user?.id as string;

  if (!videoId || !userId) {
    console.error("Missing required data in /api/video/delete/route.ts");

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  await db
    .delete(videos)
    .where(and(eq(videos.id, videoId), eq(videos.ownerId, userId)));

  const s3Client = new S3Client({
    region: process.env.CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
    },
  });

  const bucket = process.env.CAP_AWS_BUCKET || "";
  const prefix = `${userId}/${videoId}/`;

  const listObjectsCommand = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  });

  const listedObjects = await s3Client.send(listObjectsCommand);

  if (listedObjects.Contents?.length) {
    const deleteObjectsCommand = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: listedObjects.Contents.map((content) => ({
          Key: content.Key,
        })),
      },
    });

    await s3Client.send(deleteObjectsCommand);
  }

  return new Response(
    JSON.stringify({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}
