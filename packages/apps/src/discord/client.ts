import { serverEnv } from "@cap/env/server";
import { Effect } from "effect";

import { AppHandlerError, createAppHandlerError } from "../core/errors.ts";
import type { AppDestination } from "../core/types.ts";
import { DISCORD_APP_TYPE, type DiscordMessagePayload } from "./config.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10" as const;

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

const buildError = (
	operation: string,
	params: Omit<Parameters<typeof createAppHandlerError>[0], "app" | "operation">,
) =>
	createAppHandlerError({
		...params,
		app: DISCORD_APP_TYPE,
		operation,
	});
const request = <T>(operation: string, path: string, init: RequestInit) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise(() => fetch(`${DISCORD_API_BASE}${path}`, init)).pipe(
			Effect.mapError((cause) =>
				buildError(operation, {
					reason: `Discord request failed: ${String(cause)}`,
					retryable: true,
					status: undefined,
					detail: undefined,
				}),
			),
		);

		let body: unknown = undefined;

		if (response.status !== 204) {
			body = yield* Effect.tryPromise(() => response.json()).pipe(
				Effect.catchAll(() => Effect.succeed(undefined)),
			);
		}

		if (!response.ok) {
			const message =
				body && typeof body === "object" && body !== null && "message" in body
					? String((body as { message: unknown }).message ?? "Unknown Discord error")
					: `Discord request failed (${response.status})`;

			return yield* Effect.fail(
				buildError(operation, {
					reason: message,
					retryable: response.status >= 500 || response.status === 429,
					status: response.status,
					detail: body,
				}),
			);
		}

		return body as T;
	});

const resolveBotToken = Effect.gen(function* () {
	const env = serverEnv();

	if (!env.DISCORD_BOT_TOKEN) {
		yield* Effect.fail(
			buildError("resolveBotToken", {
				reason: "DISCORD_BOT_TOKEN is not configured",
				retryable: false,
				status: undefined,
			}),
		);
	}

	return env.DISCORD_BOT_TOKEN!;
});

const buildAuthHeaders = (token: string) => ({
	Authorization: `Bot ${token}`,
	"Content-Type": "application/json",
});

export const listGuildTextChannels = (
	guildId: string,
) =>
	resolveBotToken.pipe(
		Effect.flatMap((token) =>
			request<DiscordChannelResponse[]>(
				"listGuildTextChannels",
				`/guilds/${guildId}/channels`,
				{
					headers: {
						Accept: "application/json",
						...buildAuthHeaders(token),
					},
				},
			).pipe(
				Effect.map((channels) =>
					channels
						.filter((channel) => channel.type === 0 || channel.type === 5)
						.map<AppDestination>((channel) => ({
							id: channel.id,
							name: channel.name,
							type: channel.type === 5 ? "announcement" : "text",
							parentId: channel.parent_id ?? null,
						})),
				),
			),
		),
	);

export const sendMessageToChannel = (
	channelId: string,
	body: DiscordMessagePayload,
) =>
	resolveBotToken.pipe(
		Effect.flatMap((token) =>
			request<DiscordMessageResponse>(
				"sendMessageToChannel",
				`/channels/${channelId}/messages`,
				{
					method: "POST",
					body: JSON.stringify(body),
					headers: buildAuthHeaders(token),
				},
			),
		),
	);

export const leaveGuild = (guildId: string) =>
	resolveBotToken.pipe(
		Effect.flatMap((token) =>
			request<unknown>(
				"leaveGuild",
				`/users/@me/guilds/${guildId}`,
				{
					method: "DELETE",
					headers: buildAuthHeaders(token),
				},
			),
		),
	);
