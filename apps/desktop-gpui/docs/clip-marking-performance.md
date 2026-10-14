# Clip marking construction benchmark

Baseline source: `68d6c31b44db6b3c68d8da7510b159c538c06d49`. The candidate skips one-pixel markings entirely outside the clip fill after mapping through fullscreen holds. Partially overlapping markings retain the original geometry and gradient subtree.

Benchmark environment: Apple M5 Pro, macOS 26.6.2 (25G83), Rust 1.97.1.

The ignored `editor_timeline::markings_benchmark::clip_marking_construction` test constructs synthetic `ProjectConfiguration` fixtures through the production `TimelineModel::build`. Cut fixtures retain nine seconds from source intervals spaced twelve seconds apart. They contain 1, 10, 30 or 300 total clips; the separate uncut control contains one 2700-second clip. These are synthetic model fixtures, not recordings loaded from disk.

The view uses production `Transform::initial(model.total_duration)`, which caps zoom-out at 600 seconds, over a 1200-pixel content column. Each fixture reports total clips, clips admitted by production visibility culling, and visible seconds. The 300-cut project contains 2700 output seconds but shows only the initial 600-second window, including its normal two-second render padding. The uncut control also uses a 600-second viewport.

Timing covers actual GPUI element construction and drop through `render_clip_markings`, using production visibility, seconds-per-pixel, clip width and row height. Model construction is outside timing. The baseline helper body is byte-identical to the original except its function name. Measurements use five warmup batches per variant, 24 paired samples and 20 complete model sweeps per sample. Alternating variant order produces ABBA ordering.

Measured values below are microseconds per complete model sweep. The timed run was serial and did not overlap builds, formatting, or export validation.

| Synthetic fixture | Visible clips | Zoom seconds | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 cut | 1 | 9.000 | 16.817 | 16.756 | 17.415 | 17.352 |
| 10 cuts | 10 | 90.000 | 91.558 | 18.808 | 94.348 | 19.529 |
| 30 cuts | 30 | 270.000 | 133.912 | 18.894 | 137.262 | 19.494 |
| 300 cuts | 67 | 600.000 | 625.635 | 42.967 | 660.335 | 45.317 |
| Uncut 2700 seconds | 1 | 600.000 | 17.435 | 17.308 | 19.056 | 18.706 |

The 300-cut fixture saves 582.668 microseconds at the reported p50, from 625.635 to 42.967 microseconds, with 67 visible clips in the supported 600-second viewport. Single-clip and uncut controls remain comparable. The previous 2700-second viewport exceeded the editor limit, so its measurements are excluded. This benchmark does not measure full-editor frame time, layout, painting, GPU execution, media decoding or presentation, and establishes no FPS claim.

Reproduce from the repository root:

```sh
cargo +stable test --manifest-path apps/desktop-gpui/Cargo.toml --release --bin cap-gpui editor_timeline::markings_benchmark::clip_marking_construction -- --ignored --nocapture --test-threads=1
```

Ordinary tests exercise the production `clip_marking_position` helper with fixed expected positions. They cover wholly outside ticks, exact clip edges, fractional overlap, and fullscreen holds changing whether a tick remains. The renderer calls this helper before constructing the unchanged gradient subtree. Screenshot equivalence remains outside the headless benchmark.

The native timeline run passed 63 ordinary tests with zero failures; this benchmark was the one ignored test. Running it explicitly passed separately.

Raw paired samples for the 300-cut fixture, in microseconds per model sweep:

| Sample | Baseline | Candidate |
| --- | ---: | ---: |
| 0 | 623.679 | 42.960 |
| 1 | 630.521 | 45.317 |
| 2 | 625.635 | 43.112 |
| 3 | 617.790 | 43.492 |
| 4 | 625.138 | 42.513 |
| 5 | 625.867 | 41.942 |
| 6 | 629.456 | 42.956 |
| 7 | 618.733 | 43.421 |
| 8 | 631.998 | 43.904 |
| 9 | 656.596 | 43.198 |
| 10 | 628.777 | 43.658 |
| 11 | 636.244 | 43.154 |
| 12 | 625.069 | 42.967 |
| 13 | 618.467 | 41.335 |
| 14 | 622.648 | 43.171 |
| 15 | 614.204 | 42.604 |
| 16 | 626.858 | 42.379 |
| 17 | 660.335 | 41.704 |
| 18 | 628.231 | 48.465 |
| 19 | 668.227 | 44.071 |
| 20 | 612.737 | 41.644 |
| 21 | 620.077 | 42.565 |
| 22 | 611.163 | 41.844 |
| 23 | 605.681 | 41.250 |
