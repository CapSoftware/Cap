# Discord Integration Overview

This document can be rendered alongside the main install guide to provide customers with a more narrative walkthrough of the Discord automation.

## Highlights

- Automatically announcements for new recordings
- Rich embeds with author and organization details
- Quick actions to jump back into Cap or the original recording

## Flow diagram

```
Cap video published -> Discord App dispatch -> Discord API -> Target channel message
```

Add screenshots or Loom clips here to demonstrate the experience.

---

# Discord Integration Troubleshooting

Use this checklist when diagnosing issues with the Discord app.

## Common issues

- **Missing bot permissions** – confirm the guild administrator granted the required intents and the channel allows bot posts.
- **Expired tokens** – the integration automatically refreshes tokens, but revoking access in Discord will require a reinstall.
- **Channel renamed or deleted** – update the saved settings inside Cap if the destination channel changes.

## Support steps

1. Re-run the install flow to re-authorize the bot.
2. Verify environment variables are configured and available to the server runtime.
3. Check Discord's audit logs to confirm the bot is present and has the expected role.

Include any internal runbooks or contact details your team needs in this document.
