import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { createDeveloperCardCheckout } from "@/lib/developer-card-checkout";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("DeveloperCardApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("saveCard")`/api/developer/credits/card`
			.setPayload(Schema.Struct({ appId: Schema.String }))
			.addSuccess(Schema.Struct({ url: Schema.String }))
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.InternalServerError)
			.middleware(HttpAuthMiddleware),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("saveCard", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const result = yield* Effect.tryPromise(() =>
						createDeveloperCardCheckout({
							user: { id: user.id, email: user.email },
							appId: payload.appId,
						}),
					).pipe(
						Effect.catchAll((error) =>
							Effect.logError(error).pipe(
								Effect.andThen(() =>
									Effect.fail(new HttpApiError.InternalServerError()),
								),
							),
						),
					);
					if (result.status === "ok") return { url: result.url };
					if (result.status === "forbidden") {
						return yield* new HttpApiError.Forbidden();
					}
					if (result.status === "not_found") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* new HttpApiError.InternalServerError();
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
