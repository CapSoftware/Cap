# Cap Status

An independent Next.js app for `status.cap.so`. It reuses the current landing page’s Instrument Sans, Source Serif 4, DM Mono, cloud artwork, and colour palette. It has no dependency on the main web app, its database, or its deployment.

## Deploy on Vercel

1. Import this repository into a **separate Vercel project**, with root directory **`apps/status`**, framework **Next.js**, and build command **`bun run build`**. Keep access to the repository root enabled so Vercel uses the existing Bun workspace and lockfile. Use Bun 1.4.4. Do not attach the main site’s environment variables.
2. Attach a dedicated Upstash Redis database through the Vercel Marketplace. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` on the production environment. Keep preview data in a separate database, or leave preview storage unconfigured.
3. Set a random `CRON_SECRET` of at least 32 bytes on production. Vercel sends it as the cron’s Bearer token. Do not prefix any of these variables with `NEXT_PUBLIC_`.
4. Configure the production service URLs below. Deploy on a plan supporting **five-minute cron jobs** (Vercel Pro or higher), then add `status.cap.so` to this project and point its DNS at Vercel. The page starts with honest “no data” states until checks run.
5. Verify the first `/api/cron/check` invocation succeeds in the Vercel logs and `/api/status` contains current observations for every configured service. Set an **external dead-man monitor** to alert when `/api/status` has an old `checkedAt` (over 15 minutes), returns non-200, or cannot be reached. This detects a failed scheduler, Redis, or the status deployment itself.
6. Before public launch, configure a Vercel WAF rate limit for `/api/status` (GET and HEAD). Start with 300 requests per minute per IP in log mode, check expected traffic, then enforce with a 429 response. The public API rejects query parameters before accessing Redis, preventing cache-busting URLs from consuming storage requests. The WAF rule protects function usage as well and is configured on the separate status project, not the main site.

No production deployment, DNS changes, external monitors, or storage resources are created by this PR.

## Service coverage

All endpoints must be direct HTTPS URLs returning 2xx; redirects are intentionally rejected so a sign-in redirect or protection page cannot count as a healthy service. Use dedicated, public, read-only canaries; never use a customer’s private recording or a signed URL that expires.

| Environment variable | Probe | Coverage |
| --- | --- | --- |
| `STATUS_WEBSITE_URL` | HEAD; defaults to `https://cap.so` | Public website reachability |
| `STATUS_API_URL` | GET; defaults to `https://cap.so/api/auth/providers` | Authentication API reachability and a real provider payload; does not simulate sign-in or prove database health |
| `STATUS_SHARING_URL` | HEAD; required | A permanent public test recording’s share page returning 200 |
| `STATUS_STORAGE_URL` | HEAD; required | A small, permanent canary object on the production storage/CDN path; does not test uploads |
| `STATUS_MEDIA_URL` | GET; required | Media server `/health`, including `status === "ok"` rather than HTTP status alone |
| `STATUS_RENDER_URL` | GET; required | Render coordinator `/health`, requiring `ok`, active workers, and render slots |

Missing or invalid configuration is shown as unknown, never operational. Add other services to `lib/services.ts` and their environment variables to `.env.example`. Each service gets its own history and automatic incidents. The `/health` URLs are existing endpoints; this app adds no instrumentation, middleware, migrations, or code to Cap’s production services.

These are availability checks, not end-to-end recording/upload/playback tests. A cache-served canary confirms the serving path, not every downstream dependency. Keep functional synthetic tests and provider alerting alongside this page.

## Monitoring and persistence

- Vercel cron runs every five minutes **only on production**. `/api/cron/check` rejects unauthenticated calls. Preview deployments cannot run the collector.
- Six lightweight probes run concurrently, each with an eight-second deadline. Healthy responses over three seconds are degraded. An unhealthy probe is retried once immediately. Normally 72 requests per hour reach Cap; retries can increase that to 144 per hour, independent of page traffic. HEAD probes do not download recordings; GET probes use only small health JSON.
- A 55-second Redis lease prevents overlapping collectors. The function deadline is 50 seconds. Saving observations and releasing the lease is one atomic Lua operation conditional on lease ownership. A crashed collector’s lease expires. Duplicate invocations in the same five-minute UTC interval do not double-count.
- A first confirmed unhealthy sample shows degraded/unknown status. Two consecutive unhealthy samples open an incident, typically 5–10 minutes after a failure begins; two consecutive successful samples close it. After a monitoring gap, consecutive counters reset. An unobserved gap never resolves an incident.
- Redis stores 90 UTC calendar days of daily observed success/degradation/failure counts and all ongoing incidents and up to 500 recently resolved incidents. Empty days remain empty. Uptime is successful observed checks divided by all observed checks; it is not a promise about unobserved time. Hover, focus, or tap a day to see the sample count.
- Visitors read only `/api/status`, cached at the CDN for 30 seconds. The visible page refreshes once a minute and stops polling in hidden tabs. It independently marks observations older than 15 minutes unknown. Storage failures show monitoring unavailable; they never fabricate healthy data. No service URLs, health payloads, or credentials appear in the public snapshot.

The status page and its scheduler share Vercel. The independent dead-man monitor is needed to notify operators of a Vercel-wide outage. This version records automatic incidents; notifications and manually written incident updates are outside its scope.

## Local checks

From the repository root, install with `bun install --frozen-lockfile`. Then:

```sh
bun run --cwd apps/status test
bun run --cwd apps/status typecheck
bun run --cwd apps/status build
```

Copy `.env.example` to `.env.local` in this app for local configuration. Use a separate development Redis database. `bun run --cwd apps/status start` serves the production build on port 3003; `bun run --cwd apps/status dev` uses the same port. The status app is excluded from the root development commands, including the Windows wrapper, so it runs only when explicitly started and cannot take the desktop harness's port 3002. Respect the repository’s existing-server rules when starting a local server.

## Screenshots

[Desktop preview](screenshots/desktop.png) · [Mobile preview](screenshots/mobile.png)

These screenshots show the production build with sample monitoring responses, not live service history. The browser checks also cover missing storage, stale observations, an active outage, incident display, service expansion, and keyboard navigation through daily uptime. Automated WCAG 2.1 A/AA checks pass for the normal and outage views.
