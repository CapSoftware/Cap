# Recording reliability

A recording is ready only after its complete media, timing, required audio, and published object have been verified. A successful upload, complete manifest, responding worker, or playable preview is insufficient.

## Preservation contract

- Retain original recording files and cloud segments until the normal verified receipt authorizes local cleanup.
- Bind processing to a generation, attempt, exact manifest hash, and immutable source inventory. Verify every object against its saved size and identity.
- Decode every video frame and audio sample. Compare decoded content hashes, stream formats, packet timing, frame counts, and endpoints before publishing a processed recording.
- Preserve timestamps and required audio. Do not use `-shortest`, estimated legacy durations, broader tolerances, or substituted media to make a failed recording pass.
- Verify the complete uploaded object against its expected size, identity, and SHA-256 before issuing a receipt. Keep publication conditional on the current attempt and unchanged source.

## Stable resume

The recording crate enables `serde_json/float_roundtrip`. Previously, parsing and serializing a completed manifest could change a duration by one floating-point step, changing the manifest hash despite unchanged media. Regression fixtures pin the original floating-point bits and exercise repeated video/audio resume without rewriting the original manifests.

GPUI validates cached verification against the retained local recording before confirming it. A stale cache is cleared; the ordinary retry transfers the same recording again and must obtain a new exact receipt. It cannot reuse an unrelated receipt or delete changed local media.

Already installed older clients can still rewrite manifests. Preserve strict server identity checks for these recordings. Investigate the saved manifest, copy receipts, and original object identities before undertaking a source-preserving recovery. Numeric similarity alone is insufficient evidence.

## Worker ownership and recovery

Fenced workers claim ownership before downloading or decoding media. The claim transaction binds a unique process incarnation to the current generation and attempt using `remote_job_id`. Repeating the same claim is idempotent; another replica cannot start work for that attempt.

The worker protocol is `recordingWorker.version = 1`. Claims use action `claim` and sequence zero. Real state changes advance the sequence; heartbeats repeat the same snapshot. The receiver stores a payload hash and sequence in the processing checkpoint, rejects older or conflicting snapshots, and rechecks ownership in the publication transaction. Terminal receipts retain the accepted checkpoint for exact acknowledgement replay.

Active workers send durable callbacks every 60 seconds. Each accepted callback grants a five-minute lease. Workers stop when their conservative local grant expires or the receiver explicitly rejects ownership. Status probes do not renew v1 ownership. A timeout, generic error, or status 404 from another replica is not evidence that the owner stopped.

Callbacks are serialized and coalesced. Completion drains after an in-flight progress callback; retrying an old snapshot cannot overwrite newer progress or reopen a terminal job. Heartbeats do not extend fixed processing and decode deadlines.

The accelerated decoder requires Bun 1.4.0 or newer. Bun 1.3.14 can close extra decoder pipe descriptors twice when garbage collection runs, corrupting later subprocesses. Both production image definitions pin the fixed runtime, and verification refuses the unsafe accelerated path on older Bun versions. A repeated-decode regression exercises descriptor reuse under garbage collection. Streaming hashes must retain exact parity with FFmpeg's stock decoded hashes while staying within the bounded memory and time gate.

If a dispatch acknowledgement is lost, the workflow reads durable ownership and waits within the existing lease. It does not immediately create another attempt. Existing recovery continues to select expired leases and due retries, preserving source checkpoints and committed originals.

## Automatic health reporting

The existing `/api/cron/finalize-stale-desktop-segments` cron runs recovery and then reports aggregate health for all unresolved jobs. It returns HTTP 503 and a structured `[recording-health]` error when any of these remain:

- A worker lease or source commit has stalled beyond a 30-minute recovery grace period.
- A committed recording has at least five attempts and remains queued, processing, or retrying.
- A committed source is blocked, excluding intentional output replacement and deletion.
- A source manifest changed during commitment.
- The recovery pass itself failed.

Incomplete uploads without a committed source are not automatically classified as processing incidents. Health-query failure must not produce a healthy response. Logs contain aggregate counts; source media, signed URLs, customer names, and transcripts are unnecessary for this signal.

Investigate a failed cron in the production logs. This signal does not itself send a customer message or prove every recording is correct. Existing platform alert routing must deliver failed-cron notifications to the responsible operator.

## Regression and deployment gates

`Recording Reliability` runs the web recording, source commitment, publication, recovery, and webhook tests on relevant pull requests and main changes. Railway's Docker build must pass the full decode, worker, route, cancellation, and long-recording performance suites before it can deploy. The Docker workflow also runs these tests inside the release image on AMD64 and ARM64 before publishing the release tag, with two CPUs and a 2 GiB container limit for the performance workload. Superseded workflows are cancelled, and `latest` promotion checks that its commit is still current main. All media fixtures are synthetic.

The matrix must cover missing and changed source objects, required audio, silent audio, video-only recordings, repeated and tied timestamps, damaged tails, changed interior media, output replacement, cancellation, descriptor reuse, failed claims, multiple replicas, delayed callbacks, lost acknowledgements, and long silent processing stages.

Deploy the compatible web receiver and workflow first and verify the production deployment. Then deploy the media worker. New media deliberately refuses to start fenced work against a receiver that does not acknowledge v1. Existing old workers remain supported by the new receiver. Keep the web receiver available when rolling back a media deployment.

The desktop resume fix reaches installed clients through a separately verified desktop release. Passing server tests does not establish native package or updater acceptance.

## Incident verification

1. Read the primary processing record and identify its generation, attempt, source inventory, lease, error, and published receipt.
2. Confirm saved source identities and receipt pages before retrying or changing state. Reconcile uncertain operations before dispatching another worker.
3. Require complete decode and source/output preservation evidence, followed by complete remote-object hash verification.
4. Publish through the normal fenced completion path. Confirm the primary record is verified, required audio is present, and transcription can proceed.
5. Check actual playback at the beginning, middle, and end. Retain the evidence and originals.
6. Add a synthetic regression for the failure mechanism and verify it in the deployed runtime. Do not describe a recording as recovered while a required proof or publication step remains incomplete.
