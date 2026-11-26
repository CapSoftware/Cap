import { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { generateVideoOgImage } from "@/actions/videos/get-og-image";
import { renderVideoOgStatus } from "@/lib/og/video-og";

// Headroom for the ffmpeg poster-frame fallback on unprocessed videos.
export const maxDuration = 30;

const VIDEO_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;
const THUMBNAIL_VERSION_PATTERN = /^[0-9a-z]{1,32}$/;

export async function GET(req: NextRequest) {
	const params = req.nextUrl.searchParams;
	const videoId = params.get("videoId");
	if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
		return renderVideoOgStatus("not-found");
	}

	const version = params.get("v");
	const canonical = new URLSearchParams({ videoId });
	if (version && THUMBNAIL_VERSION_PATTERN.test(version)) {
		canonical.set("v", version);
	}
	if (params.toString() !== canonical.toString()) {
		return new Response(null, {
			status: 308,
			headers: {
				Location: `${req.nextUrl.pathname}?${canonical}`,
			},
		});
	}

	return generateVideoOgImage(Video.VideoId.make(videoId), canonical.get("v"));
}
