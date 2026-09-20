import { users } from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, StudioSound } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorStudioSoundApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("load", "/api/editor/preferences/studio-sound")
				.addSuccess(StudioSound.PreferenceSchema)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("save", "/api/editor/preferences/studio-sound")
				.setPayload(StudioSound.PreferenceSchema)
				.addSuccess(StudioSound.PreferenceSchema)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("load", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const database = yield* Database;
						const [row] = yield* database
							.use((client) =>
								client
									.select({ preferences: users.preferences })
									.from(users)
									.where(eq(users.id, user.id))
									.limit(1),
							)
							.pipe(
								Effect.catchTag("DatabaseError", () =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							);
						return StudioSound.fromUserPreferences(row?.preferences);
					}),
				)
				.handle("save", ({ payload }) =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const database = yield* Database;
						yield* database
							.use((client) =>
								client
									.update(users)
									.set({
										preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.studioSound', CAST(${JSON.stringify(payload)} AS JSON))`,
									})
									.where(eq(users.id, user.id)),
							)
							.pipe(
								Effect.catchTag("DatabaseError", () =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							);
						return payload;
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const PUT = handler;
