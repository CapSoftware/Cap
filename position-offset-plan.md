# Position Offset Sliders — Plan & Decision Notes

## What I'm trying to do

Add a slider (or pair of sliders) to the Cap desktop editor sidebar to control video positioning — horizontal and vertical offset of the recorded video within its rendered background frame. Sliders go directly under the existing **Padding** slider in the right-hand config panel of the editor screen (see screenshot).

Why: padding shrinks the video uniformly; there's no way to bias the framed video off-center (e.g., shift it down to leave headroom for captions, or right to leave space for a side panel). Position offset closes that gap.

Target file for UI insertion: `apps/desktop/src/routes/editor/ConfigSidebar.tsx:2015-2024` (the `Field name="Padding"` block).

## Why we explored testing first

`ConfigSidebar.tsx` is 2000+ lines, deeply coupled to the project store and auto-generated Tauri IPC bindings (`tauri.ts`, `queries.ts`). Iterating by booting `pnpm dev:desktop`, navigating into the editor with a real recording, then eyeballing the slider is slow and brittle — every tweak costs a full app reload. I wanted a tighter visual loop and a way to assert the rendering math is right *before* sinking time into the change, so I'd actually finish today.

Two domains needed test paths:
1. **UI** — does the slider render and behave correctly in isolation?
2. **Rendering math** — does the offset value actually shift the video in the output frame, with sane clamping?

## Findings

### Rendering math (Rust)
- Offset/padding math lives at `crates/rendering/src/lib.rs:2085-2120` (`ProjectUniforms::display_offset`).
- Schema: `crates/project/src/configuration.rs:234` (`BackgroundConfiguration` — add `position_offset_x/y` here).
- Existing unit tests at `crates/rendering/src/lib.rs:2948+` already exercise `display_offset` with default `ProjectConfiguration`. Drop new tests next to them.
- Run cost: `cargo test -p cap-rendering offset` — sub-second, no Tauri, no UI.

### UI component (Solid)
- No existing isolated harness for editor components. Vitest is installed (`apps/desktop/package.json:89`) but `@solidjs/testing-library` is not; no `*.test.tsx` files in the editor route.
- **However:** `apps/storybook` is already wired with `storybook-solidjs-vite` and depends on `@cap/ui-solid` (workspace). Config glob: `packages/ui-solid/src/**/*.stories.tsx`. Zero stories exist today, but the pipe is ready and currently unused.
- Storybook gives hot-reload visual rendering at `localhost:6006` without booting Tauri or needing a recording fixture.

### Options considered for visual UI verification
| Option | Setup cost | Iteration speed | Verdict |
|---|---|---|---|
| `pnpm dev:desktop` only | 0 | Slow (full reload, needs recording) | Fallback only |
| Storybook (existing infra) | ~15 min | Fast (HMR) | **Chosen** |
| Playwright screenshot | Hours (install browsers, scaffold, baselines) | Medium | Skip — overkill today |
| Dev-only Solid route in desktop | Medium (stub Tauri imports) | Medium | Skip — Storybook is cleaner |
| Vitest + `@solidjs/testing-library` | Small (one dep) | Fast, but headless (no visual) | Optional add-on later |

## Decision

**Approach:**
1. Build the new sliders as a **pure component** in `packages/ui-solid/src/PositionOffsetField/index.tsx` — props `value: { x: number; y: number }`, `onChange`, range bounds. No store, no IPC.
2. Add `PositionOffsetField.stories.tsx` next to it; existing Storybook glob picks it up automatically.
3. Run `pnpm --filter @cap/storybook dev:storybook` → visual loop at http://localhost:6006.
4. Import the component into `ConfigSidebar.tsx` from `@cap/ui-solid`, wire to `setProject("background", "positionOffsetX/Y", ...)`.
5. Add `position_offset_x/y` fields to `BackgroundConfiguration` (`crates/project/src/configuration.rs:234`); thread through `display_offset` math (`crates/rendering/src/lib.rs:2115`).
6. Add Rust unit tests next to existing padding tests (`crates/rendering/src/lib.rs:2948+`) covering: zero offset matches existing centered behavior; positive x shifts right within bounds; offset is clamped so video stays visible.
7. Final manual check: `pnpm dev:desktop`, open editor, drag sliders, confirm rendered output matches.

### Decision factors

- **Time-to-first-pixel.** Storybook = ~15 min from zero to a live, visually-verified slider. Playwright = hours. Desktop boot = slow loop.
- **Existing infrastructure.** Storybook is already configured for Solid; using it costs only writing a story file. Adding Playwright would mean introducing a whole new tool and screenshot baselines.
- **Decoupling.** Putting the component in `@cap/ui-solid` as a pure props-in/callback-out component makes it trivially storybook-able *and* unit-testable later, without dragging in Tauri context.
- **Math correctness ≠ UI correctness.** Splitting visual verification (Storybook) from numeric verification (Rust unit tests) means each loop is fast and focused. No need for Playwright screenshots of the full editor when math is provable in isolation.
- **End-of-day shipping pressure.** Skip anything that requires more setup than the change itself.

## Open questions before coding

- Single 2D pad vs. two 1D sliders? Two sliders matches existing visual style (Padding, Blur, Rounded Corners) and is simpler to spec.
- Range units: percentage of available frame area (matches padding's `%` convention) or absolute pixels? Leaning %: stays meaningful across resolutions.
- Default: `{ x: 0, y: 0 }`. Bounds: `[-50, 50]` (% of available offset room).
- Does positive Y mean "down" (screen coords) or "up" (math coords)? Pick screen coords to match Padding semantics.

## Files I'll touch

- `packages/ui-solid/src/PositionOffsetField/index.tsx` (new)
- `packages/ui-solid/src/PositionOffsetField/PositionOffsetField.stories.tsx` (new)
- `packages/ui-solid/src/index.ts` (export)
- `apps/desktop/src/routes/editor/ConfigSidebar.tsx` (insert under Padding Field)
- `crates/project/src/configuration.rs` (`BackgroundConfiguration` fields)
- `crates/rendering/src/lib.rs` (`display_offset` math + unit tests)
- Auto-regenerated: `apps/src/utils/tauri.ts` (do not edit by hand)
