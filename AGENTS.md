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
- **Web app** (`apps/web`): Next.js 15 on port 3000. Start with `cd apps/web && dotenv -e ../../.env -- pnpm dev` or use `npx dotenv -e .env -- pnpm --dir apps/web dev` from root.
- **MySQL 8.0**: Docker container `mysql-primary-db` on port 3306 (empty root password, database `cap`).
- **MinIO (S3)**: Docker container `minio-storage` on ports 9000/9001 (creds: `capso`/`capso_secret`).
- **Media Server**: Docker container `cap-media-server-dev` on port 3456.

### Starting services
1. Start Docker daemon: `sudo dockerd &` then `sudo chmod 666 /var/run/docker.sock`
2. Start containers: `cd packages/local-docker && docker compose up -d`
3. Wait for MySQL: `docker exec mysql-primary-db mysqladmin ping -u root --silent`
4. Ensure the `cap` database exists: `docker exec mysql-primary-db mysql -u root -e "CREATE DATABASE IF NOT EXISTS cap;"`
5. Push schema: `pnpm db:push`
6. Start web dev server: `npx dotenv -e .env -- pnpm --dir apps/web dev`

### Gotchas
- `pnpm env-setup` is interactive and cannot run non-interactively. Create `.env` manually with the Docker defaults from `scripts/env-cli.js` (see the `DOCKER_S3_ENVS` and `DOCKER_DB_ENVS` constants).
- The `dotenv` CLI lives in root `node_modules`; use `npx dotenv` or the full path when running outside the root package.json scripts context.
- `pnpm install` in pnpm 10 blocks build scripts by default. The repo needs `pnpm.onlyBuiltDependencies` in root `package.json` listing at least `@parcel/watcher`, `@swc/core`, `esbuild`, `sharp`, `protobufjs`, `unrs-resolver`.
- In dev mode, email auth OTP codes are logged to the Next.js server console (look for `VERIFICATION CODE (Development Mode)`).
- First page loads after starting the dev server are slow (10-30s) due to on-demand compilation. Subsequent loads are fast.
- The `pnpm lint` command reports many pre-existing Biome warnings/errors; this is normal for the current codebase.
- Web tests (`pnpm test:web`) have 2 pre-existing failures due to missing blog post MDX files; 25/27 test files and 481 tests pass.
- Desktop app development requires macOS or Windows with Rust toolchain; it cannot run on the cloud Linux VM.
