# Discord App Installation Guide

Welcome to the Discord integration for Cap. This guide walks through the install experience and highlights what the app can do once connected.

## What the integration provides

- Share newly published recordings into a designated Discord channel automatically
- Keep teams aligned with rich embeds that include title, description, author avatar, and a quick jump link
- Manage bot permissions and guild access directly from Cap without manual configuration

## Getting started

1. Ensure the required environment variables listed in the manifest (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`) are configured in your deployment.
2. From the Apps gallery inside Cap, click **Install** on the Discord card.
3. Complete the OAuth consent flow, select the guild and text channel, and confirm the permissions requested by the Cap bot.
4. Choose the target channel inside Cap and save your settings to start receiving automation updates.

## Additional resources

The `content` directory contains supplemental assets you can surface in the UI, including deeper dives, screenshots, and troubleshooting notes.

- [Detailed walkthrough](./content/overview.md)
- [Troubleshooting checklist](./content/troubleshooting.md)

Feel free to expand the `content` folder with more markdown files, images, or videos that should appear alongside the integration overview.
