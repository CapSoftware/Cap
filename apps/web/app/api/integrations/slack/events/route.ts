import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { start } from "workflow/api";
import { apiToHandler } from "@/lib/server";
import { getSlackConfig } from "@/lib/slack/client";
import { verifySlackSignature } from "@/lib/slack/signature";
import { parseSlackEventPayload } from "@/lib/slack/unfurl";
import { slackEventWorkflow } from "@/workflows/slack-event";

const MAX_BODY_BYTES = 1_000_000;

class Api extends HttpApi.make("CapSlackEventsApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("receiveSlackEvent")`/api/integrations/slack/events`,
	),
) {}

const jsonResponse = (body: unknown, status = 200) =>
	HttpServerResponse.text(JSON.stringify(body), {
		status,
		contentType: "application/json; charset=utf-8",
		headers: {
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("receiveSlackEvent", () =>
				Effect.gen(function* () {
					const config = getSlackConfig();
					if (!config) {
						return jsonResponse({ error: "Slack is not configured" }, 503);
					}
					const request = yield* HttpServerRequest.HttpServerRequest;
					const body = yield* request.text.pipe(
						HttpServerRequest.withMaxBodySize(Option.some(MAX_BODY_BYTES)),
						Effect.catchAll(() => Effect.succeed("")),
					);
					if (
						!verifySlackSignature({
							body,
							timestamp: request.headers["x-slack-request-timestamp"],
							signature: request.headers["x-slack-signature"],
							signingSecret: config.signingSecret,
						})
					) {
						return jsonResponse({ error: "Invalid signature" }, 401);
					}

					let value: unknown;
					try {
						value = JSON.parse(body);
					} catch {
						return jsonResponse({ error: "Invalid request body" }, 400);
					}
					const payload = parseSlackEventPayload(value);
					if (!payload) {
						return jsonResponse({ error: "Unsupported Slack event" }, 400);
					}
					if (payload.type === "url_verification") {
						return jsonResponse({ challenge: payload.challenge });
					}

					const queued = yield* Effect.tryPromise(() =>
						start(slackEventWorkflow, [payload, serverEnv().WEB_URL]),
					).pipe(
						Effect.as(true),
						Effect.tapError((error) =>
							Effect.sync(() => {
								console.error(
									"[slack-unfurl] Failed to queue event",
									error instanceof Error ? error.message : "Unknown error",
								);
							}),
						),
						Effect.catchAll(() => Effect.succeed(false)),
					);
					if (!queued) {
						return jsonResponse({ error: "Could not queue Slack event" }, 503);
					}
					return jsonResponse({ ok: true });
				}),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
