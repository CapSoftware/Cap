import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env/server";
import { Policy } from "@cap/web-domain";
import { HttpApiError, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Option, Schema } from "effect";

import { createAppHandlerError } from "../core/errors.ts";
import type {
	AppAuthorizeContext,
	AppCallbackContext,
	AppDispatchContext,
	AppDispatchResult,
	AppHandlers,
	AppModule,
	AppOperationContext,
	AppRefreshContext,
} from "../core/types.ts";
import type { AppStatePayload } from "../core/state.ts";
import {
	DISCORD_APP_TYPE,
	type DiscordAppSettings,
	type DiscordDispatchPayload,
	buildDiscordMessage,
	discordDefinition,
} from "./config.ts";
import { leaveGuild, listGuildTextChannels, sendMessageToChannel } from "./client.ts";

const DISCORD_API_BASE = "https://discord.com/api";
const DISCORD_OAUTH_BASE = `${DISCORD_API_BASE}/oauth2`;
const DISCORD_AUTHORIZE_URL = `${DISCORD_OAUTH_BASE}/authorize`;
const DISCORD_TOKEN_URL = `${DISCORD_OAUTH_BASE}/token`;
const DISCORD_USER_GUILDS_URL = `${DISCORD_API_BASE}/users/@me/guilds`;

type DiscordAppType = typeof DISCORD_APP_TYPE;
const STATE_COOKIE = "discord_oauth_state";
const VERIFIER_COOKIE = "discord_oauth_verifier";
const COOKIE_MAX_AGE_SECONDS = 600;
const DEFAULT_BOT_PERMISSIONS = BigInt(2048 + 16384);
const MANAGE_GUILD_PERMISSION = BigInt(1 << 5);

const toBase64Url = (buffer: Buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const generateCodeVerifier = () => toBase64Url(randomBytes(32));
const generateCodeChallenge = (verifier: string) =>
  toBase64Url(createHash("sha256").update(verifier).digest());

const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure,
  path: "/",
  maxAge: COOKIE_MAX_AGE_SECONDS,
});

const clearCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure,
  path: "/",
  maxAge: 0,
});

type DiscordTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  permissions: string;
  owner?: boolean;
  features?: ReadonlyArray<string>;
};

class DiscordConfigError extends Schema.TaggedError<DiscordConfigError>()(
  "DiscordConfigError",
  { missing: Schema.Array(Schema.String) },
) {}

class DiscordStateError extends Schema.TaggedError<DiscordStateError>()(
  "DiscordStateError",
  { message: Schema.String },
) {}

class DiscordOAuthError extends Schema.TaggedError<DiscordOAuthError>()(
  "DiscordOAuthError",
  { message: Schema.String },
) {}

class DiscordPermissionError extends Schema.TaggedError<DiscordPermissionError>()(
  "DiscordPermissionError",
  { reason: Schema.String },
) {}

const isPolicyDeniedError = (
  error: unknown,
): error is Policy.PolicyDeniedError => error instanceof Policy.PolicyDeniedError;

const logAndFailInternalError = (error: unknown) =>
  Effect.logError(error).pipe(
    Effect.flatMap(() =>
      Effect.fail(new HttpApiError.InternalServerError()),
    ),
  );

type DiscordEnvConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  requiredPermissions: bigint;
  secureCookies: boolean;
};

const resolveConfig = (): Effect.Effect<DiscordEnvConfig, DiscordConfigError> =>
  Effect.sync(() => {
    const env = serverEnv();
    const missing: string[] = [];

    if (!env.DISCORD_CLIENT_ID) missing.push("DISCORD_CLIENT_ID");
    if (!env.DISCORD_CLIENT_SECRET) missing.push("DISCORD_CLIENT_SECRET");

    let requiredPermissions = DEFAULT_BOT_PERMISSIONS;

    if (env.DISCORD_REQUIRED_PERMISSIONS) {
      try {
        requiredPermissions = BigInt(env.DISCORD_REQUIRED_PERMISSIONS);
      } catch {
        missing.push("DISCORD_REQUIRED_PERMISSIONS");
      }
    }

    if (missing.length > 0) {
      throw new DiscordConfigError({ missing: Array.from(new Set(missing)) });
    }

    return {
      clientId: env.DISCORD_CLIENT_ID!,
      clientSecret: env.DISCORD_CLIENT_SECRET!,
      redirectUri:
        env.DISCORD_REDIRECT_URI ??
        `${env.WEB_URL.replace(/\/$/, "")}/api/apps/connect/callback`,
      requiredPermissions,
      secureCookies: env.NODE_ENV === "production",
    } satisfies DiscordEnvConfig;
  });
const exchangeDiscordToken = (
  code: string,
  codeVerifier: string,
  config: DiscordEnvConfig,
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(DISCORD_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: config.redirectUri,
        }).toString(),
      });

      const payload = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new DiscordOAuthError({
          message:
            typeof payload.error_description === "string"
              ? payload.error_description
              : "Discord token exchange failed",
        });
      }

      return payload as unknown as DiscordTokenResponse;
    },
    catch: (cause) =>
      cause instanceof DiscordOAuthError
        ? cause
        : new DiscordOAuthError({
            message: `Failed to exchange Discord OAuth code: ${String(cause)}`,
          }),
  });

const refreshDiscordToken = (refreshToken: string, config: DiscordEnvConfig) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(DISCORD_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });

      const payload = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new DiscordOAuthError({
          message:
            typeof payload.error_description === "string"
              ? payload.error_description
              : "Discord token refresh failed",
        });
      }

      return payload as unknown as DiscordTokenResponse;
    },
    catch: (cause) =>
      cause instanceof DiscordOAuthError
        ? cause
        : new DiscordOAuthError({
            message: `Failed to refresh Discord access token: ${String(cause)}`,
          }),
  });

const fetchDiscordGuilds = (token: DiscordTokenResponse) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(DISCORD_USER_GUILDS_URL, {
        headers: {
          Authorization: `${token.token_type} ${token.access_token}`,
          Accept: "application/json",
        },
      });

      const payload = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        throw new DiscordOAuthError({
          message:
            typeof payload.error === "string"
              ? payload.error
              : "Failed to fetch Discord guilds",
        });
      }

      return payload as unknown as DiscordGuild[];
    },
    catch: (cause) =>
      cause instanceof DiscordOAuthError
        ? cause
        : new DiscordOAuthError({
            message: `Failed to fetch Discord guilds: ${String(cause)}`,
          }),
  });

const cookiesSchema = Schema.Struct({
  [STATE_COOKIE]: Schema.optional(Schema.String),
  [VERIFIER_COOKIE]: Schema.optional(Schema.String),
});

type InstallationMetadata = {
  icon: string | null;
  features: ReadonlyArray<string>;
  owner: boolean | undefined;
};

const buildMetadata = (guild: DiscordGuild): InstallationMetadata => ({
  icon: guild.icon ?? null,
  features: guild.features ?? [],
  owner: guild.owner,
});
export type DiscordAppStatePayload = AppStatePayload<DiscordAppType>;

type DiscordAppDependencies = {
  encodeAppState: (payload: AppStatePayload<string>) => string;
};

export const createDiscordApp = ({
  encodeAppState,
}: DiscordAppDependencies): AppModule<DiscordAppType> => {
  const authorize = (context: AppAuthorizeContext) =>
    Effect.gen(function* () {
      const { user, organisationsPolicy } = context;

      yield* organisationsPolicy
        .isOwner(user.activeOrganizationId)
        .pipe(
          Effect.catchIf(
            isPolicyDeniedError,
            () => Effect.fail(new HttpApiError.Forbidden()),
          ),
        );

      const config = yield* resolveConfig();
      const nonce = toBase64Url(randomBytes(16));
      const state = encodeAppState({
        app: DISCORD_APP_TYPE,
        orgId: user.activeOrganizationId,
        nonce,
      });
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authorizeUrl = new URL(DISCORD_AUTHORIZE_URL);
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
      authorizeUrl.searchParams.set("scope", "identify guilds bot");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("prompt", "consent");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set(
        "permissions",
        config.requiredPermissions.toString(),
      );

      return { authorizationUrl: authorizeUrl.toString() } as unknown;
    }).pipe(
      Effect.catchIf(
        (error): error is DiscordConfigError => error instanceof DiscordConfigError,
        logAndFailInternalError,
      ),
    );

  const callback = (context: AppCallbackContext<DiscordAppType>) =>
    Effect.gen(function* () {
      const { user, organisationsPolicy, repo, query, rawState, state } = context;

      yield* organisationsPolicy
        .isOwner(user.activeOrganizationId)
        .pipe(
          Effect.catchIf(
            isPolicyDeniedError,
            () => Effect.fail(new HttpApiError.Forbidden()),
          ),
        );

      const config = yield* resolveConfig();

      if (query.error) {
        throw new DiscordOAuthError({
          message: query.error_description ?? query.error,
        });
      }

      const cookies = yield* HttpServerRequest.schemaCookies(cookiesSchema);
      const storedState = cookies[STATE_COOKIE];
      const storedVerifier = cookies[VERIFIER_COOKIE];

      const code = query.code;
      const receivedState = query.state;

      if (typeof code !== "string" || typeof receivedState !== "string") {
        throw new DiscordStateError({
          message: "Missing Discord OAuth parameters",
        });
      }

      if (!storedState || !storedVerifier || storedState !== rawState) {
        throw new DiscordStateError({
          message: "Discord OAuth session mismatch",
        });
      }

      if (state.orgId !== user.activeOrganizationId) {
        throw new DiscordStateError({
          message: "Discord OAuth organization mismatch",
        });
      }

      const guildId = query.guild_id;

      if (typeof guildId !== "string" || guildId.length === 0) {
        throw new DiscordStateError({
          message: "Missing Discord guild selection",
        });
      }

      if (!query.permissions) {
        throw new DiscordPermissionError({
          reason: "missing_bot_permissions",
        });
      }

      let grantedPermissions: bigint;
      try {
        grantedPermissions = BigInt(query.permissions);
      } catch {
        throw new DiscordPermissionError({
          reason: "invalid_bot_permissions",
        });
      }

      if (
        (grantedPermissions & config.requiredPermissions) !==
        config.requiredPermissions
      ) {
        throw new DiscordPermissionError({
          reason: "insufficient_bot_permissions",
        });
      }

      const token = yield* exchangeDiscordToken(
        code,
        storedVerifier,
        config,
      );

      const guilds = yield* fetchDiscordGuilds(token);
      const guild = guilds.find((entry) => entry.id === guildId);

      if (!guild) {
        throw new DiscordPermissionError({
          reason: "guild_access",
        });
      }

      let userPermissions: bigint;
      try {
        userPermissions = BigInt(guild.permissions);
      } catch {
        throw new DiscordPermissionError({
          reason: "invalid_user_permissions",
        });
      }

      if ((userPermissions & MANAGE_GUILD_PERMISSION) === BigInt(0)) {
        throw new DiscordPermissionError({
          reason: "missing_manage_guild",
        });
      }

      const accessToken = yield* Effect.promise(() => encrypt(token.access_token));
      const refreshToken = token.refresh_token
        ? yield* Effect.promise(() => encrypt(token.refresh_token!))
        : null;
      const scope = token.scope
        ? yield* Effect.promise(() => encrypt(token.scope!))
        : null;

      const expiresAt = new Date(Date.now() + token.expires_in * 1000);
      const metadata = buildMetadata(guild);

      const existing = yield* repo.findByOrgAndType(
        state.orgId,
        DISCORD_APP_TYPE,
      );

      if (Option.isSome(existing)) {
        yield* repo.updateById(existing.value.id, {
          accessToken,
          refreshToken,
          expiresAt,
          scope,
          status: "connected",
          updatedByUserId: user.id,
          providerExternalId: guild.id,
          providerDisplayName: guild.name,
          providerMetadata: metadata,
          lastCheckedAt: new Date(),
        });
      } else {
        yield* repo.create({
          organizationId: state.orgId,
          spaceId: null,
          appType: DISCORD_APP_TYPE,
          status: "connected",
          lastCheckedAt: new Date(),
          installedByUserId: user.id,
          updatedByUserId: user.id,
          accessToken,
          refreshToken,
          expiresAt,
          scope,
          providerExternalId: guild.id,
          providerDisplayName: guild.name,
          providerMetadata: metadata,
        });
      }

      return HttpServerResponse.html(
        "<html><body><script>window.close();</script><p>Discord connected. You may close this window.</p></body></html>",
      ) as unknown;
    });

  const refresh = (context: AppRefreshContext) =>
    Effect.gen(function* () {
      const { user, organisationsPolicy, repo } = context;

      yield* organisationsPolicy
        .isOwner(user.activeOrganizationId)
        .pipe(
          Effect.catchIf(
            isPolicyDeniedError,
            () => Effect.fail(new HttpApiError.Forbidden()),
          ),
        );

      const config = yield* resolveConfig();

      const installation = yield* repo.findByOrgAndType(
        user.activeOrganizationId,
        DISCORD_APP_TYPE,
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
          new DiscordOAuthError({
            message: `Failed to decrypt refresh token: ${String(cause)}`,
          }),
      });

      const refreshed = yield* refreshDiscordToken(
        decryptedRefreshToken,
        config,
      );

      const accessToken = yield* Effect.promise(() => encrypt(refreshed.access_token));
      const refreshToken = refreshed.refresh_token
        ? yield* Effect.promise(() => encrypt(refreshed.refresh_token!))
        : installation.value.refreshToken!;
      const scope = refreshed.scope
        ? yield* Effect.promise(() => encrypt(refreshed.scope!))
        : installation.value.scope!;

      const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

      yield* repo.updateById(installation.value.id, {
        accessToken,
        refreshToken,
        scope,
        expiresAt,
        status: "connected",
        updatedByUserId: user.id,
        lastCheckedAt: new Date(),
      });

      return HttpServerResponse.json({
        refreshed: true,
        expiresAt: expiresAt.toISOString(),
      }) as unknown;
    }).pipe(
      Effect.catchIf(
        (error): error is DiscordConfigError => error instanceof DiscordConfigError,
        logAndFailInternalError,
      ),
      Effect.catchIf(
        (error): error is DiscordOAuthError => error instanceof DiscordOAuthError,
        logAndFailInternalError,
      ),
    );

  const missingGuildError = (operation: string, reason: string) =>
    createAppHandlerError({
      app: DISCORD_APP_TYPE,
      operation,
      reason,
      retryable: false,
    });

  const handlers = {
    pause: (_context: AppOperationContext<DiscordAppType, DiscordAppSettings>) =>
      Effect.void,
    resume: (
      _context: AppOperationContext<DiscordAppType, DiscordAppSettings>,
    ) => Effect.void,
    uninstall: (context: AppOperationContext<DiscordAppType, DiscordAppSettings>) => {
      const guildId = context.installation.providerExternalId;

      if (!guildId) {
        return Effect.void;
      }

      return leaveGuild(guildId).pipe(Effect.map(() => undefined));
    },
    listDestinations: (
      context: AppOperationContext<DiscordAppType, DiscordAppSettings>,
    ) =>
      Effect.gen(function* () {
        const guildId = context.installation.providerExternalId;

        if (!guildId) {
          return yield* Effect.fail(
            missingGuildError(
              "listDestinations",
              "Discord installation is missing a guild identifier",
            ),
          );
        }

        return yield* listGuildTextChannels(guildId);
      }),
    dispatch: (
      context: AppDispatchContext<
        DiscordAppType,
        DiscordAppSettings,
        DiscordDispatchPayload
      >,
    ) =>
      Effect.gen(function* () {
        const channelId = context.settings.channelId.trim();

        if (channelId.length === 0) {
          return yield* Effect.fail(
            createAppHandlerError({
              app: DISCORD_APP_TYPE,
              operation: "dispatch",
              reason: "Discord channel is not configured",
              retryable: false,
            }),
          );
        }

        const message = buildDiscordMessage(context.payload);

        yield* Effect.logDebug(
          `Dispatching Discord message to channel ${channelId} for installation ${context.installation.id}`,
        );

        const response = yield* sendMessageToChannel(channelId, message);

        return {
          remoteId: response.id,
          metadata: {
            channelId: response.channel_id,
            channelName: context.settings.channelName,
          },
        } satisfies AppDispatchResult;
      }),
  };

  const module: AppModule<DiscordAppType, DiscordAppSettings, DiscordDispatchPayload> = {
    type: DISCORD_APP_TYPE,
    oauth: {
      authorize: authorize as (context: AppAuthorizeContext) => Effect.Effect<unknown, unknown, never>,
      callback: callback as (context: AppCallbackContext<DiscordAppType>) => Effect.Effect<unknown, unknown, never>,
      refresh: refresh as (context: AppRefreshContext) => Effect.Effect<unknown, unknown, never>,
    },
    definition: discordDefinition,
    handlers,
  };

  return module as AppModule<DiscordAppType>;
};

export const createApp = createDiscordApp;
