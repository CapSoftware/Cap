import { users } from "@cap/database/schema";
import {
	extractDefaultStyle,
	parseDefaultStyle,
} from "@cap/editor-cap-bundle/default-style";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware, type UserId } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq, type SQL, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

export const dynamic = "force-dynamic";

const PATH = "/api/editor/preferences/default-style";
const StyleResponse = Schema.Struct({ style: Schema.Unknown });

class Api extends HttpApi.make("WebEditorDefaultStyleApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("load", PATH)
				.addSuccess(StyleResponse)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.put("save", PATH)
				.setPayload(Schema.Struct({ config: Schema.Unknown }))
				.addSuccess(StyleResponse)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.del("clear", PATH)
				.addSuccess(StyleResponse)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const studioUser = Effect.gen(function* () {
	const user = yield* CurrentUser;
	if (!isWebStudioEnabledForEmail(user.email)) {
		return yield* new HttpApiError.NotFound();
	}
	return user;
});

// Rows created without preferences can hold a JSON null, which JSON_SET and
// JSON_REMOVE leave untouched, so anything but an object starts over.
const storedPreferences = sql`IF(JSON_TYPE(${users.preferences}) = 'OBJECT', ${users.preferences}, JSON_OBJECT())`;

const writePreferences = (userId: UserId, preferences: SQL) =>
	Effect.flatMap(Database, (database) =>
		database.use((client) =>
			client.update(users).set({ preferences }).where(eq(users.id, userId)),
		),
	).pipe(
		Effect.catchTag("DatabaseError", () =>
			Effect.fail(new HttpApiError.InternalServerError()),
		),
	);

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("load", () =>
					Effect.gen(function* () {
						const user = yield* studioUser;
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
						return {
							style: parseDefaultStyle(row?.preferences?.editorDefaultStyle),
						};
					}),
				)
				.handle("save", ({ payload }) =>
					Effect.gen(function* () {
						const user = yield* studioUser;
						const style = extractDefaultStyle(payload.config);
						if (!style) return yield* new HttpApiError.BadRequest();
						yield* writePreferences(
							user.id,
							sql`JSON_SET(${storedPreferences}, '$.editorDefaultStyle', CAST(${JSON.stringify(style)} AS JSON))`,
						);
						return { style };
					}),
				)
				.handle("clear", () =>
					Effect.gen(function* () {
						const user = yield* studioUser;
						yield* writePreferences(
							user.id,
							sql`JSON_REMOVE(${storedPreferences}, '$.editorDefaultStyle')`,
						);
						return { style: null };
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const PUT = handler;
export const DELETE = handler;
