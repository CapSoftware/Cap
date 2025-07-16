import { NextResponse } from "next/server";
import { db } from "@cap/database";
import { videos, s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import {
  formatTranscriptAsVTT,
  parseVTT,
} from "../../../s/[videoId]/_components/utils/transcript-utils";
import { getTranscript } from "@/actions/videos/get-transcript";

export async function GET({ params }: { params: { videoId: string } }) {
  try {
    const { videoId } = params;

    const videoData = await db()
      .select({
        video: videos,
        bucket: s3Buckets,
      })
      .from(videos)
      .leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
      .where(eq(videos.id, videoId));

    if (!videoData) {
      return new NextResponse("Video not found", { status: 404 });
    }

    const transcriptResponse = await getTranscript(videoId);

    if (!transcriptResponse.success || !transcriptResponse.content) {
      return new NextResponse(
        transcriptResponse.message || "Transcript not available",
        { status: 404 }
      );
    }

    const parsedEntries = parseVTT(transcriptResponse.content);
    const vttContent = formatTranscriptAsVTT(
      parsedEntries.map((entry, index) => ({
        id: index + 1,
        timestamp: entry.startTime,
        text: entry.text,
        startTime: entry.startTime,
      }))
    );

    return new NextResponse(vttContent, {
      headers: {
        "Content-Type": "text/vtt",
        "Content-Disposition": `inline; filename="transcript-${videoId}.vtt"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error serving subtitle file:", error);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
