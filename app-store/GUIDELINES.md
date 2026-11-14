# App Store guidelines

`bun app-store validate` checks everything a machine can. A Cap maintainer checks the rest by hand before merging. These are the rules they use.

## Every app

- **One app, one job.** An app does one clear thing. Do not bundle unrelated content to look bigger, and do not publish near-copies of an existing app.
- **Honest listing.** The name, description, icon and README describe what the app really does. No keyword stuffing, no claims you cannot back up, no "best" or "#1".
- **Names.** Title Case nouns ("Aurora", "Notion Sync"), not sentences. Do not use "Cap" in the name or imply the app is made by Cap unless it is.
- **Icon.** Your own artwork, readable at 32 pixels, works on light and dark backgrounds. No default or placeholder icons.
- **README.** Starts with what the app does, then how to set it up. If it needs an account somewhere else, a paid plan, or sends data outside Cap, it says so.
- **You own what you ship.** Images, styles and names are yours or licensed for redistribution under the license you declare. No other companies' logos or trademarks unless you are that company or the app connects to their product.
- **Ownership.** The `author.github` account maintains the app. When someone else changes it, maintainers ask the author to review first, except for security fixes and broken builds.
- **Content.** Nothing hateful, sexual, violent, deceptive or illegal.

## Content apps

- Backgrounds look good behind a screen recording: no busy patterns that fight with text, no visible compression artefacts or banding, and no watermarks.
- Caption styles stay readable over light and dark video.
- Colour looks are subtle enough to use on real content. A look that only works on one clip is not a look.

## Connections

- **Ask for the least.** Request only the permissions and events the app uses. Reviewers check each one against the README.
- **No surprises.** Never post, publish or email anything on someone's behalf unless their settings or a click on your action asked for it.
- **Privacy policy.** Explain what you store, for how long, and how people delete it. Delete everything for an install when you receive `uninstalled`.
- **Verify every request** with Cap's public key and reject anything unsigned or stale.
- **Be fast.** Answer events within a few seconds and do slow work afterwards. Actions must answer within 10 seconds.
- **Secrets.** Collect API keys and tokens only through `secret` settings, never in a `text` field or by asking people to paste them anywhere else.
- **No tracking.** Do not use Cap data for advertising, profiling or training models, and do not add analytics that identify people.
- **Stay up.** Connections that fail for days are switched off. Apps that stay broken are removed from the store.

## Removal

Cap can remove an app, or block it remotely through `app-store/blocked.json`, if it breaks these guidelines, stops working, or puts people at risk. A blocked app disappears from the store, its connection stops receiving requests, and Cap Desktop stops loading its content.
