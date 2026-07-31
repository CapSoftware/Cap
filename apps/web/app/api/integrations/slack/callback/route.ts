import { getCurrentUser } from "@cap/database/auth/session";
import { serverEnv } from "@cap/env";
import { Organisation } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { apiToHandler } from "@/lib/server";
import {
	exchangeSlackOAuthCode,
	getSlackConfig,
	isSlackIntegrationConfigured,
} from "@/lib/slack/client";
import { saveSlackInstallation } from "@/lib/slack/installations";
import { verifySlackOAuthState } from "@/lib/slack/oauth-state";

const CallbackParams = Schema.Struct({
	code: Schema.optional(Schema.String),
	state: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

class Api extends HttpApi.make("CapSlackCallbackApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get(
			"completeSlackInstall",
		)`/api/integrations/slack/callback`.setUrlParams(CallbackParams),
	),
) {}

const settingsPath = "/dashboard/settings/organization/integrations";
const redirectToSettings = (result: string) => {
	const url = new URL(settingsPath, serverEnv().WEB_URL);
	url.searchParams.set("slack", result);
	return HttpServerResponse.redirect(url, { status: 302 });
};

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("completeSlackInstall", ({ urlParams }) =>
				Effect.tryPromise(async () => {
					if (urlParams.error) return redirectToSettings("cancelled");
					const config = getSlackConfig();
					if (
						!config ||
						!isSlackIntegrationConfigured() ||
						!urlParams.code ||
						!urlParams.state
					) {
						return redirectToSettings("invalid");
					}
					const state = verifySlackOAuthState({
						state: urlParams.state,
						secret: config.clientSecret,
					});
					const user = await getCurrentUser();
					if (!state || !user || state.userId !== user.id) {
						return redirectToSettings("invalid");
					}
					const organizationId = Organisation.OrganisationId.make(
						state.organizationId,
					);
					await requireOrganizationSettingsManager(user.id, organizationId);
					const result = await exchangeSlackOAuthCode({
						code: urlParams.code,
						config,
					});
					await saveSlackInstallation({
						organizationId,
						installedByUserId: user.id,
						teamId: result.teamId,
						teamName: result.teamName,
						enterpriseId: result.enterpriseId,
						botUserId: result.botUserId,
						accessToken: result.accessToken,
						scope: result.scope,
					});
					return redirectToSettings("connected");
				}).pipe(
					Effect.catchAll((error) => {
						console.error(
							"[slack-oauth] Installation failed",
							error instanceof Error ? error.message : "Unknown error",
						);
						return Effect.succeed(redirectToSettings("failed"));
					}),
				),
			),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
