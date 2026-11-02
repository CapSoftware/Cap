import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { getVideoHighlights } from "@/actions/videos/highlights";
import { highlightDeepLink, highlightsAsText } from "@/lib/video-highlights";

export async function GET(request: NextRequest) {
	const videoId = request.nextUrl.searchParams.get("videoId");
	if (!videoId) {
		return Response.json({ error: "videoId is required" }, { status: 400 });
	}

	let highlights: Awaited<ReturnType<typeof getVideoHighlights>>;
	try {
		highlights = await getVideoHighlights(Video.VideoId.make(videoId));
	} catch {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const shareUrl = new URL(`/s/${videoId}`, serverEnv().WEB_URL).toString();

	if (request.nextUrl.searchParams.get("format") === "text") {
		return new Response(highlightsAsText(highlights, shareUrl), {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	return Response.json({
		videoId,
		shareUrl,
		highlights: highlights.map((highlight) => ({
			id: highlight.id,
			timestamp: highlight.timestamp,
			label: highlight.label,
			authorName: highlight.authorName ?? null,
			url: highlightDeepLink(shareUrl, highlight.timestamp),
			createdAt: highlight.createdAt,
		})),
	});
}
