"use server";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, s3Buckets } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createBucketProvider } from "@/utils/s3";

export async function editTranscriptEntry(
  videoId: string,
  entryId: number,
  newText: string
): Promise<{ success: boolean; message: string }> {
  const user = await getCurrentUser();

  if (!user || !videoId || entryId === undefined || !newText?.trim()) {
    return {
      success: false,
      message: "Missing required data for updating transcript entry",
    };
  }

  const userId = user.id;
  const query = await db()
    .select({
      video: videos,
      bucket: s3Buckets,
    })
    .from(videos)
    .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
    .where(eq(videos.id, videoId));

  if (query.length === 0) {
    return { success: false, message: "Video not found" };
  }

  const result = query[0];
  if (!result?.video) {
    return { success: false, message: "Video information is missing" };
  }

  const { video } = result;

  if (video.ownerId !== userId) {
    return {
      success: false,
      message: "You don't have permission to edit this transcript",
    };
  }

  const bucket = await createBucketProvider(result.bucket);

  try {
    const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;

    const vttContent = await bucket.getObject(transcriptKey);
    if (!vttContent)
      return { success: false, message: "Transcript file not found" };

    const updatedVttContent = updateVttEntry(vttContent, entryId, newText);

    await bucket.putObject(transcriptKey, updatedVttContent, {
      contentType: "text/vtt",
    });

    revalidatePath(`/s/${videoId}`);

    return {
      success: true,
      message: "Transcript entry updated successfully",
    };
  } catch (error) {
    console.error("Error updating transcript entry:", {
      error: error instanceof Error ? error.message : error,
      videoId,
      entryId,
      userId,
    });
    return {
      success: false,
      message: "Failed to update transcript entry",
    };
  }
}

function updateVttEntry(
  vttContent: string,
  entryId: number,
  newText: string
): string {
  const lines = vttContent.split("\n");
  const updatedLines: string[] = [];
  let currentEntryId: number | null = null;
  let foundEntry = false;
  let isNextLineText = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      updatedLines.push(line);
      isNextLineText = false;
      continue;
    }

    if (trimmedLine === "WEBVTT") {
      updatedLines.push(line);
      continue;
    }

    if (/^\d+$/.test(trimmedLine)) {
      currentEntryId = parseInt(trimmedLine, 10);
      updatedLines.push(line);
      isNextLineText = false;
      continue;
    }

    if (trimmedLine.includes("-->")) {
      updatedLines.push(line);
      isNextLineText = true;
      continue;
    }

    if (currentEntryId === entryId && isNextLineText && !foundEntry) {
      updatedLines.push(newText.trim());
      foundEntry = true;
      isNextLineText = false;
    } else {
      updatedLines.push(line);
      if (isNextLineText) {
        isNextLineText = false;
      }
    }
  }

  if (!foundEntry) {
    console.warn("Target entry not found in VTT content", {
      entryId,
      totalEntries: lines.filter((line) => /^\d+$/.test(line.trim())).length,
    });
  }

  const result = updatedLines.join("\n");

  return result;
}
