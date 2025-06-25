'use server';

import { getCurrentUser } from "@cap/database/auth/session";
import { createS3Client, getS3Bucket, getS3Config } from "@/utils/s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";
import { nanoId } from "@cap/database/helpers";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

export async function getVideoUploadPresignedUrl({
  fileKey,
  duration,
  resolution,
  videoCodec,
  audioCodec,
}: {
  fileKey: string;
  duration?: string;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
}) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  try {
    const [bucket] = await db()
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    const s3Config = bucket
      ? {
          endpoint: bucket.endpoint || undefined,
          region: bucket.region,
          accessKeyId: bucket.accessKeyId,
          secretAccessKey: bucket.secretAccessKey,
        }
      : null;

    if (
      !bucket ||
      !s3Config ||
      bucket.bucketName !== serverEnv().CAP_AWS_BUCKET
    ) {
      const distributionId = serverEnv().CAP_CLOUDFRONT_DISTRIBUTION_ID;
      if (distributionId) {

        const cloudfront = new CloudFrontClient({
          region: serverEnv().CAP_AWS_REGION || "us-east-1",
          credentials: {
            accessKeyId: serverEnv().CAP_AWS_ACCESS_KEY || "",
            secretAccessKey: serverEnv().CAP_AWS_SECRET_KEY || "",
          },
        });

        const pathToInvalidate = "/" + fileKey;

        try {
          const invalidation = await cloudfront.send(
            new CreateInvalidationCommand({
              DistributionId: distributionId,
              InvalidationBatch: {
                CallerReference: `${Date.now()}`,
                Paths: {
                  Quantity: 1,
                  Items: [pathToInvalidate],
                },
              },
            })
          );
        } catch (error) {
          console.error("Failed to create CloudFront invalidation:", error);
        }
      }
    }

    const [s3Client] = await createS3Client(s3Config);

    const contentType = fileKey.endsWith(".aac")
      ? "audio/aac"
      : fileKey.endsWith(".webm")
      ? "audio/webm"
      : fileKey.endsWith(".mp4")
      ? "video/mp4"
      : fileKey.endsWith(".mp3")
      ? "audio/mpeg"
      : fileKey.endsWith(".m3u8")
      ? "application/x-mpegURL"
      : "video/mp2t";

    const Fields = {
      "Content-Type": contentType,
      "x-amz-meta-userid": user.id,
      "x-amz-meta-duration": duration ?? "",
      "x-amz-meta-resolution": resolution ?? "",
      "x-amz-meta-videocodec": videoCodec ?? "",
      "x-amz-meta-audiocodec": audioCodec ?? "",
    };

    const bucketName = await getS3Bucket(bucket);

    const presignedPostData = await createPresignedPost(s3Client, {
      Bucket: bucketName,
      Key: fileKey,
      Fields,
      Expires: 1800,
    });

    const customEndpoint = serverEnv().CAP_AWS_ENDPOINT;
    if (customEndpoint && !customEndpoint.includes("amazonaws.com")) {
      if (serverEnv().S3_PATH_STYLE) {
        presignedPostData.url = `${customEndpoint}/${bucketName}`;
      } else {
        presignedPostData.url = customEndpoint;
      }
    }

    const videoId = fileKey.split("/")[1];
    if (videoId) {
      try {
        await fetch(`${serverEnv().WEB_URL}/api/revalidate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ videoId }),
        });
      } catch (revalidateError) {
        console.error("Failed to revalidate page:", revalidateError);
      }
    }

    return { presignedPostData };
  } catch (error) {
    console.error("Error getting presigned URL:", error);
    throw new Error(
      error instanceof Error ? error.message : "Failed to get presigned URL"
    );
  }
}

export async function createVideoAndGetUploadUrl({
  videoId,
  duration,
  resolution,
  videoCodec,
  audioCodec,
  isScreenshot = false,
  isUpload = false,
}: {
  videoId?: string;
  duration?: number;
  resolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  isScreenshot?: boolean;
  isUpload?: boolean;
}) {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  try {
    const isUpgraded = user.stripeSubscriptionStatus === "active";

    if (!isUpgraded && duration && duration > 300) {
      throw new Error("upgrade_required");
    }

    const [bucket] = await db()
      .select()
      .from(s3Buckets)
      .where(eq(s3Buckets.ownerId, user.id));

    const s3Config = await getS3Config(bucket);
    const bucketName = await getS3Bucket(bucket);

    const date = new Date();
    const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
      month: "long",
    })} ${date.getFullYear()}`;

    if (videoId) {
      const [existingVideo] = await db()
        .select()
        .from(videos)
        .where(eq(videos.id, videoId));

      if (existingVideo) {
        const fileKey = `${user.id}/${videoId}/${isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"}`;
        const { presignedPostData } = await getVideoUploadPresignedUrl({
          fileKey,
          duration: duration?.toString(),
          resolution,
          videoCodec,
          audioCodec,
        });

        return {
          id: existingVideo.id,
          user_id: user.id,
          aws_region: existingVideo.awsRegion,
          aws_bucket: existingVideo.awsBucket,
          presignedPostData,
        };
      }
    }

    const idToUse = videoId || nanoId();

    const videoData = {
      id: idToUse,
      name: `Cap ${isScreenshot ? "Screenshot" : isUpload ? "Upload" : "Recording"} - ${formattedDate}`,
      ownerId: user.id,
      awsRegion: s3Config.region,
      awsBucket: bucketName,
      source: { type: "desktopMP4" as const },
      isScreenshot,
      bucket: bucket?.id,
    };

    await db().insert(videos).values(videoData);

    const fileKey = `${user.id}/${idToUse}/${isScreenshot ? "screenshot/screen-capture.jpg" : "result.mp4"}`;
    const { presignedPostData } = await getVideoUploadPresignedUrl({
      fileKey,
      duration: duration?.toString(),
      resolution,
      videoCodec,
      audioCodec,
    });

    return {
      id: idToUse,
      user_id: user.id,
      aws_region: s3Config.region,
      aws_bucket: bucketName,
      presignedPostData,
    };
  } catch (error) {
    console.error("Error creating video and getting upload URL:", error);
    throw new Error(
      error instanceof Error ? error.message : "Failed to create video"
    );
  }
}