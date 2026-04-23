# CLAUDE.md

This file provides comprehensive guidance to Claude Code when working with code in this repository.

## Pre-Generation Invariants (read BEFORE writing any code)

These rules are enforced by CI (`cargo clippy -D warnings`, Biome). Fixing violations after the fact is wasted effort — emit code in the correct shape the FIRST time. Every CI failure tied to a rule below means this section was not respected.

### Zero-tolerance rules
- **No code comments anywhere.** Not `//`, `/* */`, `///`, `//!`, `#`, JSDoc, nor doc strings injected into new code. Applies to Rust, TS, JS, Python, shell, SQL, TOML — every language. Code must explain itself through naming and types.
- **Never edit generated files**: `**/tauri.ts`, `**/queries.ts`, `apps/desktop/src-tauri/gen/**`, `packages/ui-solid/src/auto-imports.d.ts`.
- **Never start additional dev servers** (`pnpm dev`, `pnpm dev:web`, `pnpm dev:desktop`, Docker). Assume the developer has them running.

### Post-edit gates (required before declaring any task complete)
These match CI. `cargo check` / `tsc` alone are NOT substitutes.

- Rust edits → `cargo fmt --all` **and** `cargo clippy -p <crate> --all-targets -- -D warnings` (use `--workspace` for multi-crate changes).
- TS / JS / JSON / CSS / MD edits → `pnpm format` **and** `pnpm lint`. For type changes also `pnpm typecheck`.
- DB schema edits → `pnpm db:generate` before relying on it.

### Rust — write the clippy-clean form the FIRST time
All patterns below are `deny` in the workspace `[workspace.lints]` in `Cargo.toml`. Do not emit the left column; emit the right column.

| ❌ Don't write | ✅ Write instead | Lint |
|---|---|---|
| `dbg!(x)` | `tracing::debug!(?x)` (or delete) | `dbg_macro` |
| `let _ = async_fn();` | `async_fn().await;` or `tokio::spawn(async_fn());` | `let_underscore_future` |
| `a - b` for `Duration`/`Instant` | `a.saturating_sub(b)` | `unchecked_time_subtraction` |
| `if a { if b { … } }` | `if a && b { … }` | `collapsible_if` |
| `x.clone()` when `x: Copy` | `x` | `clone_on_copy` |
| `iter.map(\|x\| foo(x))` | `iter.map(foo)` | `redundant_closure` |
| `fn f(v: &Vec<T>)` / `fn f(s: &String)` | `fn f(v: &[T])` / `fn f(s: &str)` | `ptr_arg` |
| `v.len() == 0` / `v.len() > 0` | `v.is_empty()` / `!v.is_empty()` | `len_zero` |
| `let _ = unit_returning();` | `unit_returning();` | `let_unit_value` |
| `opt.unwrap_or_else(\|\| 42)` (cheap default) | `opt.unwrap_or(42)` | `unnecessary_lazy_evaluations` |
| `for i in 0..v.len() { v[i] … }` | `for item in &v { … }` or `.iter().enumerate()` | `needless_range_loop` |
| `value.min(max).max(min)` | `value.clamp(min, max)` | `manual_clamp` |

`unused_must_use = "deny"` also applies: every `Result`, `Option`, `#[must_use]` value must be explicitly handled. `let _ = …;` is only valid for `Result`-returning calls you consciously discard (e.g. `let _ = tx.send(msg);`); it is NOT valid for unit-returning calls — see `let_unit_value`.

### TypeScript / JavaScript — write the Biome-clean form the FIRST time
`biome.json` at the repo root is the source of truth. When generating TS/JS/JSON/CSS:

- **Indent: tab.** Not two spaces, not four spaces.
- **Quotes: double.** `"foo"`, never `'foo'`, in JS/TS.
- **`organizeImports: on`** — group/sort imports naturally and drop unused ones.
- **Recommended lint ruleset on**, with only `suspicious.noShadowRestrictedNames` disabled. Unused vars, `noExplicitAny`, dead code, etc. are all enforced.
- Desktop (`apps/desktop/**`) has a11y rules off; everywhere else they apply.
- CSS overrides: `noUnknownAtRules`, `noUnknownTypeSelector`, `noDescendingSpecificity` off for `**/*.css`.
- Avoid `any`. Use `unknown` + narrowing, or existing shared types from `@cap/utils`, `@cap/web-domain`, generated bindings, etc.
- Do not introduce `@ts-expect-error` / `@ts-ignore` / `// biome-ignore` without a real reason. Prefer fixing the underlying type or pattern.

## Project Overview

Cap is the open source alternative to Loom. It's a Turborepo monorepo with a Tauri v2 desktop app (Rust + SolidStart) and a Next.js web app. The Next.js app at `apps/web` is the main web application for sharing and management; the desktop app at `apps/desktop` is the cross‑platform recorder/editor (macOS and Windows).

### Product Context
- **Core Purpose**: Screen recording with instant sharing capabilities
- **Target Users**: Content creators, developers, product managers, support teams
- **Key Features**: Instant recording, studio mode, AI-generated captions, collaborative comments
- **Business Model**: Freemium SaaS with usage-based pricing

## File Location Patterns & Key Directories

### Core Applications
- `apps/web/` — Next.js web application (sharing, management, dashboard)
- `apps/desktop/` — Tauri desktop app (recording, editing)
- `apps/discord-bot/` — Discord integration bot
- `apps/storybook/` — UI component documentation

### Shared Packages
- `packages/database/` — Drizzle ORM, auth, email templates
- `packages/ui/` — React components for web app
- `packages/ui-solid/` — SolidJS components for desktop
- `packages/utils/` — Shared utilities, types, constants
- `packages/env/` — Environment variable validation
- `packages/web-*` — Effect-based web API layers

### Rust Crates
- `crates/media*/` — Video/audio processing pipeline
- `crates/recording/` — Core recording functionality
- `crates/rendering/` — Video rendering and effects
- `crates/camera*/` — Cross-platform camera handling
- `crates/scap-*/` — Screen capture implementations

### Important File Patterns
- `**/tauri.ts` — Auto-generated IPC bindings (DO NOT EDIT)
- `**/queries.ts` — Auto-generated query bindings (DO NOT EDIT)
- `apps/web/actions/**/*.ts` — Server Actions ("use server")
- `packages/database/schema.ts` — Database schema definitions
- `*.config.*` — Configuration files (Next.js, Tailwind, etc.)

## Key Commands

### Development
```bash
pnpm dev:web             # Start Next.js dev server (apps/web only)
pnpm run dev:desktop     # Start Tauri desktop dev (apps/desktop)
pnpm build               # Build all packages/apps via Turbo
pnpm lint                # Lint with Biome across the repo
pnpm format              # Format with Biome
pnpm typecheck           # TypeScript project references build
```

### Database Operations
```bash
pnpm db:generate         # Generate Drizzle migrations
pnpm db:push             # Push schema changes to MySQL
pnpm db:studio           # Open Drizzle Studio
pnpm --dir packages/database db:check  # Verify database schema
```

### App-Specific Commands
```bash
# Web app (apps/web)
cd apps/web && pnpm dev          # Start Next.js dev server

# Desktop (apps/desktop)
cd apps/desktop && pnpm dev      # Start SolidStart + Tauri dev
pnpm tauri:build                 # Build desktop app (release)
```

## Development Environment Guidelines

### Server Management
- Do not start additional development servers or localhost services unless explicitly asked. Assume the developer already has the environment running and focus on code changes.
- Prefer `pnpm dev:web` or `pnpm run dev:desktop` when you only need one app. Avoid starting multiple overlapping servers.
- Avoid running Docker or external services yourself unless requested; root workflows handle them as needed.
- **Database**: MySQL via Docker Compose; schema managed through Drizzle migrations
- **Storage**: S3-compatible (AWS, Cloudflare R2, etc.) for video/audio files

### Auto-generated Bindings (Desktop)
- **NEVER EDIT**: `tauri.ts`, `queries.ts` (auto-generated on app load)
- **NEVER EDIT**: Files under `apps/desktop/src-tauri/gen/`
- **Icons**: Auto-imported in desktop app; do not import manually
- **Regeneration**: These files update automatically when Rust types change

### Common Development Pain Points
- **Node Version**: Must use Node 20 (specified in package.json engines)
- **PNPM Version**: Locked to 10.5.2 for consistency
- **Turbo Cache**: May need clearing if builds behave unexpectedly (`rm -rf .turbo`)
- **Database Migrations**: Always run `pnpm db:generate` before `pnpm db:push`
- **Desktop Icons**: Use `unplugin-icons` auto-import instead of manual imports

## Architecture Overview

### Monorepo Structure
- `apps/web` — Next.js 14 (App Router) web application
- `apps/desktop` — Tauri v2 desktop app with SolidStart (SolidJS)
- `packages/database` — Drizzle ORM (MySQL) + auth utilities
- `packages/ui` — React UI components for the web
- `packages/ui-solid` — SolidJS UI components for desktop
- `packages/utils` — Shared utilities and types
- `packages/env` — Zod-validated build/server env modules
- `crates/*` — Rust crates for media, rendering, recording, camera, etc.

### Technology Stack
- **Package Manager**: pnpm (`pnpm@10.5.2`)
- **Build System**: Turborepo
- **Frontend (Web)**: React 19 + Next.js 14.2.x (App Router)
- **Desktop**: Tauri v2, Rust 2024, SolidStart
- **Styling**: Tailwind CSS (web consumes `@cap/ui/tailwind`)
- **Server State**: TanStack Query v5 on web; `@tanstack/solid-query` on desktop
- **Database**: MySQL (PlanetScale) with Drizzle ORM
- **AI Integration**: Groq preferred, OpenAI fallback; invoked in Next.js Server Actions
- **Analytics**: PostHog
- **Payments**: Stripe

### Critical Architectural Decisions
1. **AI on the Server**: All Groq/OpenAI calls execute in Server Actions under `apps/web/actions`. Never call AI from client components.
2. **Authentication**: NextAuth with a custom Drizzle adapter. Session handling via NextAuth cookies; API keys are supported for certain endpoints.
3. **API Surface**: Prefer Server Actions. When routes are necessary, implement under `app/api/*` (Hono-based utilities present), set proper CORS, and revalidate precisely.
4. **Desktop IPC**: Use `tauri_specta` for strongly typed commands/events; do not modify generated bindings.

#### Desktop event pattern
Rust (emit):
```rust
use specta::Type;
use tauri_specta::Event;

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct UploadProgress {
    progress: f64,
    message: String,
}

UploadProgress { progress: 0.0, message: "Starting upload...".to_string() }
    .emit(&app)
    .ok();
```

Frontend (listen; generated bindings):
```ts
import { events } from "./tauri"; // auto-generated
await events.uploadProgress.listen((event) => {
  // update UI with event.payload
});
```

## Development Workflow & Best Practices

### Code Organization Principles
1. **Follow Local Patterns**: Study neighboring files and shared packages first
2. **Database Changes**: Always `pnpm db:generate` → `pnpm db:push` → test
3. **Strict Typing**: Use existing types; validate config via `@cap/env`
4. **Component Consistency**: Use `@cap/ui` (React) or `@cap/ui-solid` (Solid)
5. **No Manual Edits**: Never touch auto-generated bindings or schemas

### Key Implementation Patterns

#### Server Actions (Web App)
```typescript
"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";

export async function updateVideo(data: FormData) {
  const user = await getCurrentUser();
  if (!user?.id) throw new Error("Unauthorized");

  // Database operations with Drizzle
  return await db().update(videos).set({ ... }).where(eq(videos.id, id));
}
```

#### Desktop IPC Commands
```rust
// Rust side - emit events
UploadProgress { progress: 0.5, message: "Uploading...".to_string() }
  .emit(&app)
  .ok();
```

```typescript
// Frontend side - listen to events (auto-generated)
import { events, commands } from "./tauri";

// Call commands
await commands.startRecording({ ... });

// Listen to events
await events.uploadProgress.listen((event) => {
  setProgress(event.payload.progress);
});
```

#### React Query Patterns
```typescript
// Queries with Server Actions
const { data, isLoading } = useQuery({
  queryKey: ["videos", userId],
  queryFn: () => getUserVideos(),
  staleTime: 5 * 60 * 1000,
});

// Mutations with cache updates
const updateMutation = useMutation({
  mutationFn: updateVideo,
  onSuccess: (updated) => {
    queryClient.setQueryData(["video", updated.id], updated);
  },
});
```

## Environment Variables

### Build/Client (selected)
- `NEXT_PUBLIC_WEB_URL`
- `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`
- `NEXT_PUBLIC_DOCKER_BUILD` (enables Next.js standalone output)

### Server (selected)
- Core: `DATABASE_URL`, `WEB_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- S3: `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, optional `CAP_AWS_ENDPOINT`, `CAP_AWS_BUCKET_URL`
- AI: `GROQ_API_KEY`, `OPENAI_API_KEY`
- Email/Analytics: `RESEND_API_KEY`, `RESEND_FROM_DOMAIN`, `POSTHOG_PERSONAL_API_KEY`, `DUB_API_KEY`, `DEEPGRAM_API_KEY`
- OAuth: `GOOGLE_CLIENT_ID/SECRET`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`
- Stripe: `STRIPE_SECRET_KEY_TEST`, `STRIPE_SECRET_KEY_LIVE`, `STRIPE_WEBHOOK_SECRET`
- CDN signing: `CLOUDFRONT_KEYPAIR_ID`, `CLOUDFRONT_KEYPAIR_PRIVATE_KEY`
- Optional S3 endpoints: `S3_PUBLIC_ENDPOINT`, `S3_INTERNAL_ENDPOINT`

## Testing & Build Optimization

### Testing Strategy
- **Package-Specific**: Check each `package.json` for test commands
- **Web App**: Uses Vitest for utilities, no comprehensive frontend tests yet
- **Desktop**: Vitest for SolidJS components in some packages
- **Tasks Service**: Jest for API endpoint testing
- **Rust**: Standard Cargo test framework for crates

### Build Performance
- **Turborepo Caching**: Aggressive caching across all packages
- **Cache Invalidation**: Prefer targeted `--filter` over global rebuilds
- **Docker Builds**: `NEXT_PUBLIC_DOCKER_BUILD=true` enables standalone output
- **Development**: Incremental builds via TypeScript project references

### Performance Monitoring
- **Bundle Analysis**: Check Next.js bundle size regularly
- **Database Queries**: Monitor with Drizzle Studio
- **S3 Operations**: Watch for excessive uploads/downloads
- **Desktop Memory**: Rust crates handle heavy media processing

## Troubleshooting Common Issues

### Build Failures
- **"Cannot find module"**: Check workspace dependencies in package.json
- **TypeScript errors**: Run `pnpm typecheck` to see project-wide issues
- **Turbo cache issues**: Clear with `rm -rf .turbo`
- **Node version mismatch**: Ensure Node 20 is active

### Database Issues
- **Migration failures**: Check `packages/database/migrations/meta/`
- **Connection errors**: Verify Docker containers are running
- **Schema drift**: Run `pnpm --dir packages/database db:check`

### Desktop App Issues
- **IPC binding errors**: Restart dev server to regenerate `tauri.ts`
- **Rust compile errors**: Check Cargo.toml dependencies
- **Permission issues**: macOS/Windows may require app permissions
- **Recording failures**: Verify screen capture permissions

### Web App Issues
- **Auth failures**: Check NextAuth configuration and database
- **S3 upload errors**: Verify AWS credentials and bucket policies
- **Server Action errors**: Check network tab for detailed error messages
- **Hot reload issues**: Restart Next.js dev server

## React/Next.js Coding Standards

### Data Fetching & Server State
- Use TanStack Query v5 for all client-side server state and fetching.
- Use Server Components for initial data when possible; pass `initialData` to client components and let React Query take over.
- Mutations should call Server Actions directly and perform precise cache updates (`setQueryData`/`setQueriesData`) rather than broad invalidations.

Basic query pattern:
```tsx
import { useQuery } from "@tanstack/react-query";

function Example() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["items"],
    queryFn: fetchItems,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
  if (isLoading) return <Skeleton />;
  if (error) return <ErrorState onRetry={() => { /* refetch */ }} />;
  return <List items={data} />;
}
```

Server Action mutation with targeted cache updates:
```tsx
"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateItem } from "@/actions/items"; // 'use server'

function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateItem,
    onSuccess: (updated) => {
      qc.setQueriesData({ queryKey: ["items"] }, (old: any[] | undefined) =>
        old?.map((it) => (it.id === updated.id ? { ...it, ...updated } : it))
      );
      qc.setQueryData(["item", updated.id], updated);
    },
  });
}
```

Minimize `useEffect` usage: compute during render, handle logic in event handlers, and ensure cleanups for any subscriptions/timers.

### Next.js App Router
- Prefer Server Components for SEO/initial rendering; hydrate interactivity in client components.
- Co-locate feature components, keep components focused, and use Suspense boundaries for long fetches.

### UI/UX Guidelines
- Styling: Tailwind CSS only; stay consistent with spacing and tokens.
- Loading: Use static skeletons that mirror content; no bouncing animations.
- Performance: Memoize expensive work; code-split naturally; use Next/Image for remote assets.

## Effect Patterns

### Managed Runtimes
- `apps/web/lib/server.ts` builds a `ManagedRuntime` from `Layer.mergeAll` so database, S3, policy, and tracing services are available to every request. Always run server-side effects through `EffectRuntime.runPromise`/`runPromiseExit` from this module so cookie-derived context and `VideoPasswordAttachment` are attached automatically.
- `apps/web/lib/EffectRuntime.ts` exposes a browser runtime that merges the RPC client and tracing layers. Client code should lean on `useEffectQuery`, `useEffectMutation`, and `useRpcClient`; never call `ManagedRuntime.make` yourself inside components.

### API Route Construction
- Next.js API folders under `apps/web/app/api/*` wrap Effect handlers with `@effect/platform`'s `HttpApi`/`HttpApiBuilder`. Follow the existing pattern: declare a contract class via `HttpApi.make`, configure groups/endpoints with `Schema`, and only export the `handler` returned by `apiToHandler(ApiLive)`.
- Inside `HttpApiBuilder.group` blocks, acquire services (e.g., `Videos`, `S3Buckets`) with `yield*` inside `Effect.gen`. Provide layers using `Layer.provide` rather than manual `provideService` calls so dependencies stay declarative.
- Map domain-level errors to transport errors with `HttpApiError.*`. Keep error translation exhaustive (`Effect.catchTags`, `Effect.tapErrorCause(Effect.logError)`) to preserve observability.
- Use `HttpAuthMiddleware` for required auth and `provideOptionalAuth` when guests are allowed. The middleware/utility already hydrate `CurrentUser`, so avoid duplicating session lookups in route handlers.
- Shared HTTP contracts that power the desktop app live in `packages/web-api-contract-effect`; update them alongside route changes to keep schemas in sync.

### Server Components & Effects
- Server components that need Effect services should call `EffectRuntime.runPromise(effect.pipe(provideOptionalAuth))`. This keeps request cookies, tracing spans, and optional auth consistent with the API layer.
- Prefer lifting Drizzle queries or other async work into `Effect.gen` blocks and reusing domain services (`Videos`, `VideosPolicy`, etc.) rather than writing ad-hoc logic.

### Client Integration
- React Query hooks should wrap Effect workflows with `useEffectQuery`/`useEffectMutation` from `apps/web/lib/EffectRuntime.ts`; these helpers surface Fail/Die causes consistently and plug into tracing/span metadata.
- When a mutation or query needs the RPC transport, resolve it through `useRpcClient()` and invoke the strongly-typed procedures exposed by `packages/web-domain` instead of reaching into fetch directly.

## Desktop (Solid + Tauri) Patterns
- Data fetching: `@tanstack/solid-query` for server state.
- IPC: Call generated `commands` and `events` from `tauri_specta`. Listen directly to generated events and prefer the typed interfaces.
- Windowing/permissions are handled in Rust; keep UI logic in Solid and avoid mixing IPC with rendering logic.

## Conventions
- Directory naming: lower-case-dashed.
- Components: PascalCase; hooks: camelCase starting with `use`; Rust modules snake_case; crates kebab-case.
- Biome formats and lints TS/JS/JSON/CSS (tab indent, double quotes, organizeImports). rustfmt + the workspace clippy lints handle Rust.

The zero-comment rule, the denied clippy patterns, and the Biome style invariants all live in **Pre-Generation Invariants** at the top of this file — that section is authoritative.

## Rust Clippy Rules (Workspace Lints)

See the **Pre-Generation Invariants** section at the top of this file — it is the single source of truth for the denied workspace lints (`[workspace.lints]` in `Cargo.toml`) and the clippy-clean forms to emit. Keeping only one copy avoids the two lists drifting apart.

## Security & Privacy Considerations

### Data Handling
- **Video Storage**: S3-compatible storage with signed URLs
- **Database**: MySQL with connection pooling via PlanetScale
- **Authentication**: NextAuth with custom Drizzle adapter
- **API Security**: CORS policies, rate limiting via Hono middleware

### Privacy Controls
- **Recording Permissions**: Platform-specific (macOS Screen Recording, Windows)
- **Data Retention**: User-controlled deletion of recordings
- **Sharing Controls**: Password protection, expiry dates on shared links
- **Analytics**: PostHog with privacy-focused configuration

## AI & Processing Pipeline

### AI Integration Points
- **Transcription**: Deepgram API for captions generation
- **Metadata Generation**: Groq (primary) + OpenAI (fallback) for titles/descriptions
- **Processing Location**: All AI calls in Next.js Server Actions only
- **Privacy**: Transcripts stored in database, audio sent to external APIs

### Media Processing Flow
```
Desktop Recording → Local Files → Upload to S3 →
Background Processing (tasks service) →
Transcription/AI Enhancement → Database Storage
```

## References & Documentation

### Core Technologies
- **TanStack Query**: https://tanstack.com/query/latest
- **React Patterns**: https://react.dev/learn/you-might-not-need-an-effect
- **Tauri v2**: https://github.com/tauri-apps/tauri
- **tauri_specta**: https://github.com/oscartbeaumont/tauri-specta
- **Drizzle ORM**: https://orm.drizzle.team/
- **SolidJS**: https://solidjs.com/

### Cap-Specific
- **Self-hosting**: https://cap.so/docs/self-hosting
- **API Documentation**: Generated from TypeScript contracts
- **Architecture Decisions**: See individual package READMEs

### Development Resources
- **Monorepo Guide**: Turborepo documentation
- **Effect System**: Used in web-backend packages
- **Media Processing**: FFmpeg documentation for Rust bindings

## Code Formatting & Lint Gates

Before declaring any task complete, run the appropriate gate for every file type that was touched. These are the same gates CI runs; skipping them will push broken work.

- **Rust**: `cargo fmt --all` **and** `cargo clippy -p <crate> --all-targets -- -D warnings` (`--workspace` for multi-crate changes). `cargo check` does NOT run the denied clippy lints and is not a substitute.
- **TypeScript / JavaScript / JSON / CSS / MD**: `pnpm format` **and** `pnpm lint`. If types changed, also `pnpm typecheck`.
- If a gate fails, fix the violation in the source code (see the "write X instead of Y" tables in **Pre-Generation Invariants** at the top of this file). Do not paper over clippy/Biome failures with `#[allow(...)]`, `// biome-ignore`, or `any` unless explicitly approved.
