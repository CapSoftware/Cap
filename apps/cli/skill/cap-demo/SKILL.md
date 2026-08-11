---
name: cap-demo
description: Generate a cinematic 3D product-demo video from any URL — scouts the page, records it with virtual input, and treats it with Cap's 3D camera, brand background, and music.
---

# cap-demo

Give it a URL, get back a short, cinematic product-demo video. The pipeline
scouts the page headlessly, shoots a headed browser with **virtual input only**
(CDP mouse/keyboard — the user's real cursor is never touched), records with
Cap's CLI, then treats the recording with Cap's 3D camera, a brand-matched
background gradient, a synthetic cursor, and music, and exports an mp4.

> **macOS only (for now).** This skill records via Cap's window capture and
> resolves a cached Playwright Chromium under
> `~/Library/Caches/ms-playwright`, both of which are macOS-specific today.
> Apple Silicon is assumed (the bundled Chromium path is `chrome-mac-arm64`).

## The skill directory

`<skilldir>` below is the directory this `SKILL.md` was installed into. `cap
agents install` writes it next to the main `cap` skill, so it is one of:

- Claude: `~/.claude/skills/cap-demo`
- Cursor: `~/.cursor/skills/cap-demo`
- Codex: `<CODEX_HOME>/skills/cap-demo` (default `~/.codex/skills/cap-demo`)

There is no `cap-demo` binary on PATH — the `cap-demo` command is just
`node <skilldir>/cap-demo.mjs`. Alias it if you like:

```
alias cap-demo='node <skilldir>/cap-demo.mjs'
```

## Requirements

- **macOS on Apple Silicon.** Windows/Linux are not supported yet.
- **Node 18+**, with `playwright-core` vendored into the skill. Run `npm
  install` once inside `<skilldir>` on first use. It **reuses an already-cached
  Chromium** under `~/Library/Caches/ms-playwright`; if none is cached, run
  `npx playwright install chromium` once.
- **`python3`** and **`ffmpeg`/`ffprobe`** on PATH.
- The **`cap` CLI** on PATH (Cap Desktop, https://cap.so) with macOS
  **screen-recording permission** granted to it. Both stages otherwise resolve
  the binary from `CAP_BIN`; if neither is set they error clearly.

## One-liner

```
cap-demo https://website.com
```

Output lands at `<outDir>/<slug>-demo.mp4` (default `<tmp>/cap-demo/<slug>/<slug>-demo.mp4`).

## Two modes

- **Deterministic** (`cap-demo <url>`): fixed heuristics, no agent in the loop.
  Scores the best CTA, picks click-through vs scroll, paints a brand gradient
  from the page colors, picks music by brand darkness. Good, ~70% quality. Use
  it for batch runs or when you cannot watch the frames.
- **Agent-driven recipe** (recommended, ~95% quality): the agent runs the
  same steps but frame-QAs each stage and applies judgment — sets the brand
  color by eye, matches export fps to the real capture rate, reshoots on a
  dead-end CTA, regrades until the beats read. This is the path that produced
  the shipped demos. Follow the recipe below.

## The agent recipe

Run the two stages by hand so you can inspect between them. Both scripts live in
this skill; the orchestrator just chains them.

### 1. Scout + shoot

```
node <skilldir>/lib/scout-shoot.mjs <url> <outDir> <slug> [--story click|scroll]
```

- Writes the recording to `<outDir>/<slug>.cap` and the beat log to
  `<outDir>/<slug>.timeline.json`.
- Prints a final JSON line: `{"slug","story","scout":{title,hero,accent,pageBg,ctaText}}`.
  Read it to see what it decided (story, chosen CTA, brand colors).
- It already: kills stale test-chrome, closes Finder windows, dismisses cookie
  banners, injects the shimmer div, matches the capture window by exact page
  title (asserts a single match), and logs the virtual cursor path.

**Story choice.** Leave it to auto for most sites (a strong content CTA →
`click`, otherwise `scroll`). Force `--story scroll` for product one-pagers that
showcase best as a scroll of their own sections, or when the top CTA dead-ends
at a booking/login page.

### 2. Frame-QA the raw recording (before treating)

Extract a few beat frames and **look at them**:

```
ffmpeg -y -ss <t> -i <outDir>/<slug>.cap/content/segments/segment-0/display.mp4 -frames:v 1 /tmp/raw-<t>.png
```

Check: the right window/content is captured (no leftover footage from a prior
shoot), no cookie banner leaked in, the CTA click did **not** dead-end at a
booking calendar or login form, and the **end** of the clip is clean (no desktop
or Finder window bleeding into the bottom of the capture). If any of that is
wrong, reshoot with `--story scroll` or a better landmark before spending an
export.

### 3. Treat + export

```
python3 <skilldir>/lib/treat.py <outDir> <slug> [--music ID] [--quality 4k|hd] [--bg-gradient FROM_HEX,TO_HEX]
```

- Aligns beats to video (tail-anchored: the video can be **shorter** than the
  event log — never trust event times blindly), trims dead time, aims three 3D
  shots at the logged landmarks, paints the brand gradient, synthesizes the
  cursor track from the bundled cursor assets, copies music, exports the mp4.
- **Set the brand background by eye** when the site is gradient-heavy or
  light/pastel: `getComputedStyle` lies on those (e.g. a site that looks white
  with lavender accents can sample as black). Look at the raw frames and pass
  `--bg-gradient FROM_HEX,TO_HEX` (light sites → a soft light gradient; dark
  sites → a deep tint of the brand hue).
- **Match export fps to the real capture rate.** `cap record --detach` can
  engage late and the window capture stalls timestamps on static pixels, so the
  true rate is often ~58, not 60. Check it and avoid the 58-vs-60 judder:
  `ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames,duration -of csv=p=0 <cap>/content/segments/segment-0/display.mp4`,
  then pass `--quality hd` (60) only if the capture is really ~60, otherwise
  leave fps at the source rate (omit `--quality`).

### 4. Frame-QA the export, then regrade if needed

Extract 4 beat frames from `<outDir>/<slug>-demo.mp4` and look: each beat
readable, a typing shot aimed at the **text-entry point** (not the field
center), no window/desktop bleed, clean fps, music fades feel right. If a shot
reads too tight or the aim is off, adjust and re-export. The reference 3D poses
were tuned on full-desktop captures; a browser-window capture fills the card
more, so distances can read ~30% too tight — back the zoom off if so.

### 5. Deliver

Ship `<outDir>/<slug>-demo.mp4`.

## Hard editorial rules (encode these every time)

- **12s max** total. The tail is shaved evenly if the cut runs long.
- **A camera cut MUST be a content cut.** Every 3D perspective change lands on a
  different section/page — the shot boundary sits exactly on the clip cut or the
  scroll into new content. Never cut the camera mid-idle.
- **Cut on action, trim dead time.** Cut on the click; resume on the loaded
  page. Trim page-loads and loading-state frames — never let a blur-up or
  spinner leak into a shot tail (frame-check the cut points).
- **Aim at content, not the container.** Shots are aimed at landmarks (hero, the
  clicked CTA, the destination header), not copied pans. Blur focus rides the
  aim.
- **One motion system.** All emphasis lives in the 3D shot (a dolly-in is the
  click punch). Never stack 2D zoom segments on 3D shots — the two systems fight
  and read as jarring.
- **Hands off.** Virtual input only; the user's real cursor/mouse is never
  moved. The on-screen cursor is synthesized post-hoc from the logged glide path.

## Options reference

Orchestrator (`cap-demo <url> [flags]`):

- `--out DIR` — output directory (default `<tmp>/cap-demo/<slug>`).
- `--slug NAME` — project slug (default: the URL host, dashed).
- `--music ID` — music track id (see below). Default: chosen by brand darkness
  (dark → `lofi-cinematic-pulsebox`, light → `sunday-mood-lofi-cafe-upbeat-bluelike`).
- `--quality 4k|hd` — `4k` = 3840x2160 / 60fps / maximum / filesize-optimized;
  `hd` = 60fps / maximum. Omit for the source-rate default.
- `--story click|scroll` — force the storyboard (default: auto).

`lib/treat.py` extra flags (when running the stages by hand):

- `--bg-gradient FROM_HEX,TO_HEX` — override the brand gradient by eye
  (e.g. `--bg-gradient E4DCF8,C6BAEA` for a light lavender, or `261A40,0C0914`
  for a deep purple).

**Bundled music** (a premium/dark/light/moody spread):
`lofi-cinematic-pulsebox` (moody/premium), `lofi-hip-hop-leberch` (dark),
`sunday-mood-lofi-cafe-upbeat-bluelike` (light/upbeat), `lofi-smooth-pulsebox`
(light/smooth). Music resolves only from the skill's bundled
`assets/music/<id>.mp3`; an unknown id errors.

**Binary resolution** (both scripts): Cap binary = env `CAP_BIN`, else `cap` on
PATH, else a clear error. Chromium = newest cached
`~/Library/Caches/ms-playwright/chromium-*` (macOS), else the pinned
`chromium-1228` build.

## For dev tools / typing showcases (closeup variant)

For dev tools with a live terminal or code on screen, a bespoke storyboard beats
the generic click-through. Scout for `[class*=terminal]` / `pre` / `code`,
scroll each to center, dwell ~2.7s (live terminals animate = free motion). The
**closeup shot recipe**: a gentle tilt (tiltX 10-13, tiltY 9-13, rotateX -4) so
text stays legible, a tight slow push-in zoom (0.72-0.82), and blur focus locked
ON the element (focusX = the element's fraction, small focusSize ~0.55). Keep it
a single continuous clip (no editorial cut) so scrolls stay smooth — cuts are
3D-only. Aim typing shots at the **text-entry region**, not the field center.
Rebuild a bespoke shoot from `lib/scout-shoot.mjs` as the base when a site
deserves it (edit a fresh copy — do not sed/splice shot arrays, overlapping
offsets corrupt the file).
