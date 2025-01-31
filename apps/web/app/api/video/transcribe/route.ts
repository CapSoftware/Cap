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
import { createS3Client } from "@/utils/s3";
import { serverEnv } from "@cap/env";

export const maxDuration = 120;

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
  const videoId = searchParams.get("videoId") || "";
  const origin = request.headers.get("origin") as string;

  if (!serverEnv.DEEPGRAM_API_KEY) {
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

  const query = await db
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
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
    return new Response(
      JSON.stringify({ error: true, message: "Video information is missing" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  const awsRegion = video.awsRegion;
  const awsBucket = video.awsBucket;

  if (!awsRegion || !awsBucket) {
    return new Response(
      JSON.stringify({
        error: true,
        message: "AWS region or bucket information is missing",
      }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }

  if (
    video.transcriptionStatus === "COMPLETE" ||
    video.transcriptionStatus === "PROCESSING"
  ) {
    return new Response(
      JSON.stringify({
        message: "Transcription already completed or in progress",
      }),
      { status: 200, headers: getHeaders(origin) }
    );
  }

  await db
    .update(videos)
    .set({ transcriptionStatus: "PROCESSING" })
    .where(eq(videos.id, videoId));

  const s3Client = await createS3Client(bucket);

  try {
    const videoKey = `${userId}/${videoId}/result.mp4`;

    const videoUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: awsBucket,
        Key: videoKey,
      })
    );

    const transcription = await transcribeAudio(videoUrl);

    if (transcription === "") {
      throw new Error("Failed to transcribe audio");
    }

    const uploadCommand = new PutObjectCommand({
      Bucket: awsBucket,
      Key: `${userId}/${videoId}/transcription.vtt`,
      Body: transcription,
      ContentType: "text/vtt",
    });

    await s3Client.send(uploadCommand);

    await db
      .update(videos)
      .set({ transcriptionStatus: "COMPLETE" })
      .where(eq(videos.id, videoId));

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
        wordCount = 0;
      }
    }
  });

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
  const deepgram = createClient(serverEnv.DEEPGRAM_API_KEY as string);

  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    {
      url: videoUrl,
    },
    {
      model: "nova-2",
      smart_format: true,
      detect_language: true,
      utterances: true,
      mime_type: "video/mp4",
    }
  );

  if (error) {
    return "";
  }

  const captions = formatToWebVTT(result);

  return captions;
}
