import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { createS3Client, getS3Bucket } from "@/utils/s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3_BUCKET_URL } from "@cap/utils";
import { clientEnv } from "@cap/env";

export async function getScreenshot(userId: string, screenshotId: string) {
  if (!userId || !screenshotId) {
    throw new Error("userId or screenshotId not supplied");
  }

  const query = await db
    .select({ video: videos, bucket: s3Buckets })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, screenshotId));

  if (query.length === 0) {
    throw new Error("Video does not exist");
  }

  const result = query[0];
  if (!result?.video) {
    throw new Error("Video not found");
  }

  const { video, bucket } = result;

  if (video.public === false) {
    const user = await getCurrentUser();

    if (!user || user.id !== video.ownerId) {
      throw new Error("Video is not public");
    }
  }

  const Bucket = await getS3Bucket(bucket);
  const screenshotPrefix = `${userId}/${screenshotId}/`;

  try {
    const [s3Client] = await createS3Client(bucket);

    const objectsCommand = new ListObjectsV2Command({
      Bucket,
      Prefix: screenshotPrefix,
    });

    const objects = await s3Client.send(objectsCommand);

    const screenshot = objects.Contents?.find((object) =>
      object.Key?.endsWith(".png")
    );

    if (!screenshot) {
      throw new Error("Screenshot not found");
    }

    let screenshotUrl: string;

    if (video.awsBucket !== clientEnv.NEXT_PUBLIC_CAP_AWS_BUCKET) {
      screenshotUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket,
          Key: screenshot.Key,
        }),
        { expiresIn: 3600 }
      );
    } else {
      screenshotUrl = `${S3_BUCKET_URL}/${screenshot.Key}`;
    }

    return { url: screenshotUrl };
  } catch (error) {
    throw new Error(`Error generating screenshot URL: ${error}`);
  }
} 