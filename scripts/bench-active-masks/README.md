# Active-mask preparation benchmark

`interpolate_masks` now removes inactive masks before the stable track sort.
The sort then processes only the masks that the current frame needs.
The change preserves inclusive time boundaries, stable track ties, and the original nonfinite comparison behavior.
It adds no cache or persistent state.

## Recorded result

The host used an Apple M5 Pro, macOS 26.6.2, and Rust 1.99.0.
The baseline is `db7ecfcf205446de4e9d4192deed698a4175450f`.
`recorded/provenance.json` contains the exact source hashes and measurement scope.

| Synthetic masks | Active masks | Isolated mask function | Full frame preparation |
| --- | ---: | ---: | ---: |
| 64 | 1 | 524 ns → 59 ns | 1.76 us → 1.18 us |
| 256 | 4 | 1,538 ns → 130 ns | 5.86 us → 3.34 us |
| 1,024 | 4 | 4,438 ns → 686 ns | 20.25 us → 12.77 us |
| 256 | 256 | 3,286 ns → 3,030 ns | 8.27 us → 8.04 us |

The isolated run contains 1,080 sample pairs across fifteen cases and three processes.
Each side uses separate calibration and a balanced ABBA order.
Identical-code controls produced median ratios from 0.999x to 1.001x.
The shortest timed side lasted approximately 23 ms.
The bootstrap intervals describe this host and sample set.
They do not establish results on other machines.

The native probe contains three process pairs and sixteen samples per case per process.
It optimized `cap-rendering` at level 3 and reused development dependencies.
Its empty control varied from 0.995x to 1.125x between process pairs.
The eight-active-mask case took approximately 1% more time in the candidate.
These small differences need stronger evidence from a release app.

The native probe measured `ProjectUniforms::new` with actual Cap types and synthetic input.
The measured time excludes GPU submission, decode, encode, GPUI event work, and display.
All six synthetic scenes produced identical mask data and pixel bytes in all three process pairs.
The 256-mask sparse case saved approximately 2.52 us per frame.
This result does not establish a playback FPS or export throughput increase.

## Isolated reproduction

Use Python 3 and `rustc` from the repository root.
No native media libraries are necessary for this benchmark.
Use Rust 1.99.0 to match the recorded toolchain.

```sh
RUSTUP_TOOLCHAIN=1.99.0 python3 scripts/bench-active-masks/run.py --test-only --run-id correctness
RUSTUP_TOOLCHAIN=1.99.0 python3 scripts/bench-active-masks/run.py --run-id comparison --processes 3 --samples 24 --sample-ms 30
```

The script reads the baseline mask source from Git and the candidate source from the current checkout.
It copies the exact mask functions into a generated Rust harness.
It extracts the type fields and effect constants from the pinned baseline.
It omits serialization derives from those types.
The differential test compares all mask fields as exact floating-point bit patterns across 2,400 generated cases.

The script saves source hashes, raw CSV samples, correctness output, and summary statistics under `target/active-mask-benchmark/<run-id>/`.
Use a new run ID for each comparison.
Use `--base <revision>` for a different baseline after a review of its type definitions.

## Native reproduction

Complete Cap's documented native dependency setup first.
Set `FFMPEG_DIR` to the absolute path of the native bundle.
Use separate output directories for each process.

```sh
mkdir -p target/active-mask-benchmark
CAP_MASK_PROBE_OUTPUT="$PWD/target/active-mask-benchmark/native-candidate" \
CAP_MASK_PROBE_SAMPLES=16 \
cargo +1.99.0 run --locked -p cap-rendering --example mask-preparation-benchmark -j 2 \
  --config 'profile.dev.package.cap-rendering.opt-level=3' \
  > target/active-mask-benchmark/native-candidate.log
```

The example measures six synthetic cases through the shared frame constructor.
It then renders one frame per case and saves packed RGBA bytes and mask data.
It does not launch the app or open a user project.
Each `PROBE_SAMPLE` line contains the iteration count, elapsed time, and time per frame.
The output files contain the frame dimensions and exact mask bit patterns.

Create a separate baseline worktree for a comparison:

```sh
git worktree add --detach ../cap-mask-baseline db7ecfcf205446de4e9d4192deed698a4175450f
mkdir -p ../cap-mask-baseline/crates/rendering/examples
cp crates/rendering/examples/mask-preparation-benchmark.rs ../cap-mask-baseline/crates/rendering/examples/
```

Run the same example in that worktree with the same toolchain, native bundle, optimization level, and sample count.
Use a baseline output directory.
Alternate the baseline and candidate order across three process pairs.
Compare each pair's mask JSON and RGBA files byte for byte.
Compare preparation time separately from this GPU output check.

The native CSV uses LF line endings and retains the original numeric rows.
The recorded native run used a temporary `tokio::test` module with the same scenario and measurement body.
The Cargo example gives that body a standalone entry point.
The entry point changes the binary layout, so new measurements need their own source and environment records.

Cap's per-frame performance suite starts its render timer after `ProjectUniforms::new`.
Thus, its decode-plus-render total omits the preparation work that this example measures.
A representative release workload remains necessary for a claim about whole-app performance.
