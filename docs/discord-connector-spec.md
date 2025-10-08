# Discord App MVP Spec

## Overview
- Launch the Apps surface at `/dashboard/apps` so organizations can discover, install, and manage automation apps.
- Ship Discord as the first app while keeping the flow generic enough to support future providers (e.g., Slack).
- Focus the MVP on a single automated outcome: when a video is added to a chosen space, announce it in a selected Discord channel.

## Architecture & Repo Layout
- `packages/apps/discord` hosts the Discord app package, including the manifest, Effect handlers, and the `DiscordAppSettings` schema that describes persisted config.
- `packages/apps/core` exposes the shared helpers that Discord plugs into so additional providers can follow the same pattern.
- `packages/web-backend/src/apps` defines the Effect-powered `Apps` service that discovers installed app modules, runs install/pause/uninstall workflows, and brokers Discord API calls through typed adapters.
- `apps/web/app/api/apps/connect/route.ts` hosts the generic Next.js `HttpApi` endpoint that selects the appropriate app module (e.g. Discord) at runtime to orchestrate OAuth and hand configuration back to the shared `Apps` service.

## Objectives
- Allow an org admin to install the Discord app end-to-end without engineering help.
- Capture the minimum configuration required to post: Discord guild, destination channel, and Cap space to watch.
- Ensure new videos added to the configured space post to Discord within a few minutes under normal load.
- Provide lightweight visibility on the Apps page so admins can confirm connection health or reinstall if needed.

## Non-Goals (MVP)
- Supporting more than one Discord configuration per organization.
- Selecting multiple spaces or channels, or per-video overrides.
- Customizing message content beyond the default embed.
- Backfilling historical videos or bulk reposting.
- Advanced monitoring, analytics dashboards, or fine-grained permissions.

## Primary User Flow
1. **Discover** – Org admin opens `/dashboard/apps` and sees available apps (Discord listed first, others hidden/coming soon).
2. **Install** – Admin clicks "Install" on Discord, completes the OAuth flow (scopes: `identify`, `guilds`, `bot`) and selects a guild where they have `Manage Guild`.
3. **Configure** – After OAuth, app prompts for:
   - Discord text channel within the selected guild.
   - Cap space whose new videos should be shared.
   Configuration confirms the connection and returns the user to the Apps page with status `Connected`.
4. **Automate** – When a video is added to the configured space, Cap posts a Discord embed in the chosen channel with video title, description snippet, owner, and link.
5. **Manage** – From the Apps page, admins can pause/resume posting or uninstall the app, which removes configuration and the bot from the guild.

## Configuration & Data Model
- **AppInstallation** (new table shared by future apps):
  - `id`, `organizationId`, `appType` (`discord`), `status` (`connected` | `paused` | `needs_attention`), `lastCheckedAt`, `createdAt`, `updatedAt`.
  - OAuth credentials: `accessToken`, `refreshToken`, `expiresAt`, `scope`, `guildId`, `guildName`, stored encrypted.
- **DiscordAppSettings** (defined in `packages/apps/discord/config.ts` and persisted via `app_installation_settings`):
  - `channelId`, `channelName`, `spaceId`.
- Only one active Discord `AppInstallation` per organization in MVP.

## Environment Variables
- `DISCORD_CLIENT_ID` – Discord application client ID (required).
- `DISCORD_CLIENT_SECRET` – Discord application client secret (required).
- `DISCORD_BOT_TOKEN` – Bot token used for guild operations during message dispatch (required for messaging pipeline).
- `DISCORD_REDIRECT_URI` – Optional override for the OAuth callback URL (defaults to `${WEB_URL}/api/apps/connect/callback`).
- `DISCORD_REQUIRED_PERMISSIONS` – Optional override for requested bot permissions (defaults to `18432`, enabling `SEND_MESSAGES` and `EMBED_LINKS`).

## Posting Rules
- Trigger when a new row is written to `space_videos` for the configured `spaceId` and the video is public.
- Avoid duplicate posts by checking for an existing post for the same `videoId + channelId` within 24 hours.
- Messages use a single embed:
  - Title: video name truncated to 80 chars.
  - Description: first 140 chars of the video description, fallback "New recording ready to watch.".
  - Footer: space name and organization name.
  - Button link to the video watch URL.

## Error Handling & Status
- Transition to `needs_attention` when Discord returns 4xx/5xx errors or OAuth tokens expire and cannot be refreshed.
- Show a compact error message and "Reconnect" CTA on the Apps page.
- Paused apps keep their configuration but skip posting until resumed.

## Observability (Lightweight)
- Emit structured logs for install success/failure and post success/failure (include organizationId, spaceId, channelId, HTTP status).
- Capture basic counters (install started/completed, post success/failure) for later dashboarding, but no dedicated UI in MVP.

## Security
- Store all Discord credentials encrypted; never log plaintext tokens or message bodies.
- Uninstall revokes tokens, removes stored credentials, and attempts to remove the bot from the guild.

## Future Considerations
- Multiple spaces/channels per app installation.
- Reusable webhook/workflow framework shared across additional apps.
- Richer health reporting and per-space overrides.
- Allowing organizations to enable multiple apps simultaneously once catalog grows.

## MVP Decisions
- Only organization owners can manage Apps in the MVP.
- Posting triggers on new `space_videos` rows for the configured space.
- Apps UI defers posting history or event logs until a future release.
