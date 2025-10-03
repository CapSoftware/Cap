# Repository Guidelines

## Project Structure & Modules
- Turborepo monorepo:
  - `apps/desktop` (Tauri v2 + SolidStart), `apps/web` (Next.js), `apps/cli` (Rust CLI).
  - `packages/*` shared libs (e.g., `database`, `ui`, `ui-solid`, `utils`, `web-*`).
  - `crates/*` Rust media/recording/rendering/camera crates.
  - `scripts/*`, `infra/`, and `packages/local-docker/` for tooling and local services.

## Build, Test, Develop
- Install: `pnpm install`; setup: `pnpm env-setup` then `pnpm cap-setup`.
- Dev: `pnpm dev` (web+desktop). Desktop only: `pnpm dev:desktop`. Web only: `pnpm dev:web` or `cd apps/web && pnpm dev`.
- Build: `pnpm build` (Turbo). Desktop release: `pnpm tauri:build`.
- DB: `pnpm db:generate` → `pnpm db:push` → `pnpm db:studio`.
- Docker: `pnpm docker:up | docker:stop | docker:clean`.
- Quality: `pnpm lint`, `pnpm format`, `pnpm typecheck`. Rust: `cargo build -p <crate>`, `cargo test -p <crate>`.

## Coding Style & Naming
- TypeScript: 2‑space indent; Biome formats/lints (`pnpm format`).
- Rust: `rustfmt` + workspace clippy lints.
- Naming: files kebab‑case (`user-menu.tsx`); components PascalCase; Rust modules snake_case, crates kebab‑case.
- Runtime: Node 20, pnpm 10.x, Rust 1.88+, Docker for MySQL/MinIO.

## Testing
- TS/JS: Vitest where present (e.g., desktop). Name tests `*.test.ts(x)` near sources.
- Rust: `cargo test` per crate; tests in `src` or `tests`.
- Prefer unit tests for logic and light smoke tests for flows; no strict coverage yet.

## Commits & PRs
- Conventional style: `feat:`, `fix:`, `chore:`, `improve:`, `refactor:`, `docs:` (e.g., `fix: hide watermark for pro users`).
- PRs: clear description, linked issues, screenshots/GIFs for UI, env/migration notes. Keep scope tight and update docs when behavior changes.

## Agent‑Specific Practices (inspired by CLAUDE.md)
- Do not start extra servers; use `pnpm dev:web` or `pnpm dev:desktop` as needed.
- Never edit auto‑generated files: `**/tauri.ts`, `**/queries.ts`, `apps/desktop/src-tauri/gen/**`.
- Prefer existing scripts and Turbo filters over ad‑hoc commands; clear `.turbo` only when necessary.
- Database flow: always `db:generate` → `db:push` before relying on new schema.
- Keep secrets out of VCS; configure via `.env` from `pnpm env-setup`.
- macOS note: desktop permissions (screen/mic) apply to the terminal running `pnpm dev:desktop`.

## Effect Usage
- Next.js API routes in `apps/web/app/api/*` are built with `@effect/platform`'s `HttpApi` builder; copy the existing class/group/endpoint pattern instead of ad-hoc handlers.
- Acquire backend services (e.g., `Videos`, `S3Buckets`) inside `Effect.gen` blocks and wire them through `Layer.provide`/`HttpApiBuilder.group`, translating domain errors to `HttpApiError` variants.
- Convert the effectful API to a Next.js handler with `apiToHandler(ApiLive)` from `@/lib/server` and export the returned `handler`—avoid calling `runPromise` inside route files.
- On the server, run effects through `EffectRuntime.runPromise` from `@/lib/server`, typically after `provideOptionalAuth`, so cookies and per-request context are attached automatically.
- On the client, use `useEffectQuery`/`useEffectMutation` from `@/lib/EffectRuntime`; they already bind the managed runtime and tracing so you shouldn't call `EffectRuntime.run*` directly in components.
