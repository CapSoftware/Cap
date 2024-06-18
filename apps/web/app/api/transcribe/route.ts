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

    const chunksUrls = await Promise.all(
      (objects.Contents || []).map(async (object) => {
        const url = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          }),
          { expiresIn: 3600 }
        );
        const metadata = await s3Client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: object.Key,
          })
        );

        return {
          url: url,
          duration: metadata?.Metadata?.duration ?? "",
          key: object.Key,
        };
      })
    );

    let elapsedTime = 0;
    const transcriptions = [];
    for (const chunk of chunksUrls) {
      const transcription = await transcribeAudioSegment(chunk, elapsedTime);
      elapsedTime += Number(chunk.duration);
      transcriptions.push(transcription);
    }

    const vttContent =
      "WEBVTT\n\n" +
      transcriptions
        .map((transcription, index) => {
          const end = transcription.end;
          return `${index + 1}\n${formatTimestamp(
            Number(transcription.start)
          )} --> ${formatTimestamp(Number(end))}\n${transcription.text}\n\n`;
        })
        .join("");

    const vttKey = `${userId}/${videoId}/subtitles.vtt`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: vttKey,
        Body: vttContent,
        ContentType: "text/vtt",
      })
    );

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
      JSON.stringify({ error: true, message: "Error processing audio files" }),
      {
        status: 500,
        headers: getHeaders(origin),
      }
    );
  }
}

function formatTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const secs = date.getUTCSeconds().toString().padStart(2, "0");
  const millis = (date.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5);

  return `${hours}:${minutes}:${secs}.${millis}`;
}

async function transcribeAudioSegment(
  chunk: any,
  startTime: number
): Promise<any> {
  const transcription = await transcribeAudio(chunk.url);
  const duration = Number(chunk.duration);

  return {
    start: startTime,
    text: transcription,
    end: startTime + duration,
  };
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
      language: "en-GB",
    }
  );

  if (error) return "";

  return result.results.channels[0].alternatives[0].transcript;
}
