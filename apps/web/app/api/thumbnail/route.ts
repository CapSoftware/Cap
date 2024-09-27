import { type NextRequest } from "next/server";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getHeaders } from "@/utils/helpers";

export const revalidate = 3500;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const userId = searchParams.get("userId");
  const videoId = searchParams.get("videoId");
  const origin = request.headers.get("origin") as string;

  if (!userId || !videoId) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "userId or videoId not supplied",
      }),
      {
        status: 400,
        headers: getHeaders(origin),
      }
    );
  }

  const s3Client = new S3Client({
    region: process.env.NEXT_PUBLIC_CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
    },
  });

  const bucket = process.env.NEXT_PUBLIC_CAP_AWS_BUCKET || "";
  const prefix = `${userId}/${videoId}/`;

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    });

    const listResponse = await s3Client.send(listCommand);
    const contents = listResponse.Contents || [];

    let thumbnailKey = contents.find(item => item.Key?.endsWith('.png'))?.Key;

    if (!thumbnailKey) {
      thumbnailKey = `${prefix}screenshot/screen-capture.jpg`;
    }

    const thumbnailUrl = `https://v.cap.so/${thumbnailKey}`;

    return new Response(
      JSON.stringify({ screen: thumbnailUrl }),
      {
        status: 200,
        headers: getHeaders(origin),
      }
    );
  } catch (error) {
    console.error("Error generating thumbnail URL:", error);
    return new Response(
      JSON.stringify({ error: true, message: "Error generating thumbnail URL" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}
