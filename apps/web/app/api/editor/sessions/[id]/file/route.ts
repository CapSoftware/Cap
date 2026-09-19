import { Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	loadEligibleEditorVideo,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

const IMAGE_PATH =
	/^content\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|gif|bmp|tiff)$/;
const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};

class Api extends HttpApi.make("WebEditorFileApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("file", "/api/editor/sessions/:id/file")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setUrlParams(
				Schema.Struct({ videoId: Video.VideoId, path: Schema.String }),
			)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("file", ({ path, urlParams }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(urlParams.videoId);
					yield* verifyOwnedEditorSession(urlParams.videoId, path.id);
					const projectPrefix = `cap-web-editor://session/${path.id}/`;
					const relative = urlParams.path.startsWith(projectPrefix)
						? urlParams.path.slice(projectPrefix.length)
						: urlParams.path;
					const match = IMAGE_PATH.exec(relative);
					if (!match) return yield* new HttpApiError.NotFound();
					const asset = video.metadata?.webEditorAssets?.items.find(
						(item) => item.kind === "image" && item.path === relative,
					);
					const expectedKey = `${video.ownerId}/${video.id}/editor-assets/images/${relative.slice("content/images/".length)}`;
					if (
						!asset ||
						asset.key !== expectedKey ||
						asset.contentType !== IMAGE_CONTENT_TYPES[match[2] ?? ""] ||
						!Number.isSafeInteger(asset.size) ||
						asset.size < 1 ||
						asset.size > 64 * 1024 * 1024 ||
						!asset.objectIdentity
					) {
						return yield* new HttpApiError.NotFound();
					}
					const [bucket] = yield* Storage.getAccessForVideo(
						decodeStorageVideo(video),
						{ resolvePublishedOutput: false },
					).pipe(
						Effect.catchTag("StorageError", () =>
							Effect.fail(new HttpApiError.ServiceUnavailable()),
						),
					);
					const head = yield* bucket
						.headObject(asset.key)
						.pipe(
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
					if (
						head.ContentLength !== asset.size ||
						getRecordingObjectIdentity(head, asset.objectIdentity) !==
							asset.objectIdentity
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					const signed = yield* bucket
						.getSignedObjectUrl(asset.key, { expiresIn: 5 * 60 })
						.pipe(
							Effect.catchTag("StorageError", () =>
								Effect.fail(new HttpApiError.ServiceUnavailable()),
							),
						);
					let url: URL;
					try {
						url = new URL(signed);
					} catch {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					if (
						(url.protocol !== "https:" &&
							!(
								url.protocol === "http:" &&
								["localhost", "127.0.0.1"].includes(url.hostname)
							)) ||
						url.username ||
						url.password
					) {
						return yield* new HttpApiError.ServiceUnavailable();
					}
					return HttpServerResponse.redirect(url.toString()).pipe(
						HttpServerResponse.setHeaders({
							"Cache-Control": "private, no-store",
						}),
					);
				}),
			),
		),
	),
);

export const GET = apiToHandler(ApiLive);
