"use server";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "@cap/database";
import { s3Buckets, videos, users } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";
import { createS3Client } from "@/utils/s3";
import { isAiGenerationEnabled } from "@/utils/flags";

export async function generateAiMetadata(videoId: string, userId: string) {
  
  if (!serverEnv().OPENAI_API_KEY) {
    console.error("[generateAiMetadata] Missing OpenAI API key, skipping AI metadata generation");
    return;
  }
  const userQuery = await db()
    .select({ 
      email: users.email, 
      stripeSubscriptionStatus: users.stripeSubscriptionStatus 
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (userQuery.length === 0 || !userQuery[0]) {
    console.error(`[generateAiMetadata] User ${userId} not found for feature flag check`);
    return;
  }

  const user = userQuery[0];
  if (!isAiGenerationEnabled(user)) {
    return;
  }
  const videoQuery = await db()
    .select({ video: videos })
    .from(videos)
    .where(eq(videos.id, videoId));

  if (videoQuery.length === 0 || !videoQuery[0]?.video) {
    console.error(`[generateAiMetadata] Video ${videoId} not found in database`);
    return;
  }
  
  const videoData = videoQuery[0].video;
  const metadata = videoData.metadata as VideoMetadata || {};
  
  if (metadata.aiProcessing === true) {
    
    const updatedAtTime = new Date(videoData.updatedAt).getTime();
    const currentTime = new Date().getTime();
    const tenMinutesInMs = 10 * 60 * 1000;
    const minutesElapsed = Math.round((currentTime - updatedAtTime) / 60000);
    
    if (currentTime - updatedAtTime > tenMinutesInMs) {
      await db()
        .update(videos)
        .set({ 
          metadata: {
            ...metadata,
            aiProcessing: false,
            generationError: null
          }
        })
        .where(eq(videos.id, videoId));
      
      metadata.aiProcessing = false;
      metadata.generationError = null;
    } else {
      return;
    }
  }
  
  if (metadata.summary || metadata.chapters) {
    
    if (metadata.aiProcessing) {
      await db()
        .update(videos)
        .set({ 
          metadata: {
            ...metadata,
            aiProcessing: false 
          }
        })
        .where(eq(videos.id, videoId));
    }
    return;
  }
  
  if (videoData?.transcriptionStatus !== "COMPLETE") {
    
    if (metadata.aiProcessing) {
      await db()
        .update(videos)
        .set({ 
          metadata: {
            ...metadata,
            aiProcessing: false 
          }
        })
        .where(eq(videos.id, videoId));
    }
    return;
  }

  try {
    await db()
      .update(videos)
      .set({ 
        metadata: {
          ...metadata,
          aiProcessing: true 
        }
      })
      .where(eq(videos.id, videoId));
    const query = await db()
      .select({ video: videos, bucket: s3Buckets })
      .from(videos)
      .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
      .where(eq(videos.id, videoId));

    if (query.length === 0 || !query[0]) {
      console.error(`[generateAiMetadata] Video data not found for ${videoId}`);
      throw new Error(`Video data not found for ${videoId}`);
    }

    const row = query[0];
    if (!row || !row.video) {
      console.error(`[generateAiMetadata] Video record not found for ${videoId}`);
      throw new Error(`Video record not found for ${videoId}`);
    }
    
    const { video, bucket } = row;

    const awsBucket = video.awsBucket;
    if (!awsBucket) {
      console.error(`[generateAiMetadata] AWS bucket not found for video ${videoId}`);
      throw new Error(`AWS bucket not found for video ${videoId}`);
    }
    const [s3Client] = await createS3Client(bucket);
    
    const transcriptKey = `${userId}/${videoId}/transcription.vtt`;
    const transcriptUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: awsBucket,
        Key: transcriptKey,
      })
    );
    const res = await fetch(transcriptUrl);
    if (!res.ok) {
      console.error(`[generateAiMetadata] Failed to fetch transcript: ${res.status} ${res.statusText}`);
      throw new Error(`Failed to fetch transcript: ${res.status} ${res.statusText}`);
    }
    
    const vtt = await res.text();

    if (!vtt || vtt.length < 10) {
      console.error(`[generateAiMetadata] Transcript is empty or too short (${vtt.length} chars)`);
      throw new Error("Transcript is empty or too short");
    }

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
    
    const prompt = `You are Cap AI. Summarize the transcript and provide JSON in the following format:
{
  "title": "string",
  "summary": "string (write from 1st person perspective if appropriate, e.g. 'In this video, I demonstrate...' to make it feel personable)",
  "chapters": [{"title": "string", "start": number}]
}
Transcript:
${transcriptText}`;
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
    if (!aiRes.ok) {
      const errorText = await aiRes.text();
      console.error(`[generateAiMetadata] OpenAI API error: ${aiRes.status} ${errorText}`);
      throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
    }

    const aiJson = await aiRes.json();
    const content = aiJson.choices?.[0]?.message?.content || "{}";
    
    let data: { title?: string; summary?: string; chapters?: { title: string; start: number }[] } = {};
    try {
      data = JSON.parse(content);
    } catch (e) {
      console.error(`[generateAiMetadata] Error parsing OpenAI response: ${e}`);
      data = { 
        title: "Generated Title", 
        summary: "The AI was unable to generate a proper summary for this content.",
        chapters: []
      };
    }

    const currentMetadata: VideoMetadata = (video.metadata as VideoMetadata) || {};
    const updatedMetadata: VideoMetadata = {
      ...currentMetadata,
      aiTitle: data.title || currentMetadata.aiTitle,
      summary: data.summary || currentMetadata.summary,
      chapters: data.chapters || currentMetadata.chapters,
      aiProcessing: false,
    };
    
    await db()
      .update(videos)
      .set({ metadata: updatedMetadata })
      .where(eq(videos.id, videoId));
      
    if (video.name?.startsWith("Cap Recording -") && data.title) {
      await db()
        .update(videos)
        .set({ name: data.title })
        .where(eq(videos.id, videoId));
    }
  } catch (error) {
    console.error(`[generateAiMetadata] Error for video ${videoId}:`, error);
    
    try {
      const currentVideo = await db().select().from(videos).where(eq(videos.id, videoId));
      if (currentVideo.length > 0 && currentVideo[0]) {
        const currentMetadata: VideoMetadata = (currentVideo[0].metadata as VideoMetadata) || {};
        await db()
          .update(videos)
          .set({ 
            metadata: {
              ...currentMetadata,
              aiProcessing: false,
              generationError: error instanceof Error ? error.message : String(error)
            }
          })
          .where(eq(videos.id, videoId));
      }
    } catch (updateError) {
      console.error(`[generateAiMetadata] Failed to reset processing flag:`, updateError);
    }
  }
}
