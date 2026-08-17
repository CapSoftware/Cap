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
own revisions of the wgpu and font stacks. Incremental builds after that are
under a second.

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
| **Search is minimal** | gpui ships no text input. Ours tracks focus, takes `key_char` so dead keys and option-layouts work, and draws a static 1px caret. No selection, no cursor movement, no blink. Escape clears, then closes. |
| **Plan badge is always "Personal"** | Which of Pro/Commercial applies comes from the license query. There is no auth or license plumbing yet, and claiming a plan would be worse than showing none. |
| **Recents cards reveal, they do not open** | `openRecentMedia` routes a studio card to the Editor window (recovering first if needed), an instant card to its share link, and a screenshot to the Screenshot Editor. None of those exist here, so the whole card reveals its `.cap` bundle in Finder instead — the action the Recordings settings page calls "Open recording bundle". No hover affordance was invented for it: the real card has none either, it is click-only with no context menu. |
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
| Editor | 1275×800 | **Dependencies reconciled** — `cap-editor`/`cap-rendering`/`cap-export` link and render a real frame headlessly (see below). No window yet; by far the largest |
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
| **Selects are in-window menus** | `SelectSettingItem` and the excluded-windows Add button pop a real `NSMenu` via `Menu.popup()`. Ours draws a menu-shaped panel at the pointer (which is where `popup()` with no argument puts it), with the same check marks and the same click-away dismiss. |
| **Text fields are the search field's cousin** | gpui ships no text input, so the project-name template and the server URL use the same hand-rolled field as the main window's search: focus tracking, `key_char` for the typed character, a static caret, Escape to revert. No selection, no cursor movement, no blink. |
| **The project-name preview is literal-only** | `commands.formatProjectName` understands `{moment:<format>}` and custom `{date:...}`/`{time:...}` formats through a moment-to-chrono translation. The preview here substitutes the six literal placeholders the card documents and leaves anything else alone — which is also what an unknown placeholder does there. |
| **Theme tiles keep a fixed height** | `aspect-[5/3]` has no gpui equivalent, so the three previews are 93px tall, the height they have at the window's default 782 width. Widen the window and they stay 93. |
| **`AccentColor` is macOS blue** | `--macos-settings-accent: AccentColor` resolves to the user's system accent; gpui exposes no query for it, so the checked toggles and the selected sidebar icon use `#007aff`. A user on a non-blue accent sees blue here and their own colour in the shipping app. |
| **No toggle bevel** | `.cap-toggle` carries `box-shadow: inset 0 1px 2px rgba(0,0,0,0.16)`; there is no inset-shadow hook in this gpui rev, so the track is flat. |
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
| **The editor is append-only** | gpui ships no text input. Typing appends, Return inserts a newline, Backspace deletes the last character, and the caret is a `\|` glyph drawn at the end while the window has focus. No selection, no arrow-key navigation, no click-to-position, no paste — a longer script has to arrive through the store (or `CAP_GPUI_AUTO_TELEPROMPTER`). This is the same gap as the main window's search field, one dimension bigger. |
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

`CAP_GPUI_TAURI_STORE=<path>` points every settings read and write at another
file. Use it for anything that toggles a setting: the default is the store the
shipping app is also writing, and a probe run should not be editing the real
one. `cp "$HOME/Library/Application Support/so.cap.desktop/store" /tmp/probe`
first, so the copy carries the real unknown keys.
