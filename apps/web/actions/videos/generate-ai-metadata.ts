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
  console.log(`[generateAiMetadata] Starting for video ${videoId}, userId: ${userId}`);
  
  if (!serverEnv().OPENAI_API_KEY) {
    console.error("[generateAiMetadata] Missing OpenAI API key, skipping AI metadata generation");
    return;
  }

  console.log(`[generateAiMetadata] Querying database for video ${videoId}`);
  const videoQuery = await db()
    .select({ video: videos })
    .from(videos)
    .where(eq(videos.id, videoId));

  if (videoQuery.length === 0 || !videoQuery[0]?.video) {
    console.error(`[generateAiMetadata] Video ${videoId} not found in database`);
    return;
  }
  
  const videoData = videoQuery[0].video;
  console.log(`[generateAiMetadata] Found video ${videoId}, transcription status: ${videoData.transcriptionStatus}`);
  const metadata = videoData.metadata as VideoMetadata || {};
  
  if (metadata.aiProcessing === true) {
    console.log(`[generateAiMetadata] AI processing already in progress for video ${videoId}, skipping`);
    
    const updatedAtTime = new Date(videoData.updatedAt).getTime();
    const currentTime = new Date().getTime();
    const tenMinutesInMs = 10 * 60 * 1000;
    const minutesElapsed = Math.round((currentTime - updatedAtTime) / 60000);
    
    if (currentTime - updatedAtTime > tenMinutesInMs) {
      console.log(`[generateAiMetadata] AI processing stuck for video ${videoId} (${minutesElapsed} minutes), resetting and continuing`);
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
      console.log(`[generateAiMetadata] AI processing still recent (${minutesElapsed} minutes), skipping`);
      return;
    }
  }
  
  if (metadata.summary || metadata.chapters) {
    console.log(`[generateAiMetadata] AI metadata already exists for video ${videoId}, summary length: ${metadata.summary?.length || 0}, chapters: ${metadata.chapters?.length || 0}`);
    
    if (metadata.aiProcessing) {
      console.log(`[generateAiMetadata] Resetting aiProcessing flag for video ${videoId}`);
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
    console.log(`[generateAiMetadata] Skipping - transcription status: ${videoData?.transcriptionStatus || "unknown"} for video ${videoId}`);
    
    if (metadata.aiProcessing) {
      console.log(`[generateAiMetadata] Resetting aiProcessing flag after incomplete transcription for video ${videoId}`);
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
    console.log(`[generateAiMetadata] Setting aiProcessing flag to true for video ${videoId}`);
    await db()
      .update(videos)
      .set({ 
        metadata: {
          ...metadata,
          aiProcessing: true 
        }
      })
      .where(eq(videos.id, videoId));
      
    console.log(`[generateAiMetadata] Processing video ${videoId}`);
    
    console.log(`[generateAiMetadata] Querying database for video and bucket data`);
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
    console.log(`[generateAiMetadata] Video record loaded, bucket ID: ${bucket?.id || "none"}`);

    const awsBucket = video.awsBucket;
    if (!awsBucket) {
      console.error(`[generateAiMetadata] AWS bucket not found for video ${videoId}`);
      throw new Error(`AWS bucket not found for video ${videoId}`);
    }
    console.log(`[generateAiMetadata] Using AWS bucket: ${awsBucket}`);

    console.log(`[generateAiMetadata] Creating S3 client for video ${videoId}`);
    const [s3Client] = await createS3Client(bucket);
    console.log(`[generateAiMetadata] Getting transcript for video ${videoId}`);
    
    const transcriptKey = `${userId}/${videoId}/transcription.vtt`;
    console.log(`[generateAiMetadata] Generating signed URL for transcript at: ${transcriptKey}`);
    const transcriptUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: awsBucket,
        Key: transcriptKey,
      })
    );

    console.log(`[generateAiMetadata] Fetching transcript from S3 for video ${videoId}`);
    const res = await fetch(transcriptUrl);
    console.log(`[generateAiMetadata] Transcript fetch response status: ${res.status}`);
    if (!res.ok) {
      console.error(`[generateAiMetadata] Failed to fetch transcript: ${res.status} ${res.statusText}`);
      throw new Error(`Failed to fetch transcript: ${res.status} ${res.statusText}`);
    }
    
    const vtt = await res.text();
    console.log(`[generateAiMetadata] Transcript fetched, length: ${vtt.length} characters`);

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
    console.log(`[generateAiMetadata] Processed transcript text, length: ${transcriptText.length} characters`);

    console.log(`[generateAiMetadata] Preparing OpenAI request for video ${videoId}`);
    
    const prompt = `You are Cap AI. Summarize the transcript and provide JSON in the following format:
{
  "title": "string",
  "summary": "string (write from 1st person perspective if appropriate, e.g. 'In this video, I demonstrate...' to make it feel personable)",
  "chapters": [{"title": "string", "start": number}]
}
Transcript:
${transcriptText}`;

    console.log(`[generateAiMetadata] Sending request to OpenAI API, prompt length: ${prompt.length}`);
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

    console.log(`[generateAiMetadata] OpenAI API response status: ${aiRes.status}`);
    if (!aiRes.ok) {
      const errorText = await aiRes.text();
      console.error(`[generateAiMetadata] OpenAI API error: ${aiRes.status} ${errorText}`);
      throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
    }

    const aiJson = await aiRes.json();
    console.log(`[generateAiMetadata] Received OpenAI response for video ${videoId}`);
    const content = aiJson.choices?.[0]?.message?.content || "{}";
    
    let data: { title?: string; summary?: string; chapters?: { title: string; start: number }[] } = {};
    try {
      console.log(`[generateAiMetadata] Parsing OpenAI response JSON`);
      data = JSON.parse(content);
      console.log(`[generateAiMetadata] Parsed OpenAI response: title length: ${data.title?.length || 0}, summary length: ${data.summary?.length || 0}, chapters: ${data.chapters?.length || 0}`);
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

    console.log(`[generateAiMetadata] Updating database with AI metadata for video ${videoId}`);
    
    await db()
      .update(videos)
      .set({ metadata: updatedMetadata })
      .where(eq(videos.id, videoId));
      
    if (video.name?.startsWith("Cap Recording -") && data.title) {
      console.log(`[generateAiMetadata] Updating video name from "${video.name}" to "${data.title}"`);
      await db()
        .update(videos)
        .set({ name: data.title })
        .where(eq(videos.id, videoId));
    }
    
    console.log(`[generateAiMetadata] Completed successfully for video ${videoId}`);
  } catch (error) {
    console.error(`[generateAiMetadata] Error for video ${videoId}:`, error);
    
    try {
      console.log(`[generateAiMetadata] Attempting to reset aiProcessing flag after error for video ${videoId}`);
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
        console.log(`[generateAiMetadata] Reset aiProcessing flag and stored error for video ${videoId}`);
      }
    } catch (updateError) {
      console.error(`[generateAiMetadata] Failed to reset processing flag:`, updateError);
    }
  }
}
