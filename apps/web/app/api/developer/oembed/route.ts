import { serverEnv } from "@cap/env";
import type { NextRequest } from "next/server";
import { developerVideoPageUrls } from "@/lib/developer-video-api";
import {
	DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS,
	developerVideoOEmbed,
	developerVideoPlaybackIdFromUrl,
} from "@/lib/developer-video-oembed";
import { findPlayableVideo } from "@/lib/developer-video-playback";
import { developerVideoIsTakenDown } from "@/lib/developer-video-takedown";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control":
				status === 200
					? `public, max-age=${DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS}, s-maxage=${DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS}`
					: "no-store",
		},
	});

export async function GET(request: NextRequest) {
	const query = request.nextUrl.searchParams;
	const format = query.get("format");
	if (format !== null && format !== "json") {
		return json({ error: "Only the json format is supported" }, 501);
	}
	const webUrl = serverEnv().WEB_URL;
	const playbackId = developerVideoPlaybackIdFromUrl(
		query.get("url") ?? "",
		webUrl,
	);
	if (!playbackId) return json({ error: "Not a Cap video page" }, 404);

	try {
		const video = await findPlayableVideo(playbackId);
		if (!video || developerVideoIsTakenDown(video)) {
			return json({ error: "Video not found" }, 404);
		}
		const { width, height } = video;
		const measured =
			width !== null && height !== null && width > 0 && height > 0;
		return json(
			developerVideoOEmbed({
				name: video.name,
				width: measured ? width : DEFAULT_WIDTH,
				height: measured ? height : DEFAULT_HEIGHT,
				embedUrl: developerVideoPageUrls(playbackId, webUrl).embedUrl,
				webUrl,
				maxWidth: query.get("maxwidth"),
				maxHeight: query.get("maxheight"),
			}),
			200,
		);
	} catch (error) {
		console.error("[developer-oembed] Failed to load the video", error);
		return json({ error: "Unable to load video" }, 502);
	}
}
