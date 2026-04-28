# Position Offset — Frontend Wiring TODO

Backend (`BackgroundConfiguration.position_offset_x/y`) and UI component
(`@cap/ui-solid` → `PositionOffsetField`) both exist. Desktop app does not yet
write to the new fields, so manual integration testing of the offset has no
effect until the wiring below is added.

## Places that need wiring

### 1. Video editor sidebar
**File:** `apps/desktop/src/routes/editor/ConfigSidebar.tsx` (~line 2024, after
the Padding `<Field>`).

**Why:** This is the main video editor. The existing padding slider already
follows the `setProject("background", "padding", v[0])` pattern — position
offset must follow the same pattern so recorded videos can shift the display
within the background.

**Suggested snippet:**
```tsx
<Field name="Position Offset" icon={<IconCapPadding class="size-4" />}>
  <PositionOffsetField
    value={{
      x: project.background.positionOffsetX,
      y: project.background.positionOffsetY,
    }}
    onChange={(v) => {
      setProject("background", "positionOffsetX", v.x);
      setProject("background", "positionOffsetY", v.y);
    }}
  />
</Field>
```

### 2. Screenshot editor background popover
**File:** `apps/desktop/src/routes/screenshot-editor/popovers/BackgroundSettingsPopover.tsx`.

**Why:** The screenshot editor uses the same `BackgroundConfiguration` struct
and already wires padding/rounding here. Without adding the offset field, the
feature will only work for video and not for screenshots, breaking parity.

Use the same `PositionOffsetField` snippet, bound to whatever local
`setProject`/store equivalent the popover already uses.

## Prerequisite (not wiring, but required)

Restart `pnpm dev:desktop` once after the Rust changes. `tauri_specta`
regenerates `apps/desktop/src/utils/tauri.ts`, which currently still has the
old `BackgroundConfiguration` shape (no `positionOffsetX/Y`). Without a restart
the TypeScript wiring above will not compile. Never edit `tauri.ts` by hand.

## Already done (no action needed)

- `BackgroundConfiguration` has `position_offset_x` / `position_offset_y`
  (snake_case in Rust → `positionOffsetX/Y` in TS via
  `#[serde(rename_all = "camelCase")]`).
- `#[serde(default)]` on the struct means old project JSONs without these
  fields deserialize to 0.0 — no migration needed.
- Renderer (`crates/rendering/src/lib.rs::display_layout`) consumes the offsets,
  applies a percentage shift within the available room, and clamps so the image
  stays visible.
- `PositionOffsetField` is exported from
  `packages/ui-solid/src/index.tsx`. The desktop app already depends on
  `@cap/ui-solid`, so the import will resolve.

## Quick manual test path before wiring

If you want to verify the renderer end-to-end before doing the UI work, edit
the project's saved config JSON on disk and set
`background.positionOffsetX` / `background.positionOffsetY` to a value in
roughly `[-50, 50]`, then reopen the project in the editor.
