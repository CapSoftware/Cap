# capcodec in the media server

The published media-server images install ffmpeg and do not include the capcodec executable. Leave `CAP_MEDIA_VIDEO_ENCODER` unset to keep libx264.

To encode with capcodec:

1. Build a capcodec binary for the image architecture (amd64 and arm64 are separate).
2. Mount it into the container, for example `/usr/local/bin/capcodec`.
3. Set `CAP_MEDIA_VIDEO_ENCODER=capcodec`.
4. Set `CAPCODEC_BIN` to that path. When it is on `PATH`, `capcodec` is enough.

Optional overrides: `CAPCODEC_CRF` (0–51), `CAPCODEC_PRESET` (`live`, `fast`, `medium`, `slow`), `CAPCODEC_KEYINT`, and `CAPCODEC_NOISE`. Without those, the job's CRF and preset are used. `ultrafast` maps to `fast`.

The server writes a fragmented MP4 (`.fmp4`) so capcodec flushes each GOP, then ffmpeg remuxes audio and faststart. The decode filter converts frames to limited-range BT.709, matching the labels the encoder writes.

Benchmark tables against x264 veryfast are in `capcodec-benchmarks.md`. The encoder source is `capcodec/` at the repository root.
