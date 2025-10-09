import { randomBytes } from "node:crypto";

import { decrypt, encrypt } from "@cap/database/crypto";
import type { AppInstallationStatus } from "@cap/database/schema";
import { HttpApiError, HttpServerResponse } from "@effect/platform";
import { Effect, Option } from "effect";

import { getServerEnv } from "../app-env.ts";
import { AppHandlerError, createAppHandlerError } from "../errors.ts";
import { createAppModuleContext } from "../module-context.ts";
import { generatePkcePair } from "../oauth/pkce.ts";
import {
	createOAuthSessionManager,
	type OAuthSessionOptions,
} from "../oauth/session.ts";
import { ensureOrganisationOwner } from "../policy.ts";
import type { AppStatePayload } from "../state.ts";
import type {
	AppAuthorizeContext,
	AppCallbackContext,
	AppDefinition,
	AppDestination,
	AppDispatchContext,
	AppDispatchResult,
	AppModule,
	AppOperationContext,
	AppRefreshContext,
} from "../types.ts";

const logAndFailInternalError = (error: unknown) =>
	Effect.logError(error).pipe(
		Effect.flatMap(() => Effect.fail(new HttpApiError.InternalServerError())),
	);

export type OAuthTokenSet = {
	accessToken: string;
	refreshToken?: string | null;
	scope?: string | null;
	expiresIn?: number | null;
	expiresAt?: Date | null;
	tokenType?: string | null;
};

export class OAuthConfigError extends Error {
	readonly missing?: ReadonlyArray<string>;

	constructor(message: string, options?: { missing?: ReadonlyArray<string> }) {
		super(message);
		this.name = "OAuthConfigError";
		this.missing = options?.missing;
	}
}

export class OAuthCallbackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthCallbackError";
	}
}

export class OAuthStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthStateError";
	}
}

export class OAuthPermissionError extends Error {
	readonly reason: string;

	constructor(reason: string, message?: string) {
		super(message ?? reason);
		this.name = "OAuthPermissionError";
		this.reason = reason;
	}
}

export class OAuthProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthProviderError";
	}
}

export type OAuthConfigHelpers<AppType extends string> = {
	slug: AppType;
	appEnv: Readonly<Record<string, string>>;
	serverEnv: Readonly<Record<string, unknown>>;
};

export type OAuthHandlerDependencies<AppType extends string> = {
	resolveAppSlug: () => AppType;
	getAppEnv: () => Readonly<Record<string, string>>;
};

export type OAuthInstallationDetails = {
	providerExternalId: string;
	providerDisplayName: string;
	metadata?: Record<string, unknown> | null;
	status?: AppInstallationStatus;
	spaceId?: string | null;
};

type OptionalPromise<T> = Promise<T> | T;

export type OAuthAppHandlers<
	AppType extends string,
	Settings,
	DispatchPayload,
> = {
	pause?: (
		context: AppOperationContext<AppType, Settings>,
	) => OptionalPromise<void>;
	resume?: (
		context: AppOperationContext<AppType, Settings>,
	) => OptionalPromise<void>;
	uninstall?: (
		context: AppOperationContext<AppType, Settings>,
	) => OptionalPromise<void>;
	listDestinations?: (
		context: AppOperationContext<AppType, Settings>,
	) => OptionalPromise<ReadonlyArray<AppDestination>>;
	dispatch: (
		context: AppDispatchContext<AppType, Settings, DispatchPayload>,
	) => OptionalPromise<AppDispatchResult>;
};

export type OAuthAppOptions<
	AppType extends string,
	Settings,
	DispatchPayload,
	Config extends { secureCookies: boolean },
	CallbackData,
> = {
	importMetaUrl: string;
	definition: AppDefinition<AppType, Settings>;
	encodeAppState: (payload: AppStatePayload<AppType>) => string;
	session: OAuthSessionOptions;
	resolveConfig: (
		helpers: OAuthConfigHelpers<AppType>,
	) => Config | Promise<Config>;
	authorize: {
		buildAuthorizeUrl: (input: {
			config: Config;
			context: AppAuthorizeContext;
			state: string;
			statePayload: AppStatePayload<AppType>;
			codeChallenge: string;
			nonce: string;
		}) => string | URL;
	};
	callback: {
		parse: (input: {
			query: Record<string, string | undefined>;
			config: Config;
			context: AppCallbackContext<AppType>;
		}) => CallbackData;
	};
	tokens: {
		exchange: (input: {
			code: string;
			codeVerifier: string;
			config: Config;
			callbackData: CallbackData;
			query: Record<string, string | undefined>;
			context: AppCallbackContext<AppType>;
		}) => Promise<OAuthTokenSet>;
		refresh?: (input: {
			refreshToken: string;
			config: Config;
			context: AppRefreshContext;
		}) => Promise<OAuthTokenSet>;
	};
	installation: {
		derive: (input: {
			tokens: OAuthTokenSet;
			config: Config;
			callbackData: CallbackData;
			context: AppCallbackContext<AppType>;
		}) => Promise<OAuthInstallationDetails>;
	};
	handlers: (
		dependencies: OAuthHandlerDependencies<AppType>,
	) => OAuthAppHandlers<AppType, Settings, DispatchPayload>;
	requireOrganisationOwner?: boolean;
};

const ensureStateMatches = <AppType extends string>(
	context: AppCallbackContext<AppType>,
	sessionState: string | undefined,
	sessionVerifier: string | undefined,
) => {
	if (!sessionState || !sessionVerifier || sessionState !== context.rawState) {
		throw new OAuthStateError("OAuth session mismatch");
	}

	if (context.state.orgId !== context.user.activeOrganizationId) {
		throw new OAuthStateError("OAuth organization mismatch");
	}
};

const resolveExpiresAt = (tokens: OAuthTokenSet) => {
	if (tokens.expiresAt) return tokens.expiresAt;
	if (typeof tokens.expiresIn === "number") {
		return new Date(Date.now() + Math.max(0, tokens.expiresIn) * 1000);
	}

	return null;
};

const wrapOperation = <
	AppType extends string,
	Settings,
	DispatchPayload,
	Context,
	Result,
>(
	resolveAppSlug: () => AppType,
	operation: string,
	handler: ((context: Context) => OptionalPromise<Result>) | undefined,
	fallback: () => Result,
) => {
	if (!handler) {
		return (_: Context) => Effect.sync(fallback);
	}

	return (context: Context) =>
		Effect.tryPromise({
			try: async () => await handler(context),
			catch: (cause) =>
				cause instanceof AppHandlerError
					? cause
					: createAppHandlerError({
							app: resolveAppSlug(),
							operation,
							reason:
								cause instanceof Error
									? cause.message
									: `Unknown ${operation} error`,
							retryable: false,
							detail: cause,
						}),
		});
};

export const createOAuthAppModule = <
	AppType extends string,
	Settings,
	DispatchPayload,
	Config extends { secureCookies: boolean },
	CallbackData,
>(
	options: OAuthAppOptions<
		AppType,
		Settings,
		DispatchPayload,
		Config,
		CallbackData
	>,
): AppModule<AppType, Settings, DispatchPayload> => {
	const { resolveAppSlug, resolveAppEnv } = createAppModuleContext<AppType>(
		options.importMetaUrl,
	);
	const sessionManager = createOAuthSessionManager(options.session);

	const resolveConfigEffect = () =>
		Effect.tryPromise({
			try: () =>
				Promise.resolve(
					options.resolveConfig({
						slug: resolveAppSlug(),
						appEnv: resolveAppEnv(),
						serverEnv: getServerEnv(),
					}),
				),
			catch: (cause) =>
				cause instanceof OAuthConfigError
					? cause
					: new OAuthConfigError(
							`Failed to resolve configuration: ${
								cause instanceof Error ? cause.message : String(cause)
							}`,
						),
		});

	const authorize = (context: AppAuthorizeContext) =>
		Effect.gen(function* () {
			if (options.requireOrganisationOwner !== false) {
				yield* ensureOrganisationOwner(
					context.organisationsPolicy,
					context.user.activeOrganizationId,
				);
			}

			const config = yield* resolveConfigEffect();
			const nonce = randomBytes(16).toString("base64url");
			const statePayload: AppStatePayload<AppType> = {
				app: resolveAppSlug(),
				orgId: context.user.activeOrganizationId,
				nonce,
			};
			const state = options.encodeAppState(statePayload);

			const { codeVerifier, codeChallenge } = generatePkcePair();

			const authorizeUrlRaw = options.authorize.buildAuthorizeUrl({
				config,
				context,
				state,
				statePayload,
				codeChallenge,
				nonce,
			});

			const authorizationUrl =
				typeof authorizeUrlRaw === "string"
					? authorizeUrlRaw
					: authorizeUrlRaw.toString();

			const authorizeResponse = yield* HttpServerResponse.json({
				authorizationUrl,
			});
			const response = yield* sessionManager.store(
				authorizeResponse,
				{ state, verifier: codeVerifier },
				config.secureCookies,
			);

			return response as unknown;
		}).pipe(
			Effect.catchIf(
				(error): error is OAuthConfigError => error instanceof OAuthConfigError,
				logAndFailInternalError,
			),
		);

	const callback = (context: AppCallbackContext<AppType>) =>
		Effect.gen(function* () {
			if (options.requireOrganisationOwner !== false) {
				yield* ensureOrganisationOwner(
					context.organisationsPolicy,
					context.user.activeOrganizationId,
				);
			}

			const config = yield* resolveConfigEffect();

			if (context.query.error) {
				throw new OAuthCallbackError(
					context.query.error_description ?? context.query.error,
				);
			}

			const code = context.query.code;
			const receivedState = context.query.state;

			if (typeof code !== "string" || code.length === 0) {
				throw new OAuthCallbackError("Missing OAuth authorization code");
			}

			if (typeof receivedState !== "string" || receivedState.length === 0) {
				throw new OAuthCallbackError("Missing OAuth state parameter");
			}

			const session = yield* sessionManager.read();
			ensureStateMatches(context, session.state, session.verifier);

			const callbackData = options.callback.parse({
				query: context.query,
				config,
				context,
			});

			const tokens = yield* Effect.tryPromise({
				try: () =>
					options.tokens.exchange({
						code,
						codeVerifier: session.verifier!,
						config,
						callbackData,
						query: context.query,
						context,
					}),
				catch: (cause) =>
					cause instanceof OAuthProviderError
						? cause
						: new OAuthProviderError(
								cause instanceof Error
									? cause.message
									: "Failed to exchange OAuth code",
							),
			});

			const installDetails = yield* Effect.tryPromise({
				try: () =>
					options.installation.derive({
						tokens,
						config,
						callbackData,
						context,
					}),
				catch: (cause) => cause,
			});

			const refreshTokenValue = tokens.refreshToken ?? null;
			const scopeValue = tokens.scope ?? null;

			const encryptedAccessToken = yield* Effect.promise(() =>
				encrypt(tokens.accessToken),
			);
			const encryptedRefreshToken = refreshTokenValue
				? yield* Effect.promise(() => encrypt(refreshTokenValue))
				: null;
			const encryptedScope = scopeValue
				? yield* Effect.promise(() => encrypt(scopeValue))
				: null;

			const expiresAt = resolveExpiresAt(tokens);
			const now = new Date();

			const existing = yield* context.repo.findByOrgAndSlug(
				context.state.orgId,
				resolveAppSlug(),
			);

			if (Option.isSome(existing)) {
				yield* context.repo.updateById(existing.value.id, {
					accessToken: encryptedAccessToken,
					refreshToken: encryptedRefreshToken,
					expiresAt,
					scope: encryptedScope,
					status: installDetails.status ?? "connected",
					lastCheckedAt: now,
					updatedByUserId: context.user.id,
					providerExternalId: installDetails.providerExternalId,
					providerDisplayName: installDetails.providerDisplayName,
					providerMetadata: installDetails.metadata ?? null,
					spaceId: installDetails.spaceId ?? null,
				});
			} else {
				yield* context.repo.create({
					organizationId: context.state.orgId,
					spaceId: installDetails.spaceId ?? null,
					appSlug: resolveAppSlug(),
					status: installDetails.status ?? "connected",
					lastCheckedAt: now,
					installedByUserId: context.user.id,
					updatedByUserId: context.user.id,
					accessToken: encryptedAccessToken,
					refreshToken: encryptedRefreshToken,
					expiresAt,
					scope: encryptedScope,
					providerExternalId: installDetails.providerExternalId,
					providerDisplayName: installDetails.providerDisplayName,
					providerMetadata: installDetails.metadata ?? null,
				});
			}

			const response = HttpServerResponse.html(
				"<html><body><script>window.close();</script><p>OAuth connection complete. You may close this window.</p></body></html>",
			);

			return (yield* sessionManager.clear(
				response,
				config.secureCookies,
			)) as unknown;
		}).pipe(
			Effect.catchIf(
				(error): error is OAuthConfigError => error instanceof OAuthConfigError,
				logAndFailInternalError,
			),
			Effect.catchIf(
				(error): error is OAuthProviderError =>
					error instanceof OAuthProviderError,
				logAndFailInternalError,
			),
		);

	const refresh = (context: AppRefreshContext) =>
		Effect.gen(function* () {
			if (options.requireOrganisationOwner !== false) {
				yield* ensureOrganisationOwner(
					context.organisationsPolicy,
					context.user.activeOrganizationId,
				);
			}

			if (!options.tokens.refresh) {
				throw new HttpApiError.BadRequest();
			}

			const config = yield* resolveConfigEffect();

			const installation = yield* context.repo.findByOrgAndSlug(
				context.user.activeOrganizationId,
				resolveAppSlug(),
			);

			if (Option.isNone(installation)) {
				throw new HttpApiError.NotFound();
			}

			if (!installation.value.refreshToken) {
				throw new HttpApiError.BadRequest();
			}

			const decryptedRefreshToken = yield* Effect.tryPromise({
				try: () => decrypt(installation.value.refreshToken!),
				catch: (cause) =>
					new OAuthProviderError(
						`Failed to decrypt refresh token: ${
							cause instanceof Error ? cause.message : String(cause)
						}`,
					),
			});

			const refreshed = yield* Effect.tryPromise({
				try: () =>
					options.tokens.refresh!({
						refreshToken: decryptedRefreshToken,
						config,
						context,
					}),
				catch: (cause) =>
					cause instanceof OAuthProviderError
						? cause
						: new OAuthProviderError(
								cause instanceof Error
									? cause.message
									: "Failed to refresh access token",
							),
			});

			const refreshedRefreshToken = refreshed.refreshToken ?? null;
			const refreshedScope = refreshed.scope ?? null;

			const encryptedAccessToken = yield* Effect.promise(() =>
				encrypt(refreshed.accessToken),
			);
			const encryptedRefreshToken = refreshedRefreshToken
				? yield* Effect.promise(() => encrypt(refreshedRefreshToken))
				: installation.value.refreshToken;
			const encryptedScope = refreshedScope
				? yield* Effect.promise(() => encrypt(refreshedScope))
				: installation.value.scope;

			const expiresAt = resolveExpiresAt(refreshed);

			yield* context.repo.updateById(installation.value.id, {
				accessToken: encryptedAccessToken,
				refreshToken: encryptedRefreshToken,
				scope: encryptedScope,
				expiresAt,
				status: "connected",
				updatedByUserId: context.user.id,
				lastCheckedAt: new Date(),
			});

			const response = yield* HttpServerResponse.json({
				refreshed: true,
				expiresAt: expiresAt?.toISOString() ?? null,
			});

			return response as unknown;
		}).pipe(
			Effect.catchIf(
				(error): error is OAuthConfigError => error instanceof OAuthConfigError,
				logAndFailInternalError,
			),
			Effect.catchIf(
				(error): error is OAuthProviderError =>
					error instanceof OAuthProviderError,
				logAndFailInternalError,
			),
		);

	const handlerImplementations = options.handlers({
		resolveAppSlug,
		getAppEnv: resolveAppEnv,
	});

	const dispatchHandler = handlerImplementations.dispatch;
	if (!dispatchHandler) {
		throw new Error(
			`Dispatch handler is required for app integration '${resolveAppSlug()}'`,
		);
	}

	const handlers = {
		pause: wrapOperation<
			AppType,
			Settings,
			DispatchPayload,
			AppOperationContext<AppType, Settings>,
			void
		>(resolveAppSlug, "pause", handlerImplementations.pause, () => undefined),
		resume: wrapOperation<
			AppType,
			Settings,
			DispatchPayload,
			AppOperationContext<AppType, Settings>,
			void
		>(resolveAppSlug, "resume", handlerImplementations.resume, () => undefined),
		uninstall: wrapOperation<
			AppType,
			Settings,
			DispatchPayload,
			AppOperationContext<AppType, Settings>,
			void
		>(
			resolveAppSlug,
			"uninstall",
			handlerImplementations.uninstall,
			() => undefined,
		),
		listDestinations: wrapOperation<
			AppType,
			Settings,
			DispatchPayload,
			AppOperationContext<AppType, Settings>,
			ReadonlyArray<AppDestination>
		>(
			resolveAppSlug,
			"listDestinations",
			handlerImplementations.listDestinations,
			() => [],
		),
		dispatch: wrapOperation<
			AppType,
			Settings,
			DispatchPayload,
			AppDispatchContext<AppType, Settings, DispatchPayload>,
			AppDispatchResult
		>(
			resolveAppSlug,
			"dispatch",
			dispatchHandler,
			() => ({}) as AppDispatchResult,
		),
	} satisfies AppModule<AppType, Settings, DispatchPayload>["handlers"];

	return {
		slug: resolveAppSlug(),
		oauth: { authorize, callback, refresh },
		definition: options.definition,
		handlers,
	} satisfies AppModule<AppType, Settings, DispatchPayload>;
};
