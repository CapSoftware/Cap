use std::{
    collections::{HashMap, HashSet},
    fs::{File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use cap_project::{
    AudioMeta, CursorMeta, Cursors, MultipleSegment, ProjectConfiguration, StudioRecordingMeta,
    StudioRecordingStatus, VideoMeta,
};

use super::{IncompleteRecording, RecoveryManager, reject_recovery_link};
use crate::studio_recording::CleanStoppedStudioClaim;

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_INIT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CURSOR_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CURSOR_IMAGES_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SOURCE_ENTRIES: usize = 262_144;
const MAX_SOURCE_PATH_BYTES: usize = 64 * 1024 * 1024;

pub(super) struct PreparingProjection {
    pub(super) segments: Vec<PreparingStudioSegment>,
    pub(super) configuration_bytes: Vec<u8>,
}

pub struct PreparingStudioSegment {
    index: u32,
    metadata: MultipleSegment,
    display: PreparingVideoInput,
    camera: Option<PreparingVideoInput>,
    mic: Option<PreparingAudioInput>,
    system_audio: Option<PreparingAudioInput>,
    cursor_path: Option<PathBuf>,
    keyboard_path: Option<PathBuf>,
    cursor_images: Arc<[PreparingCursorImage]>,
}

impl PreparingStudioSegment {
    pub fn index(&self) -> u32 {
        self.index
    }

    pub fn metadata(&self) -> &MultipleSegment {
        &self.metadata
    }

    pub fn display(&self) -> &PreparingVideoInput {
        &self.display
    }

    pub fn camera(&self) -> Option<&PreparingVideoInput> {
        self.camera.as_ref()
    }

    pub fn mic(&self) -> Option<&PreparingAudioInput> {
        self.mic.as_ref()
    }

    pub fn system_audio(&self) -> Option<&PreparingAudioInput> {
        self.system_audio.as_ref()
    }

    pub fn cursor_path(&self) -> Option<&Path> {
        self.cursor_path.as_deref()
    }

    pub fn keyboard_path(&self) -> Option<&Path> {
        self.keyboard_path.as_deref()
    }

    pub fn cursor_images(&self) -> &[PreparingCursorImage] {
        &self.cursor_images
    }
}

pub struct PreparingVideoInput {
    metadata: VideoMeta,
    paths: Vec<PathBuf>,
}

impl PreparingVideoInput {
    pub fn metadata(&self) -> &VideoMeta {
        &self.metadata
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }
}

pub struct PreparingAudioInput {
    metadata: AudioMeta,
    path: PathBuf,
}

impl PreparingAudioInput {
    pub fn metadata(&self) -> &AudioMeta {
        &self.metadata
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub struct PreparingCursorImage {
    id: String,
    metadata: CursorMeta,
    bytes: Vec<u8>,
}

impl PreparingCursorImage {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn metadata(&self) -> &CursorMeta {
        &self.metadata
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub(super) fn project(
    recording: &IncompleteRecording,
    claim: &CleanStoppedStudioClaim,
) -> Result<PreparingProjection, String> {
    if recording.project_path != claim.metadata().project_path
        || recording.meta.project_path != recording.project_path
        || persisted_json_value(&recording.meta)? != persisted_json_value(claim.metadata())?
    {
        return Err("Stopped recording identity or metadata changed".into());
    }
    let project = &recording.project_path;
    checked_metadata(project, Path::new("content/segments"), true)?;
    let metadata_bytes = read_bounded(project, Path::new("recording-meta.json"), MAX_JSON_BYTES)?;
    let disk_metadata: serde_json::Value =
        serde_json::from_slice(&metadata_bytes).map_err(|error| error.to_string())?;
    if disk_metadata != persisted_json_value(claim.metadata())? {
        return Err("Persisted stopped metadata changed".into());
    }
    let configuration_bytes =
        read_bounded(project, Path::new("project-config.json"), MAX_JSON_BYTES)?;
    let disk_configuration: serde_json::Value =
        serde_json::from_slice(&configuration_bytes).map_err(|error| error.to_string())?;
    if disk_configuration != persisted_json_value(claim.configuration())? {
        return Err("Persisted stopped configuration changed".into());
    }
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = claim.metadata().studio_meta()
    else {
        return Err("Preparing requires indexed Studio metadata".into());
    };
    if !matches!(inner.status, Some(StudioRecordingStatus::NeedsRemux))
        || inner.segments.is_empty()
        || inner.segments.len() != recording.recoverable_segments.len()
    {
        return Err("Preparing requires every stopped segment".into());
    }
    validate_configuration(claim.configuration(), inner.segments.len())?;
    validate_diagnostics(project)?;
    let cursor_images = cursor_images(project, &inner.cursors)?;
    let source_root = project.join("content/segments");
    let mut inventory = Inventory::read(&source_root)?;
    let mut segments = Vec::with_capacity(inner.segments.len());
    for (index, (metadata, recovered)) in inner
        .segments
        .iter()
        .zip(&recording.recoverable_segments)
        .enumerate()
    {
        if usize::try_from(recovered.index).ok() != Some(index) {
            return Err("Stopped and discovered segment indexes differ".into());
        }
        let segment_dir = PathBuf::from(format!("segment-{}", recovered.index));
        inventory.directory(&segment_dir)?;
        let display = video(
            &source_root,
            &mut inventory,
            metadata.display.clone(),
            &segment_dir.join("display"),
            recovered.display_init_segment.as_deref(),
            &recovered.display_fragments,
        )?;
        let camera = match (&metadata.camera, &recovered.camera_fragments) {
            (Some(metadata), Some(fragments)) => Some(video(
                &source_root,
                &mut inventory,
                metadata.clone(),
                &segment_dir.join("camera"),
                recovered.camera_init_segment.as_deref(),
                fragments,
            )?),
            (None, None) if recovered.camera_init_segment.is_none() => None,
            _ => return Err("Stopped camera track does not match discovered media".into()),
        };
        let mic = audio(
            &source_root,
            &mut inventory,
            metadata.mic.as_ref(),
            recovered.mic_fragments.as_deref(),
            &segment_dir,
            "audio-input",
        )?;
        let system_audio = audio(
            &source_root,
            &mut inventory,
            metadata.system_audio.as_ref(),
            recovered.system_audio_fragments.as_deref(),
            &segment_dir,
            "system_audio",
        )?;
        let cursor_path = sidecar(
            &mut inventory,
            metadata.cursor.as_ref(),
            &segment_dir.join("cursor.json"),
        )?;
        if recovered.cursor_path.as_deref()
            != cursor_path
                .as_ref()
                .map(|path| source_root.join(path))
                .as_deref()
        {
            return Err("Stopped cursor sidecar does not match discovery".into());
        }
        let keyboard_path = keyboard(&mut inventory, metadata, &segment_dir)?;
        if let Some(notch) = metadata.display_notch
            && (!notch.x.is_finite() || !notch.width.is_finite() || !notch.height.is_finite())
        {
            return Err("Invalid stopped notch metadata".into());
        }
        segments.push(PreparingStudioSegment {
            index: recovered.index,
            metadata: metadata.clone(),
            display,
            camera,
            mic,
            system_audio,
            cursor_path,
            keyboard_path,
            cursor_images: cursor_images.clone(),
        });
    }
    inventory.finish()?;
    Ok(PreparingProjection {
        segments,
        configuration_bytes,
    })
}

fn persisted_json_value(value: &impl serde::Serialize) -> Result<serde_json::Value, String> {
    // Value serialization widens f32; compare the same decimal representation the file writer uses.
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn validate_configuration(
    config: &ProjectConfiguration,
    segment_count: usize,
) -> Result<(), String> {
    config.validate().map_err(|error| error.to_string())?;
    let timeline = config.timeline.as_ref().ok_or("Missing stopped timeline")?;
    if timeline.segments.len() != segment_count {
        return Err("Stopped timeline does not map every segment".into());
    }
    for (index, segment) in timeline.segments.iter().enumerate() {
        if usize::try_from(segment.recording_clip).ok() != Some(index)
            || segment.start != 0.0
            || !segment.end.is_finite()
            || segment.end <= 0.0
            || segment.timescale != 1.0
            || segment.name.is_some()
            || segment.speed_audio_mode.is_some()
        {
            return Err("Preparing requires the unchanged stopped timeline".into());
        }
    }
    let timeline_json = persisted_json_value(timeline)?;
    if timeline_json.as_object().is_none_or(|fields| {
        fields.iter().any(|(key, value)| {
            key != "segments" && value.as_array().is_none_or(|values| !values.is_empty())
        })
    }) {
        return Err("Timeline overlays require ordinary loading".into());
    }
    let expected = ProjectConfiguration {
        timeline: config.timeline.clone(),
        clips: config.clips.clone(),
        ..ProjectConfiguration::default()
    };
    if persisted_json_value(config)? != persisted_json_value(&expected)? {
        return Err("Edited or legacy configuration requires ordinary loading".into());
    }
    let mut indexes = HashSet::new();
    for clip in &config.clips {
        if clip.index as usize >= segment_count
            || !indexes.insert(clip.index)
            || !clip.offsets.camera.is_finite()
            || !clip.offsets.mic.is_finite()
            || !clip.offsets.system_audio.is_finite()
        {
            return Err("Invalid stopped clip offsets".into());
        }
    }
    Ok(())
}

fn validate_diagnostics(project: &Path) -> Result<(), String> {
    let path = Path::new("recording-diagnostics.json");
    match project.join(path).symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let diagnostics: serde_json::Value =
        serde_json::from_slice(&read_bounded(project, path, MAX_JSON_BYTES)?)
            .map_err(|error| error.to_string())?;
    if diagnostics
        .get("segments")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|segments| {
            segments.iter().any(|segment| {
                segment
                    .get("trackFailures")
                    .and_then(serde_json::Value::as_array)
                    .is_none_or(|failures| !failures.is_empty())
            })
        })
    {
        return Err(
            "Requested-track failures or incomplete diagnostics require ordinary finalization"
                .into(),
        );
    }
    Ok(())
}

fn local_relative(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || path.to_str().is_none_or(|value| {
            value.contains(':')
                || (cfg!(unix) && value.contains('\\'))
                || value
                    .split(['/', '\\'])
                    .any(|part| matches!(part, "" | "." | ".."))
        })
    {
        return Err("Preparing input path is not local and normalized".into());
    }
    Ok(())
}

fn source_relative(path: &relative_path::RelativePath) -> Result<PathBuf, String> {
    if path.as_str().contains('\\') {
        return Err("Preparing metadata path contains a platform-specific separator".into());
    }
    let path = Path::new(path.as_str());
    local_relative(path)?;
    let relative = path
        .strip_prefix("content/segments")
        .map_err(|_| "Preparing media must remain within content/segments")?;
    local_relative(relative)?;
    Ok(relative.to_path_buf())
}

fn checked_metadata(root: &Path, relative: &Path, directory: bool) -> Result<Metadata, String> {
    local_relative(relative)?;
    let mut path = root.to_path_buf();
    let root_metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
    reject_recovery_link(&root_metadata).map_err(|error| error.to_string())?;
    if !root_metadata.is_dir() {
        return Err("Preparing source root is not a directory".into());
    }
    let mut parts = relative.components().peekable();
    while let Some(part) = parts.next() {
        path.push(part.as_os_str());
        let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
        reject_recovery_link(&metadata).map_err(|error| error.to_string())?;
        if parts.peek().is_none() {
            if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
                return Err("Preparing input has an unexpected file type".into());
            }
            return Ok(metadata);
        }
        if !metadata.is_dir() {
            return Err("Preparing input ancestor is not a directory".into());
        }
    }
    Err("Preparing input path is empty".into())
}

fn read_bounded(root: &Path, relative: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = checked_metadata(root, relative, false)?;
    if metadata.len() > limit {
        return Err("Preparing input exceeds the read limit".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file: File = options
        .open(root.join(relative))
        .map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    reject_recovery_link(&opened).map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != metadata.len() {
        return Err("Preparing input changed before reading".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != metadata.len() {
        return Err("Preparing input changed while reading".into());
    }
    Ok(bytes)
}

struct Inventory {
    files: HashMap<PathBuf, u64>,
    directories: HashSet<PathBuf>,
}

impl Inventory {
    fn read(root: &Path) -> Result<Self, String> {
        let mut inventory = Self {
            files: HashMap::new(),
            directories: HashSet::new(),
        };
        let mut pending = vec![PathBuf::new()];
        let mut entry_count = 0_usize;
        let mut path_bytes = 0_usize;
        while let Some(directory) = pending.pop() {
            for entry in
                std::fs::read_dir(root.join(&directory)).map_err(|error| error.to_string())?
            {
                let entry = entry.map_err(|error| error.to_string())?;
                let relative = directory.join(entry.file_name());
                local_relative(&relative)?;
                entry_count += 1;
                path_bytes = path_bytes
                    .checked_add(relative.as_os_str().len())
                    .ok_or("Path budget overflow")?;
                if entry_count > MAX_SOURCE_ENTRIES
                    || path_bytes > MAX_SOURCE_PATH_BYTES
                    || relative.components().count() > 3
                {
                    return Err("Preparing input exceeds the descriptor budget".into());
                }
                let metadata = entry
                    .path()
                    .symlink_metadata()
                    .map_err(|error| error.to_string())?;
                reject_recovery_link(&metadata).map_err(|error| error.to_string())?;
                if metadata.is_dir() {
                    inventory.directories.insert(relative.clone());
                    pending.push(relative);
                } else if metadata.is_file() {
                    let _ = inventory.files.insert(relative, metadata.len());
                } else {
                    return Err("Unsupported preparing source file type".into());
                }
            }
        }
        Ok(inventory)
    }

    fn directory(&mut self, path: &Path) -> Result<(), String> {
        if !self.directories.remove(path) {
            return Err("Missing or reused preparing track directory".into());
        }
        Ok(())
    }

    fn file(&mut self, path: &Path) -> Result<u64, String> {
        self.files
            .remove(path)
            .ok_or_else(|| "Missing or reused preparing input".into())
    }

    fn finish(self) -> Result<(), String> {
        if !self.files.is_empty() || !self.directories.is_empty() {
            return Err(
                "Unrepresented source files or respawn layouts require ordinary finalization"
                    .into(),
            );
        }
        Ok(())
    }
}

fn video(
    root: &Path,
    inventory: &mut Inventory,
    metadata: VideoMeta,
    directory: &Path,
    init: Option<&Path>,
    fragments: &[PathBuf],
) -> Result<PreparingVideoInput, String> {
    if metadata.fps == 0
        || metadata.start_time.is_none_or(|time| !time.is_finite())
        || source_relative(&metadata.path)? != directory
        || fragments.is_empty()
        || fragments.len() > MAX_SOURCE_ENTRIES
    {
        return Err("Unsupported stopped video metadata or layout".into());
    }
    inventory.directory(directory)?;
    let expected_init = directory.join("init.mp4");
    if init != Some(root.join(&expected_init).as_path()) {
        return Err("Preparing video requires exactly one init segment".into());
    }
    inventory.file(&expected_init)?;
    validate_init(&read_bounded(root, &expected_init, MAX_INIT_BYTES)?)?;
    let mut paths = Vec::with_capacity(fragments.len() + 1);
    paths.push(expected_init);
    let mut previous: Option<u64> = None;
    for fragment in fragments {
        let relative = fragment
            .strip_prefix(root)
            .map_err(|_| "Discovered video is outside source root")?;
        local_relative(relative)?;
        let index =
            RecoveryManager::m4s_fragment_index(fragment).ok_or("Unsupported M4S fragment name")?;
        if relative.parent() != Some(directory)
            || previous.is_some_and(|previous| previous.checked_add(1) != Some(index))
            || (previous.is_none() && index > 1)
            || !RecoveryManager::is_m4s_complete(fragment)
        {
            return Err(
                "Video fragments are not complete and contiguous in discovered order".into(),
            );
        }
        inventory.file(relative)?;
        previous = Some(index);
        paths.push(relative.to_path_buf());
    }
    validate_manifest(root, inventory, directory, &paths)?;
    for name in ["dash_manifest.mpd", "master.m3u8", "media_0.m3u8"] {
        let path = directory.join(name);
        if inventory.files.contains_key(&path) {
            inventory.file(&path)?;
        }
    }
    Ok(PreparingVideoInput { metadata, paths })
}

fn validate_init(bytes: &[u8]) -> Result<(), String> {
    let mut rest = bytes;
    let mut ftyp = false;
    let mut moov = false;
    let mut boxes = 0;
    while !rest.is_empty() {
        boxes += 1;
        if rest.len() < 8 || boxes > 256 {
            return Err("Incomplete video initialization segment".into());
        }
        let size =
            u32::from_be_bytes(rest[..4].try_into().map_err(|_| "Invalid init box")?) as usize;
        if size < 8 || size > rest.len() {
            return Err("Unsupported or incomplete video initialization box".into());
        }
        ftyp |= &rest[4..8] == b"ftyp";
        moov |= &rest[4..8] == b"moov";
        rest = &rest[size..];
    }
    if !ftyp || !moov {
        return Err("Video initialization lacks ftyp or moov".into());
    }
    Ok(())
}

fn validate_manifest(
    root: &Path,
    inventory: &mut Inventory,
    directory: &Path,
    paths: &[PathBuf],
) -> Result<(), String> {
    let path = directory.join("manifest.json");
    if !inventory.files.contains_key(&path) {
        return Ok(());
    }
    inventory.file(&path)?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&read_bounded(root, &path, MAX_MANIFEST_BYTES)?)
            .map_err(|error| error.to_string())?;
    if manifest.get("type").and_then(serde_json::Value::as_str) != Some("m4s_segments")
        || manifest
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .is_none_or(|version| !(1..=5).contains(&version))
        || manifest
            .get("init_segment")
            .and_then(serde_json::Value::as_str)
            != Some("init.mp4")
    {
        return Err("Unsupported video manifest".into());
    }
    let entries = manifest
        .get("segments")
        .and_then(serde_json::Value::as_array)
        .ok_or("Missing manifest segments")?;
    if entries.len() + 1 != paths.len() {
        return Err("Manifest does not describe every discovered video fragment".into());
    }
    for (entry, path) in entries.iter().zip(&paths[1..]) {
        let name = entry
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or("Missing manifest path")?;
        local_relative(Path::new(name))?;
        if directory.join(name) != *path
            || entry
                .get("is_complete")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || entry.get("index").and_then(serde_json::Value::as_u64)
                != RecoveryManager::m4s_fragment_index(path)
            || entry.get("file_size").and_then(serde_json::Value::as_u64)
                != Some(checked_metadata(root, path, false)?.len())
        {
            return Err("Video manifest differs from complete discovered inputs".into());
        }
    }
    Ok(())
}

fn audio(
    root: &Path,
    inventory: &mut Inventory,
    metadata: Option<&AudioMeta>,
    fragments: Option<&[PathBuf]>,
    directory: &Path,
    name: &str,
) -> Result<Option<PreparingAudioInput>, String> {
    let (metadata, fragments) = match (metadata, fragments) {
        (None, None) => return Ok(None),
        (Some(metadata), Some(fragments)) => (metadata, fragments),
        _ => return Err("Stopped audio track does not match discovered media".into()),
    };
    let path = source_relative(&metadata.path)?;
    if fragments.len() != 1
        || fragments[0] != root.join(&path)
        || path.parent() != Some(directory)
        || path.file_stem().is_none_or(|stem| stem != name)
        || path.extension().is_none_or(|extension| {
            !["m4a", "ogg", "mp3"]
                .iter()
                .any(|allowed| extension == *allowed)
        })
        || metadata.start_time.is_none_or(|time| !time.is_finite())
        || inventory.file(&path)? == 0
    {
        return Err("Preparing audio requires one complete discovered file".into());
    }
    Ok(Some(PreparingAudioInput {
        metadata: metadata.clone(),
        path,
    }))
}

fn sidecar(
    inventory: &mut Inventory,
    declared: Option<&relative_path::RelativePathBuf>,
    expected: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(declared) = declared else {
        return Ok(None);
    };
    let path = source_relative(declared)?;
    if path != expected {
        return Err("Unsupported stopped sidecar path".into());
    }
    inventory.file(&path)?;
    Ok(Some(path))
}

fn keyboard(
    inventory: &mut Inventory,
    metadata: &MultipleSegment,
    directory: &Path,
) -> Result<Option<PathBuf>, String> {
    let binary = directory.join(cap_project::KEYBOARD_EVENTS_FILE_NAME);
    let legacy = directory.join(cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME);
    let preferred = if inventory.files.contains_key(&binary) {
        &binary
    } else {
        &legacy
    };
    if let Some(declared) = &metadata.keyboard {
        return sidecar(inventory, Some(declared), preferred);
    }
    if inventory.files.contains_key(preferred) {
        inventory.file(preferred)?;
        return Ok(Some(preferred.clone()));
    }
    Ok(None)
}

fn cursor_images(project: &Path, cursors: &Cursors) -> Result<Arc<[PreparingCursorImage]>, String> {
    let Cursors::Correct(cursors) = cursors else {
        return Err("Legacy cursor assets require ordinary loading".into());
    };
    validate_cursor_inventory(project, cursors)?;
    let mut remaining = MAX_CURSOR_IMAGES_BYTES;
    let mut images = Vec::with_capacity(cursors.len());
    let mut ordered: Vec<_> = cursors.iter().collect();
    ordered.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (id, metadata) in ordered {
        let path = Path::new(metadata.image_path.as_str());
        local_relative(path)?;
        if path.parent() != Some(Path::new("content/cursors"))
            || path.extension().is_none_or(|extension| extension != "png")
            || !metadata.hotspot.x.is_finite()
            || !metadata.hotspot.y.is_finite()
        {
            return Err("Unsupported stopped cursor image".into());
        }
        let bytes = read_bounded(project, path, remaining.min(MAX_CURSOR_IMAGE_BYTES))?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Stopped cursor image is not PNG".into());
        }
        remaining = remaining
            .checked_sub(bytes.len() as u64)
            .ok_or("Cursor image budget exceeded")?;
        images.push(PreparingCursorImage {
            id: id.clone(),
            metadata: metadata.clone(),
            bytes,
        });
    }
    Ok(images.into())
}

fn validate_cursor_inventory(
    project: &Path,
    cursors: &HashMap<String, CursorMeta>,
) -> Result<(), String> {
    let directory = Path::new("content/cursors");
    match project.join(directory).symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && cursors.is_empty() => {
            return Ok(());
        }
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    checked_metadata(project, directory, true)?;
    let mut remaining: HashSet<_> = cursors
        .values()
        .map(|cursor| PathBuf::from(cursor.image_path.as_str()))
        .collect();
    for entry in std::fs::read_dir(project.join(directory)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = directory.join(entry.file_name());
        checked_metadata(project, &path, false)?;
        if !remaining.remove(&path) {
            return Err("Unrepresented cursor assets require ordinary finalization".into());
        }
    }
    if !remaining.is_empty() {
        return Err("Missing stopped cursor assets".into());
    }
    Ok(())
}

#[cfg(test)]
impl PreparingProjection {
    pub(super) fn for_test(
        metadata: MultipleSegment,
        display_paths: Vec<PathBuf>,
        configuration_bytes: Vec<u8>,
    ) -> Self {
        Self {
            segments: vec![PreparingStudioSegment {
                index: 0,
                display: PreparingVideoInput {
                    metadata: metadata.display.clone(),
                    paths: display_paths,
                },
                metadata,
                camera: None,
                mic: None,
                system_audio: None,
                cursor_path: None,
                keyboard_path: None,
                cursor_images: Arc::from([]),
            }],
            configuration_bytes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{MultipleSegments, RecordingMeta, RecordingMetaInner};
    use relative_path::RelativePathBuf;

    struct Fixture {
        directory: tempfile::TempDir,
        recording: IncompleteRecording,
        configuration: ProjectConfiguration,
    }

    impl Fixture {
        fn new(count: u32) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let mut segments = Vec::new();
            let mut recovered = Vec::new();
            for index in 0..count {
                let base = format!("content/segments/segment-{index}");
                let video = directory.path().join(&base).join("display");
                let (init, fragments) = write_video(&video);
                segments.push(MultipleSegment {
                    display: VideoMeta {
                        path: RelativePathBuf::from(format!("{base}/display")),
                        fps: 30,
                        start_time: Some(0.25 + f64::from(index)),
                        device_id: Some("display-device".into()),
                    },
                    camera: None,
                    mic: None,
                    system_audio: None,
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                });
                recovered.push(super::super::RecoverableSegment {
                    index,
                    display_fragments: fragments,
                    display_init_segment: Some(init),
                    camera_fragments: None,
                    camera_init_segment: None,
                    mic_fragments: None,
                    system_audio_fragments: None,
                    cursor_path: None,
                });
            }
            let metadata = RecordingMeta {
                platform: None,
                project_path: directory.path().to_path_buf(),
                pretty_name: "Preparing projection".into(),
                sharing: None,
                inner: RecordingMetaInner::Studio(Box::new(
                    StudioRecordingMeta::MultipleSegments {
                        inner: MultipleSegments {
                            segments,
                            cursors: Cursors::default(),
                            status: Some(StudioRecordingStatus::NeedsRemux),
                        },
                    },
                )),
                upload: None,
            };
            let configuration = ProjectConfiguration {
                timeline: Some(
                    serde_json::from_value(serde_json::json!({
                        "segments": (0..count).map(|index| serde_json::json!({
                            "recordingSegment": index, "timescale": 1.0, "start": 0.0,
                            "end": 7200.25 + f64::from(index), "name": null
                        })).collect::<Vec<_>>(),
                        "zoomSegments": []
                    }))
                    .unwrap(),
                ),
                ..ProjectConfiguration::default()
            };
            let fixture = Self {
                recording: IncompleteRecording {
                    project_path: directory.path().to_path_buf(),
                    meta: metadata,
                    recoverable_segments: recovered,
                    estimated_duration: std::time::Duration::from_secs(1),
                },
                directory,
                configuration,
            };
            fixture.persist();
            fixture
        }

        fn metadata(&mut self) -> &mut MultipleSegments {
            let RecordingMetaInner::Studio(studio) = &mut self.recording.meta.inner else {
                unreachable!()
            };
            let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut() else {
                unreachable!()
            };
            inner
        }

        fn persist(&self) {
            self.recording.meta.save_for_project().unwrap();
            self.configuration.write(self.directory.path()).unwrap();
        }

        fn claim(&self) -> CleanStoppedStudioClaim {
            CleanStoppedStudioClaim::for_test(
                self.recording.meta.clone(),
                self.configuration.clone(),
            )
            .unwrap()
        }

        fn project(&self) -> Result<PreparingProjection, String> {
            project(&self.recording, &self.claim())
        }

        fn snapshot(&self) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
            let mut paths = vec![self.directory.path().to_path_buf()];
            let mut snapshot = std::collections::BTreeMap::new();
            while let Some(path) = paths.pop() {
                if path.is_dir() {
                    paths.extend(
                        std::fs::read_dir(path)
                            .unwrap()
                            .map(|entry| entry.unwrap().path()),
                    );
                } else {
                    let _ = snapshot.insert(
                        path.strip_prefix(self.directory.path())
                            .unwrap()
                            .to_path_buf(),
                        std::fs::read(path).unwrap(),
                    );
                }
            }
            snapshot
        }

        fn add_optional_tracks_and_sidecars(&mut self) {
            let base = "content/segments/segment-0";
            let segment = self.directory.path().join(base);
            let (init, fragments) = write_video(&segment.join("camera"));
            self.recording.recoverable_segments[0].camera_init_segment = Some(init);
            self.recording.recoverable_segments[0].camera_fragments = Some(fragments);
            for name in ["audio-input.m4a", "system_audio.ogg"] {
                std::fs::write(segment.join(name), b"discovery-validated-audio").unwrap();
            }
            self.recording.recoverable_segments[0].mic_fragments =
                Some(vec![segment.join("audio-input.m4a")]);
            self.recording.recoverable_segments[0].system_audio_fragments =
                Some(vec![segment.join("system_audio.ogg")]);
            std::fs::write(segment.join("cursor.json"), b"{\"moves\":[],\"clicks\":[]}").unwrap();
            std::fs::write(
                segment.join(cap_project::KEYBOARD_EVENTS_FILE_NAME),
                b"raw keyboard bytes",
            )
            .unwrap();
            self.recording.recoverable_segments[0].cursor_path = Some(segment.join("cursor.json"));
            let asset = self.directory.path().join("content/cursors/cursor_0.png");
            std::fs::create_dir_all(asset.parent().unwrap()).unwrap();
            std::fs::write(&asset, b"\x89PNG\r\n\x1a\nimmutable asset").unwrap();
            let metadata = self.metadata();
            metadata.segments[0].camera = Some(VideoMeta {
                path: RelativePathBuf::from(format!("{base}/camera")),
                fps: 24,
                start_time: Some(0.5),
                device_id: Some("camera-device".into()),
            });
            metadata.segments[0].mic = Some(AudioMeta {
                path: RelativePathBuf::from(format!("{base}/audio-input.m4a")),
                start_time: Some(-0.125),
                device_id: Some("microphone-device".into()),
                gap_summary: Some(cap_project::AudioGapSummary {
                    total_overlap_trimmed_ms: 21,
                    startup_overlap_trimmed_ms: 7,
                    overlap_dropped_frames: 2,
                    startup_overlap_drops: 1,
                }),
            });
            metadata.segments[0].system_audio = Some(AudioMeta {
                path: RelativePathBuf::from(format!("{base}/system_audio.ogg")),
                start_time: Some(0.375),
                device_id: None,
                gap_summary: None,
            });
            metadata.segments[0].cursor =
                Some(RelativePathBuf::from(format!("{base}/cursor.json")));
            metadata.segments[0].display_notch = Some(cap_project::DisplayNotch {
                x: 0.45,
                width: 0.1,
                height: 0.03,
            });
            metadata.cursors = Cursors::Correct(HashMap::from([(
                "0".into(),
                CursorMeta {
                    image_path: RelativePathBuf::from("content/cursors/cursor_0.png"),
                    hotspot: cap_project::XY { x: 0.25, y: 0.125 },
                    shape: None,
                },
            )]));
            self.persist();
        }
    }

    fn mp4_box(name: &[u8; 4], payload: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((payload + 8) as u32).to_be_bytes());
        bytes.extend_from_slice(name);
        bytes.resize(payload + 8, 0);
        bytes
    }

    fn write_video(directory: &Path) -> (PathBuf, Vec<PathBuf>) {
        std::fs::create_dir_all(directory).unwrap();
        let init = directory.join("init.mp4");
        std::fs::write(&init, [mp4_box(b"ftyp", 16), mp4_box(b"moov", 16)].concat()).unwrap();
        let fragments: Vec<_> = (1..=2)
            .map(|index| {
                let path = directory.join(format!("segment_{index:03}.m4s"));
                std::fs::write(
                    &path,
                    [mp4_box(b"moof", 16), mp4_box(b"mdat", 128)].concat(),
                )
                .unwrap();
                path
            })
            .collect();
        (init, fragments)
    }

    fn manifest(fixture: &Fixture) -> serde_json::Value {
        serde_json::json!({"version":5,"type":"m4s_segments","init_segment":"init.mp4",
            "segments": fixture.recording.recoverable_segments[0].display_fragments.iter().enumerate().map(|(index,path)| {
                serde_json::json!({"index": index + 1, "path":path.file_name().unwrap().to_str().unwrap(),
                    "is_complete":true,"file_size":path.metadata().unwrap().len()})
            }).collect::<Vec<_>>()})
    }

    #[test]
    fn preparing_projection_preserves_all_tracks_offsets_duration_and_raw_sidecars_without_writes()
    {
        let mut fixture = Fixture::new(2);
        fixture.add_optional_tracks_and_sidecars();
        let before = fixture.snapshot();
        let projection = fixture.project().unwrap();
        assert_eq!(before, fixture.snapshot());
        assert_eq!(projection.segments.len(), 2);
        let first = &projection.segments[0];
        assert_eq!(first.index(), 0);
        assert_eq!(first.metadata().latest_start_time(), Some(0.5));
        assert_eq!(
            first.display().paths()[0],
            Path::new("segment-0/display/init.mp4")
        );
        assert_eq!(
            first.display().paths()[2],
            Path::new("segment-0/display/segment_002.m4s")
        );
        assert_eq!(first.camera().unwrap().metadata().fps, 24);
        assert_eq!(
            first
                .mic()
                .unwrap()
                .metadata()
                .gap_summary
                .unwrap()
                .startup_overlap_trimmed_ms,
            7
        );
        assert_eq!(
            first.system_audio().unwrap().metadata().start_time,
            Some(0.375)
        );
        assert_eq!(
            first.cursor_path(),
            Some(Path::new("segment-0/cursor.json"))
        );
        assert_eq!(
            first.keyboard_path(),
            Some(
                Path::new("segment-0")
                    .join(cap_project::KEYBOARD_EVENTS_FILE_NAME)
                    .as_path()
            )
        );
        assert_eq!(first.cursor_images()[0].metadata().hotspot.x, 0.25);
        assert_eq!(first.cursor_images()[0].id(), "0");
        assert_eq!(
            projection.configuration_bytes,
            before[Path::new("project-config.json")]
        );
        assert!(Arc::ptr_eq(
            &first.cursor_images,
            &projection.segments[1].cursor_images
        ));
        std::fs::write(
            fixture
                .directory
                .path()
                .join("content/cursors/cursor_0.png"),
            b"changed",
        )
        .unwrap();
        assert_eq!(
            first.cursor_images()[0].bytes(),
            b"\x89PNG\r\n\x1a\nimmutable asset"
        );
    }

    #[test]
    fn preparing_projection_compares_writer_float_representation_and_rejects_unknown_fields() {
        let fixture = Fixture::new(1);
        let path = fixture.directory.path().join("project-config.json");
        let mut persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let in_memory = serde_json::to_value(&fixture.configuration).unwrap();
        let field = "/background/advancedShadow/blur";
        assert_ne!(in_memory.pointer(field), persisted.pointer(field));
        eprintln!(
            "{}",
            serde_json::json!({
                "probe": "preparing-configuration-float-representation", "field": field,
                "inMemory": in_memory.pointer(field), "persisted": persisted.pointer(field)
            })
        );
        assert_eq!(
            persisted_json_value(&fixture.configuration).unwrap(),
            persisted
        );
        assert!(fixture.project().is_ok());
        persisted["unrecognizedFutureMedia"] = serde_json::json!({"path":"foreign.wav"});
        let changed = serde_json::to_vec_pretty(&persisted).unwrap();
        std::fs::write(&path, &changed).unwrap();
        assert!(fixture.project().is_err());
        assert_eq!(std::fs::read(path).unwrap(), changed);
    }

    #[test]
    fn preparing_projection_rejects_current_or_persisted_metadata_and_configuration_drift() {
        for mutation in 0..5 {
            let mut fixture = Fixture::new(1);
            let claim = fixture.claim();
            match mutation {
                0 => fixture.recording.meta.pretty_name.push_str(" changed"),
                1 => {
                    fixture.recording.meta.pretty_name.push_str(" changed");
                    fixture.persist();
                }
                2 => {
                    fixture.configuration.timeline.as_mut().unwrap().segments[0].end += 1.0;
                    fixture.persist();
                }
                3 => {
                    let path = fixture.directory.path().join("project-config.json");
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    let _ = value.as_object_mut().unwrap().remove("textSizeVersion");
                    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
                }
                _ => fixture.recording.project_path = fixture.directory.path().join("other"),
            }
            let before = fixture.snapshot();
            assert!(project(&fixture.recording, &claim).is_err());
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_requires_one_to_one_indexes_and_exact_discovered_order() {
        for mutation in 0..5 {
            let mut fixture = Fixture::new(2);
            match mutation {
                0 => fixture.recording.recoverable_segments.swap(0, 1),
                1 => fixture.recording.recoverable_segments[1].index = 0,
                2 => {
                    let _ = fixture.recording.recoverable_segments.pop();
                }
                3 => fixture.recording.recoverable_segments[0]
                    .display_fragments
                    .reverse(),
                _ => {
                    let _ = fixture.recording.recoverable_segments[0]
                        .display_fragments
                        .remove(0);
                }
            }
            assert!(fixture.project().is_err());
        }
    }

    #[test]
    fn preparing_projection_manifest_completeness_order_and_size_are_authoritative() {
        for mutation in 0..6 {
            let fixture = Fixture::new(1);
            assert!(fixture.project().is_ok());
            let mut value = manifest(&fixture);
            match mutation {
                0 => {}
                1 => value["segments"][0]["is_complete"] = false.into(),
                2 => value["segments"][0]["file_size"] = 1.into(),
                3 => value["segments"].as_array_mut().unwrap().reverse(),
                4 => value["segments"][0]["path"] = "../segment_001.m4s".into(),
                _ => value["version"] = 6.into(),
            }
            std::fs::write(
                fixture
                    .directory
                    .path()
                    .join("content/segments/segment-0/display/manifest.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            let before = fixture.snapshot();
            assert_eq!(fixture.project().is_ok(), mutation == 0);
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_does_not_rescue_pending_fragments_or_ignore_extra_tracks() {
        for name in [
            "display/segment_003.m4s.tmp",
            "display/init_1.mp4",
            "camera.mp4",
            "audio-input.m4a",
            "cursor.json",
            "unknown/data",
        ] {
            let fixture = Fixture::new(1);
            let path = fixture
                .directory
                .path()
                .join("content/segments/segment-0")
                .join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"retained original").unwrap();
            let before = fixture.snapshot();
            assert!(fixture.project().is_err(), "{name}");
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_declines_missing_optional_tracks_and_grouped_audio() {
        for mutation in 0..4 {
            let mut fixture = Fixture::new(1);
            fixture.add_optional_tracks_and_sidecars();
            match mutation {
                0 => fixture.recording.recoverable_segments[0].camera_fragments = None,
                1 => fixture.recording.recoverable_segments[0].mic_fragments = None,
                2 => {
                    let files = fixture.recording.recoverable_segments[0]
                        .mic_fragments
                        .as_mut()
                        .unwrap();
                    files.push(files[0].clone());
                }
                _ => {
                    std::fs::remove_file(
                        fixture
                            .directory
                            .path()
                            .join("content/cursors/cursor_0.png"),
                    )
                    .unwrap();
                }
            }
            let before = fixture.snapshot();
            assert!(fixture.project().is_err());
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_rejects_truncated_media_and_oversized_metadata_without_writes() {
        for mutation in 0..3 {
            let fixture = Fixture::new(1);
            let path = match mutation {
                0 => fixture.recording.recoverable_segments[0]
                    .display_init_segment
                    .clone()
                    .unwrap(),
                1 => fixture.recording.recoverable_segments[0].display_fragments[1].clone(),
                _ => fixture.directory.path().join("recording-meta.json"),
            };
            let length = if mutation == 2 { MAX_JSON_BYTES + 1 } else { 5 };
            OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(length)
                .unwrap();
            let before = fixture.snapshot();
            assert!(fixture.project().is_err());
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_rejects_foreign_paths_and_nonfinite_timing() {
        for mutation in 0..5 {
            let mut fixture = Fixture::new(1);
            let display = &mut fixture.metadata().segments[0].display;
            match mutation {
                0 => display.path = RelativePathBuf::from("../display"),
                1 => display.path = RelativePathBuf::from("content/segments/segment-0/../display"),
                2 => display.path = RelativePathBuf::from("content\\segments\\segment-0\\display"),
                3 => display.fps = 0,
                _ => display.start_time = None,
            }
            fixture.persist();
            assert!(fixture.project().is_err());
        }
    }

    #[test]
    fn preparing_projection_accepts_complete_diagnostics_and_retains_failed_diagnostics() {
        for failures in [
            serde_json::json!([]),
            serde_json::json!([{"track":"camera","error":"failed"}]),
            serde_json::Value::Null,
        ] {
            let fixture = Fixture::new(1);
            std::fs::write(
                fixture.directory.path().join("recording-diagnostics.json"),
                serde_json::to_vec(&serde_json::json!({"version":2,"segments":[{"segmentIndex":0,"trackFailures":failures}]})).unwrap(),
            ).unwrap();
            let before = fixture.snapshot();
            assert_eq!(
                fixture.project().is_ok(),
                failures.as_array().is_some_and(Vec::is_empty)
            );
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[test]
    fn preparing_projection_does_not_omit_undeclared_cursor_assets_or_second_keyboard_format() {
        for extra_asset in [false, true] {
            let mut fixture = Fixture::new(1);
            fixture.add_optional_tracks_and_sidecars();
            let extra = if extra_asset {
                fixture
                    .directory
                    .path()
                    .join("content/cursors/cursor_extra.png")
            } else {
                fixture
                    .directory
                    .path()
                    .join("content/segments/segment-0")
                    .join(cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME)
            };
            std::fs::write(&extra, b"original extra input").unwrap();
            let before = fixture.snapshot();
            assert!(fixture.project().is_err());
            assert_eq!(before, fixture.snapshot());
        }
    }

    #[cfg(unix)]
    #[test]
    fn preparing_projection_rejects_source_and_asset_symlinks() {
        for asset in [false, true] {
            let mut fixture = Fixture::new(1);
            fixture.add_optional_tracks_and_sidecars();
            let path = if asset {
                fixture
                    .directory
                    .path()
                    .join("content/cursors/cursor_0.png")
            } else {
                fixture.recording.recoverable_segments[0].display_fragments[0].clone()
            };
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::fs::copy(&path, outside.path()).unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(outside.path(), &path).unwrap();
            assert!(fixture.project().is_err());
            assert!(path.symlink_metadata().unwrap().file_type().is_symlink());
        }
    }
}
