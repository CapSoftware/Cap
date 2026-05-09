import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const PREVIEW_GIF_EXPIRES_SECONDS = 60 * 60;

function getPreviewGifKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/preview/animated-preview.gif`;
}

function getFallbackResponse(request: NextRequest, videoId: string) {
	if (request.nextUrl.searchParams.get("fallback") !== "og") {
		return new NextResponse(null, { status: 404 });
	}

	const fallbackUrl = new URL("/api/video/og", request.url);
	fallbackUrl.searchParams.set("videoId", videoId);
	const response = NextResponse.redirect(fallbackUrl, 302);
	response.headers.set("Cache-Control", "private, no-store, max-age=0");
	return response;
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

			if (!hasPreview) return null;

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
