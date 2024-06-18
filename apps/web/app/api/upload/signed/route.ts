import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost, PresignedPost } from "@aws-sdk/s3-presigned-post";
import { NextRequest } from "next/server";

const s3Client = new S3Client({
  region: process.env.CAP_AWS_REGION || "",
  credentials: {
    accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
    secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
  },
});

export async function POST(request: NextRequest) {
  try {
    const {
      userId,
      fileKey,
      duration,
      bandwidth,
      resolution,
      videoCodec,
      audioCodec,
      awsBucket,
      awsRegion,
    } = await request.json();

    if (!userId || !fileKey || !awsBucket || !awsRegion) {
      console.error("Missing required fields in /api/upload/signed/route.ts");

      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    const contentType = fileKey.endsWith(".aac")
      ? "audio/aac"
      : fileKey.endsWith(".webm")
      ? "audio/webm"
      : fileKey.endsWith(".mp4")
      ? "video/mp4"
      : fileKey.endsWith(".mp3")
      ? "audio/mpeg"
      : "video/mp2t";

    const Fields = {
      "Content-Type": contentType,
      "x-amz-meta-userid": userId,
      "x-amz-meta-duration": duration ?? "",
      "x-amz-meta-bandwidth": bandwidth ?? "",
      "x-amz-meta-resolution": resolution ?? "",
      "x-amz-meta-videocodec": videoCodec ?? "",
      "x-amz-meta-audiocodec": audioCodec ?? "",
    };

    const presignedPostData: PresignedPost = await createPresignedPost(
      s3Client,
      {
        Bucket: awsBucket,
        Key: fileKey,
        Fields,
        Expires: 1800,
      }
    );

    console.log("Presigned URL created successfully");

    return new Response(JSON.stringify({ presignedPostData }), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating presigned URL", error);
    return new Response(
      JSON.stringify({ error: "Error creating presigned URL" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
