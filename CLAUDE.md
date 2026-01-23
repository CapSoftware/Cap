# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cap is the open source alternative to Loom. It's a Turborepo monorepo with a Tauri v2 desktop app (Rust + SolidStart) and a Next.js web app.

**Core Applications:**
- `apps/web` — Next.js 14 (App Router) web application for sharing, management, dashboard
- `apps/desktop` — Tauri v2 desktop app with SolidStart (recording, editing)
- `apps/cli` — Rust CLI tool
- `apps/discord-bot` — Discord integration bot
- `apps/storybook` — UI component documentation

**Shared Packages:**
- `packages/database` — Drizzle ORM (MySQL), auth utilities, email templates
- `packages/ui` — React components for web
- `packages/ui-solid` — SolidJS components for desktop
- `packages/utils` — Shared utilities and types
- `packages/env` — Zod-validated environment modules
- `packages/web-*` — Effect-based web API layers

**Rust Crates** (`crates/*`):
- `media*`, `audio`, `video-decode` — Media processing pipeline
- `recording` — Core recording functionality
- `rendering`, `rendering-skia` — Video rendering and effects
- `camera*` — Cross-platform camera handling (AVFoundation, DirectShow, MediaFoundation)
- `scap-*` — Screen capture implementations

## Key Commands

### Initial Setup
```bash
pnpm install              # Install dependencies
pnpm env-setup            # Generate .env file (interactive)
pnpm cap-setup            # Install native dependencies (FFmpeg, etc.)
```

### Development
```bash
pnpm dev                  # Start web + desktop + Docker services
pnpm dev:web              # Web only (starts Docker for MySQL/MinIO)
pnpm dev:desktop          # Desktop only
cd apps/web && pnpm dev   # Web without Docker
```

### Build & Quality
```bash
pnpm build                # Build all via Turbo
pnpm tauri:build          # Build desktop release
pnpm lint                 # Lint with Biome
pnpm format               # Format with Biome
pnpm typecheck            # TypeScript check
cargo fmt                 # Format Rust code
cargo build -p <crate>    # Build specific Rust crate
cargo test -p <crate>     # Test specific Rust crate
```

### Database
```bash
pnpm db:generate          # Generate Drizzle migrations
pnpm db:push              # Push schema to MySQL
pnpm db:studio            # Open Drizzle Studio
```

### Docker
```bash
pnpm docker:up            # Start MySQL/MinIO containers
pnpm docker:stop          # Stop containers
pnpm docker:clean         # Remove containers and volumes
```

### Analytics (Tinybird)
```bash
pnpm analytics:setup      # Provision Tinybird data sources (destructive)
pnpm analytics:check      # Validate Tinybird schema
```

## Critical Rules

### Auto-generated Files (NEVER EDIT)
- `**/tauri.ts` — IPC bindings (regenerated on app load)
- `**/queries.ts` — Query bindings
- `apps/desktop/src-tauri/gen/**` — Tauri generated files

### NO CODE COMMENTS
Never add comments (`//`, `/* */`, `///`, `//!`, `#`, etc.) to any code. Code must be self-explanatory through naming, types, and structure.

### Server Management
Do not start additional dev servers unless asked. Assume the developer already has the environment running.

### Database Changes
Always run: `pnpm db:generate` → `pnpm db:push` → test

### Desktop Permissions (macOS)
When running from terminal, grant screen/mic permissions to the terminal app, not the Cap app.

## Architecture Patterns

### Technology Stack
- **Package Manager**: pnpm 10.5.2
- **Node**: 20+
- **Rust**: 1.88+
- **Build**: Turborepo
- **Frontend (Web)**: React 19 + Next.js 14.2.x (App Router)
- **Desktop**: Tauri v2, SolidStart
- **Database**: MySQL (PlanetScale) with Drizzle ORM
- **Storage**: S3-compatible (AWS, Cloudflare R2, MinIO for local)
- **AI**: Groq (primary) + OpenAI (fallback) — Server Actions only

### Server Actions (Web)
```typescript
"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";

export async function updateVideo(data: FormData) {
  const user = await getCurrentUser();
  if (!user?.id) throw new Error("Unauthorized");
  return await db().update(videos).set({ ... }).where(eq(videos.id, id));
}
```

### Desktop IPC (Tauri + specta)
Rust emit:
```rust
#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct UploadProgress { progress: f64, message: String }

UploadProgress { progress: 0.5, message: "Uploading...".to_string() }
  .emit(&app).ok();
```

Frontend listen (auto-generated):
```typescript
import { events, commands } from "./tauri";
await commands.startRecording({ ... });
await events.uploadProgress.listen((event) => {
  setProgress(event.payload.progress);
});
```

### React Query Pattern
```typescript
const { data, isLoading } = useQuery({
  queryKey: ["videos", userId],
  queryFn: () => getUserVideos(),
  staleTime: 5 * 60 * 1000,
});

const mutation = useMutation({
  mutationFn: updateVideo,
  onSuccess: (updated) => {
    queryClient.setQueryData(["video", updated.id], updated);
  },
});
```

### Effect System
- API routes use `@effect/platform`'s `HttpApi`/`HttpApiBuilder` pattern
- Acquire services via `yield*` in `Effect.gen` blocks
- Run server effects through `EffectRuntime.runPromise` from `@/lib/server`
- Client uses `useEffectQuery`/`useEffectMutation` from `@/lib/EffectRuntime`

## Important File Patterns

- `apps/web/actions/**/*.ts` — Server Actions ("use server")
- `packages/database/schema.ts` — Database schema
- `apps/web/app/api/*` — API routes (Effect/Hono-based)
- `packages/web-api-contract-effect` — Shared HTTP contracts for desktop

## Conventions

- **Directory naming**: lower-case-dashed
- **Components**: PascalCase
- **Hooks**: camelCase starting with `use`
- **Rust modules**: snake_case
- **Rust crates**: kebab-case
- **Files**: kebab-case (`user-menu.tsx`)
- Strict TypeScript; avoid `any`
- Use Biome for TS/JS; rustfmt for Rust

## Troubleshooting

- **Turbo cache issues**: `rm -rf .turbo`
- **IPC binding errors**: Restart dev server to regenerate `tauri.ts`
- **Node version**: Must be 20+
- **Clean rebuild**: `pnpm clean`
