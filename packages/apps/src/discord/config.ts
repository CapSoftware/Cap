import { Schema } from "effect";

import type { AppDefinition } from "../core/types.ts";
import type { AppManifest } from "../core/manifest.ts";
import discordManifestJson from "./config.json" with { type: "json" };

export const DISCORD_APP_TYPE = "discord" as const;

export const discordManifest = {
  ...discordManifestJson,
  type: DISCORD_APP_TYPE,
} as const satisfies AppManifest & { type: typeof DISCORD_APP_TYPE };

export const DiscordAppSettingsSchema = Schema.Struct({
	channelId: Schema.String,
	channelName: Schema.String,
	spaceId: Schema.String,
});

export type DiscordAppSettings = typeof DiscordAppSettingsSchema.Type;

export type DiscordDispatchPayload =
	| {
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

export const discordDefinition: AppDefinition<
  typeof DISCORD_APP_TYPE,
  DiscordAppSettings
> = {
  type: DISCORD_APP_TYPE,
  displayName: discordManifest.displayName,
  description: discordManifest.description,
  icon: discordManifest.icon,
  category: discordManifest.category,
  settings: {
    schema: DiscordAppSettingsSchema as Schema.Schema<DiscordAppSettings, unknown>,
  },
};

export const DiscordAppSettings = DiscordAppSettingsSchema;
