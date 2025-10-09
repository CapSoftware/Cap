import {
	type AppInstallationRepoCreate,
	type AppInstallationRepoRecord,
	type AppInstallationRepoUpdate,
	type AppInstallationsRepository,
	type AppStateError,
	decodeAppState,
	getAppModule,
	getAppModuleByName,
} from "@cap/apps";
import { AppInstallationsRepo, OrganisationsPolicy } from "@cap/web-backend";
import { CurrentUser, HttpAuthMiddleware } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import type { HttpServerResponse } from "@effect/platform/HttpServerResponse";
import { Effect, Layer, Option, Schema } from "effect";

import { apiToHandler } from "@/lib/server";

const authorizeRequestSchema = Schema.Struct({
	app: Schema.String,
});

const refreshRequestSchema = Schema.Struct({
	app: Schema.String,
});

const callbackQuerySchema = Schema.Struct({
	state: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
	error_description: Schema.optional(Schema.String),
}).pipe(
	Schema.extend(
		Schema.Record({
			key: Schema.String,
			value: Schema.String,
		}),
	),
);

type AuthorizeErrors =
	| HttpApiError.BadRequest
	| HttpApiError.Forbidden
	| HttpApiError.InternalServerError;

type RefreshErrors =
	| HttpApiError.BadRequest
	| HttpApiError.Forbidden
	| HttpApiError.NotFound
	| HttpApiError.InternalServerError;

const toRepoCreate = (
	installation: AppInstallationRepoCreate,
) => ({
	id: installation.id,
	organizationId: installation.organizationId,
	spaceId: installation.spaceId,
	appType: installation.appSlug,
	status: installation.status,
	lastCheckedAt: installation.lastCheckedAt,
	installedByUserId: installation.installedByUserId,
	updatedByUserId: installation.updatedByUserId,
	accessToken: installation.accessToken,
	refreshToken: installation.refreshToken,
	expiresAt: installation.expiresAt,
	scope: installation.scope,
	providerExternalId: installation.providerExternalId,
	providerDisplayName: installation.providerDisplayName,
	providerMetadata: installation.providerMetadata,
});

const toRepoUpdate = (updates: AppInstallationRepoUpdate) => {
	const { appSlug, ...rest } = updates;

	return {
		...rest,
		...(appSlug ? { appType: appSlug } : {}),
	};
};

class Api extends HttpApi.make("AppsConnectApi").add(
	HttpApiGroup.make("connect")
		.add(
			HttpApiEndpoint.post(
				"authorize",
				"/api/apps/connect/authorize",
			)
				.middleware(HttpAuthMiddleware)
				.setPayload(authorizeRequestSchema)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.get(
				"callback",
				"/api/apps/connect/callback",
			)
				.middleware(HttpAuthMiddleware)
				.setUrlParams(callbackQuerySchema)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.InternalServerError),
		)
		.add(
			HttpApiEndpoint.post(
				"refresh",
				"/api/apps/connect/refresh",
			)
				.middleware(HttpAuthMiddleware)
				.setPayload(refreshRequestSchema)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.InternalServerError),
		),
) {}


const ApiLive = (HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "connect", (handlers) =>
			Effect.gen(function* () {
				const repoService = yield* AppInstallationsRepo;
				const organisationsPolicy = yield* OrganisationsPolicy;

				const repo: AppInstallationsRepository = {
					findByOrgAndSlug: (organizationId, slug) =>
						repoService.findByOrgAndSlug(organizationId, slug).pipe(
							Effect.map((option) =>
								Option.map(option, (row) => {
									const { appType, ...rest } = row;
									return {
										...rest,
										appSlug: appType,
									} satisfies AppInstallationRepoRecord;
								}),
							),
					),
					create: (installation) =>
						repoService.create(toRepoCreate(installation)),
					updateById: (id, updates) =>
						repoService.updateById(id, toRepoUpdate(updates)),
					deleteById: (id) => repoService.deleteById(id),
				};

					return handlers
						.handle("authorize", ({ payload }) =>
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const module = getAppModuleByName(payload.app);

								if (!module) {
									throw new HttpApiError.BadRequest();
								}

								const authorizeEffect = module.oauth.authorize({
									user,
									organisationsPolicy,
								}) as Effect.Effect<HttpServerResponse, AuthorizeErrors, never>;

								return yield* authorizeEffect;
							}),
						)
						.handle("callback", ({ urlParams }) =>
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const query = urlParams as Record<string, string | undefined>;
								const stateValue = query.state;

								if (typeof stateValue !== "string" || stateValue.length === 0) {
									throw new HttpApiError.BadRequest();
								}

								const decodedState = yield* decodeAppState(stateValue).pipe(
									Effect.catchTag("AppStateError", (error: AppStateError) =>
										Effect.logError(error).pipe(
											Effect.flatMap(() =>
												Effect.fail(new HttpApiError.BadRequest()),
											),
										),
									),
								);

								const module = getAppModule(decodedState.app);

								if (!module) {
									throw new HttpApiError.BadRequest();
								}

								const callbackEffect = module.oauth.callback({
									user,
									organisationsPolicy,
									repo,
									query,
									rawState: stateValue,
									state: decodedState,
								}) as Effect.Effect<HttpServerResponse, AuthorizeErrors, never>;

								return yield* callbackEffect;
							}),
						)
						.handle("refresh", ({ payload }) =>
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const module = getAppModuleByName(payload.app);

								if (!module) {
									throw new HttpApiError.BadRequest();
								}

								const refreshEffect = module.oauth.refresh({
									user,
									organisationsPolicy,
									repo,
								}) as Effect.Effect<HttpServerResponse, RefreshErrors, never>;

								return yield* refreshEffect;
							}),
						);
			}),
		),
	),
	Layer.provideMerge(AppInstallationsRepo.Default),
)) as unknown;

const handler = apiToHandler(ApiLive as any);

export const POST = handler;
export const GET = handler;
