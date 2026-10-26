# MP4 audio memory with fullscreen titles

Run the example on disposable project copies. Loading can migrate their config,
and exporting can refresh their thumbnail. It uses the same `build_for_mp4` and
`export_prepared` calls as GPUI, at 1080p/60 fps with Social compression.

```sh
cd apps/desktop-gpui
cargo +stable build --locked --example export-audio-memory-benchmark
target/debug/examples/export-audio-memory-benchmark /tmp/copy.cap /tmp/new-output.mp4 --hold
```

`--hold` adds a fullscreen title at output seconds 5–7 in memory. Omit it for
the control. `--prepare-only` stops after exporter preparation;
`--studio-sound` enables microphone enhancement. The output path must be unused.

## Fixtures

- **Official recording:** `reference-recording.cap` from
  [Cap's performance fixtures](https://github.com/CapSoftware/cap-performance-fixtures/tree/75c8ed2ed92da26685c3b3590644b54c2460e55e).
  Its two recorded takes total 30.818333 seconds. Download the full bundle,
  including cursor images and audio. The example adds the title, yielding
  1,970 output frames. No source events or media are repeated.
- **Long voice source:** an assembled stress project using the first 15 seconds
  of the official recording's first display track and the original 27:50 mono
  MP3 of [LibriVox's *A Scandal in Bohemia*, read by Ruth Golding](https://archive.org/details/adventures_sherlock_holmes_rg_librivox).
  This is recorded speech in an assembled project, not an authentic long Cap
  capture. It tests retained audio outside a short edit. The title makes the
  output 17 seconds / 1,020 frames. There is no generated or repeated audio.

Create the second fixture from a downloaded official copy:

```sh
python3 - /tmp/reference-recording.cap /tmp/voice-title.cap <<'PY'
import json, shutil, sys, urllib.request
from pathlib import Path
source, target = map(Path, sys.argv[1:])
target.mkdir()
shutil.copy2(source / 'content/segments/segment-0/display.mp4', target / 'display.mp4')
name = 'adventuresholmes_01_doyle_64kb.mp3'
url = 'https://archive.org/download/adventures_sherlock_holmes_rg_librivox/' + name
with urllib.request.urlopen(url) as response, (target / name).open('wb') as output:
    shutil.copyfileobj(response, output)
meta = dict(pretty_name='Recorded voice title export test', platform='MacOS',
            segments=[dict(display=dict(path='display.mp4', fps=59), mic=dict(path=name))])
(target / 'recording-meta.json').write_text(json.dumps(meta))
config = json.loads((source / 'project-config.json').read_text())
config['timeline'] = dict(segments=[dict(recordingSegment=0, timescale=1, start=0, end=15)],
                          zoomSegments=[])
config['clips'] = []
config['camera']['hide'] = True
config['audio']['improve'] = False
(target / 'project-config.json').write_text(json.dumps(config))
PY
```

MP3 SHA-256: `08dbdb62400d61e51ef3bc1cb6112306c5cf253821f5f295e2b0b698d35e70f2`.
The source is 13,366,784 bytes, 22,050 Hz mono, 1,670.635102 seconds.

## Comparison procedure

Build this identical example on base `db7ecfcf205446de4e9d4192deed698a4175450f`
and on the changed revision. Preserve both binaries before measurement. The
measurements below used the GPUI development profile: dependencies at opt-level
2, the example at opt-level 0, Rust stable 1.96, Apple M1 Pro, macOS 27.0.1.

For each fixture, run three pairs in before/after, after/before, before/after
order, each as a fresh process. Use a unique output per run, warm filesystem
caches, and no concurrent builds, tests or app runs. On macOS, set library paths
*after* `/usr/bin/time`, because protected system executables strip inherited
`DYLD_*` variables:

```sh
/usr/bin/time -l /usr/bin/env \
  DYLD_LIBRARY_PATH="$REPO/target/native-deps/Spacedrive.framework/Libraries:$REPO/target/native-deps/onnxruntime/lib" \
  ORT_DYLIB_PATH="$REPO/target/native-deps/onnxruntime/lib/libonnxruntime.dylib" \
  /tmp/benchmark-before /tmp/copy.cap /tmp/before-1.mp4 --hold
```

`build_ms` ends when exporter preparation completes; `total_ms` ends after
encoder completion and audio validation. Config loading is outside the timer.
Maximum RSS is the whole benchmark process, excluding external decoder services.

| Fixture | Prepare median, before → after | Complete export median | Peak RSS median |
| --- | --- | --- | --- |
| Official recording + title | 131.78 → 119.31 ms | 9.350 → 9.337 s | 158.48 → 144.50 MiB |
| Long recorded voice + title | 2187.92 → 35.71 ms | 7.063 → 6.957 s | 413.30 → 104.73 MiB |

This establishes a memory/preparation improvement, not a large full-export
speedup. Streaming still validates the complete audio source before success,
including unused tails, so that work has moved out of preparation rather than
disappeared. Short-clip timing changes are within normal run-to-run variation.

For all six pairs, compare decoded video and audio plus timestamps:

```sh
ffmpeg -v error -i /tmp/before-1.mp4 -map 0:v:0 -f framemd5 /tmp/before-video.md5
ffmpeg -v error -i /tmp/after-1.mp4 -map 0:v:0 -f framemd5 /tmp/after-video.md5
diff -u /tmp/before-video.md5 /tmp/after-video.md5
# Repeat with -map 0:a:0 for audio.
```

All six measured pairs matched, including frame sizes, sample counts and
timestamps. The native GPUI auto-export hook also completed an export of the
official fixture with the title, using an isolated `CAP_GPUI_APP_DATA_DIR`.
