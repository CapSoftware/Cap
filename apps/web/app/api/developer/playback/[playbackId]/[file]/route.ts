import type { NextRequest } from "next/server";
import {
	developerPlaybackResponse,
	PLAYBACK_CORS_HEADERS,
} from "@/lib/developer-video-playback";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ playbackId: string; file: string }> },
) {
	const { playbackId, file } = await params;
	try {
		return await developerPlaybackResponse(playbackId, file, request);
	} catch (error) {
		console.error("[developer-playback] Failed to serve playback file", error);
		return new Response("Playback is unavailable", {
			status: 502,
			headers: { ...PLAYBACK_CORS_HEADERS, "Cache-Control": "no-store" },
		});
	}
}

export const HEAD = GET;

export function OPTIONS() {
	return new Response(null, { status: 204, headers: PLAYBACK_CORS_HEADERS });
}
