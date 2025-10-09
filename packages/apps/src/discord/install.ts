import { createAppHandlerError } from "../core/errors.ts";
import {
	createAppSettings,
	type InferAppSettings,
	stringSetting,
} from "../core/settings.ts";
import type { AppStatePayload } from "../core/state.ts";
import {
	createOAuthAppModule,
	type OAuthAppHandlers,
	OAuthCallbackError,
	OAuthConfigError,
	type OAuthHandlerDependencies,
	OAuthPermissionError,
	OAuthProviderError,
} from "../core/templates/oauth-app.ts";
import { getAppConfig } from "../core/manifest.ts";

const discordAppSettings = createAppSettings({
	channelId: stringSetting,
	channelName: stringSetting,
	spaceId: stringSetting,
});

export const DiscordAppSettingsSchema = discordAppSettings.schema;
export type DiscordAppSettings = InferAppSettings<typeof discordAppSettings>;
export const DiscordAppSettings = DiscordAppSettingsSchema;

const DISCORD_API_BASE = "https://discord.com/api" as const;
const DISCORD_API_V10 = `${DISCORD_API_BASE}/v10` as const;
const DISCORD_OAUTH_BASE = `${DISCORD_API_BASE}/oauth2` as const;
const DISCORD_AUTHORIZE_URL = `${DISCORD_OAUTH_BASE}/authorize` as const;
const DISCORD_TOKEN_URL = `${DISCORD_OAUTH_BASE}/token` as const;
const DISCORD_USER_GUILDS_URL = `${DISCORD_API_BASE}/users/@me/guilds` as const;

const STATE_COOKIE = "discord_oauth_state" as const;
const VERIFIER_COOKIE = "discord_oauth_verifier" as const;
const COOKIE_MAX_AGE_SECONDS = 600;

const DEFAULT_BOT_PERMISSIONS = BigInt(2048 + 16384);
const MANAGE_GUILD_PERMISSION = BigInt(1 << 5);

export const discordManifest = getAppConfig(import.meta.url);

export type DiscordAppSlug = typeof discordManifest.slug;

export type DiscordDispatchPayload = {
	readonly type: "video.published";
	readonly videoId: string;
	readonly videoTitle: string;
	readonly videoDescription: string | null;
	readonly videoUrl: string;
	readonly spaceName: string;
	readonly organizationName: string;
	readonly authorName: string;
	readonly authorAvatarUrl: string | null;
};

export type DiscordMessagePayload = {
	embeds: ReadonlyArray<Record<string, unknown>>;
	components?: ReadonlyArray<Record<string, unknown>>;
	allowed_mentions?: { parse: [] };
};

const truncate = (value: string, max: number) =>
	value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const DEFAULT_DESCRIPTION = "New recording ready to watch.";

export const buildDiscordMessage = (
	payload: DiscordDispatchPayload,
): DiscordMessagePayload => {
	if (payload.type !== "video.published") {
		return {
			embeds: [],
			allowed_mentions: { parse: [] },
		};
	}

	const title = truncate(payload.videoTitle, 80);
	const descriptionSource = payload.videoDescription?.trim();
	const description = truncate(
		descriptionSource && descriptionSource.length > 0
			? descriptionSource
			: DEFAULT_DESCRIPTION,
		140,
	);

	return {
		embeds: [
			{
				title,
				description,
				url: payload.videoUrl,
				author: {
					name: payload.authorName,
					icon_url: payload.authorAvatarUrl ?? undefined,
				},
				footer: {
					text: `${payload.spaceName} • ${payload.organizationName}`,
				},
			},
		],
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 5,
						label: "Watch recording",
						url: payload.videoUrl,
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	};
};

export const discordDefinition = {
	slug: discordManifest.slug,
	displayName: discordManifest.displayName,
	description: discordManifest.description,
	icon: discordManifest.icon,
	category: discordManifest.category,
	settings: discordAppSettings,
};

const parseBigInt = (value: string, error: Error) => {
	try {
		return BigInt(value);
	} catch {
		throw error;
	}
};

type DiscordEnvConfig = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	requiredPermissions: bigint;
	secureCookies: boolean;
};

type DiscordCallbackData = {
	guildId: string;
	grantedPermissions: bigint;
};

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
	owner?: boolean;
	features?: ReadonlyArray<string>;
	permissions: string;
};

type DiscordChannelResponse = {
	id: string;
	name: string;
	type: number;
	parent_id?: string | null;
};

type DiscordMessageResponse = {
	id: string;
	channel_id: string;
};

const readJson = async <T>(response: Response): Promise<T | undefined> => {
	try {
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
};

const requestDiscordToken = async (
	params: Record<string, string>,
	errorMessage: string,
): Promise<DiscordTokenResponse> => {
	let response: Response;

	try {
		response = await fetch(DISCORD_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams(params).toString(),
		});
	} catch (cause) {
		throw new OAuthProviderError(
			`${errorMessage}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}

	const payload = await readJson<Record<string, unknown>>(response);

	if (!response.ok) {
		const messageCandidate =
			payload && typeof payload === "object"
				? typeof payload.error_description === "string"
					? payload.error_description
					: typeof payload.error === "string"
						? payload.error
						: undefined
				: undefined;

		throw new OAuthProviderError(messageCandidate ?? errorMessage);
	}

	if (!payload || typeof payload !== "object") {
		throw new OAuthProviderError(errorMessage);
	}

	return payload as unknown as DiscordTokenResponse;
};

const fetchDiscordGuilds = async (tokens: {
	accessToken: string;
	tokenType?: string | null;
}): Promise<DiscordGuild[]> => {
	let response: Response;

	try {
		response = await fetch(DISCORD_USER_GUILDS_URL, {
			headers: {
				Authorization: `${tokens.tokenType ?? "Bearer"} ${tokens.accessToken}`,
				Accept: "application/json",
			},
		});
	} catch (cause) {
		throw new OAuthProviderError(
			`Failed to fetch Discord guilds: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}

	const payload = await readJson<DiscordGuild[] | { error?: string }>(response);

	if (!response.ok || !Array.isArray(payload)) {
		const messageCandidate =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? typeof payload.error === "string"
					? payload.error
					: undefined
				: undefined;

		throw new OAuthProviderError(
			messageCandidate ?? "Failed to fetch Discord guilds",
		);
	}

	return payload;
};

const buildInstallationMetadata = (guild: DiscordGuild) => ({
	icon: guild.icon ?? null,
	features: guild.features ?? [],
	owner: guild.owner,
});

const createDiscordHandlers = (
	dependencies: OAuthHandlerDependencies<DiscordAppSlug>,
): OAuthAppHandlers<
	DiscordAppSlug,
	DiscordAppSettings,
	DiscordDispatchPayload
> => {
	const { resolveAppSlug, getAppEnv } = dependencies;

	const discordApiRequest = async <T>(
		operation: string,
		path: string,
		init: RequestInit = {},
	): Promise<T> => {
		const token = getAppEnv().DISCORD_APP_BOT_TOKEN;

		let response: Response;

		try {
			response = await fetch(`${DISCORD_API_V10}${path}`, {
				...init,
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bot ${token}`,
					...(init.headers ?? {}),
				},
			});
		} catch (cause) {
			throw createAppHandlerError({
				app: resolveAppSlug(),
				operation,
				reason: `Discord request failed: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
				retryable: true,
			});
		}

		const body =
			response.status === 204 ? undefined : await readJson<unknown>(response);

		if (!response.ok) {
			const message =
				body && typeof body === "object" && body !== null && "message" in body
					? String(
							(body as { message?: unknown }).message ??
								"Unknown Discord error",
						)
					: `Discord request failed (${response.status})`;

			throw createAppHandlerError({
				app: resolveAppSlug(),
				operation,
				reason: message,
				retryable: response.status >= 500 || response.status === 429,
				status: response.status,
				detail: body,
			});
		}

		return body as T;
	};

	const ensureGuildId = (
		operation: string,
		guildId: string | null | undefined,
	) => {
		if (!guildId) {
			throw createAppHandlerError({
				app: resolveAppSlug(),
				operation,
				reason: "Discord installation is missing a guild identifier",
				retryable: false,
			});
		}

		return guildId;
	};

	return {
		uninstall: async (context) => {
			const guildId = context.installation.providerExternalId;
			if (!guildId) return;

			await discordApiRequest<unknown>(
				"uninstall",
				`/users/@me/guilds/${guildId}`,
				{ method: "DELETE" },
			);
		},
		listDestinations: async (context) => {
			const guildId = ensureGuildId(
				"listDestinations",
				context.installation.providerExternalId,
			);

			const channels = await discordApiRequest<DiscordChannelResponse[]>(
				"listDestinations",
				`/guilds/${guildId}/channels`,
				{ method: "GET" },
			);

			return channels
				.filter((channel) => channel.type === 0 || channel.type === 5)
				.map((channel) => ({
					id: channel.id,
					name: channel.name,
					type: channel.type === 5 ? "announcement" : "text",
					parentId: channel.parent_id ?? null,
				}));
		},
		dispatch: async (context) => {
			const channelId = context.settings.channelId.trim();

			if (channelId.length === 0) {
				throw createAppHandlerError({
					app: resolveAppSlug(),
					operation: "dispatch",
					reason: "Discord channel is not configured",
					retryable: false,
				});
			}

			const message = buildDiscordMessage(context.payload);

			const response = await discordApiRequest<DiscordMessageResponse>(
				"dispatch",
				`/channels/${channelId}/messages`,
				{
					method: "POST",
					body: JSON.stringify(message),
				},
			);

			return {
				remoteId: response.id,
				metadata: {
					channelId: response.channel_id,
					channelName: context.settings.channelName,
				},
			};
		},
	};
};

const createDiscordApp = ({
	encodeAppState,
}: {
	encodeAppState: (payload: AppStatePayload<string>) => string;
}) =>
	createOAuthAppModule<
		DiscordAppSlug,
		DiscordAppSettings,
		DiscordDispatchPayload,
		DiscordEnvConfig,
		DiscordCallbackData
	>({
		importMetaUrl: import.meta.url,
		definition: discordDefinition,
		encodeAppState: encodeAppState as (
			payload: AppStatePayload<DiscordAppSlug>,
		) => string,
		session: {
			stateCookie: STATE_COOKIE,
			verifierCookie: VERIFIER_COOKIE,
			maxAgeSeconds: COOKIE_MAX_AGE_SECONDS,
		},
		resolveConfig: ({ appEnv, serverEnv }) => {
			let requiredPermissions = DEFAULT_BOT_PERMISSIONS;

			const requiredPermissionsRaw =
				typeof serverEnv.DISCORD_REQUIRED_PERMISSIONS === "string"
					? serverEnv.DISCORD_REQUIRED_PERMISSIONS.trim()
					: undefined;

			if (requiredPermissionsRaw && requiredPermissionsRaw.length > 0) {
				requiredPermissions = parseBigInt(
					requiredPermissionsRaw,
					new OAuthConfigError("Invalid DISCORD_REQUIRED_PERMISSIONS value", {
						missing: ["DISCORD_REQUIRED_PERMISSIONS"],
					}),
				);
			}

			const redirectUriRaw =
				typeof serverEnv.DISCORD_REDIRECT_URI === "string"
					? serverEnv.DISCORD_REDIRECT_URI.trim()
					: "";
			const webUrlRaw =
				typeof serverEnv.WEB_URL === "string" ? serverEnv.WEB_URL.trim() : "";

			let redirectUri = redirectUriRaw;

			if (redirectUri.length === 0) {
				if (webUrlRaw.length === 0) {
					throw new OAuthConfigError(
						"WEB_URL is required to derive the Discord redirect URI",
						{ missing: ["WEB_URL"] },
					);
				}

				redirectUri = `${webUrlRaw.replace(/\/$/, "")}/api/apps/connect/callback`;
			}

			return {
				clientId: appEnv.DISCORD_CLIENT_ID,
				clientSecret: appEnv.DISCORD_CLIENT_SECRET,
				redirectUri,
				requiredPermissions,
				secureCookies: serverEnv.NODE_ENV === "production",
			} satisfies DiscordEnvConfig;
		},
		authorize: {
			buildAuthorizeUrl: ({ config, state, codeChallenge }) => {
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

				return authorizeUrl;
			},
		},
		callback: {
			parse: ({ query, config }) => {
				const guildId =
					typeof query.guild_id === "string" ? query.guild_id.trim() : "";

				if (guildId.length === 0) {
					throw new OAuthCallbackError("Missing Discord guild selection");
				}

				const permissionsRaw =
					typeof query.permissions === "string" ? query.permissions.trim() : "";

				if (permissionsRaw.length === 0) {
					throw new OAuthPermissionError("missing_bot_permissions");
				}

				const grantedPermissions = parseBigInt(
					permissionsRaw,
					new OAuthPermissionError("invalid_bot_permissions"),
				);

				if (
					(grantedPermissions & config.requiredPermissions) !==
					config.requiredPermissions
				) {
					throw new OAuthPermissionError("insufficient_bot_permissions");
				}

				return {
					guildId,
					grantedPermissions,
				} satisfies DiscordCallbackData;
			},
		},
		tokens: {
			exchange: async ({ code, codeVerifier, config }) => {
				const payload = await requestDiscordToken(
					{
						client_id: config.clientId,
						client_secret: config.clientSecret,
						grant_type: "authorization_code",
						code,
						code_verifier: codeVerifier,
						redirect_uri: config.redirectUri,
					},
					"Discord token exchange failed",
				);

				return {
					accessToken: payload.access_token,
					refreshToken: payload.refresh_token ?? null,
					scope: payload.scope ?? null,
					expiresIn: payload.expires_in ?? null,
					tokenType: payload.token_type ?? "Bearer",
				};
			},
			refresh: async ({ refreshToken, config }) => {
				const payload = await requestDiscordToken(
					{
						client_id: config.clientId,
						client_secret: config.clientSecret,
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					},
					"Discord token refresh failed",
				);

				return {
					accessToken: payload.access_token,
					refreshToken: payload.refresh_token ?? null,
					scope: payload.scope ?? null,
					expiresIn: payload.expires_in ?? null,
					tokenType: payload.token_type ?? "Bearer",
				};
			},
		},
		installation: {
			derive: async ({ tokens, callbackData }) => {
				const guilds = await fetchDiscordGuilds({
					accessToken: tokens.accessToken,
					tokenType: tokens.tokenType,
				});

				const guild = guilds.find((entry) => entry.id === callbackData.guildId);

				if (!guild) {
					throw new OAuthPermissionError("guild_access");
				}

				const userPermissions = parseBigInt(
					guild.permissions,
					new OAuthPermissionError("invalid_user_permissions"),
				);

				if ((userPermissions & MANAGE_GUILD_PERMISSION) === BigInt(0)) {
					throw new OAuthPermissionError("missing_manage_guild");
				}

				return {
					providerExternalId: guild.id,
					providerDisplayName: guild.name,
					metadata: buildInstallationMetadata(guild),
				};
			},
		},
		handlers: (dependencies) => createDiscordHandlers(dependencies),
	});

export const createApp = createDiscordApp;
