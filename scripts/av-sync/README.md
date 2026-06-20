# A/V sync hardware test

Empirically verifies that recordings stay in audio/video sync across real
webcam / microphone / monitor / OS combinations. Use this to confirm the
recording pipeline on actual hardware — the unit tests cover the logic, this
covers the metal.

It works like a clapperboard: a stimulus page flashes the screen white and
plays a click at the **same instant**, every 2 seconds. You record it, then
`av-sync-check` finds each flash (in the video) and each click (in the audio),
pairs them, and reports:

- **offset** — video time minus audio time per event. The _constant_ part is
  dominated by display + audio-output latency, so don't over-read it.
- **drift slope (ms/min)** — the authoritative metric. It must stay near zero.
  A growing slope means the pipeline is losing sync over the recording.

## 1. Build the analyzer

```bash
cargo build -p cap-audio --bin av-sync-check
# binary at target/debug/av-sync-check
```

## 2. Open the stimulus

Open `scripts/av-sync/av-sync-stimulus.html` in a browser, click **Start & go
full-screen**. Optional: `av-sync-stimulus.html?interval=1.5` to change spacing
(pass the same value to `--interval` later).

## 3. Record with Cap (≥ 60 s; longer is better for drift)

Record one of these modes, then **stop**:

| Mode | What it exercises | How |
|---|---|---|
| **Screen + system audio** | screen-video vs audio pipeline (cleanest) | Record the display, system audio on, mic off |
| **Screen + mic** | mic capture path | Record the display, mic on; speakers must play the click |
| **Camera + mic** | camera capture path | Point the webcam at the screen, mic on, speakers playing the click |
| **Mic + system audio together** | the multi-source mixer (known drift path) | Record with **both** mic and system audio on — see note below |

Run each mode you care about for **2–5 minutes** so any drift is visible
(0.1 ms/min only shows up over minutes).

## 4. Locate the files

Inside the recording folder (open it from the editor, or your Cap recordings
directory):

- **Instant mode:** `content/output.mp4` — video + audio in one file.
- **Studio mode:** `content/segments/segment-0/`
  - `display.mp4` (screen), `camera.mp4` (webcam)
  - `audio-input.ogg`/`.m4a` (mic), `system_audio.ogg`/`.m4a` (system)

## 5. Analyze

```bash
# instant-mode single file (audio muxed in):
target/debug/av-sync-check --video content/output.mp4

# studio: screen video vs mic audio
target/debug/av-sync-check \
  --video content/segments/segment-0/display.mp4 \
  --audio content/segments/segment-0/audio-input.ogg

# camera video vs mic audio
target/debug/av-sync-check \
  --video content/segments/segment-0/camera.mp4 \
  --audio content/segments/segment-0/audio-input.ogg \
  --csv /tmp/sync.csv      # optional: per-event offsets for plotting
```

If detection misfires (matched pairs ≪ expected, or noisy stddev), tune
`--flash-frac` (default 0.5) and `--click-frac` (default 0.3) down toward ~0.2.

## 6. Read the result

```
drift slope:      +0.00 ms/min   (r²=0.000)   <- this is what matters
```

| drift slope | verdict |
|---|---|
| < 10 ms/min | excellent — no meaningful drift |
| 10–30 ms/min | minor — imperceptible on short recordings |
| > 30 ms/min | investigate |

**`r²` is the discriminator.** The tool only treats the slope as real drift when
`r²` is high (the line explains the offset variance). A slope with low `r²` is
just a line fit through per-event jitter, so the verdict reads _"no significant
trend — offset is stable"_ — that's a **pass**. Real drift looks like the
injected-drift self-test: a clean slope at `r²≈1.0`. The **offset** number
differs between machines (latency) and is not the metric.

It's normal for the tool to detect only ~half the flashes (a brief flash vs
on-change screen capture) and to drop a few outliers; as long as the surviving
events agree (tight stddev, no significant trend), sync is good. A reference run
of Cap's own pipeline (screen + system audio) landed at a stable ~150 ms offset
(stddev ~8 ms) with no significant trend.

## The matrix to cover

Vary one axis at a time and confirm the drift slope stays near zero:

- **Microphone sample rate:** a 44.1 kHz device and a 48 kHz device, plus a USB
  mic and the built-in mic. (Set rate in macOS _Audio MIDI Setup_ / Windows
  _Sound → Device properties → Advanced_.)
- **Webcam fps:** a 30 fps and a 60 fps camera; a cheap webcam that varies its
  rate in low light is a good VFR stress.
- **Monitor:** 60 Hz and a 120/144 Hz display; an external monitor; a Retina/HDR
  panel.
- **OS:** run the whole thing on **macOS and Windows**.

## Known caveat to confirm: multi-source mixer drift

Recording **mic + system audio at the same time** routes through the ffmpeg
mixer, which has a small uncorrected clock-drift path (code analysis put it at
~0.1–0.36 s over 30–60 min, one direction, only when the audio hardware runs
slow). To check it in practice: run the **mic + system audio** mode for as long
as you can (ideally 30+ min) and look at the drift slope. A single mic, or
system audio alone, bypasses the mixer and should show no drift.

## Caveats of the method

- The stimulus's own flash-vs-beep skew and the display/output latency add a
  roughly **constant** offset. This test is authoritative for **drift**; for an
  absolute-offset measurement use a physical clapperboard.
- Keep the stimulus full-screen and the click audible; partial-screen captures
  or a muted system reduce detection quality.
