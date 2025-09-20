import { Workflows } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Option, Schema } from "effect";
import { apiToHandler } from "@/lib/server";

export const revalidate = "force-dynamic";

class Api extends HttpApi.make("CapWebApi")
	.add(
		HttpApiGroup.make("root").add(
			HttpApiEndpoint.post("loom")`/import-video`
				.setPayload(
					Schema.Struct({
						loom: Schema.Struct({
							downloadUrl: Schema.String,
							videoId: Schema.String,
						}),
					}),
				)
				.middleware(HttpAuthMiddleware)
				.addError(HttpApiError.InternalServerError),
		),
	)
	.prefix("/api/loom") {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle(
				"loom",
				Effect.fn(
					function* ({ payload }) {
						const { workflows } = yield* Workflows.HttpClient;
						const user = yield* CurrentUser;

						yield* workflows.LoomImportVideo({
							payload: {
								cap: {
									userId: user.id,
									orgId: user.activeOrgId,
								},
								loom: {
									userId: "loomVideoId123",
									orgId: "loomOrgId123",
									video: {
										id: payload.loom.videoId,
										name: "loom video name",
										downloadUrl: payload.loom.downloadUrl,
										width: Option.none(),
										height: Option.none(),
										durationSecs: Option.none(),
										fps: Option.none(),
									},
								},
							},
						});
					},
					(e) =>
						e.pipe(
							Effect.tapDefect(Effect.log),
							Effect.catchAll(() => new HttpApiError.InternalServerError()),
						),
				),
			),
		),
	),
);

const { handler } = apiToHandler(ApiLive);

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
