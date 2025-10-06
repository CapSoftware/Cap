# Import & Upload From File — Desktop App Task Spec

Owner: Desktop team
Target view: `apps/desktop/src/routes/(window-chrome)/settings/recordings.tsx`
Related runtime: `apps/desktop/src-tauri/src/*` (Rust, ffmpeg, upload)

## Goal
Add an “Upload from file” flow in Settings → Recordings that lets a user pick any local video, converts it to our standard MP4 format using ffmpeg, wraps it into a `.cap` project with RecordingMeta, and uploads via the existing single-part uploader. The `.cap` project should persist upload state so progress resumes after app restarts and errors are visible in the UI like any studio recording.

## UX Overview
- Entry point: a new button in the Recordings page header (next to “Previous Recordings” area).
  - Label: “Upload from file”
  - Action: opens file picker (video files).
- On selection:
  1) Create a new `.cap` project from the file (transcode if needed).
  2) Generate thumbnail.
  3) Start upload using the same single-part uploader flow as Studio.
  4) Show progress in the list (leveraging existing `upload-progress-event`).
- On success: project shows a shareable link button just like other recordings.
- On failure: the project appears with a “Recording failed” badge and tooltip (same as existing status UI), and can be retried later.

## High-Level Architecture
- UI (Solid):
  - Add a header button that calls a new Tauri command `import_and_upload_video(sourcePath, channel)`.
  - Use the existing `events.uploadProgressEvent` listener + `recordingsQuery` to reflect progress and final state.
- Rust (Tauri):
  - New command `import_and_upload_video` orchestrates:
    1) Validate auth/plan constraints.
    2) Create `.cap` project directory and `RecordingMeta` (Studio SingleSegment).
    3) Transcode input → `output/result.mp4` to our standard MP4 (H.264 + AAC, 30fps; preserve resolution where possible).
    4) Generate `screenshots/display.jpg` from the video using ffmpeg.
    5) Request S3 config (`create_or_get_video`), set `upload = SinglePartUpload{...}`, save meta.
    6) Upload video + screenshot via `upload::upload_video` (single-part uploader), writing progress events and updating meta on success/failure.
  - Reuse existing helpers: `build_video_meta`, `create_or_get_video`, `upload_video`, `create_screenshot`, `UploadMeta` variants, and `resume_uploads` bootstrap.

## Detailed Implementation Plan

### 1) UI: Add “Upload from file” button
- File: `apps/desktop/src/routes/(window-chrome)/settings/recordings.tsx`
- Placement: top toolbar above the list, aligned to the right of the Tabs or next to the heading.
- Action:
  - Use `@tauri-apps/plugin-dialog`’s `open()` to select a file.
  - Filter: common video types (`mp4`, `mov`, `mkv`, `webm`, `avi`), but allow Any as fallback.
  - On a path selection, call a new Tauri command `commands.importAndUploadVideo(path, new Channel<UploadProgress>(...))`.
  - While uploading, the new project will show up in the list via `listRecordings()` refetch and will display progress based on `events.uploadProgressEvent` keyed by `video_id` as is done today.

Pseudo-code:
```ts
import { open } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import { commands, type UploadProgress } from "~/utils/tauri";

async function handleImportUpload() {
  const path = await open({ multiple: false, filters: [{ name: "Video", extensions: ["mp4","mov","mkv","webm","avi"] }] });
  if (!path || Array.isArray(path)) return;
  const ch = new Channel<UploadProgress>(() => {});
  // Optional: reflect per-call progress in local state if desired; global event also fires.
  await commands.importAndUploadVideo(path, ch);
}
```

Notes:
- We already listen to `events.uploadProgressEvent` and poll `listRecordings()`; no extra client-side state model is needed.
- Analytics: track button press and success/failure as needed (optional).

### 2) Tauri command: `import_and_upload_video`
- File: `apps/desktop/src-tauri/src/lib.rs` (define command + export via specta), and helper(s) in `apps/desktop/src-tauri/src/upload.rs` or a new module `import.rs` if preferred.

Signature:
```rust
#[tauri::command]
#[specta::specta]
async fn import_and_upload_video(
    app: AppHandle,
    source_path: PathBuf,
    channel: Channel<UploadProgress>,
) -> Result<UploadResult, String>
```

Flow:
1) Auth/plan checks (reuse code from `upload_exported_video`):
   - Fail with `NotAuthenticated` if no auth.
   - Build metadata with `build_video_meta(&source_path)` to determine duration; gate 5+ minute uploads if not upgraded (return `UpgradeRequired`).
2) Create new project dir:
   - `let id = uuid::Uuid::new_v4().to_string();`
   - `let recording_dir = recordings_path(&app).join(format!("{id}.cap"));`
   - `std::fs::create_dir_all(&recording_dir)?;`
3) Transcode input to standard MP4:
   - Output: `recording_dir.join("output/result.mp4")`
   - Standard: H.264 + AAC, MP4 container, 30fps; preserve width/height when possible; yuv420p pixel format; fast preset.
   - Implement `transcode_to_mp4(input: &Path, output: &Path) -> Result<(), String>` using `ffmpeg` crate (preferred) or, if we already have an encoder utility in the codebase, reuse it.
   - If the input is already compliant MP4, optionally fast-path copy (remux) instead of re-encode.
4) Generate thumbnail:
   - `let screenshot_path = recording_dir.join("screenshots/display.jpg");`
   - `std::fs::create_dir_all(screenshot_path.parent().unwrap())?;`
   - Call `create_screenshot(output_mp4.clone(), screenshot_path.clone(), None).await?;`
5) Create and persist RecordingMeta (Studio SingleSegment):
   - Use `cap_project::RecordingMeta` with `RecordingMetaInner::Studio(StudioRecordingMeta::SingleSegment { ... })`.
   - `segment.display.path` is a path relative to the project root pointing to `output/result.mp4`.
   - `pretty_name` defaults to the file name (without extension) or a timestamp.
   - `upload: None` initially.
   - `meta.save_for_project()?;`
6) Create/get S3 upload config:
   - Build video meta from the transcoded output: `let s3_meta = build_video_meta(&output_mp4)?;`
   - `let s3_config = create_or_get_video(&app, false, None, Some(meta.pretty_name.clone()), Some(s3_meta)).await?;`
7) Persist upload state to meta and save:
   - Set `meta.upload = Some(UploadMeta::SinglePartUpload { video_id: s3_config.id.clone(), file_path: output_mp4.clone(), screenshot_path: screenshot_path.clone(), recording_dir: recording_dir.clone() });`
   - Save: `meta.save_for_project().ok();`
8) Upload (single-part):
   - Call `upload::upload_video(&app, s3_config.id.clone(), output_mp4, screenshot_path, s3_meta, Some(channel)).await`
   - On success:
     - `meta.upload = Some(UploadMeta::Complete)`
     - `meta.sharing = Some(SharingMeta { link, id })`
     - Save meta
     - Copy link to clipboard and send `ShareableLinkCopied` notification (same as `upload_exported_video`).
     - Return `UploadResult::Success(link)`
   - On error:
     - `meta.upload = Some(UploadMeta::Failed { error })`, save and return `Err`.

Specta export will generate `commands.importAndUploadVideo(...)` in `apps/desktop/src/utils/tauri.ts` automatically.

### 3) Progress & Resume
- Progress events: `upload::progress(...)` already emits `UploadProgressEvent { video_id, uploaded, total }`; UI already listens and updates the local store. We don’t need anything new here.
- Resume: `resume_uploads(app)` in `lib.rs` handles `UploadMeta::SinglePartUpload` by attempting to complete the upload on app startup. Our imported projects will be picked up thanks to the saved `UploadMeta::SinglePartUpload` state.

### 4) Error Handling
- Auth/plan rejections return the same `UploadResult` variants as the Studio flow.
- Conversion/transcode failures:
  - Write `UploadMeta::Failed { error }` and persist to `.cap`.
  - UI will show the same “Recording failed” chip with tooltip (already implemented in `RecordingItem`).
- File validation:
  - If `ffmpeg::format::input` can’t open the selected file, surface an error dialog and stop.
  - Optional: preflight accept-list based on container/codec; otherwise rely on conversion step.

### 5) Analytics (optional but recommended)
- Track: button click, file picked, transcode started/ended, upload started/completed/failed; include duration/size (rounded), and plan status.

## Data Model Alignment
- `.cap` layout for imported recording mirrors Studio single-segment output:
  - `output/result.mp4` — transcoded file
  - `screenshots/display.jpg` — thumbnail used by UI
  - `meta.json` — includes `pretty_name`, `upload` state, and `sharing` on success
- `list_recordings()` will discover the directory and display it. `RecordingMetaWithMetadata` continues to work.

## Type/Code References
- TS bindings: `apps/desktop/src/utils/tauri.ts` — autogenerated by specta.
- Upload flow (single part): `apps/desktop/src-tauri/src/upload.rs` → `singlepart_uploader`, `upload_video`, `build_video_meta`, `compress_image`.
- Meta + listings: `apps/desktop/src-tauri/src/lib.rs` → `RecordingMeta`, `list_recordings`, `resume_uploads`, `create_screenshot`.
- UI patterns for upload/progress: `apps/desktop/src/routes/editor/ExportDialog.tsx`, `apps/desktop/src/routes/recordings-overlay.tsx`.

## Pseudocode: Rust pieces

```rust
async fn transcode_to_mp4(input: &Path, output: &Path) -> Result<(), String> {
    // Using ffmpeg crate
    // - open input, find video and audio streams
    // - set up encoders: H.264 (yuv420p, 30fps) + AAC
    // - remux if possible, else re-encode
    // - write to mp4 muxer
    // Return Err(...) on failure
}

#[tauri::command]
#[specta::specta]
async fn import_and_upload_video(
    app: AppHandle,
    source_path: PathBuf,
    channel: Channel<UploadProgress>,
) -> Result<UploadResult, String> {
    // 1) auth / plan check (like upload_exported_video)
    // 2) create {id}.cap folder
    // 3) transcode_to_mp4(source, output/result.mp4)
    // 4) create_screenshot(output/result.mp4, screenshots/display.jpg, None).await
    // 5) instantiate RecordingMeta::Studio(SingleSegment { display: VideoMeta { path: rel("output/result.mp4") ... }})
    // 6) create_or_get_video(...), set upload=SinglePartUpload, save
    // 7) upload::upload_video(..., Some(channel)).await; update meta on success/failure
}
```

## Acceptance Criteria
- Button “Upload from file” exists and opens picker.
- Selecting a valid video spawns a new `.cap` project under recordings.
- A thumbnail appears; the item shows in the list with progress during upload.
- Upload succeeds using single-part flow and produces a shareable link stored in meta.
- On restart during an in-flight upload, the upload resumes automatically.
- On failure (auth/plan/network/transcode), the error is persisted to meta and visible as the existing “Recording failed” badge with a tooltip.

## Rollout & Flags
- Honors `GeneralSettingsStore.enable_new_uploader` automatically through `upload::upload_video` — if false, falls back to legacy as implemented.
- No migration required; feature is additive.

## Testing
- Unit-ish: 
  - Import a <5 min .mp4, verify success end-to-end.
  - Import a long file without upgrade → `UpgradeRequired` path.
  - Import an already MP4-compliant file → optional remux path.
  - Kill app mid-upload; restart and verify resume.
  - Offline or network error during upload; verify `UploadMeta::Failed` and tooltip.
- Manual on macOS + Windows: file picker works, ffmpeg linking ok, permissions OK.

## Open Questions
1) Formats: Do we want to accept any container/codec the local ffmpeg can decode, or limit to a specific set in the picker?
2) Transcode policy: Always re-encode to our preset, or remux when the file already matches (mp4/H.264/AAC, yuv420p, 30fps)?
3) FPS handling: Always 30fps, or preserve source FPS with an upper cap (e.g., 30/60)?
4) Pretty name: Use the source file name (sans extension) as `pretty_name`, or prompt for a name before upload?
5) Multi-select: Should the picker allow multiple files and queue them sequentially?
6) Plan gating: Do we want to proactively open Upgrade modal on `UpgradeRequired` like other flows?
7) Storage: Any need to clean up the original source file if we moved/copied it? (Current plan: keep source untouched.)
8) Telemetry: Which analytics events do we want to capture for this flow?

## Estimation
- UI button + wiring: 0.5 day
- Tauri command + meta plumbing: 0.5–1 day
- ffmpeg transcode path (encode + optional remux): 1–2 days depending on reuse
- QA + polish: 0.5–1 day

Total: ~2–4 days depending on transcode complexity.
