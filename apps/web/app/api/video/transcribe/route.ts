import type { NextRequest } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@deepgram/sdk";
import { getHeaders } from "@/utils/helpers";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { createS3Client, getS3Bucket } from "@/utils/s3";

export const maxDuration = 120;

export async function OPTIONS(request: NextRequest) {
  console.log("OPTIONS request received");
  const origin = request.headers.get("origin") as string;

  return new Response(null, {
    status: 200,
    headers: getHeaders(origin),
  });
}

export async function GET(request: NextRequest) {
  console.log("Transcription request received");
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("userId") || "";
  const videoId = searchParams.get("videoId") || "";
  const origin = request.headers.get("origin") as string;

  console.log(`UserId: ${userId}, VideoId: ${videoId}`);

  if (
    !process.env.NEXT_PUBLIC_CAP_AWS_BUCKET ||
    !process.env.NEXT_PUBLIC_CAP_AWS_REGION ||
    !process.env.CAP_AWS_ACCESS_KEY ||
    !process.env.CAP_AWS_SECRET_KEY ||
    !process.env.DEEPGRAM_API_KEY
  ) {
    console.error("Missing necessary environment variables");
    return new Response(
      JSON.stringify({
        error: true,
        message: "Missing necessary environment variables",
      }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  if (!userId || !videoId) {
    console.error("userId or videoId not supplied");
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

  console.log("Querying database for video");
  const query = await db
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  console.log("Database query result:", query);

  if (query.length === 0) {
    console.error("Video does not exist");
    return new Response(
      JSON.stringify({ error: true, message: "Video does not exist" }),
      {
        status: 401,
        headers: getHeaders(origin),
      }
    );
  }

  const result = query[0];
  if (!result || !result.video) {
    console.error("Video information is missing");
    return new Response(
      JSON.stringify({ error: true, message: "Video information is missing" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  const { video, bucket } = result;

  if (!video) {
    console.error("Video information is missing");
    return new Response(
      JSON.stringify({ error: true, message: "Video information is missing" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  // Use the awsRegion and awsBucket from the video object
  const awsRegion = video.awsRegion;
  const awsBucket = video.awsBucket;

  if (!awsRegion || !awsBucket) {
    console.error("AWS region or bucket information is missing");
    return new Response(
      JSON.stringify({ error: true, message: "AWS region or bucket information is missing" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  console.log("Video and bucket information:", { video, bucket });

  if (
    video.transcriptionStatus === "COMPLETE" ||
    video.transcriptionStatus === "PROCESSING"
  ) {
    console.log("Transcription already completed or in progress");
    return new Response(
      JSON.stringify({
        message: "Transcription already completed or in progress",
      }),
      { status: 200, headers: getHeaders(origin) }
    );
  }

  console.log("Updating transcription status to PROCESSING");
  await db
    .update(videos)
    .set({ transcriptionStatus: "PROCESSING" })
    .where(eq(videos.id, videoId));

  const Bucket = getS3Bucket(awsBucket);
  console.log("S3 Bucket:", Bucket);

  console.log("Creating S3 client");
  const s3Client = createS3Client(awsBucket);

  try {
    const videoKey = `${userId}/${videoId}/result.mp4`;
    console.log("Video key:", videoKey);

    console.log("Getting signed URL for video");
    const videoUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket,
        Key: videoKey,
      })
    );
    console.log("Signed URL obtained");

    console.log("Transcribing audio");
    const transcription = await transcribeAudio(videoUrl);

    if (transcription === "") {
      throw new Error("Failed to transcribe audio");
    }

    console.log("Uploading transcription");
    const uploadCommand = new PutObjectCommand({
      Bucket,
      Key: `${userId}/${videoId}/transcription.vtt`,
      Body: transcription,
      ContentType: "text/vtt",
    });

    await s3Client.send(uploadCommand);
    console.log("Transcription uploaded successfully");

    console.log("Updating transcription status to COMPLETE");
    await db
      .update(videos)
      .set({ transcriptionStatus: "COMPLETE" })
      .where(eq(videos.id, videoId));

    console.log("Transcription process completed successfully");
    return new Response(
      JSON.stringify({
        message: "VTT file generated and uploaded successfully",
      }),
      {
        status: 200,
        headers: getHeaders(origin),
      }
    );
  } catch (error) {
    console.error("Error processing video file", error);
    await db
      .update(videos)
      .set({ transcriptionStatus: "ERROR" })
      .where(eq(videos.id, videoId));

    return new Response(
      JSON.stringify({ error: true, message: "Error processing video file" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}

function formatToWebVTT(result: any): string {
  console.log("Formatting transcription to WebVTT");
  let output = "WEBVTT\n\n";
  let captionIndex = 1;

  result.results.utterances.forEach((utterance: any) => {
    const words = utterance.words;
    let group = [];
    let start = formatTimestamp(words[0].start);
    let wordCount = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      group.push(word.word);
      wordCount++;

      if (
        word.punctuated_word.endsWith(",") ||
        word.punctuated_word.endsWith(".") ||
        (words[i + 1] && words[i + 1].start - word.end > 0.5) ||
        wordCount === 8
      ) {
        const end = formatTimestamp(word.end);
        const groupText = group.join(" ");

        output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
        captionIndex++;

        group = [];
        start = words[i + 1] ? formatTimestamp(words[i + 1].start) : start;
        wordCount = 0; // Reset the counter for the next group
      }
    }
  });

  console.log("WebVTT formatting completed");
  return output;
}

function formatTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const secs = date.getUTCSeconds().toString().padStart(2, "0");
  const millis = (date.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5);

  return `${hours}:${minutes}:${secs}.${millis}`;
}

async function transcribeAudio(videoUrl: string): Promise<string> {
  console.log("Starting audio transcription");
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY as string);

  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    {
      url: videoUrl,
    },
    {
      model: "nova-2",
      smart_format: true,
      detect_language: true,
      utterances: true,
      mime_type: "video/mp4", // Specify the MIME type for MP4 video
    }
  );

  if (error) {
    console.error("Transcription error:", error);
    return "";
  }

  console.log("Transcription completed successfully");
  const captions = formatToWebVTT(result);

  return captions;
}
