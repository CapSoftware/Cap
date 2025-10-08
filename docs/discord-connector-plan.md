# Discord App Delivery Plan

Cap is evolving from a standalone screen recording tool into a collaborative video platform where teams can automate distribution. This project delivers the first app integration—automatically sharing organization and space videos into Discord channels—while laying groundwork for future providers such as Slack. The plan below sequences product discovery, backend plumbing, UI, and rollout steps so any contributor can pick up in order, mark progress, and annotate downstream tasks with new context.

This checklist captures the agreed sequence for shipping the Discord app. When you finish a task, check it off (`[x]`), add a short completion note, and update any downstream task context that changed while you were working. Keep all relevant context under the affected task so the next agent has the latest picture.

- [x] 1) Discovery & Requirements Alignment
  Context: Confirm which user personas can manage apps, how organization vs. space-level inheritance should behave, and what success looks like for the first release. Capture expected message format, limits (e.g., per-space overrides, pause states), required permissions from Discord, and the minimal viable analytics/observability signals. Output: a brief spec in the repo (e.g., `docs/discord-connector-spec.md`) that product + eng sign off on.
  Completion (2025-10-06): Added `docs/discord-connector-spec.md` outlining personas, inheritance model, message format, OAuth scopes, pause states, analytics, and observability requirements for downstream tasks.

- [x] 2) Data Model & Migration Prep
  Context: Extend `packages/database/schema.ts` with generic app tables (`app_installations` for shared lifecycle + credentials, `app_installation_settings` for provider JSON payloads) so future apps can reuse the same schema. Capture organization-level configuration, optional space override, audit fields, and keep secrets in `encryptedText` columns. Draft drizzle migration(s) and document any backfill or feature-flag strategy. Ensure the spec from Task 1 answers open questions (naming, cascade behavior). Do not run migrations yet—just land code + tests.
  Completion (2025-02-23): Added `app_installations` and `app_installation_settings` to `packages/database/schema.ts` with encrypted OAuth fields, org/space links, provider-agnostic identifiers, and audit columns. Stub drizzle migration `0009_steadfast_lockjaw.sql` checked in for later execution; Drizzle meta left unchanged so `pnpm db:generate` can regenerate snapshots. No backfill required—new feature gated behind upcoming Apps UI rollout.

- [x] 3) Discord OAuth & Token Handling
  Context: Implement the generic Next.js API endpoints under `apps/web/app/api/apps/connect/route.ts` that delegate OAuth flows based on app type, store state/PKCE, exchange codes, and persist tokens encrypted. Handle token refresh and permission validation. Update environment docs with required secrets (`DISCORD_CLIENT_ID`, etc.).
  Completion (2025-02-24): Added OAuth start/callback/refresh endpoints under the shared `/api/apps/connect/*` route backed by the new `@cap/apps` registry, persisted encrypted app credentials via `AppInstallationsRepo`, enforced owner policy, and documented required Discord secrets.

- [x] 4) Connector Service & Message Delivery Pipeline
  Context: Introduce a shared apps framework: scaffold `packages/apps` with a `core` helper package plus a Discord module exporting Effect handlers (install/pause/uninstall) and config metadata. Add an `Apps` service in `packages/web-backend/apps` that consumes those handlers, wraps Discord REST calls behind typed errors, and exposes RPCs/handlers for CRUD on app configs. Implement message dispatch (embeds linking to videos) with retry-aware Effect workflows. Confirm the service can be extended for Slack later by dropping a new folder under `packages/apps`.
  Notes: Core OAuth plumbing now lives in `@cap/apps` and the `/api/apps/connect/*` endpoint; remaining work focuses on the shared Apps service, settings flows, and delivery pipeline.

- [ ] 5) UI Management Surfaces
  Context: Update the dashboard apps page and space settings UI to visualize Discord status, channel selection, inheritance, and manual test-post controls. Ensure UX matches spec and states (connected, needs attention, paused) are consistent with backend data. Include loading/error states and smoke tests where applicable.

- [ ] 6) Automation Triggers & Workflows
  Context: Hook into video sharing/publish events so new videos automatically enqueue a Discord post when the app installation is active. Leverage the workflow system (`packages/web-backend/src/Workflows.ts`) for async processing, respecting rate limits and providing failure feedback surfaced in the UI.

- [ ] 7) Observability & Operations
  Context: Add structured logging, metrics hooks, and alerting notes for the new pipeline. Document manual recovery steps (e.g., reauth, channel permissions) and ensure admin tooling can pause/resume apps. Update the spec/docs with monitoring dashboards or CLI commands if applicable.

- [ ] 8) Rollout & QA
  Context: Finalize feature-flag or staged rollout plan, run end-to-end tests against a staging Discord guild, and capture test evidence. Update docs/readme, ensure migrations are applied in the correct order, and prepare customer-facing release notes. Once complete, confirm no open blockers remain before GA.
