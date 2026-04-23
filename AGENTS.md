# Repository Guidelines

## Pre-Generation Invariants (read BEFORE writing any code)

These rules are enforced by CI (`cargo clippy -D warnings`, Biome). Fixing them afterwards is wasted effort — emit code in the correct shape the FIRST time. Every CI failure caused by one of these rules means the agent didn't read this section.

### Zero-tolerance rules
- **No code comments anywhere.** Not `//`, `/* */`, `///`, `//!`, `#`, JSDoc, nor doc-strings injected into new code. Code must be self-explanatory via naming and types. This applies to every language: Rust, TS, JS, Python, shell, SQL, TOML, etc.
- **Never edit generated files**: `**/tauri.ts`, `**/queries.ts`, `apps/desktop/src-tauri/gen/**`, `packages/ui-solid/src/auto-imports.d.ts`, Drizzle migration SQL under `packages/database/migrations/`.
- **Never start additional dev servers** (`pnpm dev`, `pnpm dev:web`, `pnpm dev:desktop`, Docker services). Assume they are already running.

### Post-edit gates (run before you say "done")
- Touched any Rust file → `cargo fmt --all` **and** `cargo clippy -p <crate> --all-targets -- -D warnings` (use `--workspace` if multiple crates changed). `cargo check` alone is not sufficient; it will not catch the lints below.
- Touched any TS / JS / JSON / CSS / MD file → `pnpm format` **and** `pnpm lint`. For type changes, also `pnpm typecheck`.
- Touched DB schema → `pnpm db:generate` before relying on it.

### Rust — write the clippy-clean form the FIRST time
All patterns below are `deny` in the workspace `[workspace.lints]` in `Cargo.toml`. Do not emit the left column; always emit the right column.

| ❌ Don't write | ✅ Write instead | Lint |
|---|---|---|
| `dbg!(x)` | `tracing::debug!(?x)` (or delete it) | `dbg_macro` |
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

Additionally, `unused_must_use = "deny"` applies to all Rust code: every `Result`, `Option`, and `#[must_use]` value must be explicitly handled (`?`, `.unwrap()`, `.ok()`, `let _ = …;` **is not allowed** for unit-returning calls — see `let_unit_value`; it is the correct escape hatch for `Result`-returning calls you consciously discard, e.g. `let _ = tx.send(msg);`).

### TypeScript / JavaScript — write the Biome-clean form the FIRST time
`biome.json` at repo root enforces (do not override locally):
- **Indent: tab.** Not two spaces, not four spaces. New files and edits must use tabs.
- **Quotes: double.** `"foo"`, never `'foo'`, for JS/TS string literals.
- **`organizeImports: on`** — imports are sorted/grouped automatically; don't leave unused imports or hand-sort against the grain.
- **Recommended lint ruleset is on**, with `suspicious.noShadowRestrictedNames` disabled. Everything else (unused vars, `noExplicitAny`, dead code, etc.) applies.
- Desktop code under `apps/desktop/**` has a11y rules disabled; they are enforced everywhere else (`apps/web`, `packages/ui`, etc.).
- CSS overrides: `noUnknownAtRules`, `noUnknownTypeSelector`, `noDescendingSpecificity` are off for `**/*.css`.

### TypeScript — strictness
- Avoid `any`. Use `unknown` + narrowing, or existing shared types from `@cap/utils`, `@cap/web-domain`, generated bindings, etc.
- Do not introduce `@ts-expect-error` / `@ts-ignore` without a concrete reason. Prefer fixing the type.

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
- TypeScript / JS / JSON / CSS: **tab indent** and **double-quoted** strings, enforced by Biome (see `biome.json`). Do not configure per-file overrides.
- Rust: `rustfmt` default style + the denied clippy lints in the Pre-Generation Invariants above.
- Naming: files kebab‑case (`user-menu.tsx`); React/Solid components PascalCase; hooks `useX`; Rust modules snake_case; crates kebab‑case.
- Runtime: Node 20, pnpm 10.5.2, Rust 1.88+, Docker for MySQL/MinIO.

(See **Pre-Generation Invariants** at the top of this file for the zero-comments rule and the denied clippy/Biome patterns. Those are the source of truth — do not duplicate or weaken them here.)

## Testing
- TS/JS: Vitest where present (e.g., desktop). Name tests `*.test.ts(x)` near sources.
- Rust: `cargo test` per crate; tests in `src` or `tests`.
- Prefer unit tests for logic and light smoke tests for flows; no strict coverage yet.

## Commits & PRs
- Conventional style: `feat:`, `fix:`, `chore:`, `improve:`, `refactor:`, `docs:` (e.g., `fix: hide watermark for pro users`).
- PRs: clear description, linked issues, screenshots/GIFs for UI, env/migration notes. Keep scope tight and update docs when behavior changes.

## Agent‑Specific Practices
- Do not start extra servers; use `pnpm dev:web` or `pnpm dev:desktop` as needed.
- Prefer existing scripts and Turbo filters over ad‑hoc commands; clear `.turbo` only when necessary.
- Database flow: always `db:generate` → `db:push` before relying on new schema.
- Keep secrets out of VCS; configure via `.env` from `pnpm env-setup`.
- macOS note: desktop permissions (screen/mic) apply to the terminal running `pnpm dev:desktop`.
- All other agent-facing rules (no comments, no editing generated files, clippy/Biome shape, post-edit gates) live in **Pre-Generation Invariants** at the top of this file.

## Effect Usage
- Next.js API routes in `apps/web/app/api/*` are built with `@effect/platform`'s `HttpApi` builder; copy the existing class/group/endpoint pattern instead of ad-hoc handlers.
- Acquire backend services (e.g., `Videos`, `S3Buckets`) inside `Effect.gen` blocks and wire them through `Layer.provide`/`HttpApiBuilder.group`, translating domain errors to `HttpApiError` variants.
- Convert the effectful API to a Next.js handler with `apiToHandler(ApiLive)` from `@/lib/server` and export the returned `handler`—avoid calling `runPromise` inside route files.
- On the server, run effects through `EffectRuntime.runPromise` from `@/lib/server`, typically after `provideOptionalAuth`, so cookies and per-request context are attached automatically.
- On the client, use `useEffectQuery`/`useEffectMutation` from `@/lib/EffectRuntime`; they already bind the managed runtime and tracing so you shouldn't call `EffectRuntime.run*` directly in components.

## Code Formatting & Lint Gates
Before declaring any task complete, the agent MUST run the appropriate gate for every file type it touched. These are not optional — they are the same gates CI runs.

- **Rust**: `cargo fmt --all` **and** `cargo clippy -p <crate> --all-targets -- -D warnings` (swap `-p <crate>` for `--workspace` if multiple crates were touched). `cargo check` is NOT a substitute — it does not run clippy's denied lints.
- **TS / JS / JSON / CSS / MD**: `pnpm format` **and** `pnpm lint`. If types changed, also `pnpm typecheck`.
- If a gate fails, fix the violation in the source (do NOT suppress with `#[allow(...)]`, `// biome-ignore`, or `any` unless explicitly approved). The Pre-Generation Invariants show the correct form for every denied lint.
