# Clip marking construction benchmark

Baseline source: `68d6c31b44db6b3c68d8da7510b159c538c06d49`. The candidate skips one-pixel markings entirely outside the clip fill after mapping through fullscreen holds. Partially overlapping markings retain the original geometry and gradient subtree.

Measured on Apple M5 Pro, macOS 26.6.2 (25G83), Rust 1.97.1.

The ignored `editor_timeline::markings_benchmark::clip_marking_construction` test constructs synthetic `ProjectConfiguration` fixtures through the production `TimelineModel::build`. Cut fixtures retain nine seconds from source intervals spaced twelve seconds apart. They contain 1, 10, 30 or 300 clips; the separate uncut control contains one 2700-second clip. These are synthetic model fixtures, not recordings loaded from disk.

Each model is displayed at full zoom-out over a 1200-pixel content column. Timing covers actual GPUI element construction and drop through `render_clip_markings`, using production visibility, seconds-per-pixel, clip width and row height. Model construction is outside timing. The baseline helper body is byte-identical to the original except its function name.

Release measurements use five warmup batches per variant, 24 paired samples and 20 complete clip sweeps per sample. Alternating variant order produces ABBA ordering. Values below are microseconds per complete sweep, from a clean run; an earlier run overlapping a formatting check was excluded.

| Synthetic fixture | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 cut | 11.540 | 11.240 | 14.648 | 13.731 |
| 10 cuts | 70.327 | 14.331 | 87.229 | 22.506 |
| 30 cuts | 96.356 | 13.056 | 111.792 | 14.713 |
| 300 cuts | 10302.871 | 153.296 | 11601.567 | 287.585 |
| Uncut 2700 seconds | 58.165 | 56.973 | 113.650 | 103.944 |

The 300-cut fixture saves 10.150 ms at the reported p50 for this helper's construction/drop work. This does not measure full-editor frame time, layout, painting, GPU execution, media decoding or presentation, and establishes no FPS claim.

Reproduce from the repository root:

```sh
cargo +stable test --manifest-path apps/desktop-gpui/Cargo.toml --release --bin cap-gpui editor_timeline::markings_benchmark::clip_marking_construction -- --ignored --nocapture --test-threads=1
```

The native timeline test run passed 60 tests with zero failures; this benchmark was the one ignored test. Running it explicitly passed separately. Geometry coverage also includes source-level checks for fractional edges, fullscreen holds, ghost trim and release positions; screenshot equivalence remains outside the headless benchmark.

Raw paired samples for the 300-cut fixture, in microseconds per sweep:

| Sample | Baseline | Candidate |
| --- | ---: | ---: |
| 0 | 8869.910 | 140.502 |
| 1 | 8628.402 | 142.940 |
| 2 | 9207.121 | 173.373 |
| 3 | 9814.571 | 154.623 |
| 4 | 12197.135 | 211.373 |
| 5 | 10638.140 | 196.888 |
| 6 | 10579.898 | 135.896 |
| 7 | 10508.523 | 318.817 |
| 8 | 10548.873 | 203.865 |
| 9 | 10126.415 | 130.250 |
| 10 | 9731.596 | 287.585 |
| 11 | 10302.871 | 141.167 |
| 12 | 9798.006 | 139.988 |
| 13 | 9876.454 | 174.200 |
| 14 | 10197.133 | 176.975 |
| 15 | 10034.508 | 137.483 |
| 16 | 9774.258 | 159.896 |
| 17 | 10614.821 | 181.446 |
| 18 | 10247.388 | 153.296 |
| 19 | 10371.877 | 145.127 |
| 20 | 10482.452 | 143.175 |
| 21 | 11601.567 | 139.648 |
| 22 | 11523.148 | 146.958 |
| 23 | 10990.983 | 144.181 |
