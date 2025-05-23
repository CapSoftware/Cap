import { NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";

export const dynamic = "force-dynamic";

const MAX_AI_PROCESSING_TIME = 10 * 60 * 1000;

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

    if (metadata.aiProcessing) {
      const updatedAtTime = new Date(video.updatedAt).getTime();
      const currentTime = new Date().getTime();
      
      if (currentTime - updatedAtTime > MAX_AI_PROCESSING_TIME) {
        console.log(`[Status API] AI processing appears stuck for video ${videoId} (${Math.round((currentTime - updatedAtTime) / 60000)} minutes), resetting flag`);
        
        await db()
          .update(videos)
          .set({ 
            metadata: {
              ...metadata,
              aiProcessing: false,
              generationError: "AI processing timed out and was reset"
            }
          })
          .where(eq(videos.id, videoId));
          
        const updatedResult = await db().select().from(videos).where(eq(videos.id, videoId));
        if (updatedResult.length > 0 && updatedResult[0]) {
          const updatedVideo = updatedResult[0];
          const updatedMetadata = updatedVideo.metadata as VideoMetadata || {};
          
          return Response.json({
            transcriptionStatus: updatedVideo.transcriptionStatus || null,
            aiProcessing: false,
            aiTitle: updatedMetadata.aiTitle || null,
            summary: updatedMetadata.summary || null,
            chapters: updatedMetadata.chapters || null,
            error: "AI processing timed out and was reset"
          }, { status: 200 });
        }
      }
    }

    if (
      video.transcriptionStatus === "COMPLETE" && 
      !metadata.aiProcessing && 
      !metadata.summary && 
      !metadata.chapters &&
      !metadata.generationError
    ) {
      console.log(`[Status API] Transcription complete but no AI data, triggering generation for video ${videoId}`);
      
      (async () => {
        try {
          console.log(`[Status API] Starting AI metadata generation for video ${videoId}`);
          await generateAiMetadata(videoId, video.ownerId);
          console.log(`[Status API] AI metadata generation completed for video ${videoId}`);
        } catch (error) {
          console.error(`[Status API] Error generating AI metadata for video ${videoId}:`, error);
          
          try {
            const currentVideo = await db().select().from(videos).where(eq(videos.id, videoId));
            if (currentVideo.length > 0 && currentVideo[0]) {
              const currentMetadata = (currentVideo[0].metadata as VideoMetadata) || {};
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
          } catch (resetError) {
            console.error(`[Status API] Failed to reset AI processing flag for video ${videoId}:`, resetError);
          }
        }
      })();
      
      return Response.json({
        transcriptionStatus: video.transcriptionStatus || null,
        aiProcessing: true,
        aiTitle: metadata.aiTitle || null,
        summary: metadata.summary || null,
        chapters: metadata.chapters || null,
      }, { status: 200 });
    }

    return Response.json({
      transcriptionStatus: video.transcriptionStatus || null,
      aiProcessing: metadata.aiProcessing || false,
      aiTitle: metadata.aiTitle || null,
      summary: metadata.summary || null,
      chapters: metadata.chapters || null,
    }, { status: 200 });
  } catch (error) {
    console.error("Error in video status endpoint:", error);
    return Response.json({ 
      error: true,
      message: "An unexpected error occurred"
    }, { status: 500 });
  }
} 