import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { ensureLoomPreviewGif } from "@/lib/loom-preview-gif";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PREVIEW_GIF_EXPIRES_SECONDS = 60 * 60;

function getPreviewGifKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/preview/animated-preview.gif`;
}

function getFallbackResponse(request: NextRequest, videoId: string) {
	if (request.nextUrl.searchParams.get("fallback") !== "og") {
		return new NextResponse(null, { status: 404 });
	}

	// Relative on purpose: behind a proxy `request.url` carries the server's
	// bind address (eg. https://0.0.0.0:8080), which unfurlers can't reach. The
	// client resolves this against the URL it requested, custom domains included.
	const params = new URLSearchParams({ videoId });
	return new NextResponse(null, {
		status: 302,
		headers: {
			Location: `/api/video/og?${params}`,
			"Cache-Control": "private, no-store, max-age=0",
		},
	});
}

export async function GET(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) {
		return new NextResponse(null, { status: 400 });
	}

	const videoId = Video.VideoId.make(rawVideoId);
	let previewUrl: string | null;
	try {
		previewUrl = await Effect.gen(function* () {
			const videos = yield* Videos;
			const maybeVideo = yield* videos.getByIdForViewing(videoId);
			if (Option.isNone(maybeVideo)) return null;

			const [video] = maybeVideo.value;
			const [bucket] = yield* Storage.getAccessForVideo(video);
			const previewKey = getPreviewGifKey(video.ownerId, video.id);
			const hasPreview = yield* bucket.headObject(previewKey).pipe(
				Effect.as(true),
				Effect.catchAll(() => Effect.succeed(false)),
			);

			if (
				!hasPreview &&
				!(
					request.nextUrl.searchParams.get("fallback") !== "og" &&
					(yield* ensureLoomPreviewGif(video, bucket, previewKey))
				)
			)
				return null;

			return yield* bucket.getSignedObjectUrl(previewKey, {
				expiresIn: PREVIEW_GIF_EXPIRES_SECONDS,
			});
		}).pipe(provideOptionalAuth, runPromise);
	} catch (error) {
		console.warn("[video/preview] Failed to resolve preview GIF:", error);
		return new NextResponse(null, { status: 404 });
	}

	if (!previewUrl) {
		return getFallbackResponse(request, rawVideoId);
	}

	const response = NextResponse.redirect(previewUrl, 302);
	response.headers.set("Cache-Control", "public, max-age=300");
	return response;
}

export const HEAD = GET;
