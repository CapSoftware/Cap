# Instant audio quality experiment

The level-correction worker reuses the local MP4 from the existing desktop Instant
segment mux or Chrome/WebM conversion, after publishing the original recording. The original output key and
verification receipt remain intact. A separate, versioned MP4 becomes the playback
and download source only after local and remote-byte validation and an atomic check
that ownership, storage, source, and upload state have not changed.

The serving integration uses bounded, constant level correction. EQ and denoising
remain experimental because consistent perceptual improvement has not been
established. No desktop capture change is required.

Eligibility is limited to newly finalized, durably verified desktop Instant segment
recordings and completed browser conversions on S3-compatible storage, at most
15 minutes and 256 MiB. All existing audio-policy
gates still apply. Google Drive, legacy recordings without an immutable output,
unsupported audio, and larger recordings retain their original audio. There is no
historical backfill. Only one enhancement runs per media-server replica, it requires
spare processing capacity, and the entire request has a two-minute deadline.
Capacity, timeout, transfer, or validation failures retain the original. The step
does not retry capacity failures or delay original publication.

There is no second download of the source and no second video encode. Correction
reads the local completed MP4, copies video packets, and encodes its audio to a
separate MP4. Candidate decode validation is audio-only; video packet identity is
checked separately. The original recording verification remains unchanged. Chrome
conversion already encodes audio, so correction adds one audio encode and can make
one bounded peak-correction attempt. Keeping both originals and derivatives requires
an additional output upload and one full output read to verify stored bytes, plus
two one-byte identity reads. Media bytes travel directly to storage; the web callback
only handles metadata and signed URLs. Output verification has its own reserved
transfer budget, independent of the completed original job's download budget.

Stored-byte verification happens in the authenticated media worker, before the
publication callback. It hashes a complete conditional GET, compares SHA-256 with
the locally validated derivative, and checks the strong ETag and size before and
after that read. The callback carries the digest returned by this remote verifier.
The web transaction pins the same verified identity with metadata checks instead
of downloading the media again. Corrupted bytes are rejected even when the mocked
storage preserves ETag and size. Storage must honor strong ETag/If-Match semantics;
these checks do not treat an ETag as a cryptographic digest.

The original becomes playable before correction. Corrections run only with spare
capacity, use one FFmpeg decoder/filter thread, and occupy one audio slot per replica.
Clearing the two audio selection fields restores the retained original. Rolling back
to the pre-activation web deployment also selects the original; the original recording
verification target is never redirected to a derivative.

## Quiet-recording policy update

A customer-reported 13.93-second recording measured -50.48 LUFS with -31.03 dBTP
peaks. A local +28 dB comparison was preferred in a listening check. The previous
constant-gain policy skipped it below -50 LUFS, and its audio ended 144 ms after
the video, exceeding the old input-duration check.

Level correction now accepts finite measurements down to -55 LUFS. It retains
the previous gain for inputs at or above -34 LUFS and progressively raises quieter
inputs toward -22 LUFS, capped at 28 dB and the available -2 dBTP peak headroom.
Encoded output must still remain below -1 dBTP and pass the existing timing and
dynamics checks. Output gain is checked against that recording's actual planned
gain, including the peak limit. Silence, invalid measurements, clipping, and
insufficient headroom keep the original. Experimental voice processing retains
its previous level limits and remains disabled.
The web publication callback enforces the same quiet-input range and loudness-based
gain bound before selecting the derivative. Its tests include the reported output
measurements, excessive-gain rejection, and retained-original playback resolution.

Level correction permits different source audio and video end times because each
original timeline is preserved independently. It neither pads nor truncates one
track to match the other. Source and output video packets, terminal packet timing,
audio start, decoded sample count, and audio duration are still checked. Both
track durations must remain within the worker's duration limit. Tests exercise
quiet audio ending before and after video, including the last audible pulse.

Rerunning the same 60 audio files produced 42 validated corrections and 18 unchanged
originals, with no rejected outputs or previously accepted files becoming ineligible.
Twenty-five prior output hashes were unchanged; fourteen prior outputs received
stronger bounded gain, and two previously excluded quiet recordings became eligible.
The remaining unchanged-gain output matched a fresh run of the previous worker
byte for byte, despite differing from its historical encoded hash.
All decoded sample counts were unchanged. The largest container-duration change was
21 ms, and the highest encoded true peak was -1.95 dBTP. The input corpus remains
the same historical tuning/holdout split; repeated tuning does not create a new
independent holdout.

The complete MP4 worker was also exercised offline on 21 production files in the
Linux image with two CPUs and 2 GiB of memory. Four published into mocked storage
and seventeen retained their originals. Every original hash was preserved, and no
source download occurred. The reported recording reached -22.49 LUFS and -3.04 dBTP
with identical decoded sample count and audio duration, unchanged LRA, and verified
video packets. Constant gain also raises existing background noise; this is a level
improvement, not a denoising claim or a universal listening-quality guarantee.

Signal comparisons covered all 42 accepted audio files and the reported recording.
The minimum STOI similarity to the input was 0.9924, median 0.99986, minimum SI-SDR
25.93 dB, and measured lag zero in every comparison. These relative metrics check
encoding distortion against each original; they do not establish clean speech or
improved intelligibility against a clean reference.

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

## Before enabling voice processing

Human review of the 12 volume-matched A/B excerpts is still required. Speech-only
eligibility, noisy and mixed-system-audio cases, and recordings excluded by the
public/transcribed selection need broader coverage. The short holdout clip rejected
for excessive gain must remain on its original audio; do not relax its gate to make
the benchmark pass.

Run the exact policy in the production Linux image, then verify actual share-page,
embed, seeking, downloads, edits, transcript alignment, and fallback behavior.
Measure worker memory, throughput, storage, and tail latency before rollout.

The level-correction integration runs inside the existing media job, after the
original completion callback and before local cleanup. It does not start another
Workflow or media job. Its immutable derivative key is bound to the original key,
object identity, and media job identity. A signed, expiring publication token binds
ownership, storage, source, and output. The worker hashes the source and output,
verifies video packets and audio timing, and verifies uploaded bytes. Publication
rechecks source and output identities while holding the video row lock. Edits,
replacement, and reprocessing clear stale audio selection; copying resolves selected
bytes into the new recording's canonical output. A lost publication response can
leave an unpublished derivative under the recording prefix for normal deletion.

The local-file integration was exercised on 20 complete production MP4s in the Linux
image with two CPUs and 2 GiB of memory. That set includes eight browser recordings
and twelve desktop recordings. One quiet recording was eligible; nineteen remained
unchanged under the existing stream, level, and timing gates. All 20 original hashes
were preserved, and the eligible output was byte-identical to the prior worker's
output. It improved from -33.06 to -21.75 LUFS with a -1.99 dBTP true peak. A timed
run took 13.1 seconds versus 16.1 seconds with the separate-source-download worker;
these offline runs use mocked storage and do not establish production tail latency.

Route tests exercise actual segmented muxing and Chrome/WebM conversion, assert each
source is downloaded once, and check that correction receives the published local
MP4 only after original completion. A thrown correction failure preserves the
successful recording and cleans up temporary files. Separate worker tests exercise
real correction, corrupted output, unavailable publication, capacity rejection,
concurrency, and independent transfer-budget accounting. Web tests cover authenticated
callbacks, signed publication, source/storage races, output selection, copies, edits,
and replacements. These checks cannot guarantee zero regressions on every recording;
unsupported cases retain their original audio.
