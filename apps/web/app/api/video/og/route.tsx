import { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { generateVideoOgImage } from "@/actions/videos/get-og-image";
import { renderVideoOgStatus } from "@/lib/og/video-og";

// Headroom for the ffmpeg poster-frame fallback on unprocessed videos.
export const maxDuration = 30;

const VIDEO_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

export async function GET(req: NextRequest) {
	const params = req.nextUrl.searchParams;
	const videoId = params.get("videoId");
	if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
		return renderVideoOgStatus("not-found");
	}

	if (Array.from(params.keys()).length > 1) {
		return new Response(null, {
			status: 308,
			headers: {
				Location: `${req.nextUrl.pathname}?${new URLSearchParams({ videoId })}`,
			},
		});
	}

	return generateVideoOgImage(Video.VideoId.make(videoId));
}
