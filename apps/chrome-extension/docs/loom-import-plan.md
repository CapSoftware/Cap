# Loom -> Cap importer (issue #363)

## Existing pieces this reuses
- `apps/chrome-extension/src/shared/api.ts` — extension already has a full
  auth flow (`createAuthStart` / `parseAuthResponse` via `chrome.identity`,
  bearer-token requests against `/api/extension/...`). The importer reuses
  this instead of inventing a second auth path.
- `apps/web/app/api/tools/loom-download/route.ts` — already resolves a Loom
  video id to a direct/streaming CDN url and can transcode it. The importer
  backend route reuses `tryGetDirectMp4Url`-equivalent logic instead of
  reimplementing Loom CDN resolution.
- `Extension.ExtensionApiPaths` in `@cap/web-domain` — the extension/web
  contract lives here; new paths must be added to this shared schema so
  drift fails to compile (per existing pattern in `shared/api.ts`).

## New pieces needed
1. `Extension.ExtensionApiPaths` additions: `listLoomSpaces`,
   `listLoomVideos`, `importLoomVideos`.
2. `apps/web/app/api/extension/[...route]/loom-importer.ts` (new): given the
   user's Loom session (read client-side, see below), returns spaces + videos
   for the signed-in user, and a POST endpoint that, for each selected video
   id, resolves the CDN url (reusing `loom-download`'s resolver) and creates
   a Cap video record tagged with `loomVideoId`.
3. Schema: `videos` table needs a nullable `loomVideoId` column
   (`packages/database`) + migration, so re-imports are idempotent.
4. Extension UI: new page (`import-loom.html` + `src/import-loom/main.tsx`,
   following the `options` page pattern) — user picks a space, sees a
   preview list, confirms import.
5. Loom space/video listing: Loom has no public read API for third parties.
   Plan is to read it from the user's own loom.com session via a content
   script injected on `loom.com/*` (`host_permissions` already broad enough),
   posting the space/video list back to the background service worker —
   mirrors how the recorder overlay talks to the service worker today.

## Open questions for maintainers (to ask on the PR)
- Preferred destination for a brand-new Cap space vs. only existing spaces on
  first version (issue text allows both; starting with "existing spaces
  only" keeps the first PR small).
- Whether `loomVideoId` should be unique per user or per workspace (affects
  the idempotency migration).

## Status
Scaffolding + plan only. Auth wiring, backend route, migration and UI still
to be implemented in follow-up commits on this branch.
