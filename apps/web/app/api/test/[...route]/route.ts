import { Loom } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";

export const revalidate = "force-dynamic";

class Api extends HttpApi.make("CapWebApi")
	.add(
		HttpApiGroup.make("root").add(HttpApiEndpoint.get("test")`/import-video`),
	)
	.prefix("/api/test") {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle(
				"test",
				Effect.fn(function* () {
					yield* Loom.ImportVideo.execute({
						userId: "user123",
						loomVideoId: "loomVideoId123",
						loomOrgId: "loomOrgId123",
						orgId: "orgId123",
						downloadUrl:
							"https://cdn.loom.com/sessions/thumbnails/95a01fba1f5f434da5af3cfbe567c6a7-10954f1f96d7b5c2.mp4",
					});
				}),
			),
		),
	),
);

const { handler } = apiToHandler(ApiLive);

export const GET = handler;
export const HEAD = handler;
