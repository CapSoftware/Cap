import { users } from "@cap/database/schema";
import { extractDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { Database } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { isWebStudioEnabledForEmail } from "@/lib/web-studio-rollout";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("WebEditorDefaultStyleApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.put("save", "/api/editor/preferences/default-style")
			.setPayload(Schema.Struct({ config: Schema.Unknown }))
			.addSuccess(Schema.Struct({ saved: Schema.Literal(true) }))
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("save", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					if (!isWebStudioEnabledForEmail(user.email)) {
						return yield* new HttpApiError.NotFound();
					}
					const style = extractDefaultStyle(payload.config);
					if (!style) return yield* new HttpApiError.BadRequest();
					const database = yield* Database;
					yield* database
						.use((client) =>
							client
								.update(users)
								.set({
									preferences: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.editorDefaultStyle', CAST(${JSON.stringify(style)} AS JSON))`,
								})
								.where(eq(users.id, user.id)),
						)
						.pipe(
							Effect.catchTag("DatabaseError", () =>
								Effect.fail(new HttpApiError.InternalServerError()),
							),
						);
					return { saved: true as const };
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const PUT = handler;
