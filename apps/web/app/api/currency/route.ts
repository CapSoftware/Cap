import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { currencyForCountry } from "@/utils/currency";

export const dynamic = "force-dynamic";

const GetCurrencyParams = Schema.Struct({
	country: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("CapCurrencyApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getCurrency")`/api/currency`.setUrlParams(
			GetCurrencyParams,
		),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("getCurrency", ({ urlParams }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const override =
						process.env.VERCEL_ENV !== "production" ? urlParams.country : null;
					const country =
						override || request.headers["x-vercel-ip-country"] || null;

					return HttpServerResponse.unsafeJson(
						{ currency: currencyForCountry(country), country },
						{
							// The response varies per visitor IP, so it must never land in a
							// shared CDN cache where one region's currency would be served to
							// another.
							headers: { "Cache-Control": "private, no-store" },
						},
					);
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
