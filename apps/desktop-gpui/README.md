# cap-desktop-gpui

Cap's desktop app, rewritten in [gpui](https://www.gpui.rs/). No Tauri, no
webview — the whole UI is drawn by gpui and every pixel is Rust.

This is milestone 1: **the main recording window**, compact and expanded, with
real device enumeration. It is a parallel implementation, not a replacement.
`apps/desktop` is untouched and remains the shipping app.

| | |
|---|---|
| ![compact](docs/main-window-compact.png) | ![expanded](docs/main-window-expanded.png) |
| 330×395 | 600×660 |

## Running it

```sh
cd apps/desktop-gpui
cargo run
```

`RUST_LOG=cap_gpui=debug cargo run` for logs — note the filter is `cap_gpui`
(the binary), not `cap_desktop_gpui` (the package).

The first build takes a few minutes and about 8 GB of `target/`: gpui pulls its
own revisions of the wgpu and font stacks. Rebuilds after that are seconds —
the dependencies build at `opt-level = 2` and so, since the editor landed, does
the app crate: the editor's per-frame pixel conversion is 30ms unoptimised and
0.92ms optimised, which is the difference between a 33fps preview and a 60fps
one (see the editor's measurements below).

### Why it is a separate workspace

`Cargo.toml` declares its own `[workspace]`. The root workspace carries
`[patch.crates-io]` entries — a vendored `wgpu-hal`, a forked `tao` — that exist
only for the Tauri app and that gpui's tree does not want. Nesting a second
workspace here leaves the root `Cargo.lock`, the `cargo hakari` workspace-hack
and CI completely untouched.

`rust-toolchain.toml` pins `stable` rather than the root's 1.88.0, because
gpui's dependencies need 1.89+ (`smol_str` 0.3.6, `cosmic-text` 0.19). The
nearest toolchain file wins, so the Tauri app is unaffected.

## What is implemented

Everything below is real, not mocked.

- **Window shell.** Undecorated, transparent, 16px rounded, fixed size. Custom
  header with hand-drawn traffic lights and a scoped drag region.
- **Compact and expanded layouts.** 330×395 and 600×660. Expanding adds section
  headings, turns the capture tiles horizontal with descriptions, widens the
  control rhythm from 8px to 10px, and reveals Recents.
- **Device enumeration.** Cameras via `cap-camera`, microphones via the Cap
  `cpal` fork, displays and windows via `scap-targets` — the same crates the
  recorder uses, so the identities are the ones `cap-recording` expects. Camera
  rows show the device's best advertised format, microphone rows the config the
  device would actually open with.
- **Pickers.** Camera, microphone, display and window, each a full-body panel
  with a live filter field. Displays and windows render as a two-column card
  grid with real refresh rates and bounds.
- **Mode selector**, whose dot opens the in-body info panel — what shipping
  `new-main` does (it passes `onInfoClick` into `Mode.tsx`). The standalone
  mode select window exists too; see below.
- **Light and dark**, following the system appearance, from the app's real
  resolved Radix values.
- **Native panel behavior.** The main window runs at window level 100 on all
  Spaces, exactly as `windows.rs` configures it — applied through a small
  `platform` module that reaches the `NSWindow` behind a gpui window via
  `raw-window-handle` (gpui exposes no level/Spaces API).
- **The native window material.** The main window sits on real Liquid Glass,
  with the vibrancy fallback behind it. See below.
- **Recording controls bar.** The 320×150 always-on-screen panel from
  `in-progress-recording.tsx`: stop with a live timer, pause/resume, restart,
  delete, mic indicator, drag handle. A non-activating panel
  (`WindowKind::PopUp`), so its buttons work without stealing focus from the
  app being recorded. While it is up the main window hides, and the bar's own
  window is excluded from the capture.
- **The settings window.** 782×775, resizable down to 780×560, on the
  `"settings"` material (radius 26) with the real traffic lights repositioned
  to (22, 22). The sidebar lists all twelve pages; **General** is built in
  full and writes to the same tauri-plugin-store file the shipping app uses.
  See below.
- **The mode select window.** The real 580×340 `mode-select` route — three
  cards, fixed size, opaque `bg-gray-1`, native traffic lights where AppKit
  puts them. Picking a mode goes through the same path the main window's own
  pill does. Opening it hides the main window and gets it back on close.
  Nothing in the shipping frontend reaches this window (see the deviation),
  so here it opens via `CAP_GPUI_AUTO_MODE_SELECT`.
- **Recents, with real thumbnails.** The expanded window's carousel is the
  real filesystem library: `list_recordings` + `list_screenshots` transcribed
  into `library.rs` (every known recordings folder, `recording-meta.json`
  parsed by `cap-project`'s own loader, sorted by the bundle's ctime, both
  lists capped at 9 and merged). The thumbnails are the pre-baked files inside
  each `.cap` — `screenshots/display.jpg` for a recording, the bundle's PNG for
  a screenshot — decoded on the background executor. See below.
- **The editor window, playing.** The real 1275×800 window with a project
  loaded through `EditorInstance`, the shell complete — header, letterboxed
  player, timeline strip, config sidebar — and **playback**: play/pause on the
  button and on Space, a live playhead and `M:SS / M:SS` clock at 60 fps, real
  audio, click and drag-scrub seeking on the timeline, and the source's
  end-of-media stop. Measured at 59.9 fps sustained with zero dropped frames.
  The controls the later units own render in place, disabled. See below.
- **The teleprompter.** 560×320, resizable to 420×220, native level 101 on all
  Spaces, on the `"teleprompter"` material at radius 22 with the traffic lights
  at (14, 14). A typed script, word-count-driven auto-scroll, WPM / opacity /
  font-size controls, cue markers, and window opacity through the NSWindow's
  own `alphaValue`. Excluded from Cap's own captures and content-protected
  while one is running. See below.

### Layout fidelity

Metrics are transcribed from `apps/desktop`, not eyeballed, and the Tailwind
class each one came from is quoted in a comment next to it — `pl-3` and
`gap-2.5` are much easier to check against the original than `12.` and `10.`.

The colour tokens are the resolved Radix values **with the dark-mode overrides
from `apps/desktop/src/styles/theme.css` applied**. Six of the dark grays and
`gray-11` are not stock Radix, so regenerating the palette from a Radix crate
would quietly change the app's colours.

### The native window material

The main window is not a `bg-gray-1` slab, and neither is the settings window.
`platform::install_window_material` does what
`applyMacOSWindowMaterial("panel")` (radius 16) or
`applyMacOSWindowMaterial("settings")` (radius 26) plus
`apply_main_window_liquid_glass_background` do in the shipping app:

- **macOS 26+** — an `NSGlassEffectView`, found by runtime class lookup,
  `setStyle:` regular (`SystemManaged`, radius 16), inserted `NSWindowBelow`
  gpui's Metal view. gpui's `contentView` is a plain AppKit container with the
  renderer view added as a subview, which is exactly the shape the Tauri code
  assumes, so the material drops in underneath unchanged. The *always-active*
  pin (`setState:` / `setActive:` probing) is deliberately **not** reproduced:
  that is the other windows' path, and the main window is system-managed in
  the shipping app too.
- **Below that** — an `NSVisualEffectView` on `windowBackground` (12),
  `BehindWindow`, `FollowsWindowActiveState`: the
  `setEffects({ effects: [Effect.WindowBackground] })` fallback.
- **Both paths** clip the content view's layer to a 16px `continuous` corner
  (`setCornerRadius:` + `setMasksToBounds:`), or the material renders a square
  corner outside the shell's own rounded quad.

Nothing here is private SPI. No occlusion mutation, no CGS, no window-alpha
tricks — an occlusion-suppressed surface is what wedged WindowServer
machine-wide once already, and the comment in
`apply_liquid_glass_background_inner` is the record of it.

What the shell paints *over* the material is transcribed from `theme.css`:

| | Liquid Glass | Vibrancy |
|---|---|---|
| `.cap-window-shell` | `rgba(255,255,255,0.55)` / `rgba(17,17,17,0.88)`, no border | `rgba(244,244,243,0.84)` / `rgba(17,17,17,0.94)` + 1px `--macos-settings-border` |
| `.cap-window-header` | transparent, hairline transparent | `rgba(250,250,249,0.72)` / `rgba(28,28,28,0.88)` |
| body `bg-gray-2`, `bg-gray-3` | `--macos-settings-control-fill` | unchanged |
| body `bg-gray-4` | `--macos-settings-control-hover` | unchanged |
| body `bg-gray-5` | `--macos-settings-control-active` | unchanged |
| body `hover:bg-gray-4/5` | `control-hover` | unchanged |
| body `hover:bg-gray-6/7` | `--macos-settings-selection` | unchanged |
| body `border-gray-4/5/6` | `--macos-settings-border` | unchanged |
| body text, `ring-offset-gray-1` | `--macos-settings-text`, transparent | unchanged |

The asymmetry is the CSS's, not ours: every `.cap-window-body` remap in
`theme.css` is gated on `[data-macos-visual-system="liquid-glass"]`, so
vibrancy only ever changes the shell and the header. The resolved values live
in `theme::MaterialTokens` with the rule each came from quoted next to it, and
`Theme` exposes them as `shell_bg()` / `body_fill(n)` / `body_hover_fill(n)` /
`body_border(n)` so a call site still reads as the Tailwind class it came from.

The settings window uses the *same* token set — the `--macos-settings-*`
custom properties are set by the visual-system blocks, not per material, so
one struct serves both windows and only the elements differ. It adds the
surfaces the panel material never lands on:

| | Liquid Glass | Vibrancy |
|---|---|---|
| `--macos-settings-window-radius` | 26 | 16 |
| `--macos-settings-sidebar-radius` | 18, then zeroed again by the settings rule | 0 |
| `.cap-settings-sidebar` | `rgba(255,255,255,0.58)` / `rgba(28,28,28,0.88)` | `rgba(250,250,249,0.74)` / `rgba(22,22,22,0.9)` |
| `.cap-settings-content` | `#f6f6f5` (opaque) / `rgba(17,17,17,0.92)` | `rgba(244,244,243,0.84)` / `rgba(17,17,17,0.94)` |
| `.cap-settings-card`, page `bg-gray-2` | `rgba(255,255,255,0.92)` / `rgba(28,28,28,0.94)` | `rgba(249,249,248,0.94)` / `rgba(28,28,28,0.96)` |
| page `bg-gray-3/4/5` → `--macos-settings-fill` | `rgba(0,0,0,0.045)` / `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.055)` / `rgba(255,255,255,0.05)` |
| nav/profile `:hover` → `--macos-settings-hover` | `rgba(0,0,0,0.065)` / `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.055)` / `rgba(255,255,255,0.05)` |
| description text → `--macos-settings-muted` | `rgba(0,0,0,0.48)` / `#a1a1a1` | same |

Only the sidebar is translucent under Liquid Glass; `--macos-settings-content`
is `#f6f6f5`, fully opaque, so the glass reads as a single lit edge down the
left rather than a see-through window.

The material is installed from a task after the window handle exists — subview
insertion re-enters gpui's window callbacks, so it cannot run inside an update
— and the result lands in a `platform::WindowMaterial` global that `render`
polls through `sync_appearance`.

## The component library

`src/ui/` is one component set for the whole app. Before it, every window was
hand-rolling its own buttons, toggles, selects, sliders, menus and cards — the
settings window had a `toggle()`, the teleprompter had a `tool_button()` and a
`render_range()`, the main window had a search field, the editor had a tab rail
— and the editor's own build-out would have added a seventh copy of each. The
Tauri app does not work that way either: `packages/ui-solid/src/Button.tsx`,
`components/Toggle.tsx` and `routes/editor/ui.tsx` are imported by the editor,
the settings pages, the teleprompter, the main window and the screenshot editor
alike.

| module | what it is | what it consolidated |
|---|---|---|
| `ui/button.rs` | `Button` (8 variants × 4 sizes) and `IconButton` | the settings window's `button()`; the main window's header `icon_button`; the teleprompter's `ToolButton`; the editor's transport play button. `IconButton` is also the `TooltipIconButton` the Solid app copy-pastes into three route files |
| `ui/toggle.rs` | `Toggle`, sizes `sm`/`md`/`lg` | the settings window's `toggle()` and the teleprompter popover's inline switch |
| `ui/slider.rs` | `Slider` + the pure value maths | the settings zoom slider, both teleprompter range pills, the editor's (inert) timeline zoom slider |
| `ui/segmented.rs` | `SegmentedControl`, the superset of the four Tauri idioms | the settings window's `segmented`/`segmented_raw`; `::pills` and `::icons` are the export page's and the text-align grid's, built ahead of their units |
| `ui/menu.rs` | `MenuState` (the keyboard contract) + `Menu` | the settings window's `Menu.popup()` stand-in |
| `ui/select.rs` | `Select` — the closed trigger a `Menu` opens | the settings `SelectSettingItem` button and the editor's preview-quality trigger |
| `ui/text_field.rs` | `TextField` + `text_edit_for` | the main window's search field and the settings window's two inputs |
| `ui/surface.rs` | `Card`, `Popover`, `SettingRow`, `Section` | the settings `card`/`rows`/`setting_row`/`Section`, the teleprompter's footer pill and settings popover, and the overlays' liquid-glass surface |
| `ui/collapsible.rs` | `CollapsibleState` + `Collapsible`, with real height measurement | the settings window's "Available placeholders" reveal |
| `ui/tab_rail.rs` | `TabRail` | the editor's six-tab config-sidebar rail |
| `ui/progress.rs` | `CircularProgress`, determinate + indeterminate | replaces all three of the Solid app's rings ahead of the export unit |
| `ui/kbd.rs` | `KbdChip` + `kbd_symbol` | the three divergent keycap looks, and the ⌘⌃⇧⌥-vs-`Ctrl`/`Shift`/`Alt` mapping each re-implements |
| `ui/tooltip.rs` | `Tooltip` over gpui's own `.tooltip()` | `Tooltip.tsx` and `ComingSoonTooltip`, for `EditorButton`'s `kbd`/`tooltipText`/`comingSoon` arms |

### How a component is themed

`theme.css` re-skins controls per window through attribute selectors —
`[data-macos-native-material="settings"] .cap-toggle { background:
var(--macos-settings-control-fill) }` and a few dozen siblings. There is no
general mechanism here to match it, because the remaps are not general: three
surfaces exist in the shipping CSS and each re-points a specific, enumerable
list of properties. So every component carries **named constructors, one per
surface**, and the quoted rule lives in the constructor:

| constructor | window | token set |
|---|---|---|
| `::body(theme, ..)` | main window | Radix, with `Theme::body_*`'s panel-material remaps |
| `::settings(theme, ..)` | settings | `--macos-settings-*` (`Theme::settings_*`) |
| `::glass(theme, ..)` | teleprompter | bare glass: `gray-12` at 5/7/8/10 % |
| `::plain(theme, ..)` | editor, mode select | Radix, no material |

A call site needing a colour no surface provides sets it explicitly — every
builder exposes the individual colours — so consolidation never costs fidelity.
Handlers are `impl Fn(&ClickEvent, &mut Window, &mut App)`, which is exactly
what `cx.listener(..)` produces for any window type, so components are
window-agnostic without a generic parameter; the components that dispatch by
index (`SegmentedControl`, `Menu`, `TabRail`) take `&usize` as their event for
the same reason.

### Behaviour contracts

What Kobalte contributed, reproduced by hand:

- **Menu.** Click-away *and* Escape dismiss, Arrow Down / Arrow Up walk the
  rows and wrap at both ends, Home / End jump, Enter (or Space) commits the
  highlighted row, and the value in force carries a check mark. The keyboard
  highlight is not *painted* until an arrow key is used: a menu opened by
  pointer shows the check mark and follows the mouse, exactly as a real
  `NSMenu` does — but Enter straight after opening still commits the current
  value, because the highlight is seeded either way. `MenuState` is a plain
  struct, so all of that is unit-tested without a window.
- **Slider.** The track's rect comes back from a zero-sized `canvas` in
  prepaint (every slider here lives in a resizable pane, so its width is
  unknown at build time), and a full-bleed transparent `drag_layer` stands in
  for DOM pointer capture so a drag that leaves the 48px pill keeps tracking.
  `snap_to_step` reproduces *both* formulas it replaced — the settings
  window's `(v * 10).round() / 10` and the teleprompter's `stepped` — across
  their whole range, which is what
  `slider_snapping_matches_the_formulas_it_replaced` asserts over 10 001
  sample points per range. It has to work for it: `0.1` is not representable
  in binary, so `(2.75 - 1.0) / 0.1f32` is `17.4999997` and the naive
  quantisation snaps an exact half-step *down*. The quotient is pre-quantised
  to six decimal places in `f64` first.
- **Collapsible.** Kobalte sets `--kb-collapsible-content-height` from the
  content's *measured* natural height and animates the `height` property
  itself, so the surrounding page reflows with it. Here the content is
  measured by a `canvas` inside its natural-size stack, the container's height
  is animated over 200ms ease-out by a ticker task (gpui only renders on
  invalidation), and an interrupted transition restarts from wherever the
  panel currently is rather than snapping. The first expand of a
  never-rendered panel is instant, because there is no measurement to animate
  towards yet. The keyframe's `filter: blur(5px) → blur(0)` cross-fade is not
  reproduced — same missing hook as the teleprompter's vignette.
- **TextField.** `text_edit_for` classifies a keystroke into
  Insert/Backspace/Escape/Ignored and the window keeps the string, because
  Escape means "clear the filter, then close the panel" in the main window and
  "revert to the stored value" in settings, and neither belongs in a
  component. Command and control chords never insert; Backspace and Escape are
  recognised whatever is held, because they are edits rather than characters.

Two things the Solid components do that this rev cannot: the **sliding
indicator** (`SwitchTab`, the tab rail and `FrameButton` all animate a
transform to the selected trigger's measured rect — there is no transform in
this gpui rev, so the selected item paints its own fill, which is what these
windows already did), and the **forced-open tooltip** the Solid `Slider` uses
to pin a value readout to the thumb mid-drag (`getAnchorRect`); gpui's tooltip
is hover-driven and pointer-anchored only.

`TabRail` is deliberately *not* shared with the settings sidebar. The usage
matrix lists `KTabs` in the editor and the screenshot editor only; the settings
sidebar is a vertical nav *list* (`.cap-settings-nav`, rendered with a `<For>`
over `settingsItems`), not a tab strip. Merging them would mean inventing a
component neither app has.

## Deviations from the Tauri app

Things that are deliberately different, and why.

| | |
|---|---|
| **Traffic lights are hand-drawn** | The Tauri main window returns `None` from `traffic_lights_position`, which routes it to `decorations(false)`; the lights are HTML there too. `titlebar: None` is the gpui equivalent. Minimize is not drawn, and zoom toggles expand/collapse. |
| **Only the chrome windows are on a material** | The main and settings windows are native (see below), which matches the shipping app exactly: `applyMacOSWindowMaterial` runs only in the `(window-chrome)` layout, so the camera bubble, the recording bar and the target overlays never had a native material in the Tauri app either — the bar's liquid-glass look is painted CSS. The teleprompter is the exception that proves it: it is not a chrome route, so it calls `applyMacOSWindowMaterial("teleprompter")` itself, and it is native here too. Mode select calls neither and is an opaque slab in both apps. The chrome window still to come is upgrade. |
| **No always-active pin on the settings glass** | `apply_liquid_glass_background_inner` gives the *non-main* Tauri windows an "always active" pin (`setState:` / `setActive:` probing on the glass view) so the material does not dim when the app deactivates. It is not reproduced: it broke on 26.3 and falls back to the plain `SystemManaged` install anyway, and the hard rule here is to make only the AppKit calls the shipping app can be shown to rely on. The settings window therefore takes the same `setStyle:`-only path the main window does. |
| **No header backdrop filter** | On the vibrancy path `.cap-window-header` is `rgba(250,250,249,0.72)` *plus* `backdrop-filter: blur(28px) saturate(1.45)`. The wash is here, the filter is not — same missing hook as the recording overlay's `backdrop-blur-xs`. |
| **Appearance changes need a relaunch** | `sync_appearance` runs from `render`, and gpui only renders on invalidation, so flipping the system to light while the app is up leaves the dark palette on screen until something else forces a frame. Pre-existing, not specific to the material. |
| **NSWindow, not NSPanel** | The Tauri app class-swizzles its windows into `NSPanel`s via `tauri_nspanel`. Here the main window stays a normal `NSWindow` and gets the observable parts — level 100, `CanJoinAllSpaces \| FullScreenPrimary` — from the `platform` module. (`WindowKind::Floating` is *not* a shortcut to this: its panel hides on app deactivation.) The controls bar *is* a real panel via `WindowKind::PopUp`, whose non-activating behavior it genuinely needs. |
| **Controls bar level 8, faithfully** | `windows.rs` raises the bar with `CGWindowLevelForKey(10)` under a constant named `kCGMaximumWindowLevelKey` — but key 10 is `kCGModalPanelWindowLevelKey` (maximum is 14), so the shipping bar actually runs at level 8. Reproduced verbatim rather than "fixed" from over here. |
| **Resize does not re-clamp** | Expand/collapse animates over 180ms with an ease-out cubic, as the Tauri app does, but does not re-clamp the window into the monitor work area afterwards — expanding near a screen edge can push the window off it. |
| **The mode select window is harness-only** | `Mode.tsx`'s info button is `commands.showWindow("ModeSelect")` *unless* its host passes `onInfoClick` — and shipping `new-main` passes one, so the dot opens the in-body `ModeInfoPanel` in both apps. Nothing else in the shipping frontend calls `showWindow("ModeSelect")` either, so the standalone window is dead code there; here it is built for parity and reachable via `CAP_GPUI_AUTO_MODE_SELECT`. The device and target pickers are body panels in both apps. |
| **No target thumbnails** | Display and window cards render the icon fallback the real card falls back to before its thumbnail arrives. Live previews need the capture pipeline. |
| **Search is minimal** | gpui ships no text input. `ui::TextField` tracks focus, takes `key_char` so dead keys and option-layouts work, and draws a static 1px caret. No selection, no cursor movement, no blink. Escape clears, then closes. The same field serves the settings window's two inputs. |
| **Plan badge is always "Personal"** | Which of Pro/Commercial applies comes from the license query. There is no auth or license plumbing yet, and claiming a plan would be worse than showing none. |
| **Only studio Recents cards open** | `openRecentMedia` routes a studio card to the Editor window (recovering first if needed), an instant card to its share link, and a screenshot to the Screenshot Editor. The studio arm is real now; the other two still reveal the `.cap` bundle in Finder — the action the Recordings settings page calls "Open recording bundle". The recovery step is not reproduced either, so an `InProgress`/`NeedsRemux` bundle reaches the editor's error state instead of being remuxed first. No hover affordance was invented: the real card has none either, it is click-only with no context menu. |
| **No carousel mask, snap or hover lift** | `RecentCarousel`'s edge fade is a scroll-position-driven `mask-image` and the cards are `snap-x snap-proximity`; the card's `hover:-translate-y-0.5` and the thumbnail's `group-hover:scale-[1.025]` are transforms. This gpui rev has neither a mask hook (same gap as the teleprompter vignette) nor a transform. The scroller, the gap, the `pr-8` gutter, the border/shadow hover and the trailing skeletons are all real — the skeletons just do not pulse (`animate-pulse` has no keyframe hook either). |
| **Thumbnails are downsampled to the card** | `create_screenshot(.., None)` writes `display.jpg` at the display's *native* resolution — 3024×1964 here. The browser scales that per `<img>`; a gpui sprite atlas would hold nine of them whole, so each is resized to 392×224 (the card at 2×) during the same background decode. `ObjectFit::Cover` then crops as `object-cover` does. |
| **Blur bridges on studio only** | `project_config_from_recording` is the studio arm of `handle_recording_finish`; the instant arm never writes a project config, so neither does this. |
| **Window filter is duplicated** | The level-0 listability rule is copied from `cap_recording::sources::screen_capture` rather than imported — that crate drags in ffmpeg and the whole encode stack, which this app has no other reason to build. |

### gpui traps worth knowing

**Do not touch the window from inside `open_window`'s builder closure.**
`MainWindow::new` runs before the platform window is finished. A `resize` there
produces a window whose viewport disagrees with its scale factor — every `px()`
comes out at exactly twice its size — and a task spawned there updates the model
without ever scheduling a frame. Both failures are silent. Set the initial size
through the bounds passed to `open_window`, and start async work from `main`
once the window handle exists.

**Do not mutate AppKit window state from inside a gpui update.** `setFrame:`,
`orderFrontRegardless`, subview insertion and content-view layer mutation all
synchronously fire gpui's own move/resize/frame callbacks, which re-borrow the
App — inside a window or entity update that logs `RefCell already borrowed`
and silently drops the callback. Grab the `NSWindow` inside the update, then
do the AppKit calls from a spawned task (`platform::place_overlay_panel`,
`platform::install_window_material`).

**Titled windows cannot cover the menu bar.** Every gpui window — `PopUp`
panels included — carries `NSTitledWindowMask`, so AppKit's
`constrainFrameRect:toScreen:` pushes a display-covering window 33pt down.
The Tauri app never sees this because tao's `NSWindow` subclass overrides the
method to return the rect unchanged; `platform::install_occlusion_shim`
installs the same override on gpui's window classes.

## Parity roadmap

Sizes are the Tauri app's, from `apps/desktop/src-tauri/src/windows.rs`.

| Window | Size | Status |
|---|---|---|
| Main | 330×395 / 600×660 | **Done** — layout, devices, pickers, modes, recording, Recents with real thumbnails, level-100 panel behavior, native Liquid Glass / vibrancy material |
| Camera preview | size×(size+56), 150–600 | **Done** — live frames, round/square/full shapes, S/L sizes, hover toolbar, corner resize, drag, persisted chrome state, capture-excluded in studio / included in instant |
| Recording controls | 320×150 | **Done** — live timer, pause/resume, restart, delete, live mic level, instant-mode mute, drag; capture-excluded, non-activating |
| Target select overlay | per display | **Done** — all four variants (display / window / area / camera-only), one transparent non-activating panel per display at the Tauri-verbatim level 7, cursor-following highlight, click-to-pin windows with app icons, draw/move/resize area selection with min-size validation, the real Start Recording flow (overlays close, bar opens, overlays excluded from capture), Escape/close dismiss |
| Window capture occluder | per display | Not started |
| Capture area | per display | Superseded — area selection is the target-select overlay's area variant; the Tauri app still registers a standalone `capture-area` window but nothing in its frontend opens it |
| Recordings overlay | per display | Not started |
| Mode select | 580×340 | **Done** — the real fixed-size window, opaque `bg-gray-1` with the native traffic lights at their default position, three cards with the selected one's blue border / tint / check badge, main window hidden while it is up and restored on close |
| Settings | 782×775 (min 780×560) | **Done — General** — window shell on the `"settings"` material (radius 26), native traffic lights at (22, 22), resizable with the real min size, sidebar with all twelve pages, the General page in full against the shared Tauri store. The other eleven pages are placeholder bodies |
| Upgrade | 950×850 | Not started |
| Onboarding | dynamic, 860–1080 wide | Not started |
| Teleprompter | 560×320 | **Done, with deviations** — resizable to the 420×220 floor, level 101 on all Spaces, the `"teleprompter"` material at radius 22, traffic lights at (14, 14), auto-scroll from the ported `teleprompter-utils` maths, the full footer and settings popover, native window opacity, the `teleprompter` store section, capture exclusion + content protection. The script editor is append-only and Mirror is inert — see below |
| Editor | 1275×800 | **E1+E2 done — window, shell, playback.** The real 1275×800 window with the traffic lights at (20, 32), the header, the letterboxed player, the 260px timeline strip and the 416px config sidebar with its six-tab rail; a real project through `EditorInstance`; play/pause (button + Space), a 60fps live playhead and clock, real audio, click/drag seeking, end-of-media stop. Timeline interaction (E3) and the sidebar's controls are pending — every affordance they own renders in place and disabled |
| Screenshot editor | 1240×800 (min 800×600) | Not started |

## Recording

The app records for real, through the same `cap-recording` actors the Tauri
app drives — studio and instant, screen + microphone, written into the same
recordings library (`recordingsPath` from the Tauri settings store, falling
back to `<app data>/recordings`; `CAP_GPUI_RECORDINGS_DIR` overrides both for
tests). Studio projects are finalized with `RecoveryManager::remux_if_needed`,
instant projects get `content/output.mp4` plus the
`recording-meta.json`/`project-config.json` pair, mirroring the CLI's
`finalize_completed` — a project recorded here exports cleanly with
`cap export`.

The flow matches the real app: starting opens the controls bar first (in its
"Starting" state) and hides the main window; the bar's window number is passed
to the recording actors as an excluded window so the bar never appears in the
capture; stop, delete, and a failed start all close the bar and bring the main
window back. Pause closes the live segment and resume opens the next one —
a paused recording produces exactly the multi-segment `.cap` the editor
expects. A microphone that enumerates but fails to open (Bluetooth profile
switches, Continuity devices) degrades to a no-mic recording instead of
failing the start.

Stopping does the two things `handle_recording_finish` does after the remux,
in its order — and nothing else, because the completion affordance is now
Recents rather than a Finder reveal:

- **`screenshots/display.jpg`.** `create_screenshot`
  (`apps/desktop/src-tauri/src/lib.rs:2582-2655`) is ported into `library.rs`:
  decode packets until the first video frame comes out, scale to RGB24 at the
  source's own size, save as JPEG. `cap-recording` does not write this file, so
  without it a project recorded here would show the icon fallback forever — in
  the shipping app too. The source path is read back off disk after the remux,
  because the remux is what decides where the display track lives (before it,
  the meta points at the fragmented `.../segment-0/display` *directory*).
  Instant projects take their frame from the already-muxed
  `content/output.mp4` rather than rebuilding a temporary from the DASH
  segments, which is the same first frame with one fewer file.
- **The camera blur bridge.** `project_config_from_recording` copies the live
  preview's blur toggle into the new project
  (`apps/desktop/src-tauri/src/recording.rs:3889-3891`,
  `config.camera.background_blur = BackgroundBlurConfig { mode: ... }`); blur is
  never baked into the recorded camera track by either app, so this field is the
  only thing that makes a project *open* blurred. `cap-recording` writes
  `project-config.json` itself and its builder takes no config, so the value is
  merged in afterwards: a read-modify-write on the raw JSON that replaces
  exactly `camera.backgroundBlur.mode` (`"off"`/`"light"`/`"heavy"`, the
  `BackgroundBlurMode` spelling) and leaves the other fifteen top-level
  sections alone. `store::set_store_setting`'s discipline on the other shared
  file, refusal included: a config that does not parse is never replaced.

Recording-specific deviations:

| | |
|---|---|
| **Bar timer, no countdown** | The countdown variant (`window.COUNTDOWN`) needs the settings store; the bar goes straight from Starting to the timer. |
| **Settings button is inert** | The bar's recording-settings popover menu is not built; the same applies to the gear button in the overlay's start cluster. |
| **No overlay blur** | The recording overlay is `bg-gray-1/80` without `backdrop-blur-xs`; this gpui rev has no per-element backdrop blur hook. The target-select overlay's liquid-glass surfaces drop their `backdrop-blur-xl` for the same reason. |
| **Escape is a focused key handler** | The Tauri app registers Escape as a *global* shortcut while the overlays are up; here it is a key handler on the overlay that holds focus (the one on the cursor's display). Escape pressed while another app is active does not dismiss. |
| **Overlay cluster is start-only** | The device row (camera/microphone selects under the start pill), the mode dropdown behind the caret, and the "What is X Mode?" link are deferred — device pickers live in the main window. The area toolbar shows the size readout but not the aspect-ratio/reset/fill/lock controls. |
| **Camera-only keeps the bubble** | The TSX inlines a camera preview into the camera-only overlay; ours keeps the separate camera preview window it already has. |
| **Camera id is DeviceID-only** | The Tauri app persists `ModelID` when a camera advertises one, so the same camera survives re-plugging into a different port. |
| **Defaults are the builder's** | `desktop_recording_defaults` (studio quality, fps caps, custom cursor) is not applied yet — it reads the Tauri settings store. |

`CAP_GPUI_AUTO_RECORD=studio:5` (or `instant:4`) arms the primary display and
drives a start/stop through the button code paths — the end-to-end check uses
it because unprivileged synthetic clicks are dropped. Add
`CAP_GPUI_AUTO_PAUSE=1` to pause for the middle third: two segments whose
summed duration is ~⅔ of wall time is the proof the pause reached the engine.
`CAP_GPUI_AUTO_CAMERA=1` selects the first camera at startup the way a click
would, opening the preview bubble; combined with `CAP_GPUI_AUTO_RECORD` it
verifies the camera track end to end.

`CAP_GPUI_AUTO_OVERLAY=display|window|area|camera` arms a target mode the way
clicking its tile does and opens the target-select overlays; on its own it
leaves them up (how the screenshots are taken), combined with
`CAP_GPUI_AUTO_RECORD` it routes the start through the overlay's own Start
button. `CAP_GPUI_AUTO_AREA=x,y,width,height` seeds the crop a drag would have
drawn (synthetic drags are dropped without Accessibility). The area variant
was verified end to end: a seeded 800×500 crop recorded a 1600×1000 (2×)
display track.

## Recents and the recordings library

The expanded window's carousel reads the same library the shipping app does,
by doing the same work rather than by asking it. `library.rs` is
`list_recordings` and `list_screenshots` transcribed
(`apps/desktop/src-tauri/src/lib.rs:3974-4092`) plus the `recentMedia` query's
merge (`new-main/index.tsx:2217-2263`):

- **Directories.** `known_recordings_dirs` — the active recordings folder,
  then the default `<app data>/recordings`, then every path in the store's
  `previousRecordingsPaths`, deduplicated by canonical path and skipping ones
  that do not exist. Recordings left behind in a folder the user has since
  switched away from stay visible, which is the whole point of that list.
  Screenshots come from `<app data>/screenshots`, which the custom-folder
  setting never moves.
- **Metadata.** `cap-project`'s own `RecordingMeta::load_for_project`, so the
  studio/instant split and the clip count come off the same enum the Tauri
  command reads them off. A directory whose `recording-meta.json` is missing
  or unparseable is skipped, exactly as `get_recording_meta`'s `Ok(..)` guard
  skips it.
- **Order.** `sort_time_millis` is not stored data: it is the bundle
  directory's `created()` (falling back to `modified()`), recomputed on every
  scan — and for a screenshot, the PNG's rather than the directory's. Both
  quirks are kept so the two apps order an identical library identically. Each
  list is capped at 9 *before* the merge and the merged list capped again,
  which is what stops ten screenshots from crowding out a recording newer than
  nine of them.
- **Thumbnails.** No video is decoded at render time: the files are already
  there. A recording draws `screenshots/display.jpg`, a screenshot draws its
  own PNG, and a bundle with neither draws the icon fallback the real card
  falls back to — which is what every recording made before this unit does.
- **Scheduling.** The scan and every decode run on the background executor and
  land through `cx.notify()` + `window.refresh()`, never on the render path: a
  library with several hundred bundles is several hundred `read_dir`s and JSON
  parses, and the thumbnails are multi-megapixel JPEGs. The list arrives first
  so the cards can paint with their fallbacks, then each thumbnail replaces its
  own card's as it decodes — the shape `target_overlay::fetch_icon` uses. A
  refresh that a newer one supersedes is cancelled by dropping its task.
- **When it refreshes.** On expanding (the query's `enabled: isExpanded()`),
  and on every path that brings the main window back — which is what makes a
  recording that just finished appear at the head of the carousel without a
  restart.

`CAP_GPUI_RECORDINGS_DIR` scopes the scan as well as the writes: when it is
set, it is the *only* directory listed. A verification run that redirects the
library would otherwise still be reading the user's real one.

## Camera preview and app-scoped feeds

Selecting a camera spins up an app-scoped `CameraFeed` actor and opens the
preview bubble immediately, before any recording — the Tauri model. The same
applies to the microphone: an app-scoped `MicrophoneFeed` keeps a meter
running, which is what feeds the live level bar in the mic picker rows and on
the recording bar. Starting a recording locks the already-running feeds
(`feeds::camera::Lock` / `feeds::microphone::Lock`), so the preview never
stutters across a start, and the bar's mute button (instant mode only, like
the real app) flips the recording-scoped payload-zeroing mute on the mic lock.

Frames arrive as `420v` CoreMedia sample buffers on a bounded flume channel.
gpui's zero-copy `surface()` element turned out to be unusable for this on the
pinned rev — its Metal path hard-asserts `420f`, and surface primitives ignore
rounded-corner clipping (fatal when the default shape is a circle). Instead
VideoToolbox converts `420v` → BGRA in hardware, one row-copy lifts the frame
into a gpui `RenderImage`, and the previous frame's image is explicitly
dropped from the sprite atlas each frame. Cover-fit and the circular clip both
hold on the image path. Camera-window deviations: no mirroring (no flip
transform exists in this gpui rev — the toolbar button is present but
disabled), background blur does not process *preview* frames yet (the
`cap-camera-effects` segmentation pipeline needs a `wgpu::Device` this app
does not have — it is its own unit), the window position is not persisted
per-monitor, and chrome state persists to `gpui-state.json` next to the Tauri
store rather than `localStorage`.

The blur toggle is no longer preview-only state, though: its value is copied
into every studio recording's `project-config.json` at finalize time, the way
`project_config_from_recording` copies the Tauri preview's (see Recording
above). Blur was always non-destructive in both apps — the recorded camera
track is raw and the editor re-runs the pipeline over it from that field — so
a project recorded here with the bubble set to Light opens Light in the
shipping editor, whether or not the bubble itself ever painted the blur.

### The macOS 26 display-link fix

The single most important platform finding so far: on macOS 26,
`NSWindow.occlusionState` reports visible windows with an undocumented bit
(`0x2000`) instead of the documented `NSWindowOcclusionStateVisible` (`0x2`)
— and gpui only starts a window's CVDisplayLink when it sees `0x2`. Result:
**no window in this app ever received frame callbacks** — first paint, then
frozen. Every earlier "inactive repaint" workaround (250ms `refresh()` ticks)
was painting nothing; the bar's timer sat on "Starting" through entire
recordings. `platform::install_occlusion_shim` overrides `occlusionState` on
gpui's own window classes to OR the documented bit back in whenever AppKit
reports any visibility, and `apply_panel_behavior` re-fires the occlusion
handler so the link starts. With it, the bar timer ticks and the camera
renders at capture cadence while another app is frontmost. Remove the shim
when the gpui pin understands the macOS 26 bit.

Running from a dev build needs the ffmpeg dylibs the binary's install names
point at (`@executable_path/../Frameworks/Spacedrive.framework/...`):

```sh
mkdir -p target/Frameworks
ln -sfn "$(pwd)/../../target/native-deps/Spacedrive.framework" target/Frameworks/Spacedrive.framework
```

## Settings, and the store both apps share

The header gear opens the real second window — 782×775, resizable to a
780×560 minimum, the `"settings"` material at radius 26 — and hides the main
window, which is exactly what `new-main/index.tsx` does
(`showWindow({ Settings: { page: "general" } })` then
`getCurrentWindow().hide()`). Closing it brings the main window back, matching
the `CapWindowId::Settings` arm of the Tauri app's `Destroyed` handler
(`restore_main_and_target_select_windows`) — without that the gear would leave
the app with no visible window at all. Cmd-W closes it, as
`(window-chrome).tsx` binds for every chrome window; Escape is not bound
there and is not bound here.

Unlike the main window these are the **real** traffic lights: the Tauri
settings window returns `Some(Some(LogicalPosition::new(22.0, 22.0)))` from
`traffic_lights_position`, i.e. it keeps AppKit's buttons and moves them, and
the chrome layout returns `null` for its own header on the settings route.
gpui expresses that as `TitlebarOptions { appears_transparent: true,
traffic_light_position: Some(point(px(22.), px(22.))) }`, and the min size as
`window_min_size` — no `setContentMinSize:` helper was needed.

The sidebar carries all twelve entries of `settingsItems`, in order, none of
them gated: General, Shortcuts (route `hotkeys`), CLI, Recordings,
Screenshots, Automations, Transcription, Integrations, License, Experimental,
Feedback, Changelog. Only **General** is built.

### The store contract

`general.tsx` writes through `generalSettingsStore`, i.e. the
tauri-plugin-store file `Store.load("store")` — `store` (no extension) inside
`so.cap.desktop`'s app-data dir. This app writes the same file, and every
write is a read-modify-write on the raw JSON that replaces exactly
`store[section][key]`: `store::set_store_setting`. Serializing a typed struct
back over the file would silently drop `auth`, `presets`, the migration flags
and the two thirds of `general_settings` no page here renders — the store test
`writing_one_setting_preserves_unknown_keys` is what holds that line. A store
file that exists but does not parse is never written to at all, because
replacing it with a fresh object would delete someone's auth token.

Reads are field-by-field rather than `derive(Deserialize)` on a struct: one
enum value written by a newer Tauri build would otherwise fail the whole
deserialize and blank every row on the page. `CAP_GPUI_TAURI_STORE` points the
whole module at a copy, which is how the tests — and any verification run that
must not touch real settings — work.

Settings-specific deviations:

| | |
|---|---|
| **Eleven placeholder pages** | Shortcuts, CLI, Recordings, Screenshots, Automations, Transcription, Integrations, License, Experimental, Feedback and Changelog render their name, a one-line description and a card saying they are not part of the rewrite yet. The sidebar is real; the bodies are not. |
| **No auth, so the free-plan variant** | There is no auth store here (same gap as the main window's plan badge), so the profile row shows the signed-out "Click to sign in" state and does nothing when clicked, and the Cap Pro section renders as it does for a free user: Instant Mode quality pinned to 720p, the other tiers inert. In the Tauri app clicking a locked tier raises an upgrade toast. `instantModeMaxResolution` is therefore displayed but never written. |
| **Selects are in-window menus** | `SelectSettingItem` and the excluded-windows Add button pop a real `NSMenu` via `Menu.popup()`. `ui::Menu` draws a menu-shaped panel at the pointer (which is where `popup()` with no argument puts it), with the same check marks, the same click-away dismiss, and the `KSelect` keyboard contract on top: arrows, Home/End, Enter, Escape. It does not flip or shift to stay inside the window, so a menu opened near the right edge is clipped by it — as it was before the consolidation. |
| **Text fields are the search field's cousin** | gpui ships no text input, so the project-name template and the server URL are literally the main window's search field: `ui::TextField::settings` and `ui::TextField::search` differ only in their fills. Focus tracking, `key_char` for the typed character, a static caret, Escape to revert. No selection, no cursor movement, no blink. |
| **The project-name preview is literal-only** | `commands.formatProjectName` understands `{moment:<format>}` and custom `{date:...}`/`{time:...}` formats through a moment-to-chrono translation. The preview here substitutes the six literal placeholders the card documents and leaves anything else alone — which is also what an unknown placeholder does there. |
| **Theme tiles keep a fixed height** | `aspect-[5/3]` has no gpui equivalent, so the three previews are 93px tall, the height they have at the window's default 782 width. Widen the window and they stay 93. |
| **`AccentColor` is macOS blue** | `--macos-settings-accent: AccentColor` resolves to the user's system accent; gpui exposes no query for it, so the checked toggles and the selected sidebar icon use `#007aff`. A user on a non-blue accent sees blue here and their own colour in the shipping app. |
| **No toggle bevel** | `.cap-toggle` carries `box-shadow: inset 0 1px 2px rgba(0,0,0,0.16)`; there is no inset-shadow hook in this gpui rev, so `ui::Toggle`'s track is flat on every surface. |
| **Settings does not park the other windows** | `ShowCapWindow::Settings::show` also calls `hide_recording_windows` and `release_camera_preview_if_idle`, and its close calls `restore_camera_window`. Neither half is reproduced — the gear hides the main window and nothing else. |
| **The theme setting is stored, not applied** | Selecting Light or Dark writes `theme`, which the Tauri app uses to force an appearance. This app follows the system appearance only (`sync_appearance`), so the tile is persisted parity, not behaviour. The same is true of `hideDockIcon`, `enableNotifications`, the countdown, the post-recording behaviours and the update channel: they persist, and the machinery that would obey them is not built yet. |
| **No confirm on the recordings folder move** | `pickRecordingsFolder` offers to migrate existing recordings afterwards; here the path is written and nothing is moved. |
| **Version is this crate's** | The sidebar footer shows `v0.1.0` from `CARGO_PKG_VERSION`, not `getVersion()`; "Check for updates" is drawn in its disabled state because there is no updater. |

## Mode select

The 580×340 picker behind the mode dot. It is *not* a `(window-chrome)` route,
so it has no shared header, no `applyMacOSWindowMaterial` and no Cmd-W: an
opaque `bg-gray-1` slab, the native traffic lights where AppKit puts them
(`traffic_lights_position` has no ModeSelect arm and takes the `_ => Some(None)`
catch-all), and the close button as the only way out. `ShowCapWindow::ModeSelect`
hides the main window first and its `Destroyed` arm calls
`restore_main_and_target_select_windows`, so both halves are here too — the same
pair the settings window uses.

Picking a card is `setOptions({ mode })` + `commands.setRecordingMode(mode)`.
Both live in `app_windows::set_recording_mode`, which the main window's pill and
its info panel also call, so a mode change happens in exactly one place and the
target-select overlay's start button relabels from it either way.

## Teleprompter

The one window the Tauri app does not build through `ShowCapWindow` — it is
constructed straight from JS (`new WebviewWindow("teleprompter", ...)`) — but
from over here it is just another window.

- **Level 101 on all Spaces.** `set_teleprompter_window_level(true)` sets
  `TELEPROMPTER_PANEL_LEVEL`, which `windows.rs` defines as `MAIN_PANEL_LEVEL +
  1`; `platform::teleprompter_level` is that literal, applied through the same
  `apply_panel_behavior` the main window's level 100 goes through. It stays a
  `WindowKind::Normal` window rather than a `PopUp` panel: it has to take
  keystrokes for the script, and a non-activating panel cannot.
- **The material.** `applyMacOSWindowMaterial("teleprompter")` at radius 22
  (16 on vibrancy). The material adds no custom properties of its own — its
  whole block in `theme.css` is two `border-radius` rules — so it reuses the
  shared `--macos-settings-*` token set. What it does *not* inherit is the
  panel's `rgba(255,255,255,0.55)` tint: that rule is gated on
  `[data-macos-native-material="panel"]`, so under Liquid Glass this window is
  bare glass, and its body keeps the Radix grays because the body remaps are
  panel-gated too.
- **Window opacity is native.** `windowOpacityPercent` (45–100, default 92)
  drives `NSWindow.setAlphaValue:` through `platform::set_window_alpha`, the
  same clamp (`0.45..1.0`) `crate::platform::set_window_opacity` applies — which
  is where the slider's floor of 45 comes from.
- **Auto-scroll.** `calculatePlaybackSpeed` / `advancePlaybackPosition` are
  ported verbatim as pure functions, with `teleprompter-utils.test.ts`'s four
  cases translated next to them. Play spawns a 16ms ticker that clamps each
  tick's elapsed time to 0.05s, advances the position, and calls `refresh` as
  well as `notify` — an inactive window only repaints when asked. It stops
  within 0.5px of the bottom, and an emptied script stops it too.
- **Persistence.** `{script, fontSize, wordsPerMinute, lineHeight,
  showCueMarkers, mirror, windowOpacityPercent}` under the store's top-level
  `teleprompter` key, defaults `{"", 30, 150, 1.5, true, false, 92}`, written
  250ms after the last change through `store::set_store_setting` — one key at a
  time, and only the keys that actually moved, so a field a newer Tauri build
  adds to the section survives. `onCloseRequested` force-saves before the window
  goes, so a script typed in the last 250ms is not lost; the pending write lives
  in an `Rc<RefCell<..>>` shared with that handler, which only ever gets an
  `&mut App`.
- **Hidden from recordings.** Both halves of the shipping behaviour: the
  window's number joins the excluded-windows list handed to the recording actors
  (`recording.rs`'s `teleprompter_exclusion`), and `apply_content_protection`'s
  `setSharingType: None` is applied for the duration of the recording and
  cleared afterwards. The gating is theirs, and the reason is in the comment
  above `capture_exclusion_hides_ui`: a permanently excluded window is invisible
  on capture-based displays.

Teleprompter-specific deviations:

| | |
|---|---|
| **The editor is append-only** | gpui ships no text input. Typing appends, Return inserts a newline, Backspace deletes the last character, and the caret is a `\|` glyph drawn at the end while the window has focus. No selection, no arrow-key navigation, no click-to-position, no paste — a longer script has to arrive through the store (or `CAP_GPUI_AUTO_TELEPROMPTER`). This is the same gap `ui::TextField` has, one dimension bigger — the script editor is multi-line, so it does not use it. |
| **Mirror is persisted but inert** | `scale-x-[-1]` needs a flip transform, and this gpui rev has none — the same finding that leaves the camera bubble's mirror button disabled. The toggle stores `mirror` so the setting survives for the shipping app; nothing on screen changes. |
| **The vignette is a wash, not a mask** | The script area's `mask-image` fades the *glyphs'* alpha to 0.4 at the top and bottom. With no mask hook, two `gray-1` gradient layers over the same 34% / 66% stops stand in. Over vibrancy that is nearly the same picture; over Liquid Glass it tints the backdrop instead of the text. |
| **No backdrop blur** | The settings popover is `bg-gray-1/80` *plus* `backdrop-blur-2xl`, and the footer pills add their own `backdrop-blur-xl`. The washes are here, the blur is not — the same missing hook as the header's `backdrop-filter` and the recording overlay's `backdrop-blur-xs`. |
| **No letter-spacing** | The script is `tracking-[-0.025em]` in the TSX; this gpui rev exposes no letter-spacing, so it renders at the font's own tracking. |
| **Cmd-W does not close it** | `(window-chrome).tsx` binds Cmd-W for the chrome windows only, and `/teleprompter` is not one of them — so, faithfully, neither is this. The traffic lights close it. |
| **Content protection is not refreshed on open** | `openTeleprompter` calls `refreshWindowContentProtection()` when it re-shows an existing window; that call is a no-op unless a recording is running, and here the recording start/stop transitions are the only thing that drives it. |

## The editor stack

The editor's crates are linked but no editor window exists yet. This is the
dependency reconciliation the editor units were blocked on, and the answer to
"do gpui's graphics stack and cap-rendering's fight?" is **no, and they never
could have**:

- **wgpu.** `cap-rendering` wants wgpu 25 and gpui's tree carries wgpu 29, but
  the 29 is reached only through `gpui_wgpu` ← `gpui_linux` / `gpui_web`. On
  macOS gpui renders through `gpui_macos`, which is Metal-direct and links no
  wgpu at all, so exactly one wgpu compiles here — 25.0.2, on the vendored
  `wgpu-hal` the `[patch.crates-io]` above already mirrored from the root
  workspace. `cargo tree -d` shows no duplicate `wgpu` or `naga` for the host
  target. (Both majors will be in the *lockfile*; that is resolution, not
  compilation.) Nothing about gpui's pin had to move.
- **`image`.** gpui asks for `0.25.1` and the cap crates for `0.25.2`; both are
  `^0.25`, so cargo unifies them to a single 0.25.x — 0.25.10 today, which is
  what gpui's own `Frame` has been built against here since the camera preview
  landed. The pin in `Cargo.toml` is a floor, not an exact version.
- **`workspace-hack`.** Every cap crate depends on it and it declares
  `tauri-utils`, so `tauri-utils` is in this lockfile. It was already, via
  `cap-recording`; the editor crates add no new path to it, and the `tauri`
  crate itself is still absent. It is a feature-unifier with no code.
- **`cap-editor` is genuinely tauri-free.** The websocket, the `WSFrame`
  repacking and the `CommandArg` extraction all live in
  `apps/desktop/src-tauri/src/editor_window.rs`, not in the crate. `axum` and
  `specta` are declared in `crates/editor/Cargo.toml` and referenced nowhere in
  `crates/editor/src/` — dead deps worth dropping upstream one day.

`tests/editor_frame0.rs` is the proof, and it is the shape the editor window's
frame path will take:

```sh
cargo test --test editor_frame0 -- --nocapture
```

It picks the newest studio `.cap` on the Desktop with a baked
`screenshots/display.jpg` (or `CAP_GPUI_E0_PROJECT=<path>`), **copies it**,
builds a real `EditorInstance` over the copy with the headless audio sink
(`AudioOutput::new_headless`, so no cpal device is opened), pushes one
instruction onto `preview_tx`, and writes the frame the callback hands back as
a PNG into `CARGO_TARGET_TMPDIR` (or `CAP_GPUI_E0_OUT_DIR`). With no `.cap`
available it skips rather than fails.

Three things it exists to pin down:

- **`seek_to` renders nothing.** It and `set_playhead_position` have identical
  bodies and only move `state.playhead_position`. The picture comes from
  `preview_tx.send_modify(|v| *v = Some((frame, fps, resolution_base)))`,
  through the preview renderer, out of the `frame_cb`. Drive the wrong one and
  the canvas stays black with no error anywhere.
- **The copy is not paranoia.** `EditorInstance::new` *writes*
  `project-config.json` back when it has to synthesise a timeline or clip
  offsets, so opening a bundle is not a read-only act.
- **`RenderedFrame` is row-padded** to wgpu's 256-byte copy alignment —
  1080×702 arrives as 4352 bytes per row, not 4320, and `data.len()` is
  `padded_bytes_per_row * height`. Walk `data.chunks(padded_bytes_per_row)` and
  keep `width * 4` of each, or the image comes out sheared.

The render size is not chosen by the test: it asserts
`ProjectUniforms::get_output_size(options, config, resolution_base)` at the
editor's real preview defaults (60 fps, 1920×1080 at 65 % → a 1248×702
resolution base, width aligned to 4 and height to 2). A display recording lands
at 1080×702. `shared_device` is `None` — gpui on macOS exposes no wgpu device to
share, so cap-rendering owns its own, which is the same two-GPU-context shape
the Tauri app already has.

## The editor window

`editor_window.rs` is the window that test grew into. E1's scope is the shell
and a correct static picture: **playback, timeline interaction and the config
sidebar's controls are E2/E3 and later**, and every affordance they own is
drawn in place and disabled rather than left out — the layout *is* the
deliverable, and a header missing half its buttons would not be one.

- **Opaque, no material, native traffic lights at (20, 32).** `/editor` is
  *not* a `(window-chrome)` route — it is a sibling of the `(window-chrome)`
  directory, so `applyMacOSWindowMaterial` never runs for it — and
  `is_transparent()` (`windows.rs:1069-1082`) does not list Editor. So no glass,
  no vibrancy, no rounded shell: an ordinary opaque window painting
  `bg-gray-2 dark:bg-gray-1`, with `traffic_lights_position` =
  `Some(Some(LogicalPosition::new(20.0, 32.0)))` expressed as
  `TitlebarOptions { appears_transparent: true, traffic_light_position }`, the
  same shape the settings window uses at (22, 22). The header's left group
  reserves the `h-full w-16` spacer the TSX puts there for them.
- **One window per `.cap` path.** `AppWindows::editors` is a
  `Vec<(PathBuf, WindowHandle<EditorWindow>)>`, the gpui spelling of
  `EditorWindowIds` (`windows.rs:3656-3659`); opening a project that already
  has a window focuses that one (`ShowCapWindow::Editor`'s path lookup at
  `windows.rs:1164-1181`). Paths are canonicalised first, so one bundle reached
  by two spellings is still one window.
- **The main window hides, and comes back when the last editor closes.** Both
  halves are the shipping app's: `hide_recording_windows(app, false)` runs
  before the editor is built (`windows.rs:1930`) and hides Main among others,
  and `openRecording` hides it again explicitly from the frontend
  (`new-main/index.tsx:2925`); the `CapWindowId::Editor` arm of `Destroyed`
  calls `restore_main_windows_if_no_editors` (`lib.rs:5788`), so a second
  editor still open keeps it away.
- **Load path.** Everything expensive is off the UI thread: the pre-flight runs
  on gpui's background executor and `EditorInstance::new` on the `gpui_tokio`
  runtime, because the instance's decoders, renderer and preview renderer are
  all tokio-spawned. `EditorInstance::new` is the one the Tauri app calls
  (`lib.rs:6592`) — not `new_with_audio_output`, which is the test's.
  `shared_device` stays `None`. Opening a project **does** take the audio
  device, despite `AudioOutput::new` only spawning a control thread:
  `EditorInstance::new` calls `audio_output.prewarm()`
  (`editor_instance.rs:305`), which sends `EnsureStream` and logs `Audio output
  stream ready device=Some("MacBook Pro Speakers")` before the first frame is
  ever asked for. (E1's note that the device opens lazily on the first play was
  wrong; the *stream* is opened at construction, the *source* is installed on
  play.)
- **Frame path.** `frame_cb` → bounded flume channel → un-pad the 256-byte
  stride → **RGBA → BGRA** (the render target is `Rgba8Unorm`; gpui's atlas
  wants BGRA, the same swap `library::decode_thumbnail` does) → `RenderImage`,
  converted on the background executor and delivered on the main one. The
  previous frame is dropped from the sprite atlas on every replacement, the
  camera bubble's rule. The picture comes from
  `preview_tx.send_modify(|v| *v = Some((0, 60, 1248×702)))` — the initial kick
  `lib.rs:6617-6618` does; `seek_to`/`set_playhead_position` render nothing.
  A display recording lands at **1080×702** with
  `FrameLayout.display == [0, 0, 1080, 702]`, which is what the E0 test pins.
- **Letterboxing.** `PreviewCanvas`'s maths verbatim (`Player.tsx:566-601`):
  4px padding off both axes, then fit by aspect, defaulting to 1920×1080 before
  a frame arrives. gpui has no `createElementBounds`, so the container's own
  painted bounds come back through a `canvas` element and the frame is painted
  into that rect with `window.paint_image`. The bars around it are the *player
  card*, not black: `background-color: #000000` is on the `<canvas>` itself, so
  black is painted only under the fitted rect.
- **A bad `.cap` is a screen, not a crash.**
  `ProjectRecordingsMeta::new` `.expect("Failed to read display video")`s on a
  display track that will not open (`project_recordings.rs:127-131`), and that
  call is made deep inside `EditorInstance::new`. `preflight` runs the same
  *synchronous* construction first, on a background thread, inside
  `catch_unwind`, along with every check `EditorInstance::new` would have
  returned as an `Err` (missing path, unparseable meta, non-studio, zero
  segments). Both arms were verified with deliberately corrupted copies in a
  temp dir: the multi-segment arm returns `Err`, the single-segment arm
  genuinely panics at `project_recordings.rs:129`, and both land on the
  in-window error state with the process still alive.
- **The bundle is opened read-write, deliberately.** `EditorInstance::new`
  writes `project-config.json` back when it has to synthesise a timeline or
  clip offsets (`editor_instance.rs:227, 263`). The Tauri app opens real
  bundles exactly this way, so parity means accepting the write; only the
  *tests* work on copies.

### Playback, the playhead and seeking

The transport is real: play/pause, a live playhead, click and drag-scrub on the
timeline, and the audio track through the editor's own `AudioOutput`.

- **Two seams, two channels, both latest-wins.** `frame_cb` already had one
  (E1's bounded flume queue). `on_state_change` — which E1 left as
  `|_state| {}` — now gets the other. It is `Fn + Send + Sync` and is called
  from the `cap-playback` OS thread (`playback.rs:1370-1374`) and from tokio
  workers, so it may not touch a gpui `Context`: it stores
  `state.playhead_position` in an `AtomicU32` and pokes a one-slot channel.
  The drain runs on the main thread and reads the atomic, so a burst coalesces
  to the newest position rather than queueing sixty stale ones a second. That
  atomic **is** the live playhead: `setEditorState("playbackTime",
  payload.playhead_position / FPS)` (`Editor.tsx:482-486`), 60 fps of it.
- **The transport is desired state, not commands.** Play, pause and seek write
  `{ playing, seek, seek_gen }` and poke a driver task on the tokio runtime,
  which applies the difference (stop → seek → start, in the source's order).
  Everything it calls locks `instance.state` and `start_playback` decodes the
  project's music tracks first, so none of it can run on the UI thread. The
  shape is not an invention: seeking *during* playback is a stop/seek/restart
  round trip (`seekPlayheadTo`, `Timeline/index.tsx:829-853`), and
  `beginRulerScrub` coalesces a drag's seeks to one in flight with the newest
  position applied afterwards (`seekInFlight`/`seekQueued`,
  `Timeline/index.tsx:890-909`). Latest-wins state gives exactly that and
  cannot accumulate a backlog of positions the user has already dragged past.
- **Play is `seekTo(floor(playbackTime * FPS))` then `startPlayback(60,
  1248×702)`** — `handlePlayPauseClick` (`Player.tsx:212-233`), including its
  at-the-end arm: pressing play at the end stops, rewinds to 0, and plays from
  there. Pause is `state.playback_task.take().map(|h| h.stop())`.
- **End of media is the frontend's rule, not the engine's.** The engine stops
  itself at `playback_time >= duration` (`playback.rs:963`), but the UI stops
  it 0.1s earlier: `isAtEnd()` is `total > 0 && total - playbackTime <= 0.1`
  and a `createEffect` calls `stopPlayback` the moment it goes true while
  playing (`Player.tsx:156-159, 205-210`). The playhead is **not** rewound — it
  parks at the end, which is what makes the button flip back to Play
  (`!playing || isAtEnd()`, `Player.tsx:388-392`) and the next press restart
  from 0. Verified: seeking to 95 % and pressing play stopped after 0.80s at
  frame 948 of 954, not after the 12s the harness asked for.
- **`totalDuration()` comes off the instance, not the pre-flight.**
  `EditorInstance::new` synthesises a timeline for a raw bundle and writes it
  back, and `timeline.duration()` is precisely what the playback engine stops
  at (`playback.rs:560-570`, `get_duration` at `rendering/src/lib.rs:1883`), so
  the number the 0.1s rule is measured against is read from
  `instance.project_config` once the instance exists.
- **Seeking.** `timelineTimeFromClientX` verbatim (`TL/index.tsx:818-827`),
  snap-to-zero zone (`START_SNAP_PX = 10`) and `[0, totalDuration]` clamp
  included; the paused repaint is the `preview_tx` push, because `seek_to`
  renders nothing. The two press behaviours are the source's two, and they are
  genuinely different: the ruler's own `z-40` hit surface scrubs continuously
  from mousedown (`beginRulerScrub`), while a press anywhere else in the
  timeline seeks **once, on release, to the press position** —
  `handleUpdatePlayhead` is registered on mouseup but closes over the mousedown
  event (`TL/index.tsx:1155-1169`). A press released *outside* the timeline
  seeks nothing, because the source's mouseup listener is on the container and
  the window-level one only disposes it. All three were checked with real
  `CGEvent` clicks: a ruler click at 25 % rendered frame 238 of 954, a click on
  the clip track at 75 % rendered 715, a drag from 10 % to 60 % walked
  95→135→174→…→572, and a press released over the player rendered nothing.
- **Prev and next are not frame steps.** The Tauri prev button is
  `stopPlayback` + `playbackTime = 0` + `transform.setPosition(0)` and next is
  `stopPlayback` + `playbackTime = totalDuration()` (`Player.tsx:370-405`) —
  jump to start and jump to end. Transcribed as they are.
- **Space is the only key binding here.** `useEditorShortcuts`
  (`Player.tsx:236-286`) binds `Space` (play/pause), `S` (split) and `Mod+=` /
  `Mod+-` (zoom); the last three are E3's. Undo/redo (`context.ts:1930-1950`)
  and Backspace/Delete (`TL/index.tsx:963`) belong to units that do not exist.
  `e.repeat` is ignored there and `is_held` here. Verified with a real
  `key code 49`: play, then pause 3.12s later at 59.9 fps.
- **Audio is the real `AudioOutput`.** Play logs `Applying audio output latency
  hint: 27.3 ms`, `Starting progressive audio pre-render duration_secs=15.9095
  sample_rate=48000 channels=2`, and `Progressive audio pre-render complete
  total_samples=1537312 memory_mb=5 elapsed_ms=5` — the recording's real mic
  track, resampled and handed to `MacBook Pro Speakers`. Closing the window
  mid-playback logs `Audio output thread finished` 5ms later.

#### The measured numbers

`CAP_GPUI_AUTO_PLAYBACK=16` on a 15.9s studio recording (display + mic),
1248×702 preview base, 1080×702 frames, dev build:

```
playback fps=59.9 frames=949 dropped=0 (rendered=949 rendered_fps=59.9 paints=1570 convert_avg=933us over 15.84s)
```

The engine's own `Playback stats` for the same run held
`effective_fps="60.0"–"60.4"` with `total_skipped=0` throughout, so nothing was
lost at any stage: the engine skipped nothing, `rendered` (frame_cb calls)
equals `frames` (frames that reached the window), and `dropped` is zero. There
is no shortfall to locate. `paints` is deliberately *not* the frame rate — the
window repaints for the clock and the playhead as well, so it runs ~1.65x ahead
of the frame count; it is listed so that a `paints` *below* `frames` would show
gpui coalescing pictures away before they were drawn.

The per-frame CPU conversion — un-pad the 256-byte-aligned rows, swap R/B,
build the `RenderImage` — costs **0.93ms** for a 1080×702 frame, i.e. 5.6 % of
a 60fps frame budget. **On this evidence the zero-copy upstream change
(`RenderSession::current_texture`, a shared `wgpu::Device`) is not worth doing
for playback yet.** It would buy back under a millisecond per frame on the
background executor, and the pump is not the bottleneck at any size the editor
currently renders. Revisit if the preview base moves to `full` (1920×1080 is
2.4× the pixels) or if a second live surface (camera) joins the same pump.

**The one real trap this measurement found is the dev profile.** With the app
crate at `opt-level = 0` the same conversion measures **30.1ms**, the pump
becomes convert-bound at 33 fps and the bounded channel drops **45 %** of the
renderer's frames (`playback fps=33.0 frames=523 dropped=423 …
convert_avg=30149us`). Nothing about the architecture changes — it is a
3MB-per-frame per-pixel loop compiled without optimisation. `Cargo.toml` now
carries `[profile.dev.package.cap-desktop-gpui] opt-level = 2` so a dev build
shows the editor at its real speed; it costs about seven seconds a build.

Reliability, same binary:

- **45 play/pause/seek cycles** (`CAP_GPUI_AUTO_PLAYBACK_TORTURE=45`): 45/45
  completed, 45 stop reports, zero errors, zero warnings, zero "RefCell already
  borrowed". Each 320ms burst delivered 14–20 frames at 41.8–59.8 fps (the low
  end is the burst that includes the engine's own start-up inside its 320ms),
  and **one** frame was dropped across all 45 cycles put together. RSS
  climbs to ~1.39 GB while cycling (the engine's `FRAME_CACHE_SIZE = 90` /
  `PREFETCH_BUFFER_SIZE = 90` of decoded frames) and settles at **1.106 GB**,
  flat to the kilobyte over the following 15s and no higher at cycle 45 than at
  cycle 11 — a plateau, not a leak. A paused editor with no playback sits at
  345 MB.
- **Closing mid-playback** (`CAP_GPUI_AUTO_EDITOR_CLOSE=3`, which sends
  `performClose:` — the traffic light's own path): `sample` shows one
  `cap-playback` thread while playing, **none** 1.2s after the close, and a new
  one after reopening. The app stays alive, the main window comes back, and the
  reopened editor plays again at 59.9 fps with zero drops.

Editor-specific deviations:

| | |
|---|---|
| **The header's buttons are inert** | Delete recording, Open recording bundle, Presets, Organization, Undo, Redo, Clips, Captions and Export all render at their real metrics in the `disabled:opacity-50` state. Each needs a unit that does not exist: project deletion, the preset store, auth, an undo stack, the clips/transcript layout modes, export. |
| **The name is displayed, not edited** | `NameEditor` is an `<input>` overlaying a measuring `<span>` that commits through `commands.setPrettyName`. gpui ships no text input (the same gap as the main window's search field and the teleprompter's script), so the name and its `.cap` suffix render read-only. |
| **The player toolbar is inert; the transport is not** | Prev / play-pause / next are live. Aspect ratio, Crop, Frame, Preview quality, split, zoom in/out and the zoom slider are still drawn at their real sizes and do nothing — the zoom controls drive the timeline transform, which is E3. |
| **No hover playhead and no preview time** | The Tauri timeline tracks `previewTime`: a grey playhead follows the pointer while paused, and the transport clock shows `previewTime ?? playbackTime` (`TL/index.tsx:1170-1188, 1255-1277`, `Player.tsx:359-365`). Hover state belongs with the rest of E3's timeline interaction, so the clock here is always the playhead's own time. |
| **The timeline transform is fixed** | Seeking maths carries `transform.position` and `transform.zoom` and is unit-tested with a panned viewport, but nothing moves them yet: zoom is pinned at `zoomOutLimit()` and position at 0 until E3 builds the wheel/pinch/minimap paths. Edge-panning during a scrub past the content edge (`stepEdgePan`) is therefore not reproduced either — the pointer is clamped to the content instead. |
| **Playing state is set optimistically** | `handlePlayPauseClick` flips `editorState.playing` *after* awaiting the command; here the button and the icon change immediately and the driver applies the change a moment later. Same end state, no visible round trip. |
| **Prev also seeks the engine** | The Tauri prev/next buttons only set `playbackTime`, leaving `state.playhead_position` stale until the next play's `seekTo`; here both go through the same seek path, which additionally emits the state change. Invisible either way — every play seeks first — and it keeps one code path for "the playhead moved". |
| **Preview quality is pinned to `half`** | The render runs at `default_editor_preview_resolution()` = 1248×702, the app's default. The Tauri select re-renders at `full`/`half`/`quarter` and the frame is *not* re-requested on window resize either — the letterbox just re-fits the frame it has, because the render size is resolution-base-driven, not player-area-driven. |
| **The config sidebar is a rail plus a placeholder** | The six-tab bar is real (`ui::TabRail`), at its 64px height with the `size-9` icon boxes, the selection pill and the two data-driven disabled states (camera when no segment has one, cursor when nothing was recorded). The panel bodies are a single "not part of this unit" card, as the settings window's eleven placeholder pages are. |
| **The timeline is two locked tracks, drawn, and a live playhead** | Clip and Zoom — the only two `trackDefinitions` marks `locked: true` — with their real gutter chips at the `--track-clip` / `--track-zoom` colours, the 32px ruler with its tick ladder, the clip segments carrying name and duration, and the playhead tracking playback and seeks. No segment drag, trim, split, zoom, minimap, edge fade or track manager; no optional tracks. The timeline height is the default 260 and its drag handle is inert. |
| **No layout modes and no dialogs** | Export replaces the whole editor, transcript splits it and clips swaps the sidebar; none of the three is built, so `fullscreenMode`, the split ratio and the modal set are absent. |
| **The editor does not park the other windows** | `ShowCapWindow::Editor` also hides the camera bubble and the target overlays and calls `release_camera_preview_if_idle`. Only the main-window half is reproduced, the same shape as the settings window's deviation. |
| **No prewarm** | `PendingEditorInstances::start_prewarm` runs *before* the Tauri window is built so decoders warm up in parallel with the webview. There is no webview to race here, so the instance is built once, after the window exists. |

## Verifying changes

`screencapture` cannot see windows without Screen Recording permission, but
per-window capture by id works. Get the window number from
`CGWindowListCopyWindowInfo` and then:

```sh
screencapture -x -o -l<window-id> shot.png
```

Measure against it rather than trusting the eye — the 2×-scale bug above was
invisible until the compact and expanded headers were compared pixel by pixel.

A per-window capture flattens only the window's *own* layers, so it never
contains the behind-window backdrop: the shell comes out as the flat tint over
black (a useful way to read the tint's alpha back, in fact — a 0.55 white tint
lands on `#8c8c8c`). Anything about the material actually being live has to be
judged from a full-screen `screencapture -x`.

`CAP_GPUI_AUTO_EXPAND=1` opens the window expanded, the way clicking the zoom
light does, for the same reason as the other `CAP_GPUI_AUTO_*` hooks:
unprivileged synthetic clicks are dropped.

`CAP_GPUI_AUTO_SETTINGS=1` opens the settings window at startup, exactly as
the header gear does (main window hidden included). Pass a page slug instead
of `1` — `CAP_GPUI_AUTO_SETTINGS=hotkeys` — to land on another sidebar entry;
an unknown slug falls back to General.

`CAP_GPUI_AUTO_MODE_SELECT=1` opens the mode select window at startup, exactly
as the mode dot does (main window hidden included). A mode name instead of `1`
— `CAP_GPUI_AUTO_MODE_SELECT=studio` — also clicks that card, which is how the
selection is checked end to end: the run logs `recording mode changed` with both
the main window's mode and the target-select overlay's.

`CAP_GPUI_AUTO_TELEPROMPTER=1` opens the teleprompter, as the header's
scan-text button does. Any other value is *typed into the script* through the
same `edit_script` a keystroke takes, debounced write included — how the
persistence round trip is checked without synthetic key events. Add
`CAP_GPUI_AUTO_PLAY=1` to press play 1.2s after opening, once the window has
painted and there is a scrollable height to move through.

`CAP_GPUI_AUTO_EDITOR=<path-to-.cap>` opens the editor on that bundle, exactly
as a studio Recents card does. `=1` picks the newest studio recording the
library scan finds — the same list Recents reads, so it is the card that would
be first in the carousel.

The editor's playback hooks all wait 1.5s after the project loads, so the
decoders are warm and the stopwatch measures playback rather than startup:

- `CAP_GPUI_AUTO_PLAYBACK=<seconds>` presses play, waits, and pauses — which
  logs the run's `playback fps=… frames=… dropped=…` line. (Every stop logs
  one; this just guarantees a stop happens.)
- `CAP_GPUI_AUTO_SEEK=<fraction>` seeks to a fraction along the timeline
  *through the click path*: the fraction becomes a window x and goes through
  the same `timeline_time_from_x` a real click does, so only gpui's event
  delivery is skipped. Applied before the play hook, which is how the
  end-of-media stop is checked (`CAP_GPUI_AUTO_SEEK=0.95` +
  `CAP_GPUI_AUTO_PLAYBACK=12` stops after 0.8s, not 12).
- `CAP_GPUI_AUTO_PLAYBACK_TORTURE=<cycles>` runs play → 320ms → pause → seek
  cycles, logging `torture: cycle done` each time and `torture: complete` at
  the end.
- `CAP_GPUI_AUTO_EDITOR_CLOSE=<seconds>` closes the editor that many seconds
  into playback via `performClose:` — the traffic light's own path, so
  `on_window_should_close` and `editor_closed` both run — then reopens it 2s
  later. Once per process, or the reopened window would close itself forever.

Real mouse and keyboard events *do* reach the app when the terminal has
Accessibility permission, which is how the seek and Space paths were checked
end to end rather than through their hooks: `swift click.swift <window-number>
<x> <y> [drag-to-x] [drag-to-y]` posts `CGEvent`s in window-relative logical
points, and `osascript -e 'tell application "System Events" to key code 49'`
sends Space. Without that permission both are silently dropped, which is why
the `CAP_GPUI_AUTO_*` hooks exist at all.

The component library's behaviour contracts were checked the same way, against
the settings window: a click on a select opens its menu, `key code 125` walks
the highlight (wrapping at the end), `key code 36` commits — the trigger's
label changes and the store gains the new value — `key code 53` dismisses, and
a click on the page dismisses too. The zoom slider was dragged with
`click.swift <win> 570 468 680 468`, which moved the readout 2.2x → 3.9x and
wrote `defaultZoomAmount: 3.9`; the value is exactly what the track geometry
predicts, which is what makes the drag maths checkable rather than plausible.
**One thing keyboard-driven verification cannot reach: the main window.** It is
a level-100 window that does not become key from a synthetic click, so keys
posted at it are dropped — with or without Accessibility, and identically on
the pre-consolidation binary. Its search field has to be checked through the
panel it filters.

`CAP_GPUI_AUTO_RECENT=1` clicks the first Recents card once the library scan
has landed (expanding the window first, since the scan only runs while
expanded), through `main_window::activate_recent` — the card's own handler.
`=twice` clicks it again 2.5s later, which is how the one-window-per-project
rule is checked: the second activation logs `editor already open for this
project; focusing it` instead of opening a second window.

`CAP_GPUI_TAURI_STORE=<path>` points every settings read and write at another
file. Use it for anything that toggles a setting: the default is the store the
shipping app is also writing, and a probe run should not be editing the real
one. `cp "$HOME/Library/Application Support/so.cap.desktop/store" /tmp/probe`
first, so the copy carries the real unknown keys.
