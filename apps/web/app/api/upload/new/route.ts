import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost, PresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest } from "next/server";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY || "",
    secretAccessKey: process.env.AWS_SECRET_KEY || "",
  },
});

export async function POST(request: NextRequest) {
  try {
    const { userId, fileKey, awsBucket, awsRegion } = await request.json();

    if (!userId || !fileKey || !awsBucket || !awsRegion) {
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

    const Fields = {
      "x-amz-meta-userid": userId,
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
