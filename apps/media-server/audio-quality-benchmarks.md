# Instant audio quality experiment

This is an offline, shadow-only experiment. No route, recording finalizer, player,
export, upload, desktop capture path, or production flag imports the worker.
`mode: "off"` returns before filesystem access. There is no publishing mode.

The proposed first rollout is bounded, constant level correction, after production
validation. EQ and denoising remain experimental because consistent perceptual
improvement has not been established. This PR does not enable either profile.

## Evidence and limits

The September 7–8, 2026 study measured 60 additional public, unprotected Instant
recordings with completed transcripts: 20 from each of September 5, 6, and 7,
all from different owners and separate from the initial 12-recording study.
The expanded cohort contains 4.464 hours of audio. Median playback-compensated
loudness is -29.205 LUFS; 40/60 recordings are below -24 LUFS, 9 already exceed
-18 LUFS, and 9 have true peaks above 0 dBTP.

A fixed 39-recording tuning / 21-recording holdout split preceded processing.
The final voice policy passed technical gates on 42/60, left 17 unchanged, and
rejected one short holdout clip for excessive gain. Among the 42 passing clips,
median loudness moved from -31.745 to -16.84 LUFS, median gain was 14.495 dB,
and the highest encoded true peak was -1.34 dBTP. All decoded sample counts were
preserved; container duration changes were at most 21 ms. The reserved holdout
alone had 15 passes, five unchanged, and that one rejected candidate.
Constant-gain processing passed 40/60 and left 20 unchanged, with no rejected
outputs. These counts measure technical eligibility, not listening preference.

Five initial policies produced 195 comparisons. Naive dynamic normalization,
EQ/compression, and denoising each changed container duration by more than 25 ms
on 29/39 recordings. Aggressive processing also damaged synthetic intelligibility
scores. These failures remain in the local evidence; they are not shipping presets.

The adjusted policy uses a 60 Hz high-pass, -0.75 dB at 250 Hz, +0.75 dB at 2.5 kHz,
6 dB adaptive FFT denoising, and loudness normalization. It has no extra compressor.
Input and output gates bound gain and peak level. Separate constant-gain processing
is available for content whose suitability for voice processing is unknown.

The exact final worker was tested on 39 controlled cases at 48 kHz: three reference
voice excerpts, four additive noise types, and three SNRs, plus the unmodified
references. Median STOI change was -0.000260, worst -0.005510; none exceeded the
chosen -0.01 regression tolerance. Six inputs were conservatively left unchanged.
These are relative tests against existing recordings, not clean studio ground
truth, subjective quality ratings, or a matched Loom comparison. The calibration
run with 12 dB denoising exceeded that tolerance in four cases, motivating 6 dB.

Volume-matched RMS in uncaptioned intervals changed by a median +0.096 dB across
41 passing clips, with a maximum increase of 6.841 dB. Twelve voice candidates
changed LRA by more than two LU. Those observations require listening review for
background noise swelling and altered dynamics before enabling voice processing.

The reviewed intelligibility scorer aligns reference, noisy input, and processed
audio to the same overlapping sample interval before computing STOI and SI-SDR.
It retains unaligned scores and the measured lag separately; aligning a score does
not waive timing gates. The 39 exact-worker cases were rescored from their original
artifacts after this correction, with zero cases below the -0.01 tolerance.

Full-recording LUFS and caption-aligned RMS answer different questions. Caption
intervals approximate speech activity; uncaptioned audio is not necessarily noise
or silence. A completed transcript does not establish that a recording contains
only microphone speech. Mono loudness uses FFmpeg's `dual_mono=true` playback
compensation consistently; it must not be mixed with uncompensated mono metrics.

## Source and timing guarantees

The worker only reads an absolute regular local source, hashes it before and after,
and writes into a unique temporary directory. It copies video packets and verifies
them with the existing packet-proof helper. Existing finalization checks are
unchanged. Results carry source/output hashes, metrics, version, and validation
failures; every nonempty validation failure list disqualifies that candidate.

The worker restricts demuxers and protocols to local media files, rejecting playlists
instead of following their references. Only AAC inputs are eligible for processing;
other codecs are left unchanged. A MOV/PCM fixture exposed a video preservation
mismatch, so the first rollout deliberately bypasses that format.

The worker skips silence, extreme levels, existing clipping, unsupported formats,
already loud content, nonzero audio start times, discontinuous source timestamps,
and mismatched source audio/video durations. Voice processing additionally requires
`speechOnlyConfirmed`; the benchmark explicitly overrides this only for local
research. There is no production content classifier in this change.

FFmpeg's denoiser delays content by two sample-advance blocks without adjusting
PTS. Padding the tail and trimming that delay preserves boundary speech. Integer
sample timebases avoid timestamp rounding at 44.1 kHz. The encoded AAC result is
remeasured, with one bounded peak correction rendered from the original if needed.
Failed validation never authorizes publication. Cancellation, timeouts, and exceptions
clean up only the worker's own temporary files.

46 tests cover policy gates, mono/stereo, 44.1/48 kHz, both profiles, speech-like
markers at clip boundaries, exact video packets, source preservation, silence,
nonzero/discontinuous timestamps, cancellation, and timeout. Scoped TypeScript and
Biome checks also pass. Measurements used macOS FFmpeg 8.0.1 and Bun 1.4.0;
the reviewed format suite also runs in both production-image architectures and
in the Railway Docker build. The full production cohort was rerun locally.

## Reproducing

Keep source media, transcripts, per-recording measurements, and customer identifiers
outside the repository. Aggregate results and the frozen worker source hash are in
[audio-quality-benchmark-summary.json](audio-quality-benchmark-summary.json).
The local study retains `final-summary.json`, `final-voice-results.json`,
`final-levels-results.json`, and `report.md`, plus per-recording run receipts.
Interrupted runs and retries are retained separately.

The manifest is a JSON array with `id`, `split` (`tuning` or `holdout`), `stratum`,
`createdAt`, and `duration`. Sources are `sources/<id>.m4a`; transcripts are
`sources/<id>.vtt`. Initial download uses the authenticated Cap CLI for existing
transcripts and the public playlist for audio. No new transcription is requested.

```sh
python3 scripts/benchmark-instant-audio.py /absolute/study --phase baseline
python3 scripts/benchmark-instant-audio.py /absolute/study --phase tuning --policies gain6 gain12 dynamic equalized clean
bun apps/media-server/scripts/benchmark-audio-quality.ts /absolute/study tuning unique-label voice
bun apps/media-server/scripts/benchmark-audio-quality.ts /absolute/study holdout another-label levels
```

Use a new label per run; the worker benchmark will not overwrite existing results.
Rejected candidates are recorded with their validation failures but are not copied
into the output set. Earlier historical runs retained rejected files for diagnosis.
The intelligibility calibration requires NumPy, SciPy, and pystoi. Supply three
reference IDs with `--reference-ids`; their M4A files must be two directories above
the output directory. Output-directory suffix `-v2` selects the corrected mild
policy; a name containing `strength` selects the 6/12 dB comparison. This calibration
script records historical filter alternatives; the TypeScript worker benchmark is
the authoritative final implementation.

## Production-data revalidation

The tighter local-input restrictions were applied to the original 60-recording
cohort again. All 40 accepted outputs had identical hashes to the benchmark outputs;
20 sources were left unchanged. Sixteen additional public production files, including
browser captures and recordings without completed transcripts, were left unchanged
by stream, level, headroom, or timestamp gates. All original hashes were preserved.
These are bounded compatibility checks, not proof of safety for every possible file.

## Before serving any enhanced audio

Human review of the 12 volume-matched A/B excerpts is still required. Speech-only
eligibility, noisy and mixed-system-audio cases, and recordings excluded by the
public/transcribed selection need broader coverage. The short holdout clip rejected
for excessive gain must remain on its original audio; do not relax its gate to make
the benchmark pass.

Run the exact policy in the production Linux image, then verify actual share-page,
embed, seeking, downloads, edits, transcript alignment, and fallback behavior.
Measure worker memory, throughput, storage, and tail latency before rollout.

Future integration should create a separately versioned derivative after the
original is available, using a durable idempotent job bound to the source hash.
Publish atomically only after validation and only if the source still matches.
Keep the original available throughout processing, on failure, and for rollback.
Existing desktop installs could then benefit server-side without a capture update;
this experiment does not yet implement that serving integration.
