import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api";
import { apiToHandler } from "@/lib/server";
import { currencyForCountry } from "@/utils/currency";

export const dynamic = "force-dynamic";

const GetCurrencyParams = Schema.Struct({
	country: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("CapCurrencyApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getCurrency", "/api/currency", {
			query: GetCurrencyParams,
		}),
	),
) {}

const ApiLive = HttpApiBuilder.layer(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("getCurrency", ({ query: urlParams }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const override =
						process.env.VERCEL_ENV !== "production" ? urlParams.country : null;
					const country =
						override || request.headers["x-vercel-ip-country"] || null;

					return HttpServerResponse.text(
						JSON.stringify({ currency: currencyForCountry(country), country }),
						{
							// The response varies per visitor IP, so it must never land in a
							// shared CDN cache where one region's currency would be served to
							// another.
							contentType: "application/json; charset=utf-8",
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
