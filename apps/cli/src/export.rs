use std::{
    io::{Write, stdout},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{RecordingMeta, RecordingMetaInner, XY};
use clap::{Args, ValueEnum};
use serde::{Deserialize, Serialize};
use tracing::info;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum ExportFormat {
    Mp4,
    Gif,
    Mov,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum QualityArg {
    Maximum,
    Social,
    Web,
    Potato,
}

impl From<QualityArg> for cap_export::mp4::ExportCompression {
    fn from(value: QualityArg) -> Self {
        match value {
            QualityArg::Maximum => Self::Maximum,
            QualityArg::Social => Self::Social,
            QualityArg::Web => Self::Web,
            QualityArg::Potato => Self::Potato,
        }
    }
}

#[derive(Args)]
#[command(long_about = "Render a '.cap' project to a video file.

NOTE: here --format selects the CONTAINER (mp4/gif/mov), NOT the output mode. For machine-readable
output pass --json (the global flag), which streams NDJSON progress + completion events to stdout.
The NDJSON uses PascalCase type tags and snake_case fields ({\"type\":\"Progress\",\"rendered_count\":N,
\"total_frames\":N} then {\"type\":\"Completed\",\"path\":\"...\"}); on failure a final
{\"type\":\"Error\",\"error\":\"...\"} is emitted.")]
pub struct Export {
    /// Path to a '.cap' project directory (as produced by `cap record`)
    project_path: PathBuf,
    /// Output file (positional alternative to --output)
    output_path: Option<PathBuf>,
    /// Output file to write the export to
    #[arg(long, short = 'o')]
    output: Option<PathBuf>,
    /// Container to export: mp4 (default), gif, or mov. NOT the output mode — use --json for JSON
    #[arg(long, value_enum)]
    format: Option<ExportFormat>,
    /// Frames per second to render
    #[arg(long)]
    fps: Option<u32>,
    /// Output resolution as WIDTHxHEIGHT, e.g. 1920x1080
    #[arg(long)]
    resolution: Option<String>,
    /// Compression preset (mp4 only)
    #[arg(long, value_enum)]
    quality: Option<QualityArg>,
    /// Optimise for smaller files using CRF (mp4 only)
    #[arg(long)]
    optimize_filesize: bool,
    /// Full export settings as JSON, e.g. {"format":"Mp4","fps":60,"resolution_base":{"x":1920,"y":1080},"compression":"Maximum","custom_bpp":null} (mutually exclusive with the flags above)
    #[arg(long)]
    settings_json: Option<String>,
    /// Decode source video with FFmpeg instead of the platform hardware decoder
    #[arg(long)]
    force_ffmpeg_decoder: bool,
    /// Stream newline-delimited JSON progress events to stdout ({"type":"Progress","rendered_count":N,"total_frames":N}; also emits a terminal {"type":"Error","error":"..."} on failure). Implied by --json
    #[arg(long)]
    progress_json: bool,
    /// Emit a final JSON completion event to stdout ({"type":"Completed","path":"..."}). Implied by --json
    #[arg(long)]
    completion_json: bool,
}

#[derive(Default)]
pub struct ExportFlags {
    pub format: Option<ExportFormat>,
    pub fps: Option<u32>,
    pub resolution: Option<String>,
    pub quality: Option<QualityArg>,
    pub optimize_filesize: bool,
    pub force_ffmpeg_decoder: bool,
}

impl ExportFlags {
    fn is_set(&self) -> bool {
        self.format.is_some()
            || self.fps.is_some()
            || self.resolution.is_some()
            || self.quality.is_some()
            || self.optimize_filesize
    }
}

#[derive(Deserialize)]
#[serde(tag = "format")]
pub enum CliExportSettings {
    #[serde(alias = "mp4")]
    Mp4(cap_export::mp4::Mp4ExportSettings),
    #[serde(alias = "gif")]
    Gif(cap_export::gif::GifExportSettings),
    #[serde(alias = "mov")]
    Mov(cap_export::mov::MovExportSettings),
}

impl CliExportSettings {
    fn fps(&self) -> u32 {
        match self {
            Self::Mp4(settings) => settings.fps,
            Self::Gif(settings) => settings.fps,
            Self::Mov(settings) => settings.fps,
        }
    }

    fn force_ffmpeg_decoder(&self) -> bool {
        match self {
            Self::Mp4(settings) => settings.force_ffmpeg_decoder,
            Self::Gif(_) | Self::Mov(_) => false,
        }
    }

    fn cursor_only(&self) -> bool {
        match self {
            Self::Mov(settings) => settings.cursor_only,
            Self::Mp4(_) | Self::Gif(_) => false,
        }
    }
}

fn default_fps(format: ExportFormat) -> u32 {
    match format {
        ExportFormat::Mp4 | ExportFormat::Mov => 60,
        ExportFormat::Gif => 30,
    }
}

fn parse_resolution(value: &str) -> Result<XY<u32>, String> {
    let (w, h) = value
        .split_once(['x', 'X'])
        .ok_or_else(|| format!("Invalid resolution '{value}', expected WIDTHxHEIGHT"))?;
    let width: u32 = w
        .trim()
        .parse()
        .map_err(|_| format!("Invalid resolution width in '{value}'"))?;
    let height: u32 = h
        .trim()
        .parse()
        .map_err(|_| format!("Invalid resolution height in '{value}'"))?;
    if width == 0 || height == 0 {
        return Err(format!("Resolution '{value}' must be greater than zero"));
    }
    Ok(XY::new(width, height))
}

pub fn settings_from_flags(flags: &ExportFlags) -> Result<CliExportSettings, String> {
    let format = flags.format.unwrap_or(ExportFormat::Mp4);
    let fps = flags.fps.unwrap_or_else(|| default_fps(format));
    if fps == 0 {
        return Err("--fps must be greater than zero".to_string());
    }
    let resolution_base = match &flags.resolution {
        Some(value) => parse_resolution(value)?,
        None => XY::new(1920, 1080),
    };

    match format {
        ExportFormat::Mp4 => Ok(CliExportSettings::Mp4(cap_export::mp4::Mp4ExportSettings {
            fps,
            resolution_base,
            compression: flags
                .quality
                .map(Into::into)
                .unwrap_or(cap_export::mp4::ExportCompression::Maximum),
            custom_bpp: None,
            force_ffmpeg_decoder: flags.force_ffmpeg_decoder,
            optimize_filesize: flags.optimize_filesize,
        })),
        ExportFormat::Gif => {
            if flags.quality.is_some() {
                return Err(
                    "--quality is only supported for --format mp4; use --settings-json for GIF quality"
                        .to_string(),
                );
            }
            if flags.optimize_filesize {
                return Err("--optimize-filesize is only supported for --format mp4".to_string());
            }
            Ok(CliExportSettings::Gif(cap_export::gif::GifExportSettings {
                fps,
                resolution_base,
                quality: None,
            }))
        }
        ExportFormat::Mov => {
            if flags.quality.is_some() {
                return Err("--quality is only supported for --format mp4".to_string());
            }
            if flags.optimize_filesize {
                return Err("--optimize-filesize is only supported for --format mp4".to_string());
            }
            Ok(CliExportSettings::Mov(cap_export::mov::MovExportSettings {
                fps,
                resolution_base,
                cursor_only: false,
            }))
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ExportProgressMessage<'a> {
    Progress {
        rendered_count: u32,
        total_frames: u32,
    },
    Completed {
        path: &'a std::path::Path,
    },
    // Field is named `error` (not `message`) so a single `"error" in obj` predicate detects failure
    // across every JSON-emitting command. The desktop sidecar only parses Progress/Completed, so the
    // PascalCase `type` tag stays for back-compat while this terminal field is free to standardize.
    Error {
        error: &'a str,
    },
}

impl Export {
    fn resolve_output(&self) -> Result<Option<PathBuf>, String> {
        match (&self.output, &self.output_path) {
            (Some(_), Some(_)) => Err(
                "Specify the output path either positionally or with --output, not both"
                    .to_string(),
            ),
            (Some(path), None) | (None, Some(path)) => Ok(Some(path.clone())),
            (None, None) => Ok(None),
        }
    }

    fn resolve_settings(&self) -> Result<CliExportSettings, String> {
        let flags = ExportFlags {
            format: self.format,
            fps: self.fps,
            resolution: self.resolution.clone(),
            quality: self.quality,
            optimize_filesize: self.optimize_filesize,
            force_ffmpeg_decoder: self.force_ffmpeg_decoder,
        };

        match &self.settings_json {
            Some(json) => {
                if flags.is_set() {
                    return Err(
                        "--settings-json cannot be combined with --format/--fps/--resolution/--quality/--optimize-filesize"
                            .to_string(),
                    );
                }
                serde_json::from_str(json).map_err(|e| format!("Invalid export settings JSON: {e}"))
            }
            None => settings_from_flags(&flags),
        }
    }

    pub async fn run(self, json: bool) -> Result<(), String> {
        // The global --json flag is the agent-facing way to ask for machine-readable output; it
        // implies both NDJSON streams so export matches the rest of the CLI's --json convention.
        // --progress-json / --completion-json remain for the desktop sidecar, which passes them.
        let progress_json = self.progress_json || json;
        let completion_json = self.completion_json || json;
        let stdout = Arc::new(Mutex::new(stdout()));

        match self
            .run_inner(progress_json, completion_json, &stdout)
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                // Without this an agent streaming the NDJSON feed sees the stream stop with no
                // terminal marker; mirror record's Error event so failures stay machine-readable.
                if progress_json || completion_json {
                    let _ = emit_export_message(
                        &stdout,
                        &ExportProgressMessage::Error { error: &error },
                    );
                }
                Err(error)
            }
        }
    }

    async fn run_inner(
        self,
        progress_json: bool,
        completion_json: bool,
        stdout: &Arc<Mutex<std::io::Stdout>>,
    ) -> Result<(), String> {
        let output = self.resolve_output()?;
        let settings = self.resolve_settings()?;

        ensure_remuxed(self.project_path.clone()).await?;
        let meta = RecordingMeta::load_for_project(&self.project_path)
            .map_err(|e| format!("Failed to load recording meta: {e}"))?;

        if matches!(&meta.inner, RecordingMetaInner::Instant(_)) {
            return export_instant_project(
                self.project_path,
                output,
                &settings,
                progress_json,
                completion_json,
                stdout,
            )
            .await;
        }

        let force_ffmpeg_decoder = self.force_ffmpeg_decoder || settings.force_ffmpeg_decoder();
        let mut builder = ExporterBase::builder(self.project_path.clone())
            .with_force_ffmpeg_decoder(force_ffmpeg_decoder);

        if let Some(output_path) = output {
            builder = builder.with_output_path(output_path);
        }

        if settings.cursor_only() {
            builder = builder.with_config(make_cursor_only_project(meta.project_config()));
        }

        let exporter_base = builder
            .build()
            .await
            .map_err(|v| format!("Exporter build error: {v}"))?;

        let total_frames = exporter_base.total_frames(settings.fps());

        if progress_json {
            emit_export_message(
                stdout,
                &ExportProgressMessage::Progress {
                    rendered_count: 0,
                    total_frames,
                },
            )?;
        }

        let rendered = Arc::new(AtomicU32::new(0));
        let progress_stdout = Arc::clone(stdout);
        let progress_rendered = Arc::clone(&rendered);
        let on_progress = move |frame_index: u32| {
            let count = (frame_index + 1).min(total_frames);
            progress_rendered.store(count, Ordering::Relaxed);
            if progress_json {
                // Progress I/O must never cancel the render. Every exporter treats a `false`
                // return as cancellation, so a transient stdout failure (closed pipe, poisoned
                // lock) is swallowed here rather than aborting the export.
                let _ = emit_export_message(
                    &progress_stdout,
                    &ExportProgressMessage::Progress {
                        rendered_count: count,
                        total_frames,
                    },
                );
            }
            true
        };

        let output_path = match settings {
            CliExportSettings::Mp4(settings) => settings.export(exporter_base, on_progress).await,
            CliExportSettings::Gif(settings) => settings.export(exporter_base, on_progress).await,
            CliExportSettings::Mov(settings) => settings.export(exporter_base, on_progress).await,
        }
        .map_err(|v| format!("Exporter error: {v}"))?;

        // Defense in depth: an export that renders no frames writes an empty (~few hundred byte) file
        // but otherwise "succeeds". An agent must never silently get/upload that, so fail loudly and
        // remove the empty artifact instead of reporting completion.
        if total_frames > 0 && rendered.load(Ordering::Relaxed) == 0 {
            let _ = std::fs::remove_file(&output_path);
            return Err(format!(
                "Export rendered 0 of {total_frames} frames; the recording may be unplayable. No output written."
            ));
        }

        if progress_json || completion_json {
            emit_export_message(
                stdout,
                &ExportProgressMessage::Completed { path: &output_path },
            )?;
        } else {
            // Default callers pass no JSON flag; the resolved path is otherwise invisible (the
            // tracing log below is gated behind --log-level), so emit it to stdout unconditionally.
            println!("Exported video to {}", output_path.display());
        }

        info!("Exported video to '{}'", output_path.display());

        Ok(())
    }
}

/// Remux a recording left as fragments (status `NeedsRemux`) into a progressive `display.mp4` before
/// export, reusing the shared `RecoveryManager`. A graceful `cap record` stop already remuxes in
/// `finalize`, so this only fires for recordings interrupted before that (e.g. a killed worker);
/// without it the exporter fails trying to open a fragment directory as a video. No-op for recordings
/// that are already progressive.
async fn ensure_remuxed(project_path: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
    })
    .await
    .map_err(|e| format!("recording remux task failed: {e}"))?
    .map_err(|e| format!("Failed to remux recording before export: {e}"))?;

    Ok(())
}

async fn prepare_instant_output(project_path: PathBuf) -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(move || {
        if let Some(output) = completed_instant_output(&project_path)? {
            return Ok(output);
        }
        let ownership = cap_recording::upload_resume::UploadLock::acquire(&project_path).map_err(
            |error| {
                format!(
                    "Instant output needs repair, but upload ownership is unavailable: {error}; local recording retained"
                )
            },
        )?;
        let project_path = ownership.project_path();
        if let Some(output) = completed_instant_output(project_path)? {
            return Ok(output);
        }
        cap_recording::recovery::RecoveryManager::finalize_instant_output(
            &project_path.join("content/display"),
            &project_path.join("content/audio"),
            &project_path.join("content/output.mp4"),
        )
        .map_err(|error| format!("Failed to finalize instant recording before export: {error}"))
    })
    .await
    .map_err(|error| format!("instant export finalize task failed: {error}"))?
}

fn completed_instant_output(project_path: &Path) -> Result<Option<PathBuf>, String> {
    for path in [project_path.to_path_buf(), project_path.join("content")] {
        if let Some(metadata) = instant_input_metadata(&path)?
            && !metadata.is_dir()
        {
            return Err("Invalid Instant recording directory; local recording retained".into());
        }
    }
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| format!("Failed to load Instant recording metadata: {error}"))?;
    let RecordingMetaInner::Instant(cap_project::InstantRecordingMeta::Complete {
        sample_rate,
        ..
    }) = meta.inner
    else {
        return Ok(None);
    };
    let mut required_audio = sample_rate.is_some();
    for (name, field) in [
        ("tauri-upload.json", "required_audio"),
        ("instant-upload.json", "requested_audio"),
    ] {
        let path = project_path.join(name);
        if let Some(metadata) = instant_input_metadata(&path)? {
            if !metadata.is_file() || metadata.len() > 65536 {
                return Err("Invalid Instant upload intent; local recording retained".into());
            }
            let intent: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| format!("Invalid Instant upload intent: {error}"))?;
            if let Some(value) = intent.get(field).filter(|value| !value.is_null()) {
                required_audio |= value
                    .as_bool()
                    .ok_or("Invalid Instant audio intent; local recording retained")?;
            }
        }
    }
    let audio_dir = project_path.join("content/audio");
    let audio_metadata = instant_input_metadata(&audio_dir)?;
    let has_audio_directory = audio_metadata.is_some();
    let mut has_audio_sources = false;
    if let Some(metadata) = audio_metadata {
        if !metadata.is_dir() {
            return Err("Invalid Instant audio directory; local recording retained".into());
        }
        for entry in std::fs::read_dir(audio_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let is_audio_media = path.extension().is_some_and(|extension| {
                ["m4s", "mp4", "ogg", "aac", "wav", "webm", "m4a"]
                    .iter()
                    .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            });
            if let Some(metadata) = instant_input_metadata(&path)?
                && is_audio_media
                && metadata.is_file()
                && metadata.len() > 0
            {
                required_audio = true;
                has_audio_sources = true;
            }
        }
    }
    let output = project_path.join("content/output.mp4");
    if !required_audio
        && !has_audio_directory
        && instant_input_metadata(&output)?
            .is_some_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        return Ok(Some(output));
    }
    match cap_recording::recovery::RecoveryManager::validate_instant_output(
        project_path,
        required_audio,
    ) {
        Ok(output) => Ok(Some(output)),
        Err(error) if required_audio && !has_audio_sources => Err(format!(
            "Instant output failed validation and required audio cannot be repaired: {error}; local recording retained"
        )),
        Err(_) => Ok(None),
    }
}

fn instant_input_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Instant input is a reparse point; local recording retained".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("Instant input is a symbolic link; local recording retained".into());
    }
    Ok(Some(metadata))
}

fn instant_export_settings_supported(settings: &CliExportSettings) -> bool {
    match settings {
        CliExportSettings::Mp4(settings) => {
            settings.fps == 60
                && settings.resolution_base == XY::new(1920, 1080)
                && matches!(
                    settings.compression,
                    cap_export::mp4::ExportCompression::Maximum
                )
                && settings.custom_bpp.is_none()
                && !settings.optimize_filesize
        }
        CliExportSettings::Gif(_) | CliExportSettings::Mov(_) => false,
    }
}

fn validate_instant_output_path(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| !extension.eq_ignore_ascii_case("mp4"))
    {
        return Err("Instant recordings can only be exported as mp4 files".to_string());
    }

    Ok(())
}

fn copy_instant_output(source_path: &Path, output_path: PathBuf) -> Result<PathBuf, String> {
    validate_instant_output_path(&output_path)?;

    if source_path == output_path.as_path() {
        return Ok(output_path);
    }

    if output_path.exists()
        && let (Ok(source), Ok(output)) = (source_path.canonicalize(), output_path.canonicalize())
        && source == output
    {
        return Ok(output_path);
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create output directory {}: {e}",
                parent.display()
            )
        })?;
    }

    std::fs::copy(source_path, &output_path).map_err(|e| {
        format!(
            "Failed to copy instant recording from {} to {}: {e}",
            source_path.display(),
            output_path.display()
        )
    })?;

    Ok(output_path)
}

async fn export_instant_project(
    project_path: PathBuf,
    output: Option<PathBuf>,
    settings: &CliExportSettings,
    progress_json: bool,
    completion_json: bool,
    stdout: &Arc<Mutex<std::io::Stdout>>,
) -> Result<(), String> {
    if !instant_export_settings_supported(settings) {
        return Err(
            "Instant recordings are already finalized MP4 files; export supports copying them to an mp4 output path"
                .to_string(),
        );
    }

    let source_path = prepare_instant_output(project_path).await?;
    let output_path = output.unwrap_or_else(|| source_path.clone());

    if progress_json {
        emit_export_message(
            stdout,
            &ExportProgressMessage::Progress {
                rendered_count: 0,
                total_frames: 1,
            },
        )?;
    }

    let output_path = copy_instant_output(&source_path, output_path)?;

    if progress_json {
        emit_export_message(
            stdout,
            &ExportProgressMessage::Progress {
                rendered_count: 1,
                total_frames: 1,
            },
        )?;
    }

    if progress_json || completion_json {
        emit_export_message(
            stdout,
            &ExportProgressMessage::Completed { path: &output_path },
        )?;
    } else {
        println!("Exported video to {}", output_path.display());
    }

    info!("Exported instant video to '{}'", output_path.display());

    Ok(())
}

/// Render a project to its default output path with default settings (mp4, 1080p60, Maximum). Used by
/// `cap upload --export` to glue record -> export -> upload into one step.
pub async fn export_project_default(project_path: PathBuf) -> Result<PathBuf, String> {
    let settings = settings_from_flags(&ExportFlags::default())?;
    ensure_remuxed(project_path.clone()).await?;
    let meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;
    if matches!(&meta.inner, RecordingMetaInner::Instant(_)) {
        return prepare_instant_output(project_path).await;
    }

    let exporter_base = ExporterBase::builder(project_path)
        .with_force_ffmpeg_decoder(settings.force_ffmpeg_decoder())
        .build()
        .await
        .map_err(|v| format!("Exporter build error: {v}"))?;

    let total_frames = exporter_base.total_frames(settings.fps());
    let rendered = Arc::new(AtomicU32::new(0));
    let progress_rendered = Arc::clone(&rendered);
    let on_progress = move |frame_index: u32| {
        progress_rendered.store((frame_index + 1).min(total_frames), Ordering::Relaxed);
        true
    };

    let output_path = match settings {
        CliExportSettings::Mp4(settings) => settings.export(exporter_base, on_progress).await,
        CliExportSettings::Gif(settings) => settings.export(exporter_base, on_progress).await,
        CliExportSettings::Mov(settings) => settings.export(exporter_base, on_progress).await,
    }
    .map_err(|v| format!("Exporter error: {v}"))?;

    // Same 0-frame guard as Export::run_inner: a recording with missing media renders an empty,
    // unplayable file that otherwise "succeeds", and `cap upload --export` would sign + upload it and
    // hand back a valid-looking link. Fail loudly and remove the artifact instead.
    if total_frames > 0 && rendered.load(Ordering::Relaxed) == 0 {
        let _ = std::fs::remove_file(&output_path);
        return Err(format!(
            "Export rendered 0 of {total_frames} frames; the recording may be unplayable. No output written."
        ));
    }

    Ok(output_path)
}

#[derive(Args)]
pub struct ExportPreview {
    project_path: PathBuf,
    #[arg(long)]
    frame_time: f64,
    #[arg(long)]
    settings_json: String,
    #[arg(long)]
    force_ffmpeg_decoder: bool,
}

impl ExportPreview {
    pub async fn run(self) -> Result<(), String> {
        match self.run_inner().await {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = crate::write_json(&serde_json::json!({ "error": error }));
                Err(error)
            }
        }
    }

    async fn run_inner(self) -> Result<(), String> {
        let settings =
            serde_json::from_str::<cap_export::preview::ExportPreviewSettings>(&self.settings_json)
                .map_err(|e| format!("Invalid preview settings JSON: {e}"))?;
        let result = cap_export::preview::render_preview(
            self.project_path,
            self.frame_time,
            settings,
            self.force_ffmpeg_decoder,
        )
        .await
        .map_err(|e| format!("Preview render error: {e}"))?;

        let mut stdout = stdout();
        serde_json::to_writer(&mut stdout, &result).map_err(|e| e.to_string())?;
        writeln!(&mut stdout).map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())
    }
}

fn emit_export_message(
    stdout: &Arc<Mutex<std::io::Stdout>>,
    message: &ExportProgressMessage<'_>,
) -> Result<(), String> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| "Failed to lock stdout".to_string())?;
    serde_json::to_writer(&mut *stdout, message).map_err(|e| e.to_string())?;
    writeln!(&mut *stdout).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playable_instant_project() -> tempfile::TempDir {
        ffmpeg::init().unwrap();
        let project = tempfile::tempdir().unwrap();
        let content = project.path().join("content");
        std::fs::create_dir(&content).unwrap();
        let mut output = ffmpeg::format::output(&content.join("output.mp4")).unwrap();
        let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::MPEG4).unwrap();
        let mut encoder = ffmpeg::codec::Context::new_with_codec(codec)
            .encoder()
            .video()
            .unwrap();
        encoder.set_width(32);
        encoder.set_height(32);
        encoder.set_format(ffmpeg::format::Pixel::YUV420P);
        encoder.set_time_base((1, 30));
        encoder.set_frame_rate(Some((30, 1)));
        encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        let mut encoder = encoder.open_as(codec).unwrap();
        output.add_stream(codec).unwrap().set_parameters(&encoder);
        output.write_header().unwrap();
        let output_time_base = output.stream(0).unwrap().time_base();
        {
            let mut drain = |encoder: &mut ffmpeg::encoder::video::Encoder, finished: bool| loop {
                let mut packet = ffmpeg::Packet::empty();
                match encoder.receive_packet(&mut packet) {
                    Ok(()) => {
                        packet.set_stream(0);
                        packet.rescale_ts((1, 30), output_time_base);
                        packet.write_interleaved(&mut output).unwrap();
                    }
                    Err(ffmpeg::Error::Other { errno })
                        if !finished && errno == ffmpeg::ffi::EAGAIN =>
                    {
                        break;
                    }
                    Err(ffmpeg::Error::Eof) if finished => break,
                    Err(error) => panic!("Synthetic video encoding failed: {error}"),
                }
            };
            for index in 0..30 {
                let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, 32, 32);
                frame.data_mut(0).fill(32 + index as u8);
                frame.data_mut(1).fill(128);
                frame.data_mut(2).fill(128);
                frame.set_pts(Some(index));
                encoder.send_frame(&frame).unwrap();
                drain(&mut encoder, false);
            }
            encoder.send_eof().unwrap();
            drain(&mut encoder, true);
        }
        output.write_trailer().unwrap();
        drop(output);
        RecordingMeta {
            project_path: project.path().to_path_buf(),
            platform: None,
            pretty_name: "Owned Instant fixture".into(),
            sharing: None,
            inner: RecordingMetaInner::Instant(cap_project::InstantRecordingMeta::Complete {
                fps: 30,
                sample_rate: None,
            }),
            upload: None,
        }
        .save_for_project()
        .unwrap();
        project
    }

    #[tokio::test]
    async fn completed_instant_export_is_read_only_while_upload_owns_the_project() {
        let project = playable_instant_project();
        std::fs::create_dir(project.path().join("content/audio")).unwrap();
        let output = project.path().join("content/output.mp4");
        let before = std::fs::read(&output).unwrap();
        let _upload = cap_recording::upload_resume::UploadLock::acquire(project.path()).unwrap();
        assert_eq!(
            prepare_instant_output(project.path().to_path_buf())
                .await
                .unwrap(),
            output
        );
        let exported = project.path().join("copy.mp4");
        assert_eq!(
            copy_instant_output(&output, exported.clone()).unwrap(),
            exported
        );
        assert_eq!(std::fs::read(&output).unwrap(), before);
        assert_eq!(std::fs::read(&exported).unwrap(), before);
        assert!(!project.path().join(".recovery.lock").exists());
    }

    #[tokio::test]
    async fn instant_export_needing_repair_cannot_rewrite_an_owned_upload() {
        let project = playable_instant_project();
        std::fs::create_dir(project.path().join("content/audio")).unwrap();
        let output = project.path().join("content/output.mp4");
        std::fs::write(&output, b"broken media must remain available for repair").unwrap();
        let before = std::fs::read(&output).unwrap();
        let _upload = cap_recording::upload_resume::UploadLock::acquire(project.path()).unwrap();
        let error = prepare_instant_output(project.path().to_path_buf())
            .await
            .unwrap_err();
        assert!(error.contains("Another upload owns this recording"));
        assert_eq!(std::fs::read(&output).unwrap(), before);
        assert!(!project.path().join(".recovery.lock").exists());
    }

    #[tokio::test]
    async fn instant_export_cannot_ignore_persisted_or_recorded_audio() {
        for intent in ["tauri-upload.json", "instant-upload.json", "audio-media"] {
            let project = playable_instant_project();
            let output = project.path().join("content/output.mp4");
            let before = std::fs::read(&output).unwrap();
            match intent {
                "tauri-upload.json" => {
                    std::fs::write(project.path().join(intent), br#"{"required_audio":true}"#)
                        .unwrap();
                }
                "instant-upload.json" => {
                    std::fs::write(project.path().join(intent), br#"{"requested_audio":true}"#)
                        .unwrap();
                }
                _ => {
                    let audio = project.path().join("content/audio");
                    std::fs::create_dir(&audio).unwrap();
                    std::fs::write(audio.join("segment_001.m4s"), b"retained audio source")
                        .unwrap();
                }
            }
            let _upload =
                cap_recording::upload_resume::UploadLock::acquire(project.path()).unwrap();
            assert!(
                prepare_instant_output(project.path().to_path_buf())
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read(output).unwrap(), before);
        }
    }

    #[test]
    fn default_flags_produce_maximum_mp4_1080p60() {
        let settings = settings_from_flags(&ExportFlags::default()).unwrap();
        match settings {
            CliExportSettings::Mp4(s) => {
                assert_eq!(s.fps, 60);
                assert_eq!(s.resolution_base, XY::new(1920, 1080));
                assert!(matches!(
                    s.compression,
                    cap_export::mp4::ExportCompression::Maximum
                ));
                assert!(!s.optimize_filesize);
            }
            _ => panic!("expected mp4 settings"),
        }
    }

    #[test]
    fn gif_default_fps_is_30() {
        let settings = settings_from_flags(&ExportFlags {
            format: Some(ExportFormat::Gif),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(settings.fps(), 30);
        assert!(matches!(settings, CliExportSettings::Gif(_)));
    }

    #[test]
    fn resolution_and_fps_overrides_apply() {
        let settings = settings_from_flags(&ExportFlags {
            format: Some(ExportFormat::Mp4),
            fps: Some(24),
            resolution: Some("1280x720".to_string()),
            quality: Some(QualityArg::Web),
            ..Default::default()
        })
        .unwrap();
        match settings {
            CliExportSettings::Mp4(s) => {
                assert_eq!(s.fps, 24);
                assert_eq!(s.resolution_base, XY::new(1280, 720));
                assert!(matches!(
                    s.compression,
                    cap_export::mp4::ExportCompression::Web
                ));
            }
            _ => panic!("expected mp4 settings"),
        }
    }

    #[test]
    fn parse_resolution_accepts_upper_and_lower_x() {
        assert_eq!(parse_resolution("800x600").unwrap(), XY::new(800, 600));
        assert_eq!(parse_resolution("800X600").unwrap(), XY::new(800, 600));
    }

    #[test]
    fn parse_resolution_rejects_garbage() {
        assert!(parse_resolution("nonsense").is_err());
        assert!(parse_resolution("1920x").is_err());
        assert!(parse_resolution("0x1080").is_err());
    }

    #[test]
    fn zero_fps_is_rejected() {
        let result = settings_from_flags(&ExportFlags {
            fps: Some(0),
            ..Default::default()
        });
        assert!(result.is_err());
    }

    #[test]
    fn quality_with_gif_is_rejected() {
        let result = settings_from_flags(&ExportFlags {
            format: Some(ExportFormat::Gif),
            quality: Some(QualityArg::Social),
            ..Default::default()
        });
        assert!(result.is_err());
    }

    #[test]
    fn quality_with_mov_is_rejected() {
        let result = settings_from_flags(&ExportFlags {
            format: Some(ExportFormat::Mov),
            quality: Some(QualityArg::Social),
            ..Default::default()
        });
        assert!(result.is_err());
    }

    #[test]
    fn settings_json_accepts_lowercase_and_pascalcase_format_tags() {
        let lower = r#"{"format":"mp4","fps":30,"resolution_base":{"x":1280,"y":720},"compression":"Web","custom_bpp":null}"#;
        assert!(matches!(
            serde_json::from_str::<CliExportSettings>(lower).unwrap(),
            CliExportSettings::Mp4(_)
        ));
        let pascal = lower.replace("\"mp4\"", "\"Mp4\"");
        assert!(matches!(
            serde_json::from_str::<CliExportSettings>(&pascal).unwrap(),
            CliExportSettings::Mp4(_)
        ));
    }

    #[test]
    fn optimize_filesize_only_for_mp4() {
        assert!(
            settings_from_flags(&ExportFlags {
                format: Some(ExportFormat::Mov),
                optimize_filesize: true,
                ..Default::default()
            })
            .is_err()
        );
    }
}
