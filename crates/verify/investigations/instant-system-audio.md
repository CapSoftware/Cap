# Instant system audio investigation

Opened 2026-10-16 by the suite integration executor under coordinator decision C.
Status: product cause confirmed by the mixer arrival-schedule probe. The fix is tracked on [fix/instant-mixer-input-alignment](https://github.com/CapSoftware/Cap/tree/fix/instant-mixer-input-alignment). This track is separate from AVFoundation decoding.

| Evidence | System offset | Mic offset |
| --- | --- | --- |
| Control 38858394655 | -46.1 ms | +13.9 ms |
| Candidate 38861420654 | -45.9 ms | +14.1 ms |
| Candidate repeat 3, 38861426173 | +7.8 ms | +14.5 ms |

All use fresh fixtures. The coordinator also records #2635 evidence of the mixer placing system audio about 60 ms ahead of the microphone in about half of Instant recordings. The native case reads the pipeline's output.mp4 directly, independently of the product decoder.

The normal offset bound remains 5 to 34 ms. Coordinator decisions at 09:20 and 10:05 replace the default Instant system-sync expectation with two bounded flaky signatures: system minus microphone at -60.0 or -6.7 ms, within 1 ms, with a measured microphone offset inside 5 to 34 ms. The -60 ms signature remains macOS-only; the -6.7 ms signature applies on all platforms. Missing measurements, other offsets and other classes remain failures.

AudioMixer feeds each input to amix without per-input timing, making each first sample its own zero. Scheduler-dependent 53.3 ms startup silence partly masks the resulting 60 ms source displacement. The separate product track places each input relative to the mixer start and makes padding timestamp-based; its acceptance is outside this suite integration.

Initial code trace: `crates/verify/src/pipeline.rs` builds the Instant audio pipeline with the same epoch anchoring as the product. `crates/recording/src/output_pipeline/core.rs` attaches sources to `AudioMixer` and then applies `AudioGapTracker` overlap handling to its output. Both the mixer source alignment and later overlap trimming remain candidates. No local capture or benchmark was started while PID 72210 was live.
