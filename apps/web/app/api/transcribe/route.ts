import { NextRequest } from "next/server";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@deepgram/sdk";
import { getHeaders } from "@/utils/helpers";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";

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

  if (
    !process.env.CAP_AWS_BUCKET ||
    !process.env.CAP_AWS_REGION ||
    !process.env.CAP_AWS_ACCESS_KEY ||
    !process.env.CAP_AWS_SECRET_KEY ||
    !process.env.DEEPGRAM_API_KEY
  ) {
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

  if (
    video.transcriptionStatus === "COMPLETE" ||
    video.transcriptionStatus === "PROCESSING"
  ) {
    return new Response(
      JSON.stringify({
        message: "Transcription already completed or in progress",
      }),
      {
        status: 200,
        headers: getHeaders(origin),
      }
    );
  }

  await db
    .update(videos)
    .set({ transcriptionStatus: "PROCESSING" })
    .where(eq(videos.id, videoId));

  const bucket = process.env.CAP_AWS_BUCKET || "";
  const audioPrefix = `${userId}/${videoId}/audio/`;

  const s3Client = new S3Client({
    region: process.env.CAP_AWS_REGION || "",
    credentials: {
      accessKeyId: process.env.CAP_AWS_ACCESS_KEY || "",
      secretAccessKey: process.env.CAP_AWS_SECRET_KEY || "",
    },
  });

  try {
    const audioSegmentCommand = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: audioPrefix,
    });

    const objects = await s3Client.send(audioSegmentCommand);

    const audioFiles = await Promise.all(
      (objects.Contents || []).map(async (object) => {
        const presignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          })
        );

        return presignedUrl;
      })
    );

    const uploadUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${userId}/${videoId}/merged/audio.mp3`,
      })
    );

    const tasksServerResponse = await fetch(
      `${process.env.NEXT_PUBLIC_TASKS_URL}/api/v1/merge-audio-segments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          videoId,
          segments: audioFiles,
          uploadUrl,
        }),
      }
    );

    if (tasksServerResponse.status !== 200) {
      throw new Error("Failed to merge audio segments");
    }

    const uploadedFileUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: `${userId}/${videoId}/merged/audio.mp3`,
      })
    );

    const transcription = await transcribeAudio(uploadedFileUrl);

    if (transcription === "") {
      throw new Error("Failed to transcribe audio");
    }

    const uploadCommand = new PutObjectCommand({
      Bucket: bucket,
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
    console.error("Error processing audio files", error);
    await db
      .update(videos)
      .set({ transcriptionStatus: "ERROR" })
      .where(eq(videos.id, videoId));

    return new Response(
      JSON.stringify({ error: true, message: "Error processing audio files" }),
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
    let words = utterance.words;
    let group = [];
    let start = formatTimestamp(words[0].start);
    let wordCount = 0;

    for (let i = 0; i < words.length; i++) {
      let word = words[i];
      group.push(word.word);
      wordCount++;

      if (
        word.punctuated_word.endsWith(",") ||
        word.punctuated_word.endsWith(".") ||
        (words[i + 1] && words[i + 1].start - word.end > 0.5) ||
        wordCount === 8
      ) {
        let end = formatTimestamp(word.end);
        let groupText = group.join(" ");

        output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
        captionIndex++;

        group = [];
        start = words[i + 1] ? formatTimestamp(words[i + 1].start) : start;
        wordCount = 0; // Reset the counter for the next group
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

async function transcribeAudio(audioUrl: string): Promise<string> {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY as string);

  const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
    {
      url: audioUrl,
    },
    {
      model: "nova-2",
      smart_format: true,
      detect_language: true,
      utterances: true,
    }
  );

  if (error) return "";

  const captions = formatToWebVTT(result);

  return captions;
}
