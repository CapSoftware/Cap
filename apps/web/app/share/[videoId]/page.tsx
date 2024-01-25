"use server";
import { Share } from "./Share";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { videos } from "@cap/database/schema";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

const revalidate = 0;

const s3Client = new S3Client({
  region: process.env.CAP_AWS_REGION || "",
  credentials: {
    accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
    secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
  },
});

async function generateVideoSegmentUrls(userId: string, videoId: string) {
  const bucket = process.env.CAP_AWS_BUCKET || "";
  const outputScreenKey = `${userId}/${videoId}/screen_output.mp4`;
  const outputVideoKey = `${userId}/${videoId}/video_output.mp4`;

  // Prefixes for screen and video segments
  const screenPrefix = `${userId}/${videoId}/screen/`;
  const videoPrefix = `${userId}/${videoId}/video/`;

  const checkSingleOutputsExist = async (key: string) => {
    try {
      const headObjectCommand = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      await s3Client.send(headObjectCommand);
      return true;
    } catch (error: any) {
      if (error?.name === "NotFound") return false;
      throw error;
    }
  };

  const doesScreenOutputExist = await checkSingleOutputsExist(outputScreenKey);
  const doesVideoOutputExist = await checkSingleOutputsExist(outputVideoKey);

  if (doesScreenOutputExist && doesVideoOutputExist) {
    // Return pre-signed URLs for the single output files
    const screenOutputUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: outputScreenKey,
      })
    );

    const videoOutputUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: outputVideoKey,
      })
    );

    return {
      singleScreenUrl: screenOutputUrl,
      singleVideoUrl: videoOutputUrl,
      screenChunksUrls: [],
      videoChunksUrls: [],
    };
  }

  try {
    // Fetch the list of objects for screen recordings
    const screenObjectsCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: screenPrefix,
    });
    const screenObjects = await s3Client.send(screenObjectsCommand);

    // Fetch the list of objects for video recordings
    const videoObjectsCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: videoPrefix,
    });
    const videoObjects = await s3Client.send(videoObjectsCommand);

    // Generate pre-signed URLs for screen recording chunks
    const screenChunksUrls = await Promise.all(
      (screenObjects.Contents || []).map(async (object) => {
        return getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          }),
          { expiresIn: 3600 }
        );
      })
    );

    // Generate pre-signed URLs for video recording chunks
    const videoChunksUrls = await Promise.all(
      (videoObjects.Contents || []).map(async (object) => {
        return getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          }),
          { expiresIn: 3600 }
        );
      })
    );

    return {
      screenChunksUrls,
      videoChunksUrls,
      singleScreenUrl: "",
      singleVideoUrl: "",
    };
  } catch (error) {
    console.error("Error generating video segment URLs", error);
    throw new Error("Could not generate video segment URLs");
  }
}

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;

  console.log("videoId: ", videoId);

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  console.log("query", query);

  if (query.length === 0) {
    return <p>No video found</p>;
  }

  const video = query[0];

  const urls = await generateVideoSegmentUrls(video.ownerId, video.id);

  const videoUrls = urls.videoChunksUrls || [];
  const screenUrls = urls.screenChunksUrls || [];
  const singleVideoUrl = urls.singleVideoUrl || "";
  const singleScreenUrl = urls.singleScreenUrl || "";

  return (
    <Share
      data={video}
      urls={{ videoUrls, screenUrls, singleScreenUrl, singleVideoUrl }}
    />
  );
}
