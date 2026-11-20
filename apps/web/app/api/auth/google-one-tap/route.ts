import {
	googleOneTapNonceCookieForWebUrl,
	issueGoogleOneTapNonce,
} from "@cap/database/auth/google-one-tap";
import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Duration, Effect, Layer } from "effect";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";

class Api extends HttpApi.make("CapGoogleOneTapApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("issueNonce")`/api/auth/google-one-tap`,
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("issueNonce", () =>
				Effect.gen(function* () {
					const env = serverEnv();
					if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
						return HttpServerResponse.unsafeJson(
							{ error: "Not found" },
							{ status: 404, headers: { "Cache-Control": "no-store" } },
						);
					}
					const request = yield* HttpServerRequest.HttpServerRequest;
					const { name, options } = googleOneTapNonceCookieForWebUrl(
						env.WEB_URL,
					);
					const { nonce, cookieValue } = issueGoogleOneTapNonce(
						request.cookies[name],
					);
					return HttpServerResponse.unsafeJson(
						{ nonce },
						{ headers: { "Cache-Control": "no-store" } },
					).pipe(
						HttpServerResponse.unsafeSetCookie(name, cookieValue, {
							...options,
							maxAge: Duration.seconds(options.maxAge),
						}),
					);
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
