use super::preparing_observer::{PreparingAudioTrack, PreparingVideoTrack};
use super::{
    PreparingStudioJob, PreparingStudioObserver, PreparingStudioSources, PreparingStudioState,
    RecoveryManager,
};
use crate::studio_recording::{CleanStoppedStudio, CleanStoppedStudioClaim, CompletedRecording};
use anyhow::{Context, Result, bail, ensure};
use cap_audio::{AudioStream, ChunkRead};
use cap_enc_ffmpeg::RelocatableSource;
use cap_project::{
    Cursors, MultipleSegment, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta,
};
use cap_rendering::decoder::{
    DecodedFrame, ManagedVideoDecoder, PixelFormat, spawn_managed_decoder,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FileRecord {
    bytes: u64,
    sha256: String,
}

type FileManifest = BTreeMap<String, FileRecord>;

fn hash_file(path: &Path) -> Result<FileRecord> {
    let mut input = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
    }
    Ok(FileRecord {
        bytes,
        sha256: hex::encode(hash.finalize()),
    })
}

fn manifest(root: &Path, public_only: bool) -> Result<FileManifest> {
    fn visit(root: &Path, path: &Path, public_only: bool, result: &mut FileManifest) -> Result<()> {
        let metadata = path.symlink_metadata()?;
        super::reject_recovery_link(&metadata)?;
        if metadata.is_dir() {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                if public_only && path == root {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name == ".recovery.lock"
                        || (entry.file_type()?.is_dir()
                            && name
                                .strip_prefix(".recovery-")
                                .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok()))
                    {
                        continue;
                    }
                }
                visit(root, &entry.path(), public_only, result)?;
            }
        } else {
            ensure!(
                metadata.is_file(),
                "Unsupported fixture object: {}",
                path.display()
            );
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("Non-UTF8 fixture path")?
                .replace('\\', "/");
            ensure!(
                result.insert(relative, hash_file(path)?).is_none(),
                "Duplicate fixture path"
            );
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    visit(root, root, public_only, &mut result)?;
    Ok(result)
}

fn copy_fixture(source: &Path, destination: &Path, expected: &FileManifest) -> Result<()> {
    fs::create_dir(destination)?;
    for (relative, wanted) in expected {
        let relative = Path::new(relative);
        ensure!(
            relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
            "Non-local fixture path"
        );
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().context("Missing copy parent")?)?;
        fs::copy(source.join(relative), &target)?;
        ensure!(
            hash_file(&target)? == *wanted,
            "Fixture copy differs: {}",
            relative.display()
        );
    }
    Ok(())
}

fn ordered_json(value: Value) -> Value {
    match value {
        Value::Object(values) => {
            let sorted: BTreeMap<_, _> = values.into_iter().collect();
            Value::Object(
                sorted
                    .into_iter()
                    .map(|(key, value)| (key, ordered_json(value)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.into_iter().map(ordered_json).collect()),
        value => value,
    }
}

fn changed_json_fields(before: &Value, after: &Value) -> Vec<Value> {
    fn visit(
        path: String,
        before: Option<&Value>,
        after: Option<&Value>,
        changes: &mut Vec<Value>,
    ) {
        if before == after {
            return;
        }
        match (before, after) {
            (Some(Value::Object(before)), Some(Value::Object(after))) => {
                let keys: std::collections::BTreeSet<_> = before.keys().chain(after.keys()).collect();
                for key in keys {
                    let escaped = key.replace('~', "~0").replace('/', "~1");
                    visit(format!("{path}/{escaped}"), before.get(key), after.get(key), changes);
                }
            }
            (Some(Value::Array(before)), Some(Value::Array(after))) if before.len() == after.len() => {
                for (index, (before, after)) in before.iter().zip(after).enumerate() {
                    visit(format!("{path}/{index}"), Some(before), Some(after), changes);
                }
            }
            _ => changes.push(json!({ "pointer": path, "beforePresent": before.is_some(), "before": before, "afterPresent": after.is_some(), "after": after })),
        }
    }
    let mut changes = Vec::new();
    visit(String::new(), Some(before), Some(after), &mut changes);
    changes
}

fn normalize_empty_legacy_cursors(metadata: &mut RecordingMeta) -> Result<()> {
    let RecordingMetaInner::Studio(studio) = &mut metadata.inner else {
        bail!("Current-writer fixture requires Studio metadata");
    };
    let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
        bail!("Current-writer fixture requires indexed Studio metadata");
    };
    match &inner.cursors {
        Cursors::Old(cursors) if cursors.is_empty() => inner.cursors = Cursors::default(),
        _ => bail!("Current-writer variant only accepts the canonical empty legacy cursor map"),
    }
    Ok(())
}

fn validate_current_writer_document(name: &str, before: &Value, after: &Value) -> Result<()> {
    let expected = match name {
        "recording-meta.json" => {
            ensure!(
                before.get("cursors") == Some(&json!({})),
                "Expected exactly the canonical empty legacy cursor map"
            );
            let mut expected = before.clone();
            expected
                .as_object_mut()
                .context("Metadata is not an object")?
                .remove("cursors")
                .context("Legacy cursor field disappeared")?;
            expected
        }
        "project-config.json" => before.clone(),
        _ => bail!("Unsupported current-writer document"),
    };
    ensure!(
        expected == *after,
        "Current writer would change unapproved {name} fields: {}",
        json!(changed_json_fields(before, after))
    );
    Ok(())
}

fn current_writer_snapshot(project: &Path, original: &FileManifest) -> Result<Value> {
    let mut metadata = RecordingMeta::load_for_project(project)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let configuration: ProjectConfiguration =
        serde_json::from_slice(&fs::read(project.join("project-config.json"))?)?;
    let before_metadata_semantics = serde_json::to_value(&metadata)?;
    let before_configuration_semantics = serde_json::to_value(&configuration)?;
    normalize_empty_legacy_cursors(&mut metadata)?;
    ensure!(
        serde_json::to_value(&metadata)? == before_metadata_semantics,
        "Empty cursor representation changed typed metadata semantics"
    );
    let names = ["recording-meta.json", "project-config.json"];
    let mut before_documents = BTreeMap::new();
    for name in names {
        let bytes = fs::read(project.join(name))?;
        ensure!(
            hash_file(&project.join(name))? == original[name],
            "Owned legacy document differs before normalization"
        );
        before_documents.insert(name, serde_json::from_slice::<Value>(&bytes)?);
    }
    for (name, bytes) in [
        ("recording-meta.json", serde_json::to_vec_pretty(&metadata)?),
        (
            "project-config.json",
            serde_json::to_vec_pretty(&configuration)?,
        ),
    ] {
        let planned: Value = serde_json::from_slice(&bytes)?;
        validate_current_writer_document(name, &before_documents[name], &planned)?;
    }
    metadata
        .save_for_project()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    configuration.write(project)?;
    let roundtrip_metadata = RecordingMeta::load_for_project(project)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let roundtrip_configuration: ProjectConfiguration =
        serde_json::from_slice(&fs::read(project.join("project-config.json"))?)?;
    ensure!(
        serde_json::to_value(&roundtrip_metadata)? == before_metadata_semantics,
        "Metadata writer roundtrip changed typed semantics"
    );
    ensure!(
        serde_json::to_value(&roundtrip_configuration)? == before_configuration_semantics,
        "Configuration writer roundtrip changed typed semantics"
    );
    let mut expected = original.clone();
    let mut documents = BTreeMap::new();
    for name in names {
        let after = hash_file(&project.join(name))?;
        let after_value: Value = serde_json::from_slice(&fs::read(project.join(name))?)?;
        validate_current_writer_document(name, &before_documents[name], &after_value)?;
        documents.insert(name, json!({ "before": original[name], "after": after, "changedFields": changed_json_fields(&before_documents[name], &after_value), "typedSemanticsUnchangedAfterWriterRoundtrip": true }));
        expected.insert(name.to_string(), after);
    }
    ensure!(
        manifest(project, false)? == expected,
        "Current writer changed media, sidecars or unexpected files"
    );
    Ok(
        json!({ "variant": "current-writer-empty-cursor-snapshot", "metadataWriter": "RecordingMeta::save_for_project", "configurationWriter": "ProjectConfiguration::write", "documents": documents, "allMediaAndSidecarBytesUnchanged": true }),
    )
}

fn preflight_current_writer(project: &Path) -> Result<Value> {
    let lock = super::RecoveryLock::acquire(project)?;
    let metadata = RecordingMeta::load_for_project(project)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let configuration: ProjectConfiguration =
        serde_json::from_slice(&fs::read(project.join("project-config.json"))?)?;
    let claim = CleanStoppedStudioClaim::for_test(metadata.clone(), configuration)
        .context("Current-writer snapshot receipt declined before finalization")?;
    let recording = RecoveryManager::analyze_incomplete(project, &metadata)
        .context("Current-writer snapshot has no recoverable source")?;
    let projection = super::preparing_projection::project(&recording, &claim)
        .map_err(anyhow::Error::msg)
        .context("Current-writer source projection declined before finalization")?;
    let segment_count = projection.segments.len();
    drop(projection);
    drop(claim);
    drop(lock);
    Ok(
        json!({ "receiptEligible": true, "actualProjectorEligible": true, "segments": segment_count, "preflightObjectsAndLockDroppedBeforeFinalization": true }),
    )
}

fn source_manifest_files(manifest: &Value) -> Result<BTreeMap<String, String>> {
    match &manifest["files"] {
        Value::Object(files) => files
            .iter()
            .map(|(path, hash)| {
                Ok((
                    path.clone(),
                    hash.as_str()
                        .context("Source hash is not a string")?
                        .to_string(),
                ))
            })
            .collect(),
        Value::Array(files) => files
            .iter()
            .map(|file| {
                Ok((
                    file["path"]
                        .as_str()
                        .context("Missing source path")?
                        .to_string(),
                    file["sha256"]
                        .as_str()
                        .context("Missing source SHA256")?
                        .to_string(),
                ))
            })
            .collect(),
        _ => bail!("Unsupported source manifest file map"),
    }
}

fn validate_legacy_source_identity(control: &Value, current: &Value) -> Result<Value> {
    let identity = &control["identity"];
    let path = PathBuf::from(
        identity["sourceManifest"]
            .as_str()
            .context("Legacy source manifest path missing")?,
    );
    let expected_hash = identity["sourceManifestSha256"]
        .as_str()
        .context("Legacy source manifest hash missing")?;
    ensure!(
        path.is_absolute() && hash_file(&path)?.sha256 == expected_hash,
        "Legacy source manifest file identity mismatch"
    );
    let legacy_manifest: Value = serde_json::from_slice(&fs::read(&path)?)?;
    ensure!(
        legacy_manifest == identity["sourceManifestValue"],
        "Legacy embedded source manifest differs from retained manifest"
    );
    let legacy_files = source_manifest_files(&legacy_manifest)?;
    let current_files = source_manifest_files(current)?;
    ensure!(
        legacy_files.keys().eq(current_files.keys()),
        "Legacy/current source manifests cover different files"
    );
    let probe = "crates/recording/src/recovery/preparing_canonical_probe.rs";
    ensure!(
        legacy_files.get(probe).map(String::as_str)
            == Some("c633490f13fceaf76007ac3daa4c2692606af449ca6d2fc987b5507c25b7af6c"),
        "Legacy control was not produced by the frozen v1 probe"
    );
    for (path, hash) in &legacy_files {
        ensure!(
            path == probe || current_files.get(path) == Some(hash),
            "Runtime source differs from legacy control: {path}"
        );
    }
    Ok(
        json!({ "manifestPath": path, "manifestSha256": expected_hash, "sourceFilesCompared": legacy_files.len(), "onlyPermittedSourceDifference": probe, "runtimeSourceIdentityMatched": true }),
    )
}

fn public_output(project: &Path) -> Result<Value> {
    let mut media = manifest(project, true)?;
    let mut documents = BTreeMap::new();
    for name in ["recording-meta.json", "project-config.json"] {
        let raw = media.remove(name).context("Missing published document")?;
        let value = ordered_json(serde_json::from_slice(&fs::read(project.join(name))?)?);
        let normalized = hex::encode(Sha256::digest(serde_json::to_vec(&value)?));
        documents.insert(
            name,
            json!({ "raw": raw, "normalizedSha256": normalized, "value": value }),
        );
    }
    Ok(json!({ "media": media, "documents": documents }))
}

fn compare_outputs(before: &Value, after: &Value) -> Result<()> {
    ensure!(
        before["media"] == after["media"],
        "Published media bytes or file set differ"
    );
    for name in ["recording-meta.json", "project-config.json"] {
        ensure!(
            before["documents"][name]["value"] == after["documents"][name]["value"],
            "Published {name} semantics differ"
        );
    }
    Ok(())
}

fn retained_segments(project: &Path, canonical: &FileManifest) -> Result<Value> {
    let mut backups = Vec::new();
    for entry in fs::read_dir(project)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".recovery-")
        {
            let path = entry.path().join("original-segments");
            if path.try_exists()? {
                backups.push(path);
            }
        }
    }
    ensure!(
        backups.len() == 1,
        "Expected one retained original-segments backup"
    );
    let expected: FileManifest = canonical
        .iter()
        .filter_map(|(name, record)| {
            name.strip_prefix("content/segments/")
                .map(|name| (name.to_string(), record.clone()))
        })
        .collect();
    let actual = manifest(&backups[0], false)?;
    ensure!(actual == expected, "Retained original media changed");
    Ok(json!({ "path": backups[0], "files": actual, "allOriginalSegmentBytesMatch": true }))
}

struct OwnedThread<T>(Option<JoinHandle<T>>);

impl<T> OwnedThread<T> {
    fn join(mut self) -> Result<T> {
        self.0
            .take()
            .context("Worker already joined")?
            .join()
            .map_err(|_| anyhow::anyhow!("Native worker panicked"))
    }
}

impl<T> Drop for OwnedThread<T> {
    fn drop(&mut self) {
        if let Some(worker) = self.0.take() {
            let _ = worker.join();
        }
    }
}

struct AudioWorker {
    cancelled: Arc<AtomicBool>,
    worker: Option<OwnedThread<Result<Value>>>,
}

impl AudioWorker {
    fn start(
        source: RelocatableSource,
        relative: PathBuf,
        canonical: PathBuf,
        started: Instant,
    ) -> Result<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let worker = std::thread::Builder::new().name("canonical-preparing-audio".into()).spawn(move || {
            let mut reference = AudioStream::open(&canonical, Arc::new(AtomicBool::new(false)))?;
            let mut managed = match AudioStream::open_relocatable(&source, [relative.as_path()], stop.clone()) {
                Ok(managed) => managed,
                Err(error) if error.is_cancelled() && stop.load(Ordering::Acquire) => {
                    drop(reference);
                    drop(source);
                    return Ok(json!({ "path": relative, "comparedFrames": 0, "allComparedPcmBitsMatch": true, "firstChunkObservedMs": null, "completeEofCompared": false, "cancelledAfterEnded": true, "openCancelledAfterEnded": true, "resourcesDroppedMs": started.elapsed().as_secs_f64() * 1000.0 }));
                }
                Err(error) => return Err(error.into()),
            };
            let mut frames = 0_u64;
            let mut first_chunk_ms = None;
            let mut eof = false;
            let mut cancelled = false;
            loop {
                if stop.load(Ordering::Acquire) {
                    cancelled = true;
                    break;
                }
                let actual = match managed.read_chunk(12_000) {
                    Ok(actual) => actual,
                    Err(error) if error.is_cancelled() && stop.load(Ordering::Acquire) => {
                        cancelled = true;
                        break;
                    }
                    Err(error) => return Err(error.into()),
                };
                match (actual, reference.read_chunk(12_000)?) {
                    (ChunkRead::Chunk(actual), ChunkRead::Chunk(expected)) => {
                        first_chunk_ms.get_or_insert_with(|| started.elapsed().as_secs_f64() * 1000.0);
                        ensure!(actual.source_start_sample == frames && expected.source_start_sample == frames, "Non-contiguous audio prefix");
                        ensure!(actual.channels == expected.channels && actual.samples.len() == expected.samples.len(), "Audio shape differs");
                        ensure!(actual.samples.iter().zip(&expected.samples).all(|(actual, expected)| actual.to_bits() == expected.to_bits()), "Audio PCM bits differ at chunk starting {frames}");
                        frames += (actual.samples.len() / usize::from(actual.channels)) as u64;
                    }
                    (ChunkRead::Eof { next_sample: actual }, ChunkRead::Eof { next_sample: expected }) => {
                        ensure!(actual == expected && actual == frames, "Audio EOF differs");
                        eof = true;
                        break;
                    }
                    _ => bail!("Audio chunk/EOF state differs"),
                }
            }
            drop(managed);
            drop(reference);
            drop(source);
            Ok(json!({ "path": relative, "comparedFrames": frames, "allComparedPcmBitsMatch": true, "firstChunkObservedMs": first_chunk_ms, "completeEofCompared": eof, "cancelledAfterEnded": cancelled, "openCancelledAfterEnded": false, "resourcesDroppedMs": started.elapsed().as_secs_f64() * 1000.0 }))
        })?;
        Ok(Self {
            cancelled,
            worker: Some(OwnedThread(Some(worker))),
        })
    }

    async fn stop_and_join(mut self, started: Instant) -> Result<Value> {
        self.cancelled.store(true, Ordering::Release);
        let worker = self.worker.take().context("Audio worker already joined")?;
        let mut value = tokio::task::spawn_blocking(move || worker.join()).await???;
        value["nativeJoinObservedMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        Ok(value)
    }
}

impl Drop for AudioWorker {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        drop(self.worker.take());
    }
}

async fn ended(mut observer: PreparingStudioObserver) {
    loop {
        if matches!(observer.latest(), PreparingStudioState::Ended) {
            return;
        }
        observer.changed().await;
    }
}

fn frame_record(frame: &DecodedFrame) -> Result<Value> {
    let mut hash = Sha256::new();
    let mut bytes = 0_usize;
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let mut plane = |data: &[u8], stride: usize, row_bytes: usize, rows: usize| -> Result<()> {
        ensure!(
            stride >= row_bytes && data.len() >= stride * rows,
            "Invalid decoded plane"
        );
        for row in data.chunks(stride).take(rows) {
            hash.update(&row[..row_bytes]);
            bytes += row_bytes;
        }
        Ok(())
    };
    match frame.format() {
        PixelFormat::Rgba => plane(frame.data(), width * 4, width * 4, height)?,
        PixelFormat::Nv12 => {
            plane(
                frame.y_plane().context("Missing luma")?,
                frame.y_stride() as usize,
                width,
                height,
            )?;
            plane(
                frame.uv_plane().context("Missing chroma")?,
                frame.uv_stride() as usize,
                width,
                height / 2,
            )?;
        }
        PixelFormat::Yuv420p => {
            plane(
                frame.y_plane().context("Missing luma")?,
                frame.y_stride() as usize,
                width,
                height,
            )?;
            plane(
                frame.u_plane().context("Missing U plane")?,
                frame.uv_stride() as usize,
                width / 2,
                height / 2,
            )?;
            plane(
                frame.v_plane().context("Missing V plane")?,
                frame.uv_stride() as usize,
                width / 2,
                height / 2,
            )?;
        }
    }
    ensure!(bytes > 0, "Empty software-decoded image");
    Ok(
        json!({ "width": width, "height": height, "format": format!("{:?}", frame.format()), "pixelBytes": bytes, "sha256": hex::encode(hash.finalize()) }),
    )
}

fn single_segment(metadata: &RecordingMeta) -> Result<&MultipleSegment> {
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = metadata.studio_meta() else {
        bail!("Canonical fixture is not a multiple-segment Studio recording");
    };
    ensure!(
        inner.segments.len() == 1,
        "Canonical fixture must have one segment"
    );
    Ok(&inner.segments[0])
}

fn display_offset(segment: &MultipleSegment) -> f64 {
    segment
        .latest_start_time()
        .zip(segment.display.start_time)
        .map(|(latest, display)| latest - display)
        .unwrap_or(0.0)
}

async fn finalized_video_reference(
    project: &Path,
    stopped: &RecordingMeta,
    times: &[f32],
) -> Result<Value> {
    let finalized = RecordingMeta::load_for_project(project)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let stopped_segment = single_segment(stopped)?;
    let finalized_segment = single_segment(&finalized)?;
    let stopped_offset = display_offset(stopped_segment);
    let finalized_offset = display_offset(finalized_segment);
    ensure!(
        stopped_offset.to_bits() == finalized_offset.to_bits(),
        "Published display offset differs from stopped metadata"
    );
    ensure!(
        stopped_segment.display.fps == finalized_segment.display.fps,
        "Published display FPS differs from stopped metadata"
    );
    let root = project.join("content/segments");
    let display_path = finalized_segment.display.path.to_path(project);
    ensure!(
        display_path
            .extension()
            .is_some_and(|extension| extension == "mp4"),
        "Reference is not a finalized MP4 file"
    );
    let relative = display_path.strip_prefix(&root)?.to_path_buf();
    let source = RelocatableSource::new(root)?;
    let mut decoder = spawn_managed_decoder(
        "canonical-finalized-file-reference",
        source.clone(),
        [relative.as_path()],
        finalized_segment.display.fps,
        finalized_offset,
        false,
    )?;
    let work = async {
        let status = decoder.wait_ready().await?;
        let mut frames = Vec::new();
        for &time in times {
            let frame = decoder.get_frame_initial(time).await?;
            frames.push(json!({ "requestedTime": time, "pixels": frame_record(&frame)? }));
        }
        Ok::<_, anyhow::Error>(json!({ "method": "ordinary-finalized-file/software/shared-managed-worker-loop", "relativeFile": relative, "fps": finalized_segment.display.fps, "stoppedOffset": stopped_offset, "finalizedOffset": finalized_offset, "decoderType": format!("{:?}", status.decoder_type), "frames": frames }))
    }.await;
    let exit = decoder.stop_and_wait().await;
    drop(decoder);
    drop(source);
    let mut result = work?;
    result["workerExit"] = json!(format!("{:?}", exit.terminal));
    result["workerJoinedAndFileHandlesDroppedBeforeBaselineDeletion"] = json!(true);
    Ok(result)
}

async fn exercise_video(
    decoder: &mut ManagedVideoDecoder,
    observer: &PreparingStudioObserver,
    sources: &PreparingStudioSources,
    times: &[f32],
    reference: &Value,
    started: Instant,
) -> Result<Value> {
    let ready = tokio::select! {
        result = decoder.wait_ready() => Some(result),
        () = ended(observer.clone()) => None,
    };
    let Some(ready) = ready else {
        return Ok(json!({ "endedBeforeReady": true, "frames": [] }));
    };
    let status = ready?;
    let mut frames = Vec::new();
    for (index, &time) in times.iter().enumerate() {
        if sources.live().is_none() {
            break;
        }
        let result = tokio::select! {
            result = decoder.get_frame_initial(time) => Some(result),
            () = ended(observer.clone()) => None,
        };
        let Some(result) = result else { break };
        let observed_ms = started.elapsed().as_secs_f64() * 1000.0;
        if sources.live().is_none() {
            break;
        }
        let frame = result?;
        let pixels = frame_record(&frame)?;
        let expected = &reference["frames"][index];
        ensure!(
            expected["requestedTime"] == json!(time),
            "Finalized reference request differs at index {index}"
        );
        ensure!(
            pixels == expected["pixels"],
            "Preparing/finalized pixels differ at {time}: preparing={pixels}, finalized={}",
            expected["pixels"]
        );
        frames.push(json!({ "requestedTime": time, "decodedFrameObservedMs": observed_ms, "pixels": pixels, "matchesOrdinaryFinalizedSoftwareFrame": true }));
    }
    Ok(
        json!({ "decoderType": format!("{:?}", status.decoder_type), "frames": frames, "allCommonSeeksObserved": frames.len() == times.len(), "endedDuringRequests": sources.live().is_none() }),
    )
}

async fn observe_preparing(
    mut observer: PreparingStudioObserver,
    canonical: &Path,
    times: &[f32],
    reference: &Value,
    started: Instant,
) -> Result<Value> {
    let sources = loop {
        match observer.latest() {
            PreparingStudioState::Available(sources) => break sources,
            PreparingStudioState::Ended => {
                return Ok(
                    json!({ "endedBeforeAvailabilityObserved": true, "availabilityObservedMs": null }),
                );
            }
            PreparingStudioState::Unavailable(reason) => {
                bail!("Canonical preparing source declined: {reason}")
            }
            PreparingStudioState::Waiting => {
                observer.changed().await;
            }
        }
    };
    let available_ms = started.elapsed().as_secs_f64() * 1000.0;
    ensure!(
        sources.identity().same_job(observer.identity()),
        "Available source belongs to a different finalizer job"
    );
    let job_identity = json!({ "projectPath": sources.identity().project_path(), "generation": sources.identity().generation(), "jobId": sources.identity().job_id().to_string() });
    let Some(live) = sources.live() else {
        return Ok(json!({ "availabilityObservedMs": available_ms, "endedBeforeLiveView": true }));
    };
    let Some(segments) = live.segments() else {
        return Ok(json!({ "availabilityObservedMs": available_ms, "endedBeforeSegments": true }));
    };
    ensure!(
        segments.len() == 1 && segments[0].index() == 0,
        "Canonical probe expects its original single segment"
    );
    let metadata = segments[0].metadata().clone();
    let mut audios = Vec::new();
    for (track, declared) in [
        (PreparingAudioTrack::Mic, metadata.mic.is_some()),
        (
            PreparingAudioTrack::SystemAudio,
            metadata.system_audio.is_some(),
        ),
    ] {
        if !declared {
            continue;
        }
        let Some(lease) = live.audio(0, track) else {
            break;
        };
        let Some((source, path)) = lease.input() else {
            break;
        };
        audios.push(AudioWorker::start(
            source.clone(),
            path.to_path_buf(),
            canonical.join("content/segments").join(path),
            started,
        )?);
    }
    let video_work = async {
        let Some(lease) = live.video(0, PreparingVideoTrack::Display) else {
            return Ok(json!({ "endedBeforeVideoLease": true }));
        };
        let Some((source, paths)) = lease.input() else {
            return Ok(json!({ "endedBeforeVideoInput": true }));
        };
        let offset = display_offset(&metadata);
        ensure!(reference["stoppedOffset"] == json!(offset), "Preparing display offset differs from stopped reference");
        ensure!(reference["fps"] == json!(metadata.display.fps), "Preparing display FPS differs from reference");
        let mut decoder = spawn_managed_decoder("canonical-preparing-display", source.clone(), paths.iter().map(PathBuf::as_path), metadata.display.fps, offset, false)?;
        let work = exercise_video(&mut decoder, &observer, &sources, times, reference, started).await;
        let exit = decoder.stop_and_wait().await;
        let joined_ms = started.elapsed().as_secs_f64() * 1000.0;
        drop(decoder);
        work.map(|video| json!({ "video": video, "videoWorkerJoinedMs": joined_ms, "videoExit": format!("{:?}", exit.terminal), "offset": offset }))
    }.await;
    ended(observer.clone()).await;
    let ended_ms = started.elapsed().as_secs_f64() * 1000.0;
    for worker in &audios {
        worker.cancelled.store(true, Ordering::Release);
    }
    let mut audio_results = Vec::new();
    let mut audio_error = None;
    for worker in audios {
        match worker.stop_and_join(started).await {
            Ok(result) => audio_results.push(result),
            Err(error) => {
                audio_error.get_or_insert(error);
            }
        }
    }
    ensure!(
        sources.live().is_none(),
        "Ended source still authorizes new access"
    );
    drop(sources);
    let source_references_dropped_ms = started.elapsed().as_secs_f64() * 1000.0;
    let last_joined_ms = video_work
        .as_ref()
        .ok()
        .and_then(|value| value["videoWorkerJoinedMs"].as_f64())
        .into_iter()
        .chain(
            audio_results
                .iter()
                .filter_map(|value| value["nativeJoinObservedMs"].as_f64()),
        )
        .reduce(f64::max);
    let video = video_work?;
    if let Some(error) = audio_error {
        return Err(error);
    }
    Ok(
        json!({ "jobIdentity": job_identity, "availabilityObservedMs": available_ms, "endedObservedMs": ended_ms, "lastPreparingWorkerJoinObservedMs": last_joined_ms, "sourceReferencesDroppedMs": source_references_dropped_ms, "video": video, "audio": audio_results, "allPreparingSourceReferencesDropped": true }),
    )
}

struct ProbeConfig {
    fixture: PathBuf,
    fixture_name: String,
    manifest_path: PathBuf,
    work_root: PathBuf,
    output: PathBuf,
    source_manifest: PathBuf,
    source_manifest_sha256: String,
    binary_sha256: String,
    current_writer_snapshot: bool,
    legacy_control: Option<(PathBuf, String)>,
}

impl ProbeConfig {
    fn environment() -> Result<Self> {
        let required = |name| {
            std::env::var(name).with_context(|| format!("Explicit manual probe requires {name}"))
        };
        let config = Self {
            fixture: PathBuf::from(required("CAP_PREPARING_FIXTURE")?),
            fixture_name: required("CAP_PREPARING_FIXTURE_NAME")?,
            manifest_path: PathBuf::from(required("CAP_PREPARING_FIXTURE_MANIFEST")?),
            work_root: PathBuf::from(required("CAP_PREPARING_WORK_ROOT")?),
            output: PathBuf::from(required("CAP_PREPARING_EVIDENCE_OUTPUT")?),
            source_manifest: PathBuf::from(required("CAP_PREPARING_SOURCE_MANIFEST")?),
            source_manifest_sha256: required("CAP_PREPARING_SOURCE_MANIFEST_SHA256")?,
            binary_sha256: required("CAP_PREPARING_BINARY_SHA256")?,
            current_writer_snapshot: std::env::var("CAP_PREPARING_CURRENT_WRITER_SNAPSHOT")
                .as_deref()
                == Ok("1"),
            legacy_control: match (
                std::env::var("CAP_PREPARING_LEGACY_CONTROL"),
                std::env::var("CAP_PREPARING_LEGACY_CONTROL_SHA256"),
            ) {
                (Ok(path), Ok(hash)) => Some((PathBuf::from(path), hash)),
                (Err(std::env::VarError::NotPresent), Err(std::env::VarError::NotPresent)) => None,
                _ => bail!("Legacy control path and SHA256 must be supplied together"),
            },
        };
        ensure!(
            !config.current_writer_snapshot || config.fixture_name == "replay-2h.cap",
            "Current-writer variant is restricted to replay-2h.cap"
        );
        ensure!(
            !config.current_writer_snapshot || config.legacy_control.is_some(),
            "Current-writer variant requires the separate hash-verified legacy control"
        );
        ensure!(
            config.fixture.is_absolute()
                && config.work_root.is_absolute()
                && config.output.is_absolute()
                && config.manifest_path.is_absolute()
                && config.source_manifest.is_absolute(),
            "Probe paths must be absolute"
        );
        let canonical = config.fixture.canonicalize()?;
        ensure!(
            !config.work_root.canonicalize()?.starts_with(&canonical),
            "Work root must be outside the canonical fixture"
        );
        ensure!(
            !config
                .output
                .parent()
                .context("Missing evidence parent")?
                .canonicalize()?
                .starts_with(&canonical),
            "Evidence output must be outside the canonical fixture"
        );
        Ok(config)
    }
}

async fn run_probe(config: &ProbeConfig, evidence: &mut Value) -> Result<()> {
    let times: &[f32] = match config.fixture_name.as_str() {
        "native-screen-15.cap" => &[0.0, 7.0, 13.5, 1.0],
        "native-mic-60.cap" => &[0.0, 30.0, 58.0, 1.0],
        "replay-2h.cap" => {
            ensure!(
                std::env::var("CAP_PREPARING_ALLOW_TWO_HOURS").as_deref() == Ok("1"),
                "Two-hour copies require explicit CAP_PREPARING_ALLOW_TWO_HOURS=1"
            );
            &[0.0, 3600.0, 7194.5, 1.0]
        }
        _ => bail!("Unknown canonical fixture name"),
    };
    ensure!(
        config.fixture.is_absolute()
            && config.work_root.is_absolute()
            && config.output.is_absolute(),
        "Probe paths must be absolute"
    );
    let executable = std::env::current_exe()?;
    ensure!(
        hash_file(&executable)?.sha256 == config.binary_sha256,
        "Running binary differs from external manifest"
    );
    ensure!(
        hash_file(&config.source_manifest)?.sha256 == config.source_manifest_sha256,
        "Source manifest differs from external hash"
    );
    evidence["identity"] = json!({ "binary": executable, "binarySha256": config.binary_sha256, "sourceManifest": config.source_manifest, "sourceManifestSha256": config.source_manifest_sha256, "sourceManifestValue": serde_json::from_slice::<Value>(&fs::read(&config.source_manifest)?)? });
    ffmpeg::init()?;
    let fixture_manifest: Value = serde_json::from_slice(&fs::read(&config.manifest_path)?)?;
    let expected: FileManifest = serde_json::from_value(
        fixture_manifest["fixtures"][&config.fixture_name]["files"].clone(),
    )?;
    let original = manifest(&config.fixture, false)?;
    ensure!(
        original == expected,
        "Canonical inputs differ from shared fixture manifest"
    );
    evidence["canonicalBefore"] = serde_json::to_value(&original)?;
    if config.current_writer_snapshot {
        let metadata = RecordingMeta::load_for_project(&config.fixture)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let configuration: ProjectConfiguration =
            serde_json::from_slice(&fs::read(config.fixture.join("project-config.json"))?)?;
        let declined = CleanStoppedStudio::for_test(metadata, configuration).is_none();
        evidence["originalLegacyReceiptDeclined"] = json!(declined);
        ensure!(
            declined,
            "Expected the immutable legacy fixture receipt to decline"
        );
        let (path, sha256) = config
            .legacy_control
            .as_ref()
            .context("Missing legacy control")?;
        ensure!(
            path.is_absolute() && hash_file(path)?.sha256 == *sha256,
            "Legacy control evidence identity mismatch"
        );
        let control: Value = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            control["fixture"] == "replay-2h.cap"
                && control["passed"] == false
                && control["error"] == "Canonical stopped snapshot declined",
            "Legacy control must record the original receipt decline after ordinary finalization"
        );
        ensure!(
            control["canonicalBefore"] == serde_json::to_value(&original)?
                && control["canonicalFinalAuditUnchanged"] == true
                && control["canonicalFinalAudit"] == serde_json::to_value(&original)?,
            "Legacy control used different or changed canonical input bytes"
        );
        ensure!(
            control["ordinaryFinalizationMs"].is_number()
                && control["ordinaryOutput"].is_object()
                && control["ordinaryFinalizedSoftwareVideoReference"].is_object(),
            "Legacy control lacks ordinary output/reference evidence"
        );
        let source_identity = validate_legacy_source_identity(
            &control,
            &evidence["identity"]["sourceManifestValue"],
        )?;
        evidence["fixtureManifestIdentity"] = json!({ "path": config.manifest_path, "sha256": hash_file(&config.manifest_path)?.sha256, "legacyCanonicalFilesMatchCurrentSharedManifest": true });
        evidence["legacySourceIdentity"] = source_identity;
        evidence["legacyOrdinaryControl"] = json!({ "path": path, "sha256": sha256, "identity": control["identity"], "ordinaryFinalizationMs": control["ordinaryFinalizationMs"], "ordinaryOutput": control["ordinaryOutput"], "ordinaryFinalizedSoftwareVideoReference": control["ordinaryFinalizedSoftwareVideoReference"], "canonicalFinalAuditUnchanged": true, "originalReceiptDeclined": true, "reusedAsCurrentWriterComparison": false });
        evidence["snapshotVariant"] = json!("current-writer-empty-cursor-snapshot");
    }
    let owned = tempfile::Builder::new()
        .prefix("cap-preparing-canonical-")
        .tempdir_in(&config.work_root)?
        .keep();
    evidence["ownedRunDirectory"] = json!(owned);
    let ordinary = owned.join("ordinary.cap");
    copy_fixture(&config.fixture, &ordinary, &original)?;
    if config.current_writer_snapshot {
        evidence["ordinaryCurrentWriterSnapshot"] = current_writer_snapshot(&ordinary, &original)?;
        evidence["ordinaryCurrentWriterPreflight"] = preflight_current_writer(&ordinary)?;
    }
    let stopped_metadata = RecordingMeta::load_for_project(&ordinary)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let baseline_started = Instant::now();
    let baseline_path = ordinary.clone();
    let baseline = tokio::task::spawn_blocking(move || {
        RecoveryManager::remux_if_needed(&baseline_path).map_err(|error| error.to_string())
    })
    .await?
    .map_err(anyhow::Error::msg)?;
    let baseline_ms = baseline_started.elapsed().as_secs_f64() * 1000.0;
    ensure!(baseline, "Ordinary canonical finalizer did not run");
    let baseline_output = public_output(&ordinary)?;
    evidence["ordinaryFinalizationMs"] = json!(baseline_ms);
    evidence["ordinaryOutput"] = baseline_output.clone();
    evidence["ordinaryRetainedSources"] = retained_segments(&ordinary, &original)?;
    let reference = finalized_video_reference(&ordinary, &stopped_metadata, times).await?;
    evidence["ordinaryFinalizedSoftwareVideoReference"] = reference.clone();
    fs::remove_dir_all(&ordinary)?;
    evidence["ordinaryOwnedCopyRemovedAfterVerification"] = json!(true);
    let preparing = owned.join("preparing.cap");
    copy_fixture(&config.fixture, &preparing, &original)?;
    if config.current_writer_snapshot {
        let snapshot = current_writer_snapshot(&preparing, &original)?;
        ensure!(
            snapshot == evidence["ordinaryCurrentWriterSnapshot"],
            "Owned baseline/preparing writer snapshots differ"
        );
        evidence["preparingCurrentWriterSnapshot"] = snapshot;
        evidence["preparingCurrentWriterPreflight"] = preflight_current_writer(&preparing)?;
    }
    let metadata = RecordingMeta::load_for_project(&preparing)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let configuration: ProjectConfiguration =
        serde_json::from_slice(&fs::read(preparing.join("project-config.json"))?)?;
    let studio = metadata
        .studio_meta()
        .context("Expected Studio fixture")?
        .clone();
    let receipt = CleanStoppedStudio::for_test(metadata, configuration)
        .context("Canonical stopped snapshot declined")?;
    let completed = CompletedRecording {
        project_path: preparing.clone(),
        meta: studio,
        cursor_data: Default::default(),
        clean_stopped: Some(receipt),
    };
    let (job, observer) =
        PreparingStudioJob::claim(&completed, 1).context("Fresh receipt claim failed")?;
    ensure!(
        PreparingStudioJob::claim(&completed, 2).is_none(),
        "Receipt reused across generations"
    );
    let started = Instant::now();
    let finalizer = OwnedThread(Some(
        std::thread::Builder::new()
            .name("canonical-retained-finalizer".into())
            .spawn(move || {
                let result = RecoveryManager::remux_stopped_with_preparing(&completed, job)
                    .map_err(|error| error.to_string());
                (result, started.elapsed().as_secs_f64() * 1000.0)
            })?,
    ));
    let preview = observe_preparing(
        observer.clone(),
        &config.fixture,
        times,
        &reference,
        started,
    )
    .await;
    let (finalized, finalization_ms) =
        tokio::task::spawn_blocking(move || finalizer.join()).await??;
    evidence["preparingFinalizationMs"] = json!(finalization_ms);
    evidence["finalizerThreadJoinedMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    match preview {
        Ok(preview) => evidence["preparing"] = preview,
        Err(error) => evidence["preparingError"] = json!(format!("{error:#}")),
    }
    ensure!(
        matches!(observer.latest(), PreparingStudioState::Ended),
        "Finalizer did not revoke observer"
    );
    ensure!(
        finalized.map_err(anyhow::Error::msg)?,
        "Preparing finalizer did not run"
    );
    let candidate_output = public_output(&preparing)?;
    evidence["preparingOutput"] = candidate_output.clone();
    evidence["preparingRetainedSources"] = retained_segments(&preparing, &original)?;
    compare_outputs(&baseline_output, &candidate_output)?;
    evidence["publishedMediaAndNormalizedDocumentsMatch"] = json!(true);
    let lock = super::RecoveryLock::acquire(&preparing)?;
    drop(lock);
    evidence["ordinaryRecoveryLockAvailableAfterWorkerTeardown"] = json!(true);
    let after = manifest(&config.fixture, false)?;
    evidence["canonicalAfter"] = serde_json::to_value(&after)?;
    ensure!(after == original, "Canonical original files changed");
    ensure!(
        evidence.get("preparingError").is_none(),
        "Preparing worker error; finalization/source evidence retained"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual canonical .cap integration probe; requires explicit fixture/work/evidence/source identity environment"]
async fn canonical_preparing_finalization_probe() {
    let config = ProbeConfig::environment().expect("Missing manual probe environment");
    assert!(
        !config.output.exists(),
        "Evidence output must be a new file"
    );
    let mut evidence = json!({ "fixture": config.fixture_name, "method": "Functional integration run, ordinary-first then preparing. Copy/hash/receipt setup excluded from finalization timers. Order/cache/CPU competition are uncontrolled; times are not speedup, Stop/editor, audible playback, cold-cache or p95 evidence. Audio comparison is contiguous from sample zero until EOF or Ended cancellation, reported explicitly. Video hashes cover visible software-decoded planes. Source/binary identity is supplied and hash-checked before running. Only per-run owned baseline copies are deleted; candidate outputs and originals are retained." });
    let mut result = run_probe(&config, &mut evidence).await;
    match manifest(&config.fixture, false) {
        Ok(after) => {
            let value = serde_json::to_value(after).expect("Serialize canonical audit");
            if let Some(before) = evidence.get("canonicalBefore") {
                let unchanged = *before == value;
                evidence["canonicalFinalAuditUnchanged"] = json!(unchanged);
                if !unchanged && result.is_ok() {
                    result = Err(anyhow::anyhow!(
                        "Canonical originals changed at final audit"
                    ));
                }
            }
            evidence["canonicalFinalAudit"] = value;
        }
        Err(error) => {
            evidence["canonicalFinalAuditError"] = json!(format!("{error:#}"));
            if result.is_ok() {
                result = Err(error);
            }
        }
    }
    evidence["passed"] = json!(result.is_ok());
    if let Err(error) = &result {
        evidence["error"] = json!(format!("{error:#}"));
    }
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&config.output)
        .expect("Create new evidence output");
    serde_json::to_writer_pretty(output, &evidence).expect("Write canonical probe evidence");
    assert!(result.is_ok(), "Canonical probe failed: {result:?}");
}

#[cfg(test)]
mod current_writer_snapshot_tests {
    use super::*;

    fn legacy_metadata() -> Value {
        json!({ "platform": "MacOS", "pretty_name": "Writer snapshot test", "sharing": null, "segments": [{ "display": { "path": "content/segments/segment-0/display", "fps": 30, "start_time": 0.0 } }], "cursors": {}, "status": { "status": "NeedsRemux" } })
    }

    fn fixture(metadata: Value, configuration: Value) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("recording-meta.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.path().join("project-config.json"),
            serde_json::to_vec(&configuration).unwrap(),
        )
        .unwrap();
        fs::create_dir(directory.path().join("content")).unwrap();
        fs::write(
            directory.path().join("content/media-sentinel"),
            b"immutable sample bytes",
        )
        .unwrap();
        directory
    }

    fn configuration() -> Value {
        serde_json::from_slice(
            &serde_json::to_vec_pretty(&ProjectConfiguration::default()).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn empty_legacy_cursor_writer_roundtrip_preserves_semantics_and_media() {
        let directory = fixture(legacy_metadata(), configuration());
        let before = manifest(directory.path(), false).unwrap();
        let report = current_writer_snapshot(directory.path(), &before).unwrap();
        assert_eq!(report["allMediaAndSidecarBytesUnchanged"], true);
        assert_eq!(
            report["documents"]["recording-meta.json"]["changedFields"],
            json!([{ "pointer": "/cursors", "beforePresent": true, "before": {}, "afterPresent": false, "after": null }])
        );
        assert_eq!(
            report["documents"]["project-config.json"]["changedFields"],
            json!([])
        );
        let metadata = RecordingMeta::load_for_project(directory.path()).unwrap();
        let configuration: ProjectConfiguration = serde_json::from_slice(
            &fs::read(directory.path().join("project-config.json")).unwrap(),
        )
        .unwrap();
        assert!(CleanStoppedStudio::for_test(metadata, configuration).is_some());
    }

    #[test]
    fn nonempty_legacy_cursor_map_is_rejected_without_writes() {
        let mut metadata = legacy_metadata();
        metadata["cursors"] = json!({ "cursor": "content/cursor.png" });
        let directory = fixture(metadata, configuration());
        let before = manifest(directory.path(), false).unwrap();
        assert!(current_writer_snapshot(directory.path(), &before).is_err());
        assert_eq!(manifest(directory.path(), false).unwrap(), before);
    }

    #[test]
    fn unknown_metadata_fields_are_rejected_without_writes() {
        let mut metadata = legacy_metadata();
        metadata["unrecognizedField"] = json!(42);
        let directory = fixture(metadata, configuration());
        let before = manifest(directory.path(), false).unwrap();
        assert!(current_writer_snapshot(directory.path(), &before).is_err());
        assert_eq!(manifest(directory.path(), false).unwrap(), before);
    }

    #[test]
    fn unknown_configuration_fields_are_rejected_without_writes() {
        let mut configuration = configuration();
        configuration["unrecognizedField"] = json!({ "future": true });
        let directory = fixture(legacy_metadata(), configuration);
        let before = manifest(directory.path(), false).unwrap();
        assert!(current_writer_snapshot(directory.path(), &before).is_err());
        assert_eq!(manifest(directory.path(), false).unwrap(), before);
    }
}
