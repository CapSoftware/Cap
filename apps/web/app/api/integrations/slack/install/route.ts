import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { apiToHandler } from "@/lib/server";
import {
	buildSlackInstallUrl,
	getSlackConfig,
	isSlackIntegrationConfigured,
} from "@/lib/slack/client";
import { createSlackOAuthState } from "@/lib/slack/oauth-state";

class Api extends HttpApi.make("CapSlackInstallApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("installSlack")`/api/integrations/slack/install`,
	),
) {}

const settingsPath = "/dashboard/settings/organization/integrations";

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("installSlack", () =>
				Effect.gen(function* () {
					const user = yield* Effect.tryPromise(getCurrentUser);
					if (!user) {
						const signInUrl = new URL("/login", serverEnv().WEB_URL);
						signInUrl.searchParams.set("next", settingsPath);
						return HttpServerResponse.redirect(signInUrl, { status: 302 });
					}
					const config = getSlackConfig();
					if (
						!config ||
						!isSlackIntegrationConfigured() ||
						!user.activeOrganizationId
					) {
						const url = new URL(settingsPath, serverEnv().WEB_URL);
						url.searchParams.set("slack", "not-configured");
						return HttpServerResponse.redirect(url, { status: 302 });
					}
					yield* Effect.tryPromise(() =>
						requireOrganizationSettingsManager(
							user.id,
							user.activeOrganizationId,
						),
					);
					const state = createSlackOAuthState({
						organizationId: user.activeOrganizationId,
						userId: user.id,
						secret: config.clientSecret,
					});
					return HttpServerResponse.redirect(
						buildSlackInstallUrl({ config, state }),
						{ status: 302 },
					);
				}).pipe(
					Effect.catchAll(() => {
						const url = new URL(settingsPath, serverEnv().WEB_URL);
						url.searchParams.set("slack", "forbidden");
						return Effect.succeed(
							HttpServerResponse.redirect(url, { status: 302 }),
						);
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
