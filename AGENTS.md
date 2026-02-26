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
- **NO COMMENTS**: Never add comments to code (`//`, `/* */`, `///`, `//!`, `#`, etc.). Code must be self-explanatory through naming, types, and structure. This applies to all languages (TypeScript, Rust, JavaScript, etc.).

## Rust Clippy Rules (Workspace Lints)
All Rust code must respect these workspace-level lints defined in `Cargo.toml`:

**Rust compiler lints:**
- `unused_must_use = "deny"` — Always handle `Result`/`Option` or types marked `#[must_use]`; never ignore them.

**Clippy lints (all denied):**
- `dbg_macro` — Never use `dbg!()` in code; use proper logging instead.
- `let_underscore_future` — Never write `let _ = async_fn()` which silently drops futures; await or explicitly handle them.
- `unchecked_duration_subtraction` — Use `saturating_sub` instead of `-` for `Duration` to avoid panics.
- `collapsible_if` — Merge nested `if` statements: use `if a && b { }` instead of `if a { if b { } }`.
- `clone_on_copy` — Don't call `.clone()` on `Copy` types; just copy them directly.
- `redundant_closure` — Use function references directly: `iter.map(foo)` instead of `iter.map(|x| foo(x))`.
- `ptr_arg` — Accept `&[T]` or `&str` instead of `&Vec<T>` or `&String` in function parameters.
- `len_zero` — Use `.is_empty()` instead of `.len() == 0` or `.len() > 0`.
- `let_unit_value` — Don't assign `()` to a variable: write `foo();` instead of `let _ = foo();` when return is unit.
- `unnecessary_lazy_evaluations` — Use `.unwrap_or(val)` instead of `.unwrap_or_else(|| val)` for cheap values.
- `needless_range_loop` — Use `for item in &collection` instead of `for i in 0..collection.len()` when index isn't needed.
- `manual_clamp` — Use `.clamp(min, max)` instead of manual `if` chains or `.min().max()` patterns.

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
- **CRITICAL: NO CODE COMMENTS**: Never add any form of comments (`//`, `/* */`, `///`, `//!`, `#`, etc.) to generated or edited code. Code must be self-explanatory.

## Effect Usage
- Next.js API routes in `apps/web/app/api/*` are built with `@effect/platform`'s `HttpApi` builder; copy the existing class/group/endpoint pattern instead of ad-hoc handlers.
- Acquire backend services (e.g., `Videos`, `S3Buckets`) inside `Effect.gen` blocks and wire them through `Layer.provide`/`HttpApiBuilder.group`, translating domain errors to `HttpApiError` variants.
- Convert the effectful API to a Next.js handler with `apiToHandler(ApiLive)` from `@/lib/server` and export the returned `handler`—avoid calling `runPromise` inside route files.
- On the server, run effects through `EffectRuntime.runPromise` from `@/lib/server`, typically after `provideOptionalAuth`, so cookies and per-request context are attached automatically.
- On the client, use `useEffectQuery`/`useEffectMutation` from `@/lib/EffectRuntime`; they already bind the managed runtime and tracing so you shouldn't call `EffectRuntime.run*` directly in components.

## Code Formatting
- Always format code before completing work: run `pnpm format` for TypeScript/JavaScript and `cargo fmt` for Rust.
- Run these commands regularly during development and always at the end of a coding session to ensure consistent formatting.

## Cursor Cloud specific instructions

### Services overview
- **Web app** (`apps/web`): Next.js 15, the primary testable product on Linux. Start with `cd apps/web && pnpm dev` (uses `dotenv -e ../../.env`).
- **Docker services** (MySQL 8.0 on :3306, MinIO S3 on :9000/:9001, media-server on :3456): managed via `packages/local-docker/docker-compose.yml`. Start with `cd packages/local-docker && sudo docker compose up -d`.
- **Desktop app** (`apps/desktop`): Tauri v2, requires macOS/Windows—not runnable on Linux cloud VMs.

### Starting the web app for development/testing
1. Ensure Docker daemon is running: `sudo dockerd &>/tmp/dockerd.log &` (wait ~3s).
2. Start backing services: `cd /workspace/packages/local-docker && sudo docker compose up -d`.
3. Wait for MySQL: `sudo docker exec mysql-primary-db mysqladmin ping -h localhost --silent`.
4. Push schema if first run or schema changed: `pnpm db:push`.
5. Start Next.js: `cd /workspace/apps/web && pnpm dev` (listens on :3000).

### Authentication in development
- No email provider (Resend) is configured locally; login codes print to the Next.js server log.
- Look for `🔐 VERIFICATION CODE (Development Mode)` in the terminal running `pnpm dev`.
- Use that 6-digit code on the `/verify-otp` page to complete sign-in.

### Known caveats
- `pnpm lint` exits non-zero due to pre-existing Biome warnings/errors in the codebase; this is expected.
- Two Vitest suites in `apps/web` fail because blog `.mdx` content files are missing from the repo (`record-screen-mac-audio-blog-post.test.ts`, `record-screen-windows-blog-post.test.ts`); the remaining 25 suites (481 tests) pass.
- The `pnpm env-setup` script is interactive (uses `@clack/prompts`); in non-interactive environments, create `.env` manually with at minimum: `NODE_ENV`, `WEB_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_URL`, `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `CAP_AWS_ENDPOINT`, `NEXT_PUBLIC_WEB_URL`. See `scripts/env-cli.js` for Docker default values.
- Node 20 is required (set via `nvm use 20`). pnpm 10.5.2 is required (activated via corepack).
- First page load after `pnpm dev` takes ~15s due to compilation + workflow discovery; subsequent loads are fast.
