# Recording reliability: research, design and verification

Research date: 2026-08-30. Source baseline: official `cap-v0.5.9`, `c6b83804d2e9fa8757b75268e573b8ff113141bb`. Audited candidate: `526dc80bf5429f7729b66d0291802b65cfeb48c7`, PR #2172. This document distinguishes design requirements from implemented behavior and measured results. It is not a release approval.

## Decision

Keep the existing fragmented capture formats, codec choices, native capture adapters and project schema. Do not replace Cap's recording engine or introduce a new container as a reliability fix. The smallest defensible changes protect metadata, reject incomplete uploads, preserve retry information and remove unnecessary work only after testing its safety invariant.

Use one shared lifecycle contract across Tauri, GPUI and the CLI on macOS, Windows and Linux. Share state transitions, finalization rules, recovery rules, upload completion semantics and test assertions. Keep capture APIs, device handling, filesystem persistence and process supervision platform-specific.

Local recording completion and cloud availability must be separate states. Network latency, an expired session or a server outage must not prevent a successfully captured recording from becoming a usable local recording. They must not trigger deletion of the last usable local copy.

No software can guarantee that uncommitted samples survive power loss, that a failed drive retains data, or that an offline computer finishes uploading. The enforceable promise is: preserve every committed recoverable fragment; never silently discard a requested track; never report an incomplete save/upload as complete; retain enough durable state to retry; and make partial recovery or required user action visible.

## What OBS demonstrates

OBS writes recoverable media during capture. Its hybrid MP4/MOV approach retains fragmentation while recording, then adds a conventional index and adjusts headers at completion. This avoids a full remux of the media payload in that specific container design. It also documents compatibility and codec differences between containers. Cap already uses init segments plus fragmented media, so the relevant lesson is preserving recoverability during recording, not replacing Cap's working project format. [OBS format guide](https://obsproject.com/kb/audio-video-formats-guide), [hybrid format documentation](https://obsproject.com/kb/hybrid-mp4), [OBS technical explanation](https://obsproject.com/blog/obs-studio-hybrid-mp4).

The source inspection is pinned to OBS 32.2.2, commit `ba2f32bdf791005443988a4955e963663e16b1ed`. Its MP4 finalizer flushes the final fragment, writes the complete index and adjusts headers. Its output layer distinguishes a stop timestamp from finalization and waits for the buffered writer to drain. The writer batches I/O, bounds its queue and propagates output errors. These are useful design patterns, not evidence that another application or every storage device is infallible. [MP4 finalizer](https://github.com/obsproject/obs-studio/blob/ba2f32bdf791005443988a4955e963663e16b1ed/plugins/obs-outputs/mp4-mux.c#L2955), [output lifecycle](https://github.com/obsproject/obs-studio/blob/ba2f32bdf791005443988a4955e963663e16b1ed/plugins/obs-outputs/mp4-output.c#L453), [buffered writer](https://github.com/obsproject/obs-studio/blob/ba2f32bdf791005443988a4955e963663e16b1ed/libobs/util/buffered-file-serializer.c).

FFmpeg also documents that fragmented MP4 remains decodable after interrupted writing, unlike a conventional unfinished MP4. That depends on a usable initialization segment and complete fragments; it does not preserve bytes that never reached storage. Cap's existing fragments are therefore a sound foundation. Adopting OBS's hybrid muxer or FFmpeg's equivalent would require separate codec, timestamp, editor, export, upload and old-project compatibility work, and is not recommended for this repair. [FFmpeg MOV/MP4 fragmentation documentation](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).

## Source audit findings

| Risk | Current behavior at the audited candidate | Required change |
| --- | --- | --- |
| Canonical metadata can become empty or partial | `RecordingMeta::save_for_project` truncates and writes the existing JSON file. A write failure can make raw media undiscoverable to ordinary recovery. This also exists in 0.5.9. | Serialize first; write and sync a unique sibling temporary file; atomically replace the canonical file. Preserve the original on every pre-publication failure. Keep the schema unchanged. |
| An incomplete Instant upload can be accepted | Tauri can complete a manifest after exhausting retries for some segments, provided some video uploaded. Its caller can then run upload-complete actions and local auto-deletion. | Withhold completion while any segment or upload task failed. Preserve the resumable upload identity and local media. Include failed audio/init segments, short reads and worker failures. |
| GPUI can strand retry information | A transient failure can replace a resumable upload variant with `Failed`; GPUI has no equivalent comprehensive startup resume scan. | Keep retry identity and failure information independently; reconcile outstanding uploads on startup and network/auth recovery. Do not solve this by retrying forever inside Stop. |
| Stop includes cloud work in GPUI | `ActiveRecording::stop` awaits segment completion, thumbnail upload or full-file upload, and cleanup. | Finish capture and local publication first. Run cloud work under a managed persistent queue; report uploading/retry state separately. |
| Queue admission is treated as completed upload | `/api/upload/recording-complete` can acknowledge queued or already-processing work before final mux verification. | Distinguish accepted, processing and verified remote-ready. Only verified final readiness can permit local retention cleanup. |
| Live upload completion lacks a complete capture-success contract | A received-event inventory cannot identify an event never emitted. Live Tauri completion can race recorder failure, and historical Instant metadata does not always retain requested audio intent. | Bind final publication to successful capture/local finalization and a persisted expected inventory. Do not infer missing historical audio intent from a nullable sample rate. |
| Aborting an upload is not the same as joining its workers | External cancellation of a parent uploader can leave independently spawned children running. | Own cancellation and join child work before claiming quiescence or deleting media; a normal-path drain alone does not prove cancellation safety. |
| Publication durability is incompletely specified | Recovery syncs files and journals, but its multi-file rename transaction does not consistently persist parent-directory changes. | Define ordered platform-specific durability operations and test interruption/reordering at each transition before claiming power-loss safety. |
| Some Windows checkpoint flushes use read-only handles | Fragment helpers open files for reading before `sync_all`, sometimes only logging or discarding failure. Windows requires write access for `FlushFileBuffers`. | Use a supported writable handle at the writer boundary and propagate a failed required checkpoint. Native Windows verification is required. |
| Successful encoder completion is not universal device quiescence | Some macOS/non-Windows source stop errors or timeouts are logged; a clean output token does not prove every device/preview writer has exited. | Preserve generation/ownership checks and explicit quiescence acknowledgement. Do not use the existing token to bypass all source protection. |
| Normal Stop repeatedly reads/copies the entire recording | Studio performs four full input snapshots, a private copy, remux/validation and publication; Instant also copies and scans. | First remove only provably redundant work. A later read-only-source finalizer must leave original fragments unchanged until commit. |

Relevant source seams: `crates/project/src/meta.rs`; `crates/recording/src/recovery.rs`; `crates/recording/src/fragmentation/mod.rs`; `crates/enc-ffmpeg/src/mux/{fragment_manifest,segmented_stream,dash_audio,segmented_audio}.rs`; `apps/desktop/src-tauri/src/{recording,upload}.rs`; `apps/desktop-gpui/src/{recording,upload,session}.rs`; `apps/web/app/api/upload/[...route]/recording-complete.ts`.

## Shared safety contract

### Capture and local save

1. Allocate a unique recording generation and persist its requested tracks and recovery identity before treating capture as started. A camera/microphone requested by the user is not an optional success condition merely because its device later fails.
2. Keep initialization data and completed fragments discoverable. Publish a fragment as complete only after the encoder/muxer closes it and the required storage checkpoint succeeds. Keep the currently incomplete fragment distinguishable from committed fragments.
3. Use bounded queues. Track dropped frames, audio discontinuities, device loss and encoder failures explicitly. Silent audio is not proof that the requested audio path worked.
4. On Stop, stop accepting capture samples at a defined boundary, drain owned encoder work, close writers and acknowledge quiescence. Keep capture stopped, local saving and uploading distinguishable in the UI.
5. Read sealed source fragments without modifying them when producing a final output. Write output and new metadata separately on the same filesystem. Validate expected track inventory, time ranges, packet structure and output decodability at appropriate boundaries.
6. Install a new generation through a recoverable transaction. Commit metadata only when its referenced outputs exist. Preserve the previous generation and recovery evidence until installation is confirmed.
7. Treat post-commit cleanup failure as retained cleanup work, not a failed recording. Never turn a usable saved video into an error because a disposable temporary directory could not be removed.
8. On recovery, retain originals and identify any loss explicitly. A recovered video missing requested audio may be offered as a partial recovered copy; it must not be silently labelled a complete original recording.

The proposed source/output separation is not yet a drop-in optimization. The current `finalize_staged` deletes and renames its working inputs. Passing original fragments to it would remove the isolation that currently prevents destructive failures. Similarly, hard links are not independent backups when either name can still be written. A clone optimization needs a real filesystem capability check and safe fallback; ReFS block cloning is not a portable NTFS solution.

### Upload and retention

Use persistent per-recording upload state: video identity, local artifact generation, expected tracks/segments, completed parts, retry state and final acknowledgement. Keep this separate from local recording completeness. The same recording must not acquire duplicate remote identities because a successful response was lost.

Every expected segment must either be acknowledged or remain pending. An empty, truncated or unreadable segment is a failure; a worker panic is a failure; a successful subset is not the entire recording. Refresh expired signed URLs and auth when appropriate, retry transient failures with bounded backoff, and retain an actionable paused state for permanent failures.

Multipart completion must be reconciled, not guessed from a status code. S3 documents that a complete-multipart response can contain an error despite an HTTP 200 status; official SDKs handle that condition. ETags are not universally full-object checksums. Where supported, provide and verify the correct checksum/size contract rather than assuming every S3-compatible provider has identical features. [S3 multipart completion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html), [S3 upload integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).

The server must distinguish manifest acceptance from a verified final object. A durable final-ready receipt should bind the video ID, generation, object identity, byte length and expected media properties. Repeating completion after an ambiguous response must reconcile the same job/object. A server-side mux failure must leave local data and the upload ledger available for retry. The existing `already-complete` response checks the `desktopMP4` source marker; it does not independently verify object size, checksum or track inventory. Polling that response alone is not the proposed deletion certificate.

Auto-deletion is a separate retention operation after remote-ready confirmation. It must be cancellable, resumable, scoped to the exact completed generation, and prevented while a local editor/export/recovery still needs the data. If verification times out, retain the local copy and show why. Avoid keeping unlimited invisible backups: provide explicit retention/accounting and warn about storage pressure without silently sacrificing the last copy.

S3 provides strong read-after-write consistency for objects and HEAD metadata, but that does not make Cap's database, queue, mux worker, CDN and local state one transaction. Each boundary needs idempotent reconciliation. [S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel).

### Persistence is an OS adapter, not a shared assumption

On Linux, file `fsync` does not by itself persist its directory entry; relevant directories must also be synced. On macOS, storage barriers and full synchronization have different costs and guarantees. On Windows, writable handles, sharing modes, replacement behavior and flush semantics must be handled explicitly. Do not label a sequence of file renames a single atomic transaction or equate process-kill tests with power-loss tests. [Linux fsync](https://man7.org/linux/man-pages/man2/fsync.2.html), [Apple fsync](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html), [Apple storage guidance](https://developer.apple.com/videos/play/wwdc2019/419/), [Windows FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers), [Windows MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

SQLite's crash-testing approach is a useful model for a persistence harness: inject failures at storage transitions and validate the recovered state. It is not a reason to migrate Cap's project format to a database in this repair. Keep application-error tests, process termination tests and simulated storage write-loss/reordering tests as separate evidence classes. [SQLite atomic commit and crash testing](https://www.sqlite.org/atomiccommit.html), [SQLite testing](https://www.sqlite.org/testing.html).

## Performance without weakening preservation

The measured candidate is not yet at 0.5.9 parity. A Linux 120-second Studio pair took 537.342 ms versus 362.396 ms from Stop to process exit. Windows 12-second Instant pairs took 446.028 versus 405.319 ms and 473.999 versus 376.941 ms from capture-thread completion to process exit. These are different boundaries and limited samples, not universal latency distributions. The Linux project occupied about 141 MB versus 70 MB because original media was retained.

The original PR introduced the private copy and repeated full snapshots. Current repairs reduced decoding and temporary-write overhead, but retained the complete-media copy. A slow disk or long recording magnifies that work. Do not remove preservation merely to match a stopwatch.

Apply optimizations in increasing order of risk:

1. Avoid probing fragments whose probe result is discarded because they are already represented by a validated manifest. Keep fallback behavior for incomplete/unreadable manifests.
2. Test whether the immediate post-copy original snapshot is redundant with the initial source, independently read staged copy and final source snapshot. Exercise mutations at each boundary before removing a scan.
3. Measure copy-on-write cloning where available, with fallback that preserves isolation; do not assume all supported filesystems support it or that deferred allocation cannot fail later.
4. If needed, introduce a narrowly eligible finalizer with separate source/output roots, preserving the existing publication transaction and conservative recovery fallback. Prove ownership/sealing rather than trusting a status enum or size/mtime alone.
5. Move cloud work off Stop only together with persistent retry and visible cloud state. Background work without restart reconciliation is not a reliability improvement.

Track Stop request → capture acknowledgement → local output ready → editor interactive separately from upload accepted → final object ready. Measure bytes read/written and peak disk demand as well as elapsed time. A debug build, workload mismatch or skipped audio assertion cannot establish release parity.

## Consistent real-recording harness

The adjacent `recording-reliability.py` is the portable entry point for clean local recording checks. It requires explicit binaries, an explicit screen/window target and a fresh output root. It records executable hashes and keeps recordings and failure logs. It must not sign applications, discover or delete the user's production library, start development servers, reset devices, change permissions or upload real user recordings.

For example, with a moving test fixture already visible and an explicitly selected capture window:

```sh
python3 -B scripts/recording-reliability.py \
  --cap /absolute/path/to/cap \
  --ffmpeg /absolute/path/to/ffmpeg \
  --ffprobe /absolute/path/to/ffprobe \
  --root /absolute/path/to/new-run-directory \
  --head SOURCE_COMMIT --window WINDOW_ID --mode both --duration 12
```

On Windows use `python` and add `--windows-job-source scripts/recording-reliability-owned-process.cs`. The bundled supervisor starts the child suspended, assigns it to an owned Job Object before resuming, and confines timeout cleanup to that job. The Python runner verifies its hash and treats forced cleanup as a failed operation. No system process names are used as kill targets. To compare builds, provide `--baseline-cap`, `--baseline-head` and `--iterations 2`; source identities are supplied assertions, while executable hashes are independently measured. Use `--system-audio` only with a known audible stimulus. Exit code 2 means required coverage remains pending, not that the whole workflow passed.

Run the same assertion schema on all three OSes. A VM proves its guest capture and filesystem paths, not every physical microphone/camera/GPU. Missing devices, silent stimuli, unavailable editor controls or inaccessible cloud environments are `PENDING`, not `PASS`. Requested audio must be present and demonstrably non-silent; A/V synchronization needs an independently measurable flash/tone or equivalent stimulus, not just container timestamps.

| Scenario family | Required evidence |
| --- | --- |
| Clean Instant and Studio | Start/stop events, complete local metadata, expected tracks, duration/cadence, full decode, project validation |
| Pause/resume and repeated Stop | Ordered transitions, no double completion/deletion, no unexpected gaps, stable media identity |
| Camera/mic/system audio combinations | Exact requested track inventory, visible camera content, audible stimulus, independent A/V onset and drift |
| App or muxer crash during recording | Complete fragments retained; fresh-process recovery; decoded recovered duration accounts for the last committed fragment |
| Crash during local publication | Inject at each rename/checkpoint; old or new generation remains recoverable, with no false Complete |
| Low space/write failure | Scoped ENOSPC/EIO injection or disposable bounded filesystem; no filling the user's disk; originals retained |
| Sleep, device loss and permission loss | Visible degradation/failure, controlled stop, recoverable data, no frozen success state |
| Offline/timeout/expired credentials | Local save unaffected; upload remains retryable across restart; no local auto-deletion |
| Failed or truncated segment | No final manifest acknowledgement or completion action until the entire required inventory is verified |
| Lost multipart-complete response | Same remote object/job reconciled; no duplicate video or abandoned local state |
| Server mux failure | No remote-ready claim; local media retained; retry produces a verified playable final object |
| Upload and application restart | Durable queue reconstructs work and resumes without re-recording |
| Studio editor and export | Editor reveals/focuses; seeks/playback work; exported output fully decodes with requested media |
| Old 0.5.9 projects | Original bytes unchanged; valid legacy omissions remain supported; editing/export match baseline |
| Long/load/thermal runs | Stable memory and storage growth, measured drops, bounded Stop latency, no recording-length-dependent redundant work |
| Cleanup and retention | Only the owned completed generation is removed after remote verification; cleanup failure does not negate save success |

Record exact source/build identity, OS/filesystem, requested inputs, fixture identity, timing boundaries, all assertions, skipped reasons and cleanup ownership. Compare candidate and 0.5.9 in alternating orders with the same workload; use enough repetitions to expose variance. Do not impose an arbitrary threshold after seeing a result. Physical power failure, physical device disconnect and prolonged workloads need their own explicit runs.

## Implementation and release gates

First changes are deliberately bounded: atomic recording metadata replacement, fail-closed Tauri segment completion, and a common local recording oracle. They do not implement the entire lifecycle described above. In particular, background GPUI upload/restart reconciliation, final-object-based deletion, filesystem durability ordering and strict performance parity remain separate work until verified.

Before release: all required native scenarios must pass on the final source/build; every false-success/data-loss finding must be fixed; 0.5.9 projects and supported recording combinations must remain compatible; performance comparisons must meet the agreed parity requirement; and a fresh independent/Greptile review must cover the final changes. A review score or green CI job cannot replace missing native or cloud evidence.
