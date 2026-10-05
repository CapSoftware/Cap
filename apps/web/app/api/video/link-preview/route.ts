import { getCurrentUser } from "@cap/database/auth/session";
import { provideOptionalAuth, S3Buckets, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { runPromise } from "@/lib/server";
import {
	inspectLinkPreviewImage,
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	linkPreviewImageVersion,
	readLinkPreview,
} from "@/lib/share-link-preview";
import { ownerServesLinkPreview } from "@/lib/share-link-preview-metadata";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 8000;

// Whoever can't see the image gets the same dynamic card the share page
// would have advertised, which already knows how to say "private".
function fallback(request: NextRequest, videoId: string) {
	const url = new URL("/api/video/og", request.url);
	url.searchParams.set("videoId", videoId);
	const response = NextResponse.redirect(url, 302);
	response.headers.set("Cache-Control", "private, no-store, max-age=0");
	return response;
}

/**
 * Serves the owner's link preview image from Cap's bucket at a URL that only
 * changes when the image does (`v`), so crawlers and CDNs can cache it. The
 * object key comes from the video's metadata, never from the request.
 */
export async function GET(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) return new NextResponse(null, { status: 400 });
	const videoId = Video.VideoId.make(rawVideoId);

	let image: { url: string; key: string; contentType: string } | null;
	try {
		image = await Effect.gen(function* () {
			const maybeVideo = yield* Effect.flatMap(Videos, (videos) =>
				videos.getByIdForViewing(videoId),
			);
			if (Option.isNone(maybeVideo)) return null;
			const [video] = maybeVideo.value;
			const stored = readLinkPreview(
				Option.getOrNull(video.metadata),
				video.id,
			)?.image;
			if (!stored) return null;
			// Paused while the owner doesn't have Cap Pro.
			if (!(yield* Effect.promise(() => ownerServesLinkPreview(video.ownerId))))
				return null;

			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			const url = yield* bucket.getInternalSignedObjectUrl(stored.key, {
				expiresIn: 60,
			});
			return { url, key: stored.key, contentType: stored.contentType };
		}).pipe(provideOptionalAuth, runPromise);
	} catch {
		return fallback(request, rawVideoId);
	}

	if (!image) return fallback(request, rawVideoId);

	let bytes: Uint8Array;
	try {
		const response = await fetch(image.url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return fallback(request, rawVideoId);
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		console.error(
			`[video/link-preview] Failed to read preview image for ${rawVideoId}:`,
			error,
		);
		return fallback(request, rawVideoId);
	}

	// What was stored was checked on upload; checking again keeps this route
	// from ever serving bytes as a type they are not.
	const inspection =
		bytes.byteLength <= LINK_PREVIEW_IMAGE_MAX_BYTES
			? inspectLinkPreviewImage(bytes)
			: null;
	if (!inspection?.ok || inspection.contentType !== image.contentType) {
		return fallback(request, rawVideoId);
	}

	const anonymous = (await getCurrentUser()) === null;
	const current =
		request.nextUrl.searchParams.get("v") ===
		linkPreviewImageVersion(image.key);

	return new NextResponse(Buffer.from(bytes), {
		headers: {
			"Content-Type": inspection.contentType,
			"Content-Length": String(bytes.byteLength),
			"Content-Disposition": "inline",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": !anonymous
				? "private, max-age=300"
				: current
					? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
					: "public, max-age=60, s-maxage=60",
		},
	});
}

export const HEAD = GET;
