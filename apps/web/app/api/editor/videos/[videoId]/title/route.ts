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
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { validWebEditorTitle } from "@/lib/editor-recording-title";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

function changedRows(value: unknown) {
	const result = Array.isArray(value) ? value[0] : value;
	return typeof result === "object" &&
		result !== null &&
		"affectedRows" in result &&
		typeof result.affectedRows === "number"
		? result.affectedRows
		: 0;
}

class Api extends HttpApi.make("WebEditorBrowserTitleApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.put("save", "/api/editor/videos/:videoId/title")
			.setPath(Schema.Struct({ videoId: Video.VideoId }))
			.setPayload(Schema.Struct({ prettyName: Schema.String }))
			.addSuccess(Schema.Struct({ saved: Schema.Boolean }))
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.Conflict)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("save", ({ path, payload }) =>
				Effect.gen(function* () {
					if (!validWebEditorTitle(payload.prettyName))
						return yield* new HttpApiError.Conflict();
					const video = yield* loadEligibleEditorVideo(path.videoId);
					if (video.name === payload.prettyName) return { saved: true };
					const database = yield* Database;
					const user = yield* CurrentUser;
					const updated: unknown = yield* database
						.use((client) =>
							client
								.update(videos)
								.set({ name: payload.prettyName })
								.where(
									and(
										eq(videos.id, video.id),
										eq(videos.ownerId, user.id),
										eq(videos.name, video.name),
									),
								),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					if (changedRows(updated) !== 1)
						return yield* new HttpApiError.Conflict();
					return { saved: true };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const PUT = handler;
