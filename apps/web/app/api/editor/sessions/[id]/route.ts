import { videos } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { requestMediaEditor } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorSessionCloseApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.del("close", "/api/editor/sessions/:id")
			.setPath(Schema.Struct({ id: Schema.String }))
			.setUrlParams(Schema.Struct({ videoId: Video.VideoId }))
			.addSuccess(Schema.Struct({ closed: Schema.Boolean }))
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("close", ({ path, urlParams }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					if (!isWebStudioEnabledForEmail(user.email)) {
						return yield* new HttpApiError.NotFound();
					}
					const database = yield* Database;
					const [video] = yield* database
						.use((client) =>
							client
								.select({ ownerId: videos.ownerId })
								.from(videos)
								.where(eq(videos.id, urlParams.videoId)),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					if (!video || video.ownerId !== user.id)
						return yield* new HttpApiError.NotFound();
					const sessionPath = `/editor/sessions/${encodeURIComponent(path.id)}`;
					const identity = yield* requestMediaEditor(sessionPath);
					if (identity.status === 404)
						return yield* new HttpApiError.NotFound();
					if (!identity.ok) return yield* new HttpApiError.ServiceUnavailable();
					const data: unknown = yield* Effect.tryPromise({
						try: () => identity.json(),
						catch: () => new HttpApiError.ServiceUnavailable(),
					});
					if (
						typeof data !== "object" ||
						data === null ||
						!("videoId" in data) ||
						data.videoId !== urlParams.videoId
					) {
						return yield* new HttpApiError.NotFound();
					}
					const response = yield* requestMediaEditor(sessionPath, {
						method: "DELETE",
					});
					if (response.status !== 204)
						return yield* new HttpApiError.ServiceUnavailable();
					return { closed: true };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const DELETE = handler;
