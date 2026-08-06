import { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { generateVideoOgImage } from "@/actions/videos/get-og-image";

// Headroom for the ffmpeg poster-frame fallback on unprocessed videos.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
	const videoId = req.nextUrl.searchParams.get("videoId") as string;
	return generateVideoOgImage(Video.VideoId.make(videoId));
}
