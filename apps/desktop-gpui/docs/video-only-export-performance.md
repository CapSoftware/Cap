# Video-only export preparation

GIF and cursor-only MOV export no audio. Their GPUI preparation previously
waited for every recording mic/system track to decode into retained PCM.
`build_video_only()` uses the existing segment loader without audio. Generic
`build()` and MP4 preparation keep their existing behavior. Recording metadata
still probes audio files; this change removes full PCM decoding and retention,
not all audio I/O.

## Measurements

Baseline source: `68d6c31b44db6b3c68d8da7510b159c538c06d49`.
Measured on Apple M5 Pro, macOS 26.6.2 (25G83), Rust 1.97.1.
Three paired repetitions per format/input, alternating pair order, separate
processes, same release binary with baseline and video-only modes. The binary
used the GPUI release profile: optimization level 3, thin LTO, one codegen unit.
It called actual `ExporterBuilder` and GIF/ProRes encoders. The timer includes
builder setup through encoder finish, excluding configuration JSON loading,
fixture generation, validation, and GPUI dialogs/UI.

Synthetic inputs: 30-second control and 1800-second stress recordings, each
with two stereo AAC tracks at 48 kHz and a four-second trimmed timeline.
Output is 640x360 at 15 fps, 60 decoded frames. Cursor fixtures reuse checked-in
CLI assets with normalized movement, a shape change, and one click.

| Source | Format | Median total, baseline to candidate | Median peak RSS, baseline to candidate |
|---|---|---|---|
| 30 s | GIF | 0.209761 to 0.197071 s | 138.98 to 122.94 MiB |
| 30 s | Cursor MOV | 0.460177 to 0.450832 s | 88.77 to 66.45 MiB |
| 1800 s | GIF | 0.871047 to 0.209086 s | 1458.03 to 123.23 MiB |
| 1800 s | Cursor MOV | 1.120212 to 0.479418 s | 1397.25 to 69.45 MiB |

All 12 baseline/candidate pairs passed decoded RGBA checksums, frame count,
PTS/order/duration and stream metadata parity, with no audio stream. All six
MOV pairs additionally passed decoded alpha parity and visible moving alpha.
Results establish the benefit for these trimmed synthetic inputs; they do not
predict export speedups for every recording. Short controls show modest gains.

## Reproduce

Requires the project's native FFmpeg setup, `ffmpeg`, `ffprobe`, and Python 3.
Use the GPUI lockfile and workspace to retain its dependency pins. Build once,
then time separate binary processes; exclude Cargo/build time from results.

```sh
python3 scripts/prepare-video-only-export-fixture.py /tmp/video-only-1800.cap --source-seconds 1800 --export-seconds 4 --with-cursor
cargo +stable run --manifest-path apps/desktop-gpui/Cargo.toml --example video-only-preparation --release -- --project /tmp/video-only-1800.cap --output /tmp/video-only-baseline.gif --mode baseline --format gif
cargo +stable run --manifest-path apps/desktop-gpui/Cargo.toml --example video-only-preparation --release -- --project /tmp/video-only-1800.cap --output /tmp/video-only-candidate.gif --mode video-only --format gif
python3 scripts/check-video-only-export-parity.py /tmp/video-only-baseline.gif /tmp/video-only-candidate.gif
```

For MOV use `--format cursor-mov`, `.mov` output paths, and parity flags
`--alpha --require-visible-alpha`. Repeat with `--source-seconds 30` for the
control. Use unique output paths because the example refuses existing files.
Capture JSON stdout and `/usr/bin/time -l` stderr for peak RSS on macOS.
`--build-only` isolates preparation but is not a complete-export benchmark.
The first progress timestamp measures a callback, not an encoded packet.

Corrupt unused audio can now produce a video-only export after a metadata
warning instead of failing the complete PCM/EOF wait. Display-video errors
still fail preparation. Native GPUI UI timing and cancellation are outside
these measurements. Separate source-loading checks passed: no-audio succeeds
in both modes; invalid mic fails baseline and passes video-only; invalid
display fails both modes.

<details>
<summary>Raw samples</summary>

```csv
source_seconds,format,repetition,mode,build_secs,total_secs,peak_rss_mib
30,Gif,0,Baseline,0.056724625,0.360145084,156.609375
30,Gif,0,VideoOnly,0.012039167,0.189455042,122.937500
30,Gif,1,VideoOnly,0.012658167,0.199531333,122.906250
30,Gif,1,Baseline,0.022580584,0.205054375,138.984375
30,Gif,2,Baseline,0.020476042,0.209760750,133.125000
30,Gif,2,VideoOnly,0.009499250,0.197070667,137.000000
30,CursorMov,0,Baseline,0.021880417,0.460177125,88.765625
30,CursorMov,0,VideoOnly,0.011225542,0.450831625,66.375000
30,CursorMov,1,VideoOnly,0.012083208,0.459454000,66.593750
30,CursorMov,1,Baseline,0.021884542,0.456129417,88.562500
30,CursorMov,2,Baseline,0.024268625,0.472918166,88.968750
30,CursorMov,2,VideoOnly,0.009287208,0.446681750,66.453125
1800,Gif,0,Baseline,0.657632584,0.846303542,1459.031250
1800,Gif,0,VideoOnly,0.012863292,0.209086459,123.468750
1800,Gif,1,VideoOnly,0.012166709,0.196155334,117.234375
1800,Gif,1,Baseline,0.664888292,0.871047209,1458.031250
1800,Gif,2,Baseline,0.685738792,0.914366584,1450.703125
1800,Gif,2,VideoOnly,0.013697875,0.216982000,123.234375
1800,CursorMov,0,Baseline,0.668535250,1.155541958,1397.250000
1800,CursorMov,0,VideoOnly,0.015395500,0.499813208,69.453125
1800,CursorMov,1,VideoOnly,0.015545292,0.475296500,68.562500
1800,CursorMov,1,Baseline,0.642078958,1.118089667,1398.000000
1800,CursorMov,2,Baseline,0.639165958,1.120211791,1397.203125
1800,CursorMov,2,VideoOnly,0.015095083,0.479417500,70.343750
```

</details>
