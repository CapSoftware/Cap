"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { videos, users } from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { generateAiMetadata } from "./generate-ai-metadata";
import { transcribeVideo } from "./transcribe";
import { isAiGenerationEnabled } from "@/utils/flags";

const MAX_AI_PROCESSING_TIME = 10 * 60 * 1000;

export interface VideoStatusResult {
  transcriptionStatus: "PROCESSING" | "COMPLETE" | "ERROR" | null;
  aiProcessing: boolean;
  aiTitle: string | null;
  summary: string | null;
  chapters: { title: string; start: number }[] | null;
  generationError: string | null;
  error?: string;
}

export async function getVideoStatus(videoId: string): Promise<VideoStatusResult> {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error("Authentication required");
  }

  if (!videoId) {
    throw new Error("Video ID not provided");
  }

  const result = await db().select().from(videos).where(eq(videos.id, videoId));
  if (result.length === 0 || !result[0]) {
    throw new Error("Video not found");
  }

  const video = result[0];
  const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

  if (!video.transcriptionStatus) {
    console.log(`[Get Status] Transcription not started for video ${videoId}, triggering transcription`);
    try {
      transcribeVideo(videoId, video.ownerId).catch(error => {
        console.error(`[Get Status] Error starting transcription for video ${videoId}:`, error);
      });
      
      return {
        transcriptionStatus: "PROCESSING",
        aiProcessing: false,
        aiTitle: metadata.aiTitle || null,
        summary: metadata.summary || null,
        chapters: metadata.chapters || null,
        generationError: metadata.generationError || null,
      };
    } catch (error) {
      console.error(`[Get Status] Error triggering transcription for video ${videoId}:`, error);
      return {
        transcriptionStatus: "ERROR",
        aiProcessing: false,
        aiTitle: metadata.aiTitle || null,
        summary: metadata.summary || null,
        chapters: metadata.chapters || null,
        generationError: metadata.generationError || null,
        error: "Failed to start transcription"
      };
    }
  }

  if (video.transcriptionStatus === "ERROR") {
    return {
      transcriptionStatus: "ERROR",
      aiProcessing: false,
      aiTitle: metadata.aiTitle || null,
      summary: metadata.summary || null,
      chapters: metadata.chapters || null,
      generationError: metadata.generationError || null,
      error: "Transcription failed"
    };
  }

  if (metadata.aiProcessing) {
    const updatedAtTime = new Date(video.updatedAt).getTime();
    const currentTime = new Date().getTime();
    
    if (currentTime - updatedAtTime > MAX_AI_PROCESSING_TIME) {
      console.log(`[Get Status] AI processing appears stuck for video ${videoId} (${Math.round((currentTime - updatedAtTime) / 60000)} minutes), resetting flag`);
      
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
        
        return {
          transcriptionStatus: (updatedVideo.transcriptionStatus as "PROCESSING" | "COMPLETE" | "ERROR") || null,
          aiProcessing: false,
          aiTitle: updatedMetadata.aiTitle || null,
          summary: updatedMetadata.summary || null,
          chapters: updatedMetadata.chapters || null,
          generationError: updatedMetadata.generationError || null,
          error: "AI processing timed out and was reset"
        };
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
    console.log(`[Get Status] Transcription complete but no AI data, checking feature flag for video owner ${video.ownerId}`);
    
    const videoOwnerQuery = await db()
      .select({ 
        email: users.email, 
        stripeSubscriptionStatus: users.stripeSubscriptionStatus 
      })
      .from(users)
      .where(eq(users.id, video.ownerId))
      .limit(1);

    if (videoOwnerQuery.length > 0 && videoOwnerQuery[0] && (await isAiGenerationEnabled(videoOwnerQuery[0]))) {
      console.log(`[Get Status] Feature flag enabled, triggering AI generation for video ${videoId}`);
      
      (async () => {
        try {
          console.log(`[Get Status] Starting AI metadata generation for video ${videoId}`);
          await generateAiMetadata(videoId, video.ownerId);
          console.log(`[Get Status] AI metadata generation completed for video ${videoId}`);
        } catch (error) {
          console.error(`[Get Status] Error generating AI metadata for video ${videoId}:`, error);
          
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
            console.error(`[Get Status] Failed to reset AI processing flag for video ${videoId}:`, resetError);
          }
        }
      })();
      
      return {
        transcriptionStatus: (video.transcriptionStatus as "PROCESSING" | "COMPLETE" | "ERROR") || null,
        aiProcessing: true,
        aiTitle: metadata.aiTitle || null,
        summary: metadata.summary || null,
        chapters: metadata.chapters || null,
        generationError: metadata.generationError || null,
      };
    } else {
      const videoOwner = videoOwnerQuery[0];
      console.log(`[Get Status] AI generation feature disabled for video owner ${video.ownerId} (email: ${videoOwner?.email}, pro: ${videoOwner?.stripeSubscriptionStatus})`);
    }
  }

  return {
    transcriptionStatus: (video.transcriptionStatus as "PROCESSING" | "COMPLETE" | "ERROR") || null,
    aiProcessing: metadata.aiProcessing || false,
    aiTitle: metadata.aiTitle || null,
    summary: metadata.summary || null,
    chapters: metadata.chapters || null,
    generationError: metadata.generationError || null,
  };
} 