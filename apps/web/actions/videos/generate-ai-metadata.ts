"use server";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";
import { createS3Client } from "@/utils/s3";

export async function generateAiMetadata(videoId: string, userId: string) {
  if (!serverEnv().OPENAI_API_KEY) return;

  const query = await db()
    .select({ video: videos, bucket: s3Buckets })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) return;

  const { video, bucket } = query[0];
  if (!video) return;

  const awsBucket = video.awsBucket;
  if (!awsBucket) return;

  const [s3Client] = await createS3Client(bucket);
  const transcriptUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: awsBucket,
      Key: `${userId}/${videoId}/transcription.vtt`,
    })
  );

  const res = await fetch(transcriptUrl);
  const vtt = await res.text();

  const transcriptText = vtt
    .split("\n")
    .filter(
      (l) =>
        l.trim() &&
        l !== "WEBVTT" &&
        !/^\d+$/.test(l.trim()) &&
        !l.includes("-->")
    )
    .join(" ");

  const prompt = `You are Cap AI. Summarize the transcript and provide JSON in the following format:\n{\n  "title": "string",\n  "summary": "string",\n  "chapters": [{"title": "string", "start": number}]\n}\nTranscript:\n${transcriptText}`;

  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const aiJson = await aiRes.json();
  const content = aiJson.choices?.[0]?.message?.content || "{}";
  let data: { title?: string; summary?: string; chapters?: { title: string; start: number }[] } = {};
  try {
    data = JSON.parse(content);
  } catch {}

  const currentMetadata: VideoMetadata = (video.metadata as VideoMetadata) || {};
  const updatedMetadata: VideoMetadata = {
    ...currentMetadata,
    aiTitle: data.title || currentMetadata.aiTitle,
    summary: data.summary || currentMetadata.summary,
    chapters: data.chapters || currentMetadata.chapters,
  };

  await db()
    .update(videos)
    .set({ metadata: updatedMetadata })
    .where(eq(videos.id, videoId));
}
