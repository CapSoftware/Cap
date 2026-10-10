import { provideOptionalAuth, S3Buckets, Videos } from "@cap/web-backend";
import { CurrentUser, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import {
	inspectLinkPreviewImage,
	LINK_PREVIEW_CACHE_CONTROL,
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	linkPreviewImageVersion,
	readLinkPreview,
} from "@/lib/share-link-preview";
import {
	getLinkPreviewAccessKey,
	ownerServesLinkPreview,
} from "@/lib/share-link-preview-metadata";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 8000;

class Api extends HttpApi.make("Api").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"linkPreviewImage",
		)`/api/video/link-preview`.setUrlParams(
			Schema.Struct({
				videoId: Video.VideoId,
				v: Schema.optional(Schema.String),
			}),
		),
	),
) {}

// Whoever can't see the image gets the dynamic card the share page would have
// advertised, which already knows how to say "private".
const fallback = (videoId: string) =>
	HttpServerResponse.redirect(
		`/api/video/og?videoId=${encodeURIComponent(videoId)}`,
		{
			status: 302,
			headers: { "Cache-Control": "private, no-store, max-age=0" },
		},
	);

const readImage = (videoId: Video.VideoId) =>
	Effect.gen(function* () {
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
		const serves = yield* Effect.promise(() =>
			ownerServesLinkPreview(video.ownerId),
		);
		if (!serves) return null;

		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		const url = yield* bucket.getInternalSignedObjectUrl(stored.key, {
			expiresIn: 60,
		});
		const bytes = yield* Effect.tryPromise(async () => {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`Storage answered ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		});
		const accessKey = yield* Effect.promise(() =>
			getLinkPreviewAccessKey(video.id),
		);
		const signedIn = Option.isSome(yield* Effect.serviceOption(CurrentUser));
		return {
			bytes,
			contentType: stored.contentType,
			version: linkPreviewImageVersion(stored.key, accessKey),
			signedIn,
		};
	}).pipe(provideOptionalAuth);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("linkPreviewImage", ({ urlParams }) =>
				readImage(urlParams.videoId).pipe(
					Effect.catchAllCause((cause) =>
						Effect.logError("Failed to serve a link preview image", cause).pipe(
							Effect.as(null),
						),
					),
					Effect.map((image) => {
						if (!image) return fallback(urlParams.videoId);

						// Stored bytes were checked on upload; checking again keeps
						// this route from ever serving them as a type they are not.
						const inspection =
							image.bytes.byteLength <= LINK_PREVIEW_IMAGE_MAX_BYTES
								? inspectLinkPreviewImage(image.bytes)
								: null;
						if (!inspection?.ok || inspection.contentType !== image.contentType)
							return fallback(urlParams.videoId);

						return HttpServerResponse.uint8Array(image.bytes, {
							contentType: inspection.contentType,
							headers: {
								"Content-Disposition": "inline",
								"X-Content-Type-Options": "nosniff",
								"Cache-Control": image.signedIn
									? LINK_PREVIEW_CACHE_CONTROL.signedIn
									: urlParams.v === image.version
										? LINK_PREVIEW_CACHE_CONTROL.current
										: LINK_PREVIEW_CACHE_CONTROL.outdated,
							},
						});
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
