# Cap CleanShot X Replacement Plan

Created: 2026-05-21

## Goal

Make Cap good enough as a daily screenshot utility that CleanShot X is no longer needed, while preserving Cap's stronger open-source, cross-platform, recording, editing, and sharing direction.

## Active Branch Tracking

Each major feature area should stay on its own focused branch so upstream PRs remain small and reviewable.

| Area | Branch | Repo | Status | Notes |
| --- | --- | --- | --- | --- |
| Cap desktop action deeplinks | `codex/cap-desktop-action-deeplinks` | `ryanr14/Cap` | Pushed | Adds `cap-desktop://action?value=<json>` action handling and screenshot-mode media input safeguards. |
| Raycast command pack | `codex/cap-raycast-deeplink-commands` | `ryanr14/cap-raycast-extension` | Pushed | Separate Raycast extension repo; commands now use direct Cap deeplink actions where available. |
| Screenshot post-capture actions | `codex/cap-screenshot-post-capture-actions` | `ryanr14/Cap` | Pushed | Adds default screenshot post-capture behavior for editor, overlay, or clipboard copy. |
| Floating pinned screenshots | TBD | `ryanr14/Cap` | Not started | Next high-value CleanShot replacement slice. |
| Standalone OCR capture-to-clipboard | TBD | `ryanr14/Cap` | Not started | Should reuse screenshot editor OCR plumbing without opening the full editor. |
| Screenshot overlay/history upgrades | TBD | `ryanr14/Cap` | Not started | Likely split overlay actions and history filters into separate branches if the diff grows. |
| Annotation parity tools | TBD | `ryanr14/Cap` | Not started | Prefer small tool-by-tool branches after the capture flow is solid. |
| Capture precision tools | TBD | `ryanr14/Cap` | Not started | Previous area, timer, crosshair, magnifier, freeze screen. |
| Scrolling capture | TBD | `ryanr14/Cap` | Not started | Needs architecture spike before implementation. |
| Desktop cleanup and recording polish | TBD | `ryanr14/Cap` | Not started | Lower-priority polish after screenshot replacement basics. |

## Current Cap Strengths

- Screen recording is already a strong fit: Instant and Studio modes, local editing, export to MP4/GIF, system audio, microphone, camera, cursor handling, keyboard capture, captions, transcripts, and share links.
- Screenshots already exist as a first-class mode with display/window/area capture, hotkeys, local screenshot storage, screenshot history, upload, copy, save, and editor windows.
- The screenshot editor already supports crop, aspect ratio, background, padding, rounding, shadow, border, layers, arrow, rectangle, circle, text, mask, blur/pixelate style masking, copy, save, open folder, delete, undo/redo, and native OCR-backed text selection.
- Cap already has a Quick Access-style overlay for recent recordings and screenshots, with copy/save/upload actions.
- The local branch `codex/cap-desktop-action-deeplinks` adds a better automation surface for Raycast-style workflows through `cap-desktop://action?value=<json>`.

## CleanShot X Surface To Match

CleanShot X groups its value around:

- Capture modes: area, fullscreen, window, previous area, self-timer, scrolling capture, freeze screen, crosshair, magnifier.
- Post-capture flow: Quick Access Overlay with copy/save/annotate/upload, restore recently closed overlay, drag-and-drop to other apps, auto-close, multi-display positioning.
- Annotation: crop, arrows, rectangles, filled rectangles, ellipses, lines, pixelate, blur, spotlight, counter, pencil, highlighter, text styles, editable project files, combining screenshots.
- Background polish: backgrounds, custom backgrounds, padding, alignment, aspect ratio, auto-balance.
- Screen recording: MP4/GIF, window/fullscreen/area, quality/FPS/resolution controls, mic/computer audio, DND, cursor, click capture, keystrokes, camera, trim, quality/resolution/audio controls.
- Sharing: cloud links for screenshots and videos, passwords, self-destruct, tags, custom domains, teams.
- Floating screenshots: pin any screenshot above all windows, resize, opacity, arrow-key positioning, lock-through mode.
- OCR: standalone capture-text flow that copies recognized text to clipboard.
- Automation: URL scheme commands for captures, post-capture actions, OCR, pinning, annotate, history, desktop icons, settings.

## Replacement-Critical Gap List

### P0: Raycast command pack over Cap deeplinks

The fastest way to make Cap feel like a CleanShot replacement for Ryan is to build the Raycast layer on top of the deeplinks already added in this branch.

Work items:

- Add Raycast commands for screenshot display, screenshot window, screenshot area, record display/window/area, open recording picker, open screenshots, open recordings, pause/resume, restart, stop, and cycle mode.
- Add Raycast command preferences for default post-capture action: open editor, copy, save, upload, or leave in overlay.
- Add a "Copy Cap deeplink" developer command for testing individual action payloads.
- Add docs with example payloads for `cap-desktop://action?value=...`.

Why it matters:

CleanShot exposes many URL scheme commands. Cap now has the core app-control path, but it needs the launcher surface to feel immediate.

### P0: Post-capture actions for screenshot hotkeys and deeplinks

CleanShot lets captures specify an action like copy, save, annotate, upload, or pin. Cap currently tends to open the screenshot editor or overlay, depending on the path.

Work items:

- Introduce a shared `ScreenshotPostCaptureAction` type: `editor`, `overlay`, `copy`, `save`, `upload`, `pin`.
- Let screenshot hotkeys and deeplink actions pass the post-capture action.
- Store a default screenshot post-capture action in settings.
- Make screenshot display/window/area all use the same post-capture pipeline.

Why it matters:

This removes the biggest daily friction compared with CleanShot: one shortcut should do exactly what the user expects after capture.

### P0: Floating pinned screenshots

CleanShot's pinned screenshots are a habit-forming reference feature. Cap has transparent always-on-top window primitives, but not a dedicated pin workflow.

Work items:

- Add a `PinnedScreenshot` window type that displays an image above all windows.
- Add pin action from screenshot editor, screenshot history, quick overlay, and deeplink.
- Support resize, opacity, close, duplicate, and reveal/open editor.
- Add click-through or lock-through mode so apps underneath remain interactive.
- Persist pinned screenshot window position during the session.

Why it matters:

This is likely the single most missed CleanShot feature for day-to-day support, design review, and implementation work.

### P1: Standalone capture-text command

Cap has OCR in the screenshot editor, but CleanShot has a fast OCR mode that copies selected text directly to clipboard.

Work items:

- Add OCR target picker mode for selecting an area without opening the full editor.
- Reuse the existing native OCR engines from the screenshot editor.
- Copy recognized text to clipboard with optional line-break preservation.
- Add Raycast and deeplink command support.
- Add a fallback route to open the captured area in the editor if OCR fails.

Why it matters:

OCR is one of the small utilities that makes a screenshot tool replace system features, not just recording software.

### P1: Better Quick Access Overlay for screenshots

Cap has a recent media overlay, but screenshot handling is not yet CleanShot-like.

Work items:

- Change screenshot overlay primary action from "View" to "Edit" or make it configurable.
- Add pin, annotate/edit, copy, save, upload, delete, reveal, and drag-out affordances.
- Add restore recently closed overlay.
- Add configurable auto-close timing.
- Improve multi-display placement and remember overlay position.

Why it matters:

The overlay is where speed is won or lost. It should be a tiny command station, not just a preview.

### P1: Screenshot history parity

Cap has screenshot history in settings. CleanShot's history is closer to a capture inbox.

Work items:

- Add filters for screenshot/video/GIF/imported media.
- Add actions: copy, save, upload, pin, edit, delete, reveal, restore overlay.
- Add richer metadata: capture type, dimensions, created date, upload state.
- Add a command/deeplink to open history directly.
- Consider retention preferences.

Why it matters:

Ryan needs confidence that a capture is recoverable even after closing the overlay.

### P1: Annotation tool parity

Cap already covers the essential annotation base, but CleanShot still has more daily markup tools.

Work items:

- Add line tool.
- Add filled rectangle preset/tool.
- Add highlighter.
- Add pencil/freehand with smoothing.
- Add spotlight/emphasis tool.
- Add counter/step marker tool.
- Add curved arrow or arrow style variants.
- Add text style presets.
- Add combine-images support by importing another image as a movable layer.

Why it matters:

This is the visible "does it feel like CleanShot" layer once capture and post-capture actions are solved.

### P2: Scrolling capture

CleanShot supports scrolling capture across many apps. Cap does not appear to have this mode.

Work items:

- Start with browser/webview scrolling capture, where the capture target can be controlled more predictably.
- Add manual scrolling capture with guided stitching.
- Investigate macOS Accessibility-driven autoscroll for native apps.
- Add stitch preview and crop correction.
- Add Raycast/deeplink command once the mode is stable.

Why it matters:

High value, but harder and riskier than post-capture flow, pinning, OCR, and annotations.

### P2: Capture precision tools

CleanShot has crosshair, magnifier, freeze screen, exact dimensions, and previous area.

Work items:

- Add crosshair and magnifier to area selection.
- Add frozen-screen area selection option.
- Add exact size controls and aspect lock in area picker.
- Store and retake previous screenshot area.
- Add self-timer for screenshots.

Why it matters:

These are power-user features that make screenshots feel precise, especially for UI work.

### P2: Desktop cleanup and recording polish

CleanShot can hide desktop clutter and enable Do Not Disturb while recording.

Work items:

- Add macOS desktop icon hide/show commands or integration.
- Add optional focus/DND behavior while recording, if macOS APIs permit it cleanly.
- Add settings for whether these behaviors apply to screenshot, recording, or both.
- Add automation commands for hide/show/toggle desktop icons.

Why it matters:

Not core to screenshot replacement, but useful for demos and polished captures.

## Suggested Build Order

1. Raycast command pack over current Cap deeplinks.
2. Shared screenshot post-capture action pipeline.
3. Floating pinned screenshots.
4. Standalone capture-text/OCR-to-clipboard.
5. Screenshot overlay and history upgrades.
6. Annotation parity tools.
7. Capture precision tools.
8. Scrolling capture.
9. Desktop cleanup and recording polish.

## First Issues To Create

- Build Raycast commands for Cap action deeplinks.
- Add screenshot post-capture actions to Cap hotkeys and deeplinks.
- Add pinned screenshot windows.
- Add standalone OCR capture-to-clipboard.
- Upgrade screenshot Quick Access overlay actions.
- Add screenshot history filters and restore-overlay action.
- Add highlighter, line, pencil, counter, and spotlight annotation tools.
- Add previous-area and self-timer screenshot capture.
- Investigate scrolling screenshot capture architecture.

## Source Notes

- CleanShot X official feature list: https://cleanshot.com/features
- CleanShot X URL scheme API: https://cleanshot.com/docs-api
- Cap official product page: https://cap.so
- Cap local evidence:
  - `README.md`
  - `apps/desktop/src-tauri/src/deeplink_actions.rs`
  - `apps/desktop/src-tauri/src/hotkeys.rs`
  - `apps/desktop/src-tauri/src/recording.rs`
  - `apps/desktop/src-tauri/src/screenshot_editor.rs`
  - `apps/desktop/src/routes/screenshot-editor`
  - `apps/desktop/src/routes/recordings-overlay.tsx`
  - `apps/desktop/src/routes/(window-chrome)/settings/screenshots.tsx`
