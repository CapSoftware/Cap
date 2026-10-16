# Instant system audio investigation

Opened 2026-10-16 by the suite integration executor under coordinator decision C.
Status: open, product cause not yet isolated. This track is separate from AVFoundation decoding.

| Evidence | System offset | Mic offset |
| --- | --- | --- |
| Control 38858394655 | -46.1 ms | +13.9 ms |
| Candidate 38861420654 | -45.9 ms | +14.1 ms |
| Candidate repeat 3, 38861426173 | +7.8 ms | +14.5 ms |

All use fresh fixtures. The coordinator also records #2635 evidence of the mixer placing system audio about 60 ms ahead of the microphone in about half of Instant recordings. The native case reads the pipeline's output.mp4 directly, independently of the product decoder.

The normal offset bound remains 5 to 34 ms. A separate macOS flaky expectation permits only system offsets -70 to -30 ms, with a measured microphone offset inside its existing 5 to 34 ms bound. Missing measurements, other sources, other offsets, and other classes remain failures.

Next investigation: correlate source capture timestamps, AudioGapTracker overlap/catch-up decisions and mixer output positions on fresh matched runs. Preserve both the negative and positive states. Propose a product fix with matched proof separately; this suite change does not decide that fix or its acceptance.

Initial code trace: `crates/verify/src/pipeline.rs` builds the Instant audio pipeline with the same epoch anchoring as the product. `crates/recording/src/output_pipeline/core.rs` attaches sources to `AudioMixer` and then applies `AudioGapTracker` overlap handling to its output. Both the mixer source alignment and later overlap trimming remain candidates. No local capture or benchmark was started while PID 72210 was live.
