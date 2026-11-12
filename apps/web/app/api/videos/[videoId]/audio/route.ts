import { getCurrentUser } from "@cap/database/auth/session";
import { attachmentContentDisposition } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import {
	isMediaServerConfigured,
	streamAudioViaMediaServer,
} from "@/lib/media-client";
import { resolveVideoAudioSource } from "@/lib/video-audio-download";

export async function GET(
	request: Request,
	props: RouteContext<"/api/videos/[videoId]/audio">,
) {
	const { videoId } = (await props.params) as { videoId: Video.VideoId };

	if (!isMediaServerConfigured()) {
		return Response.json(
			{ error: "Audio downloads are not available on this server." },
			{ status: 501 },
		);
	}

	const user = await getCurrentUser();
	const source = await resolveVideoAudioSource(videoId, user);
	if (!source.success) {
		return Response.json({ error: source.error }, { status: source.status });
	}

	try {
		const audio = await streamAudioViaMediaServer(
			source.sourceUrl,
			request.signal,
		);

		if (audio.status === "no-audio") {
			return Response.json(
				{ error: "This video has no audio to download." },
				{ status: 422 },
			);
		}

		return new Response(audio.body, {
			headers: {
				"Content-Type": "audio/mpeg",
				"Content-Disposition": attachmentContentDisposition(source.filename),
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		if (request.signal.aborted) {
			return new Response(null, { status: 499 });
		}
		console.error("Error extracting audio for download:", error);
		return Response.json(
			{ error: "Failed to extract audio from this video." },
			{ status: 502 },
		);
	}
}
