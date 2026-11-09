# Worm feedback button

A feedback button any web app can embed. A person types a note and can add a screenshot of the page and a voice memo of up to two minutes. The report also carries recent evidence: the route, viewport, browser, the last 50 clicks named the way Worm walks name them, console warnings and errors, uncaught exceptions, and failed requests. Everything is sent only to the site owner's own Worm server (`apps/cloud`). There is no Worm-run service.

The button and panel live in a Shadow DOM root, so the page's CSS cannot restyle them and theirs cannot leak out. Tap targets are at least 44 px, the panel becomes a bottom sheet on phones, respects safe-area insets and stays above the on-screen keyboard.

## Embed it

Script tag (the bundle is `dist/worm-feedback.js`; host it yourself, for example next to your app's assets):

```html
<script
	src="/vendor/worm-feedback.js"
	data-server="https://worm.example.org"
	data-site-key="wf_pub_your_site_key"
	data-posthog="window"
></script>
```

Module (`dist/worm-feedback.mjs`):

```js
import { init } from "@cap-ux/feedback";

init({
	server: "https://worm.example.org",
	siteKey: "wf_pub_your_site_key",
	getContext: () => ({ userId: user.id, orgId: org.id, release: BUILD_SHA }),
	posthog,
	routeRules: [{ pattern: /^\/reset\/[^/]+/, replace: "/reset/:token" }],
});
```

| Option | Meaning |
| --- | --- |
| `server` | Your Worm server origin. HTTPS is required except for localhost. |
| `siteKey` | The publishable key for this site, configured on your server with the origins allowed to use it. It is not a secret. |
| `getContext` | Optional. Returns ids only: `userId`, `orgId`, `release`. Anything else, and any value that is not a short id (names, emails), is dropped. |
| `posthog` | Optional PostHog instance. Each report stores its session id and replay link so the report can be matched to PostHog's replay. `data-posthog="window"` uses `window.posthog`. |
| `routeRules` | Extra path rewrites applied after the defaults. Query strings and fragments are always removed; numeric ids, UUIDs, emails and long token-like segments become `:id`, `:email` or `:token`. |
| `requestIdHeaders` | Response headers read as a request id on failed requests (default `x-request-id`, `x-correlation-id`, `request-id`, `x-amzn-requestid`, `cf-ray`). Cross-origin APIs must expose the header. |
| `genericTestids` | Wrapper test ids that name no feature, skipped in click labels as in walks. |
| `position`, `label` | `bottom-right` (default) or `bottom-left`, and the button text. |

The page's Content Security Policy must allow `connect-src` to your Worm server, and `img-src blob:` and `media-src blob:` for the screenshot and voice previews.

## What leaves the browser

Only the report, sent to your configured server: the note, the evidence JSON, an optional JPEG screenshot and an optional voice memo (WebM/Opus in Chrome and Firefox, MP4/AAC in Safari on iPhone and Mac).

- Screenshots are drawn from the DOM. Every input, textarea, select, editable region and every element marked `data-worm-mask` (and everything inside it) has its contents removed from the copy before it is drawn, and its on-screen box is painted over afterwards, which also covers a marked canvas, video or iframe. Elements in open shadow roots are included. The page itself is never changed. Mark anything else that can show patient or personal data with `data-worm-mask`.
- Clicks use the walk recorder's label rules (`vendor/ux-walk/src/labels.mjs`): test ids, roles and visible labels, never field values. A click inside a `data-worm-mask` region or an editable region, or on a control that contains one, keeps only the element's tag, role and test ids, and a table row's label is dropped when that row has masked cells. Emails in labels become `[email]`.
- Console text and errors pass through the walk recorder's redaction (`vendor/ux-walk/src/redact.mjs`) plus key-based redaction of logged objects; query strings are cut from URLs.
- Failed requests record method, path, status, duration and a request id header. No bodies, headers or cookies.
- The widget marks itself for exclusion from session replay tools (`ph-no-capture`, `rr-block`, `sentry-block`, `fs-exclude`, `data-private`), so a note being typed is not recorded by the page's replay.
- Screenshots and PHI: a screenshot shows whatever is on screen outside the masked elements. For a healthcare app, mask record views, or leave screenshots to people who know what is on their screen.

## Develop

```sh
npm ci --ignore-scripts
npm run build      # dist/worm-feedback.js and .mjs
npm test           # unit tests: masking, redaction, ring buffers
npm run test:e2e   # Playwright at desktop and phone size (Google Chrome)
```

`demo/index.html` loads the built bundle against a local Worm Worker on port 8787. The Playwright test serves the demo and answers for the server itself, so it needs neither.
