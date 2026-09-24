import type { VideoMetadata } from "@cap/database/types";
import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;

class Api extends HttpApi.make("WebEditorBrowserAssetsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"desktopBackground",
			"/api/editor/videos/:videoId/assets",
		)
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(Schema.Struct({ path: Schema.NullOr(Schema.String) }))
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("desktopBackground", ({ path }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(path.videoId);
					const saved: NonNullable<VideoMetadata["webEditorAssets"]>["items"] =
						video.metadata?.webEditorAssets?.items ?? [];
					const imported = saved.findLast(
						(asset) =>
							asset.kind === "image" &&
							asset.name === "current-desktop-background" &&
							IMAGE_ASSET_PATH.test(asset.path) &&
							asset.key ===
								`${video.ownerId}/${video.id}/editor-assets/images/${asset.path.slice("content/images/".length)}`,
					);
					return { path: imported?.path ?? null };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
