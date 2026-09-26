import { HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { requestEditorPreparation } from "@/lib/editor-preparation";
import {
	getSignedEditorSources,
	loadEligibleEditorVideo,
} from "@/lib/editor-session";
import { prewarmRenderFarmSources } from "@/lib/render-farm-start";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

class EditorCapacityBusy extends Schema.TaggedError<EditorCapacityBusy>()(
	"EditorCapacityBusy",
	{ retryAfterMs: Schema.Number },
) {}

class Api extends HttpApi.make("WebEditorPreparationApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("prepare")`/api/editor/preparations`
			.setPayload(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(
				Schema.Struct({
					id: Schema.String,
					status: Schema.Literal("preparing"),
				}),
			)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(EditorCapacityBusy, { status: 503 })
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("prepare", ({ payload }) =>
				Effect.gen(function* () {
					const video = yield* loadEligibleEditorVideo(payload.videoId);
					yield* Effect.forkDaemon(
						prewarmRenderFarmSources(video).pipe(
							Effect.timeout("10 seconds"),
							Effect.ignore,
						),
					);
					const sources = yield* getSignedEditorSources(video);
					const prepared = yield* requestEditorPreparation(video.id, sources);
					if ("busy" in prepared) {
						return yield* new EditorCapacityBusy({ retryAfterMs: 8_000 });
					}
					return { id: prepared.id, status: "preparing" as const };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
