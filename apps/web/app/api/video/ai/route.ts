import { NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    const url = new URL(request.url);
    const videoId = url.searchParams.get("videoId");

    if (!user) {
      return Response.json({ auth: false }, { status: 401 });
    }

    if (!videoId) {
      return Response.json({ error: true, message: "Video ID not provided" }, { status: 400 });
    }

    const result = await db().select().from(videos).where(eq(videos.id, videoId));
    if (result.length === 0 || !result[0]) {
      return Response.json({ error: true, message: "Video not found" }, { status: 404 });
    }

    const video = result[0];
    const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

    // If we have AI data, return it
    if (metadata.summary || metadata.chapters) {
      console.log(`[AI API] Returning existing AI metadata for video ${videoId}`);
      return Response.json(
        {
          processing: false,
          title: metadata.aiTitle ?? null,
          summary: metadata.summary ?? null,
          chapters: metadata.chapters ?? null,
        },
        { status: 200 }
      );
    }

    // If AI is already processing, return processing status
    if (metadata.aiProcessing) {
      console.log(`[AI API] AI processing already in progress for video ${videoId}`);
      return Response.json({
        processing: true,
        message: "AI metadata generation in progress"
      }, { status: 200 });
    }

    // Don't start AI generation if transcription isn't complete
    if (video.transcriptionStatus !== "COMPLETE") {
      return Response.json({ 
        processing: false,
        message: `Cannot generate AI metadata - transcription status: ${video.transcriptionStatus || "unknown"}`
      }, { status: 200 });
    }

    // Start AI generation
    console.log(`[AI API] Starting AI generation for video ${videoId}`);
    try {
      // Run AI generation in the background
      generateAiMetadata(videoId, video.ownerId).catch(error => {
        console.error("[AI API] Error generating AI metadata:", error);
      });
      
      return Response.json({
        processing: true,
        message: "AI metadata generation started"
      }, { status: 200 });
    } catch (error) {
      console.error("[AI API] Error starting AI metadata generation:", error);
      return Response.json({ 
        processing: false,
        error: "Failed to start AI metadata generation"
      }, { status: 500 });
    }
  } catch (error) {
    console.error("[AI API] Unexpected error:", error);
    return Response.json({ 
      processing: false,
      error: "An unexpected error occurred"
    }, { status: 500 });
  }
}
