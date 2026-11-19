//! Editor export page -- `routes/editor/ExportPage.tsx`, 1:1 layout.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cap_export::audio::AudioExportFormat;
use cap_export::estimates::{ExportEstimates, estimate_export, estimate_turbo_export};
use cap_export::gif::{GifExportSettings, GifQuality};
use cap_export::mov::MovExportSettings;
use cap_export::mp4::{ExportCompression, Mp4ExportSettings, turbo::TurboOptions};
use cap_export::preview::{
    ExportPreviewSettings, render_preview_with_config, render_preview_with_editor,
};
use cap_export::settings::ExportSettings;
use cap_export::tracks::{self, TrackKind, TrackProgress};
use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{BackgroundSource, RecordingMeta, XY};
use cap_utils::export_resources::{
    DiskBudget, ExportResources, estimated_working_bytes, is_resource_stop,
};
use gpui::{
    Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, RenderImage, StatefulInteractiveElement, Styled, Window, div, img,
    prelude::FluentBuilder, px, svg,
};

use crate::editor_window::EditorWindow;
use crate::i18n::tr;
use crate::sign_in::{SignIn, SignInEvent, SignInOrigin, SignInOutcome};
use crate::store::{self, ExportPrefs};
use crate::ui;
use crate::{library, platform};

const SIDEBAR_WIDTH: f32 = 400.;
const HEADER_HEIGHT: f32 = 52.;
const STAGE_PADDING_X: f32 = 24.;
/// Stage top padding, caption row, preview padding, stats card and bottom
/// padding: everything on the stage that is not the preview itself.
const STAGE_VERTICAL_CHROME: f32 = 16. + 22. + 14. + 18. + STATS_HEIGHT + 20.;
const STATS_HEIGHT: f32 = 44.;
const SEGMENT_HEIGHT: f32 = 26.;
const COMPRESSION_PRESETS: [(ExportCompression, fn() -> &'static str); 4] = [
    (
        ExportCompression::Potato,
        tr::editor::export::quality::potato,
    ),
    (ExportCompression::Web, tr::editor::export::quality::web),
    (
        ExportCompression::Social,
        tr::editor::export::quality::social,
    ),
    (
        ExportCompression::Maximum,
        tr::editor::export::quality::maximum,
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportDestination {
    File,
    Clipboard,
    Link,
}

impl ExportDestination {
    const ALL: &'static [Self] = &[Self::File, Self::Clipboard, Self::Link];

    fn label(self) -> &'static str {
        match self {
            Self::File => tr::editor::export::destination::file(),
            Self::Clipboard => tr::editor::export::destination::clipboard(),
            Self::Link => tr::editor::export::destination::link(),
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::File => "icons/folder.svg",
            Self::Clipboard => "icons/copy.svg",
            Self::Link => "icons/link.svg",
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Clipboard => "clipboard",
            Self::Link => "link",
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "clipboard" => Self::Clipboard,
            "link" => Self::Link,
            _ => Self::File,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormatKind {
    Mp4,
    Gif,
    Tracks,
    Audio,
}

impl ExportFormatKind {
    const ALL: [Self; 3] = [Self::Mp4, Self::Gif, Self::Tracks];

    fn label(self) -> &'static str {
        match self {
            Self::Mp4 => "MP4",
            Self::Gif => "GIF",
            Self::Tracks => tr::editor::export::tracks::format(),
            Self::Audio => tr::editor::export::audio::format(),
        }
    }

    fn options(audio_only: bool, visuals: bool) -> Vec<Self> {
        match (audio_only, visuals) {
            (false, _) => Self::ALL.to_vec(),
            (true, false) => vec![Self::Audio],
            (true, true) => vec![Self::Mp4, Self::Gif, Self::Audio],
        }
    }

    fn writes_video(self) -> bool {
        matches!(self, Self::Mp4 | Self::Gif)
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Mp4 => "Mp4",
            Self::Gif => "Gif",
            Self::Tracks => "Tracks",
            Self::Audio => "Audio",
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "Gif" => Self::Gif,
            "Tracks" => Self::Tracks,
            "Audio" => Self::Audio,
            _ => Self::Mp4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackOption {
    pub kind: TrackKind,
    pub size: Option<(u32, u32)>,
}

fn track_options(
    recordings: &cap_rendering::ProjectRecordingsMeta,
    project: &cap_project::ProjectConfiguration,
) -> Vec<TrackOption> {
    let used = |index: usize| {
        project.timeline.as_ref().is_none_or(|timeline| {
            timeline
                .segments
                .iter()
                .any(|segment| segment.recording_clip as usize == index)
        })
    };
    tracks::available_tracks(recordings, project)
        .into_iter()
        .map(|kind| {
            let size = recordings
                .segments
                .iter()
                .enumerate()
                .filter(|(index, _)| used(*index))
                .find_map(|(_, segment)| match kind {
                    TrackKind::Screen => Some((segment.display.width, segment.display.height)),
                    TrackKind::Camera => segment
                        .camera
                        .as_ref()
                        .map(|camera| (camera.width, camera.height)),
                    TrackKind::Microphone | TrackKind::SystemAudio => None,
                });
            TrackOption { kind, size }
        })
        .collect()
}

fn track_label(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Screen => tr::editor::export::tracks::screen(),
        TrackKind::Camera => tr::editor::export::tracks::camera(),
        TrackKind::Microphone => tr::editor::export::tracks::microphone(),
        TrackKind::SystemAudio => tr::editor::export::tracks::system_audio(),
    }
}

fn track_icon(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Screen => "icons/monitor-outline.svg",
        TrackKind::Camera => "icons/camera.svg",
        TrackKind::Microphone => "icons/microphone.svg",
        TrackKind::SystemAudio => "icons/audio-on.svg",
    }
}

fn track_toggle_id(kind: TrackKind) -> &'static str {
    match kind {
        TrackKind::Screen => "export-track-screen",
        TrackKind::Camera => "export-track-camera",
        TrackKind::Microphone => "export-track-microphone",
        TrackKind::SystemAudio => "export-track-system-audio",
    }
}

fn track_detail(option: &TrackOption) -> String {
    match option.size {
        Some((width, height)) => tr::editor::export::tracks::video_detail(width, height),
        None => tr::editor::export::tracks::audio_detail().into(),
    }
}

/// Every available track is on unless the user turned its kind off before.
/// If that leaves nothing, all of them are on again rather than none.
fn selected_tracks(options: &[TrackOption], excluded: &[TrackKind]) -> Vec<TrackKind> {
    let selected = options
        .iter()
        .map(|option| option.kind)
        .filter(|kind| !excluded.contains(kind))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        options.iter().map(|option| option.kind).collect()
    } else {
        selected
    }
}

fn estimated_tracks_bytes(
    options: &[TrackOption],
    selected: &[TrackKind],
    fps: u32,
    duration: f64,
) -> u64 {
    let bpp = ExportCompression::Maximum.bits_per_pixel() as f64;
    options
        .iter()
        .filter(|option| selected.contains(&option.kind))
        .map(|option| match option.size {
            Some((width, height)) => {
                width as f64 * height as f64 * fps as f64 * bpp / 8.0 * duration
            }
            None => 48_000.0 * 2.0 * 3.0 * duration,
        })
        .sum::<f64>()
        .max(0.0) as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GifQualityPreset {
    Low,
    Medium,
    High,
}

impl GifQualityPreset {
    const ALL: [Self; 3] = [Self::Low, Self::Medium, Self::High];

    fn label(self) -> &'static str {
        match self {
            Self::Low => tr::editor::export::quality::gif_low(),
            Self::Medium => tr::editor::export::quality::gif_medium(),
            Self::High => tr::editor::export::quality::gif_high(),
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Low => "Low",
            Self::Medium => "Medium",
            Self::High => "High",
        }
    }

    fn from_slug(slug: Option<&str>) -> Self {
        match slug {
            Some("Low") => Self::Low,
            Some("Medium") => Self::Medium,
            _ => Self::High,
        }
    }

    fn settings(self) -> Option<GifQuality> {
        let quality = match self {
            Self::Low => 50,
            Self::Medium => 70,
            Self::High => return None,
        };
        Some(GifQuality {
            quality: Some(quality),
            fast: None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExportResolution {
    P480,
    P720,
    P1080,
    P4k,
}

impl ExportResolution {
    fn label(self) -> &'static str {
        match self {
            Self::P480 => "480p",
            Self::P720 => "720p",
            Self::P1080 => "1080p",
            Self::P4k => "4K",
        }
    }

    fn size(self) -> (u32, u32) {
        match self {
            Self::P480 => (854, 480),
            Self::P720 => (1280, 720),
            Self::P1080 => (1920, 1080),
            Self::P4k => (3840, 2160),
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "480p" => Self::P480,
            "1080p" => Self::P1080,
            "4K" | "4k" => Self::P4k,
            _ => Self::P720,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportPhase {
    Idle,
    ChoosingFile,
    Starting,
    Rendering,
    Copying,
    Uploading,
    Done,
    Failed,
}

impl ExportPhase {
    pub(crate) fn is_busy(self) -> bool {
        matches!(
            self,
            Self::ChoosingFile | Self::Starting | Self::Rendering | Self::Copying | Self::Uploading
        )
    }

    fn shows_progress(self) -> bool {
        !matches!(self, Self::Idle | Self::ChoosingFile)
    }
}

pub struct PreviewStats {
    pub width: u32,
    pub height: u32,
    pub total_frames: u32,
    pub estimated_size_mb: f64,
}

fn screen_enhancement(enhance: bool) -> cap_project::ScreenEnhancement {
    if enhance {
        cap_project::ScreenEnhancement::on()
    } else {
        cap_project::ScreenEnhancement::default()
    }
}

pub struct ExportUi {
    pub destination: ExportDestination,
    pub format: ExportFormatKind,
    pub resolution: ExportResolution,
    pub fps: u32,
    pub compression: ExportCompression,
    pub gif_quality: GifQualityPreset,
    pub optimize_filesize: bool,
    pub enhance_quality: bool,
    pub turbo: bool,
    pub cursor_only: bool,
    pub custom_bpp: Option<f32>,
    pub force_ffmpeg: bool,
    pub advanced_open: bool,
    pub preview: Option<Arc<RenderImage>>,
    pub preview_stats: Option<PreviewStats>,
    pub preview_error: Option<String>,
    pub preview_task: Option<gpui::Task<()>>,
    preview_request: Arc<()>,
    estimate: Option<ExportEstimates>,
    estimate_loading: bool,
    estimate_cancel: Arc<AtomicBool>,
    pub phase: ExportPhase,
    close_requested: bool,
    pub rendered: u32,
    pub total_frames: u32,
    pub output_path: Option<PathBuf>,
    pub error: Option<String>,
    pub cancel: Arc<AtomicBool>,
    pub export_task: Option<gpui::Task<()>>,
    /// The server answered the last share with 401: the stored credential is
    /// dead even though one exists, so the CTA offers sign-in again instead of
    /// another upload that would fail the same way.
    auth_rejected: bool,
    sign_in_subscriptions: Option<[gpui::Subscription; 2]>,
    pub organization_id: Option<String>,
    pub share_link: Option<String>,
    pub reuploading: bool,
    pub upload_progress: f32,
    pub copy_link_pressed: bool,
    bpp_track: ui::SliderTrack,
    bpp_dragging: bool,
    pub track_options: Vec<TrackOption>,
    pub tracks: Vec<TrackKind>,
    excluded_tracks: Vec<TrackKind>,
    resolution_from_source: bool,
    fps_from_source: bool,
    source: ExportSource,
    pub audio_format: AudioExportFormat,
    /// The video format saved before an audio export took over the pill, so
    /// exporting sound once does not change what the next video export
    /// opens with.
    saved_format: ExportFormatKind,
}

/// What the project renders from: its output size before any export scaling
/// (crop and padding included) and its highest recorded frame rate.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ExportSource {
    pub size: Option<XY<u32>>,
    pub fps: Option<u32>,
}

impl Drop for ExportUi {
    fn drop(&mut self) {
        self.estimate_cancel.store(true, Ordering::Release);
    }
}

const BPP_MIN: f32 = 0.02;
const BPP_MAX: f32 = 0.5;
const BPP_STEP: f32 = 0.01;

impl ExportUi {
    fn pick_default_organization(&mut self) {
        let organizations = store::auth_snapshot().organizations;
        if self
            .organization_id
            .as_ref()
            .is_some_and(|id| organizations.iter().any(|org| &org.id == id))
        {
            return;
        }
        if let Some(org) = organizations.first() {
            self.organization_id = Some(org.id.clone());
            self.persist();
        }
    }

    pub fn load() -> Self {
        let prefs = store::load().export.unwrap_or(ExportPrefs {
            format: "Mp4".into(),
            fps: 60,
            export_to: "file".into(),
            resolution: "1080p".into(),
            compression: "Maximum".into(),
            optimize_filesize: false,
            cursor_only: false,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            advanced_open: false,
            organization_id: None,
            turbo: false,
            gif_quality: None,
            excluded_tracks: None,
            resolution_from_source: true,
            fps_from_source: true,
            audio_format: None,
            enhance_quality: false,
        });
        Self::from_preferences(prefs)
    }

    fn from_preferences(prefs: ExportPrefs) -> Self {
        Self {
            destination: ExportDestination::from_slug(&prefs.export_to),
            format: ExportFormatKind::from_slug(&prefs.format),
            resolution: ExportResolution::from_slug(&prefs.resolution),
            fps: prefs.fps,
            compression: match prefs.compression.as_str() {
                "Social" => ExportCompression::Social,
                "Web" => ExportCompression::Web,
                "Potato" => ExportCompression::Potato,
                _ => ExportCompression::Maximum,
            },
            gif_quality: GifQualityPreset::from_slug(prefs.gif_quality.as_deref()),
            optimize_filesize: prefs.optimize_filesize,
            enhance_quality: prefs.enhance_quality,
            turbo: prefs.turbo && turbo_available(),
            cursor_only: prefs.cursor_only,
            custom_bpp: prefs.custom_bpp,
            force_ffmpeg: prefs.force_ffmpeg_decoder,
            advanced_open: prefs.advanced_open,
            preview: None,
            preview_stats: None,
            preview_error: None,
            preview_task: None,
            preview_request: Arc::new(()),
            estimate: None,
            estimate_loading: false,
            estimate_cancel: Arc::new(AtomicBool::new(false)),
            phase: ExportPhase::Idle,
            close_requested: false,
            rendered: 0,
            total_frames: 0,
            output_path: None,
            error: None,
            cancel: Arc::new(AtomicBool::new(false)),
            export_task: None,
            auth_rejected: false,
            sign_in_subscriptions: None,
            organization_id: prefs.organization_id,
            share_link: None,
            reuploading: false,
            upload_progress: 0.0,
            copy_link_pressed: false,
            bpp_track: ui::SliderTrack::default(),
            bpp_dragging: false,
            track_options: Vec::new(),
            tracks: Vec::new(),
            excluded_tracks: prefs
                .excluded_tracks
                .iter()
                .flatten()
                .filter_map(|slug| TrackKind::from_slug(slug))
                .collect(),
            resolution_from_source: prefs.resolution_from_source,
            fps_from_source: prefs.fps_from_source,
            source: ExportSource::default(),
            audio_format: match prefs.audio_format.as_deref() {
                Some("wav") => AudioExportFormat::Wav,
                _ => AudioExportFormat::Mp3,
            },
            saved_format: ExportFormatKind::from_slug(&prefs.format),
        }
    }

    fn choose_resolution(&mut self, resolution: ExportResolution) {
        self.resolution = resolution;
        self.resolution_from_source = false;
    }

    fn choose_fps(&mut self, fps: u32) {
        self.fps = fps;
        self.fps_from_source = false;
    }

    fn set_track_options(&mut self, options: Vec<TrackOption>) {
        self.tracks = selected_tracks(&options, &self.excluded_tracks);
        self.track_options = options;
        if self.format == ExportFormatKind::Tracks && self.track_options.is_empty() {
            self.format = ExportFormatKind::Mp4;
        }
    }

    /// Switches to separate tracks, for the `CAP_GPUI_AUTO_EXPORT*` hooks:
    /// the comma-separated track slugs given, or the current selection.
    pub(crate) fn use_tracks(&mut self, slugs: Option<&str>) {
        if self.track_options.is_empty() {
            return;
        }
        self.format = ExportFormatKind::Tracks;
        self.destination = ExportDestination::File;
        self.cursor_only = false;
        if let Some(slugs) = slugs {
            let mut tracks = slugs
                .split(',')
                .filter_map(TrackKind::from_slug)
                .filter(|kind| self.track_options.iter().any(|option| option.kind == *kind))
                .collect::<Vec<_>>();
            tracks.sort();
            tracks.dedup();
            self.tracks = tracks;
        }
    }

    fn toggle_track(&mut self, kind: TrackKind) {
        if let Some(index) = self.tracks.iter().position(|track| *track == kind) {
            self.tracks.remove(index);
            if !self.excluded_tracks.contains(&kind) {
                self.excluded_tracks.push(kind);
            }
        } else if self.track_options.iter().any(|option| option.kind == kind) {
            self.tracks.push(kind);
            self.tracks.sort();
            self.excluded_tracks.retain(|excluded| *excluded != kind);
        }
    }

    fn update_preview(&mut self, request: &Arc<()>, update: impl FnOnce(&mut Self)) -> bool {
        if !Arc::ptr_eq(&self.preview_request, request) {
            return false;
        }
        update(self);
        true
    }

    fn persist(&mut self) {
        self.remember_video_format();
        let prefs = self.preferences();
        store::update(|state| state.export = Some(prefs));
    }

    /// Every change to a video format becomes the one an audio export hands
    /// back, so leaving Audio restores the latest choice, not the opening one.
    fn remember_video_format(&mut self) {
        if self.format != ExportFormatKind::Audio {
            self.saved_format = self.format;
        }
    }

    fn preferences(&self) -> ExportPrefs {
        ExportPrefs {
            format: if self.format == ExportFormatKind::Audio {
                self.saved_format.slug().to_string()
            } else {
                self.format.slug().to_string()
            },
            fps: self.fps,
            export_to: self.destination.slug().to_string(),
            resolution: self.resolution.label().to_string(),
            compression: format!("{:?}", self.compression),
            optimize_filesize: self.optimize_filesize,
            enhance_quality: self.enhance_quality,
            cursor_only: self.cursor_only,
            custom_bpp: self.custom_bpp,
            force_ffmpeg_decoder: self.force_ffmpeg,
            advanced_open: self.advanced_open,
            organization_id: self.organization_id.clone(),
            turbo: self.turbo,
            gif_quality: Some(self.gif_quality.slug().to_string()),
            excluded_tracks: (!self.excluded_tracks.is_empty()).then(|| {
                self.excluded_tracks
                    .iter()
                    .map(|kind| kind.slug().to_string())
                    .collect()
            }),
            resolution_from_source: self.resolution_from_source,
            fps_from_source: self.fps_from_source,
            audio_format: (self.audio_format == AudioExportFormat::Wav)
                .then(|| self.audio_format.extension().to_string()),
        }
    }

    fn bpp(&self) -> f32 {
        self.custom_bpp
            .unwrap_or_else(|| self.compression.bits_per_pixel())
    }

    fn estimate_settings(&self) -> ExportSettings {
        let (width, height) = self.resolution.size();
        let resolution_base = XY::new(width, height);
        if self.cursor_only {
            ExportSettings::Mov(MovExportSettings {
                fps: self.fps,
                resolution_base,
                cursor_only: true,
            })
        } else if self.format == ExportFormatKind::Gif {
            ExportSettings::Gif(GifExportSettings {
                fps: self.fps,
                resolution_base,
                quality: self.gif_quality.settings(),
            })
        } else {
            ExportSettings::Mp4(Mp4ExportSettings {
                fps: self.fps,
                resolution_base,
                compression: self.compression,
                custom_bpp: self.custom_bpp,
                force_ffmpeg_decoder: self.force_ffmpeg,
                optimize_filesize: self.optimize_filesize,
            })
        }
    }

    fn gif_preview_quality(&self) -> Option<GifQuality> {
        (self.format == ExportFormatKind::Gif && !self.cursor_only).then(|| {
            self.gif_quality.settings().unwrap_or(GifQuality {
                quality: None,
                fast: None,
            })
        })
    }

    fn is_custom_bpp(&self) -> bool {
        self.custom_bpp
            .is_some_and(|bpp| (bpp - self.compression.bits_per_pixel()).abs() > 0.001)
    }

    fn complete_share_export(&mut self, link: String, copy_link: impl FnOnce(String)) {
        if self.close_requested || self.cancel.load(Ordering::Relaxed) {
            self.phase = ExportPhase::Idle;
            return;
        }

        self.phase = ExportPhase::Done;
        self.share_link = Some(link.clone());
        self.upload_progress = 1.0;
        copy_link(link);
    }

    fn clipboard_retry_path(&self) -> Option<&Path> {
        if self.phase == ExportPhase::Failed && self.destination == ExportDestination::Clipboard {
            self.output_path.as_deref()
        } else {
            None
        }
    }

    fn copy_completed_export(
        &mut self,
        path: PathBuf,
        copy: impl FnOnce(&Path) -> Result<(), String>,
    ) {
        self.output_path = Some(path.clone());
        self.error = None;
        if self.close_requested || self.cancel.load(Ordering::Relaxed) {
            self.phase = ExportPhase::Idle;
            return;
        }

        self.phase = ExportPhase::Copying;
        match copy(&path) {
            Ok(()) => self.phase = ExportPhase::Done,
            Err(error) => {
                self.phase = ExportPhase::Failed;
                self.error = Some(error);
            }
        }
    }
}

fn has_transparent_background(project: &cap_project::ProjectConfiguration) -> bool {
    matches!(
        project.background.source,
        BackgroundSource::Color { alpha, .. } if alpha < 255
    )
}

fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

pub(crate) fn export_file_name(pretty_name: &str, extension: &str) -> String {
    format!(
        "{}.{extension}",
        export_name_stem(pretty_name, extension.len() + 1)
    )
}

/// The project's name made safe for a file or folder on every platform,
/// leaving `reserved` bytes of the 255-byte limit for a suffix.
fn export_name_stem(pretty_name: &str, reserved: usize) -> String {
    let mut name = sanitize_filename::sanitize_with_options(
        pretty_name,
        sanitize_filename::Options {
            windows: true,
            ..Default::default()
        },
    );
    while name.len() > 255 - reserved {
        let _ = name.pop();
    }
    if name.trim().is_empty() {
        name = "Cap Recording".into();
    }
    name
}

fn format_estimate_range(range: [f64; 2], time: bool) -> String {
    type Single = fn(String) -> String;
    type Range = fn(String, String) -> String;
    if range[1] < 1.0 {
        return if time {
            tr::editor::export::estimate::under_second()
        } else {
            tr::editor::export::estimate::under_megabyte()
        }
        .into();
    }
    let (scale, single, range_of): (f64, Single, Range) = if time {
        if range[1] >= 3600.0 {
            (
                3600.0,
                tr::editor::export::estimate::hours,
                tr::editor::export::estimate::hours_range,
            )
        } else if range[1] >= 60.0 {
            (
                60.0,
                tr::editor::export::estimate::minutes,
                tr::editor::export::estimate::minutes_range,
            )
        } else {
            (
                1.0,
                tr::editor::export::estimate::seconds,
                tr::editor::export::estimate::seconds_range,
            )
        }
    } else if range[1] >= 1024.0 {
        (
            1024.0,
            tr::editor::export::estimate::gigabytes,
            tr::editor::export::estimate::gigabytes_range,
        )
    } else {
        (
            1.0,
            tr::editor::export::estimate::megabytes,
            tr::editor::export::estimate::megabytes_range,
        )
    };
    let precision = if scale == 1.0 { 1.0 } else { 10.0 };
    let lower = ((range[0] / scale * precision).round() / precision).max(1.0 / precision);
    let upper = ((range[1] / scale * precision).round() / precision).max(lower);
    if lower == upper {
        single(crate::i18n::decimal(lower))
    } else {
        range_of(crate::i18n::decimal(lower), crate::i18n::decimal(upper))
    }
}

fn decode_jpeg_bytes(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let rgba = cap_gpui_kernels::codec::decode_jpeg_to_bgra(bytes)?;
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(rgba)
    ])))
}

impl EditorWindow {
    pub(crate) fn render_reupload_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .rounded(px(8.))
            .bg(Hsla::from(self.theme.blue_3))
            .border_1()
            .border_color(Hsla::from(self.theme.blue_5))
            .child(
                ui::EditorButton::plain(&self.theme, "editor-reupload")
                    .left_icon("icons/cloud-upload.svg")
                    .label(tr::editor::export::reupload())
                    .tooltip(
                        &self.theme,
                        if has_transparent_background(&self.project) {
                            tr::editor::export::reupload_transparent()
                        } else {
                            tr::editor::export::reupload_tooltip()
                        },
                    )
                    .disabled(!self.project_ready() || has_transparent_background(&self.project))
                    .on_click(cx.listener(|this, _, window, cx| {
                        if !this.project_ready() {
                            return;
                        }
                        this.open_export(window, cx);
                        if !has_transparent_background(&this.project)
                            && let Some(ui) = this.export.as_mut()
                        {
                            ui.destination = ExportDestination::Link;
                            ui.format = ExportFormatKind::Mp4;
                            ui.cursor_only = false;
                        }
                        this.normalize_loaded_export_options();
                        this.refresh_export_preview(window, cx);
                        cx.notify();
                    })),
            )
    }

    pub(crate) fn open_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing {
            self.toggle_play_from_crop(cx);
        }
        let mut ui = ExportUi::load();
        ui.source = self.export_source();
        if let Ok(meta) = RecordingMeta::load_for_project(&self.project_path) {
            self.sharing = meta.sharing;
        }
        ui.set_track_options(
            self.summary()
                .map(|summary| track_options(&summary.recordings, &self.project))
                .unwrap_or_default(),
        );
        let formats = ExportFormatKind::options(self.is_audio_only(), self.audio_visuals_enabled());
        if !formats.contains(&ui.format) {
            ui.format = formats.first().copied().unwrap_or(ExportFormatKind::Mp4);
        }
        if has_transparent_background(&self.project) && ui.format.writes_video() {
            ui.format = ExportFormatKind::Gif;
            if ui.resolution == ExportResolution::P4k {
                ui.resolution = ExportResolution::P1080;
            }
            if ui.destination == ExportDestination::Link {
                ui.destination = ExportDestination::File;
            }
        }
        if (ui.cursor_only || !ui.format.writes_video())
            && ui.destination == ExportDestination::Link
        {
            ui.destination = ExportDestination::File;
        }
        self.normalize_export_options(&mut ui);
        self.export = Some(ui);
        self.subscribe_export_to_sign_in(window, cx);
        self.refresh_export_preview(window, cx);
        cx.notify();
    }

    pub(crate) fn close_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ui) = self.export.as_mut() {
            if ui.phase.is_busy() {
                ui.close_requested = true;
                ui.cancel.store(true, Ordering::Relaxed);
                cx.notify();
                return;
            }
            if let Some(image) = ui.preview.take() {
                let _ = window.drop_image(image);
            }
            ui.persist();
        }
        self.export = None;
        cx.notify();
    }

    fn finish_requested_export_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .export
            .as_ref()
            .is_some_and(|ui| ui.close_requested && !ui.phase.is_busy())
        {
            self.close_export(window, cx);
        }
    }

    fn copy_share_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(link) = self.export.as_ref().and_then(|ui| ui.share_link.clone()) else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
        if let Some(ui) = self.export.as_mut() {
            ui.copy_link_pressed = true;
        }
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.copy_link_pressed = false;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn normalize_export_options(&self, ui: &mut ExportUi) {
        normalize_export_options(ui, has_transparent_background(&self.project));
    }

    fn export_source(&self) -> ExportSource {
        let Some(summary) = self.summary() else {
            return ExportSource::default();
        };
        let segments = &summary.recordings.segments;
        let size = segments.first().map(|segment| {
            let options = cap_rendering::RenderOptions {
                camera_size: segment
                    .camera
                    .as_ref()
                    .map(|camera| XY::new(camera.width, camera.height)),
                screen_size: XY::new(segment.display.width, segment.display.height),
                preserve_screen_alpha: false,
            };
            let (width, height) =
                cap_rendering::ProjectUniforms::get_base_size(&options, &self.project);
            XY::new(width, height)
        });
        let fps = highest_recorded_fps(
            segments.iter().enumerate().map(|(index, segment)| {
                let recorded = summary.recorded_fps.get(index);
                (
                    capture_fps(segment.display.fps, recorded.map(|(display, _)| *display)),
                    segment.camera.as_ref().map(|camera| {
                        capture_fps(camera.fps, recorded.and_then(|(_, camera)| *camera))
                    }),
                )
            }),
            !self.project.camera.hide,
        );
        ExportSource { size, fps }
    }

    pub(crate) fn normalize_loaded_export_options(&mut self) {
        let transparent = has_transparent_background(&self.project);
        if let Some(ui) = self.export.as_mut() {
            normalize_export_options(ui, transparent);
        }
    }

    fn export_fps_options(&self, ui: &ExportUi) -> &'static [u32] {
        export_fps_options(ui.format, ui.cursor_only)
    }

    fn export_resolutions(&self, ui: &ExportUi) -> Vec<ExportResolution> {
        export_resolutions(
            ui.format,
            ui.cursor_only,
            has_transparent_background(&self.project),
        )
        .to_vec()
    }

    fn refresh_export_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.project_path.clone();
        let time = self.preview_or_playhead();
        let instance = self.instance.clone();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let mut project = self.project.clone();
        project.screen_enhancement = screen_enhancement(ui.enhance_quality);
        ui.estimate_cancel.store(true, Ordering::Release);
        ui.estimate_cancel = Arc::new(AtomicBool::new(false));
        ui.estimate = None;
        ui.preview_stats = None;
        if !ui.format.writes_video() {
            ui.estimate_loading = false;
            ui.preview_request = Arc::new(());
            ui.preview_task = None;
            return;
        }
        ui.estimate_loading = true;
        let estimate_cancel = ui.estimate_cancel.clone();
        let estimate_settings = ui.estimate_settings();
        let estimate_turbo = ui.turbo;
        let estimate_instance = instance.clone();
        let estimate_project = project.clone();
        let (width, height) = ui.resolution.size();
        let settings = ExportPreviewSettings {
            fps: ui.fps,
            resolution_base: XY::new(width, height),
            compression_bpp: ui.bpp(),
            cursor_only: ui.cursor_only,
            gif_quality: ui.gif_preview_quality(),
        };
        // Match Windows editor playback: a fresh Media Foundation preview seek can return black.
        let force = cfg!(target_os = "windows") || ui.force_ffmpeg;
        ui.preview_error = None;
        let request = Arc::new(());
        ui.preview_request = request.clone();
        ui.preview_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
            let started = std::time::Instant::now();
            let result = gpui_tokio::Tokio::spawn(cx, async move {
                match instance {
                    Some(instance) => {
                        render_preview_with_editor(&instance, project, time, settings).await
                    }
                    None => render_preview_with_config(path, project, time, settings, force).await,
                }
            })
            .await
            .ok();
            tracing::debug!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "export preview rendered"
            );
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                let updated = ui.update_preview(&request, |ui| match result {
                    Some(Ok(preview)) => {
                        let bytes = base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            preview.jpeg_base64.as_bytes(),
                        )
                        .ok();
                        if let Some(image) = bytes.as_deref().and_then(decode_jpeg_bytes)
                            && let Some(old) = ui.preview.replace(image)
                        {
                            let _ = window.drop_image(old);
                        }
                        ui.preview_stats = Some(PreviewStats {
                            width: preview.actual_width,
                            height: preview.actual_height,
                            total_frames: preview.total_frames,
                            estimated_size_mb: preview.estimated_size_mb,
                        });
                        ui.preview_error = None;
                    }
                    Some(Err(error)) => {
                        ui.preview_error = Some(error.to_string());
                    }
                    None => {
                        ui.preview_error = Some(tr::editor::export::preview_unavailable().into());
                    }
                });
                if !updated {
                    return;
                }
                cx.notify();
                window.refresh();
            });
            let result = if let Some(instance) = estimate_instance {
                let (estimate_tx, estimate_rx) = flume::unbounded();
                let estimate_task = gpui_tokio::Tokio::spawn(cx, async move {
                    let on_estimate = move |estimate| {
                        let _ = estimate_tx.send(estimate);
                    };
                    if estimate_turbo {
                        estimate_turbo_export(
                            instance,
                            estimate_project,
                            estimate_settings,
                            estimate_cancel,
                            on_estimate,
                        )
                        .await
                    } else {
                        estimate_export(
                            instance,
                            estimate_project,
                            estimate_settings,
                            estimate_cancel,
                            on_estimate,
                        )
                        .await
                    }
                });
                while let Ok(estimate) = estimate_rx.recv_async().await {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && !ui.estimate_cancel.load(Ordering::Acquire)
                            && ui.update_preview(&request, |ui| ui.estimate = Some(estimate))
                        {
                            cx.notify();
                        }
                    });
                }
                estimate_task.await.ok().and_then(Result::ok)
            } else {
                None
            };
            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut()
                    && ui.update_preview(&request, |ui| {
                        if let Some(estimate) = result {
                            ui.estimate = Some(estimate);
                        }
                        ui.estimate_loading = false;
                    })
                {
                    cx.notify();
                }
            });
        }));
    }

    pub(crate) fn start_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pretty_name = self
            .summary()
            .map(|summary| summary.pretty_name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Cap Recording".into());
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        ui.estimate_cancel.store(true, Ordering::Release);
        if ui.phase.is_busy() || ui.close_requested {
            return;
        }
        if ui.format == ExportFormatKind::Tracks {
            self.start_tracks_export(pretty_name, window, cx);
            return;
        }
        if ui.format == ExportFormatKind::Audio {
            self.start_audio_export(pretty_name, window, cx);
            return;
        }
        if ui.destination == ExportDestination::Link {
            let sign_in = SignIn::global(cx);
            if sign_in.read(cx).is_pending() {
                sign_in.update(cx, |sign_in, cx| sign_in.cancel(cx));
                return;
            }
            if ui.auth_rejected || !store::auth_snapshot().signed_in() {
                sign_in.update(cx, |sign_in, cx| sign_in.start(SignInOrigin::Editor, cx));
                return;
            }
            self.start_link_export(window, cx);
            return;
        }

        let estimate = ui
            .estimate
            .as_ref()
            .map(|estimate| estimate.size_range_mb[1])
            .or_else(|| {
                ui.preview_stats
                    .as_ref()
                    .map(|stats| stats.estimated_size_mb)
            })
            .map(estimated_working_bytes)
            .unwrap_or(0);
        let destination = ui.destination;
        let format = ui.format;
        let cursor_only = ui.cursor_only;
        let fps = ui.fps;
        let (width, height) = ui.resolution.size();
        let compression = ui.compression;
        let custom_bpp = ui.custom_bpp;
        let gif_quality = ui.gif_quality.settings();
        let optimize = ui.optimize_filesize;
        let turbo = ui.turbo;
        let force = ui.force_ffmpeg;
        let project_path = self.project_path.clone();
        let mut project = self.project.clone();
        project.screen_enhancement = screen_enhancement(ui.enhance_quality);
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = if destination == ExportDestination::File {
            ExportPhase::ChoosingFile
        } else {
            ExportPhase::Starting
        };
        ui.error = None;
        ui.rendered = 0;
        ui.total_frames = 0;
        ui.output_path = None;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let save_path = if destination == ExportDestination::File {
                let ext = if cursor_only {
                    "mov"
                } else if format == ExportFormatKind::Gif {
                    "gif"
                } else {
                    "mp4"
                };
                let default = export_file_name(&pretty_name, ext);
                let chosen: Result<Option<PathBuf>, String> = match std::env::var_os("CAP_GPUI_AUTO_EXPORT") {
                    Some(path) => Ok(Some(PathBuf::from(path))),
                    None => {
                        #[cfg(target_os = "macos")]
                        {
                            platform::try_save_file_panel(&default, &[ext])
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            Ok(platform::save_file_panel_async(&default, &[ext], cx).await)
                        }
                    }
                };
                if matches!(chosen, Ok(None)) {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && Arc::ptr_eq(&ui.cancel, &cancel)
                        {
                            ui.phase = ExportPhase::Idle;
                        }
                        cx.notify();
                    });
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.finish_requested_export_close(window, cx)
                    });
                    return;
                }
                match chosen {
                    Ok(path) => path,
                    Err(error) => {
                        tracing::warn!(error, "Save dialog unavailable; keeping the export in its project output folder");
                        None
                    }
                }
            } else {
                None
            };

            let output = save_path.clone().unwrap_or_else(|| project_path.join("output"));
            let resources = ExportResources::new(vec![DiskBudget {
                path: output,
                description: "your export drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| this.finish_requested_export_close(window, cx));
                return;
            }

            let started = this.update_in(cx, |this, _, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return false;
                };
                if !Arc::ptr_eq(&ui.cancel, &cancel) {
                    return false;
                }
                if cancel.load(Ordering::Relaxed) {
                    ui.phase = ExportPhase::Idle;
                    cx.notify();
                    return false;
                }
                ui.phase = ExportPhase::Starting;
                cx.notify();
                true
            });
            if !started.unwrap_or(false) {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let notify_file_save = save_path.is_some();
            let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
            let export_cancel = cancel.clone();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources.supervise(run_export(
                    project_path,
                    project,
                    format,
                    cursor_only,
                    fps,
                    width,
                    height,
                    compression,
                    custom_bpp,
                    gif_quality,
                    optimize,
                    turbo,
                    force,
                    save_path.clone(),
                    progress_tx,
                    export_cancel,
                ), || stopped.store(true, Ordering::Release)).await
            });

            loop {
                let mut latest: Option<(u32, u32)> = None;
                while let Ok((rendered, total)) = progress_rx.try_recv() {
                    latest = Some((rendered, total));
                }
                if let Some((rendered, total)) = latest {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = rendered;
                            ui.total_frames = total;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            match export.await {
                Ok(Ok(path)) => {
                    tracing::info!(path = %path.display(), "editor export completed");
                    if destination == ExportDestination::Clipboard {
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.copy_completed_export(path, |path| {
                                    let result = platform::copy_file_to_clipboard(path, cx);
                                    crate::app_sounds::play_notification();
                                    result
                                });
                            }
                            cx.notify();
                        });
                    } else {
                        if notify_file_save {
                            crate::app_sounds::play_notification();
                        }
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.phase = ExportPhase::Done;
                                ui.output_path = Some(path);
                            }
                            cx.notify();
                        });
                    }
                }
                Ok(Err(error)) => {
                    tracing::error!(error, "editor export failed");
                    let cancelled = !is_resource_stop(&error) && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            if cancelled {
                                ui.phase = ExportPhase::Idle;
                            } else {
                                ui.phase = ExportPhase::Failed;
                                ui.error = Some(error);
                            }
                        }
                        cx.notify();
                    });
                }
                Err(error) => {
                    tracing::error!(%error, "editor export task ended without a result");
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.phase = ExportPhase::Failed;
                            ui.error = Some(tr::editor::export::task_failed().into());
                        }
                        cx.notify();
                    });
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    fn start_tracks_export(
        &mut self,
        pretty_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let duration = self.total_duration();
        let project_path = self.project_path.clone();
        let project = self.project.clone();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if ui.tracks.is_empty() {
            return;
        }
        let selection = ui.tracks.clone();
        let fps = ui.fps;
        let force_ffmpeg_decoder = ui.force_ffmpeg;
        let estimate = estimated_tracks_bytes(&ui.track_options, &selection, fps, duration);
        let folder_name = export_name_stem(&pretty_name, 0);
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::ChoosingFile;
        ui.error = None;
        ui.rendered = 0;
        ui.total_frames = 0;
        ui.output_path = None;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let chosen: Result<Option<PathBuf>, String> =
                match std::env::var_os("CAP_GPUI_AUTO_EXPORT") {
                    Some(path) => Ok(Some(PathBuf::from(path))),
                    None => {
                        #[cfg(target_os = "macos")]
                        {
                            platform::try_save_file_panel(&folder_name, &[])
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            Ok(platform::save_file_panel_async(&folder_name, &[], cx).await)
                        }
                    }
                };
            let folder = match chosen {
                Ok(Some(path)) => path,
                Ok(None) => {
                    let _ = this.update_in(cx, |this, window, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && Arc::ptr_eq(&ui.cancel, &cancel)
                        {
                            ui.phase = ExportPhase::Idle;
                        }
                        cx.notify();
                        this.finish_requested_export_close(window, cx);
                    });
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        error,
                        "Save dialog unavailable; keeping the tracks in the project output folder"
                    );
                    project_path.join("output").join(&folder_name)
                }
            };

            let resources = ExportResources::new(vec![DiskBudget {
                path: folder.clone(),
                description: "your export drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }
            let started = this.update(cx, |this, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return false;
                };
                if !Arc::ptr_eq(&ui.cancel, &cancel) || cancel.load(Ordering::Relaxed) {
                    ui.phase = ExportPhase::Idle;
                    cx.notify();
                    return false;
                }
                ui.phase = ExportPhase::Starting;
                cx.notify();
                true
            });
            if !started.unwrap_or(false) {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let (progress_tx, progress_rx) = flume::unbounded::<TrackProgress>();
            let export_cancel = cancel.clone();
            let export_folder = folder.clone();
            let started_at = std::time::Instant::now();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources
                    .supervise(
                        async move {
                            tracks::export_tracks(
                                project_path,
                                Some(project),
                                tracks::TrackExportSettings {
                                    tracks: selection,
                                    fps,
                                    force_ffmpeg_decoder,
                                },
                                export_folder,
                                export_cancel,
                                move |progress| {
                                    let _ = progress_tx.send(progress);
                                },
                            )
                            .await
                            .map_err(|error| error.to_string())
                        },
                        || stopped.store(true, Ordering::Release),
                    )
                    .await
            });

            loop {
                let latest = progress_rx.try_iter().last();
                if let Some(progress) = latest {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = progress.done.min(u64::from(u32::MAX)) as u32;
                            ui.total_frames = progress.total.min(u64::from(u32::MAX)) as u32;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            let result = export.await;
            let _ = this.update(cx, |this, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                match result {
                    Ok(Ok(files)) => {
                        tracing::info!(
                            folder = %folder.display(),
                            files = files.len(),
                            elapsed_ms = started_at.elapsed().as_millis() as u64,
                            "editor tracks export completed"
                        );
                        crate::app_sounds::play_notification();
                        ui.phase = ExportPhase::Done;
                        ui.output_path = Some(folder);
                    }
                    Ok(Err(error)) => {
                        let cancelled = !is_resource_stop(&error)
                            && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                        if cancelled {
                            ui.phase = ExportPhase::Idle;
                        } else {
                            tracing::error!(error, "editor tracks export failed");
                            ui.phase = ExportPhase::Failed;
                            ui.error = Some(error);
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, "editor tracks export task ended without a result");
                        ui.phase = ExportPhase::Failed;
                        ui.error = Some(tr::editor::export::task_failed().into());
                    }
                }
                cx.notify();
            });
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    fn start_audio_export(
        &mut self,
        pretty_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let duration = self.total_duration();
        let project_path = self.project_path.clone();
        let project = self.project.clone();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let format = ui.audio_format;
        let estimate = format.estimated_bytes(duration);
        let extension = format.extension();
        let default = export_file_name(&pretty_name, extension);
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::ChoosingFile;
        ui.error = None;
        ui.rendered = 0;
        ui.total_frames = 0;
        ui.output_path = None;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let chosen: Result<Option<PathBuf>, String> =
                match std::env::var_os("CAP_GPUI_AUTO_EXPORT") {
                    Some(path) => Ok(Some(PathBuf::from(path))),
                    None => {
                        #[cfg(target_os = "macos")]
                        {
                            platform::try_save_file_panel(&default, &[extension])
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            Ok(platform::save_file_panel_async(&default, &[extension], cx).await)
                        }
                    }
                };
            let path = match chosen {
                Ok(Some(path)) => path,
                Ok(None) => {
                    let _ = this.update_in(cx, |this, window, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && Arc::ptr_eq(&ui.cancel, &cancel)
                        {
                            ui.phase = ExportPhase::Idle;
                        }
                        cx.notify();
                        this.finish_requested_export_close(window, cx);
                    });
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        error,
                        "Save dialog unavailable; keeping the audio in the project output folder"
                    );
                    project_path.join("output").join(&default)
                }
            };

            let resources = ExportResources::new(vec![DiskBudget {
                path: path.clone(),
                description: "your export drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }
            let started = this.update(cx, |this, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return false;
                };
                if !Arc::ptr_eq(&ui.cancel, &cancel) || cancel.load(Ordering::Relaxed) {
                    ui.phase = ExportPhase::Idle;
                    cx.notify();
                    return false;
                }
                ui.phase = ExportPhase::Starting;
                cx.notify();
                true
            });
            if !started.unwrap_or(false) {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let (progress_tx, progress_rx) = flume::unbounded::<TrackProgress>();
            let export_cancel = cancel.clone();
            let export_path = path.clone();
            let started_at = std::time::Instant::now();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources
                    .supervise(
                        async move {
                            cap_export::audio::export_audio(
                                project_path,
                                Some(project),
                                format,
                                export_path,
                                export_cancel,
                                move |progress| {
                                    let _ = progress_tx.send(progress);
                                },
                            )
                            .await
                            .map_err(|error| error.to_string())
                        },
                        || stopped.store(true, Ordering::Release),
                    )
                    .await
            });

            loop {
                let latest = progress_rx.try_iter().last();
                if let Some(progress) = latest {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = progress.done.min(u64::from(u32::MAX)) as u32;
                            ui.total_frames = progress.total.min(u64::from(u32::MAX)) as u32;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            let result = export.await;
            let _ = this.update(cx, |this, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                match result {
                    Ok(Ok(file)) => {
                        tracing::info!(
                            format = format.extension(),
                            bytes = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0),
                            elapsed_ms = started_at.elapsed().as_millis() as u64,
                            "editor audio export completed"
                        );
                        crate::app_sounds::play_notification();
                        ui.phase = ExportPhase::Done;
                        ui.output_path = Some(file);
                    }
                    Ok(Err(error)) => {
                        let cancelled = !is_resource_stop(&error)
                            && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                        if cancelled {
                            ui.phase = ExportPhase::Idle;
                        } else {
                            tracing::error!(error, "editor audio export failed");
                            ui.phase = ExportPhase::Failed;
                            ui.error = Some(error);
                        }
                    }
                    Err(error) => {
                        tracing::error!(%error, "editor audio export task ended without a result");
                        ui.phase = ExportPhase::Failed;
                        ui.error = Some(tr::editor::export::task_failed().into());
                    }
                }
                cx.notify();
            });
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    fn export_audio_format_field(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let options = AudioExportFormat::ALL;
        let selected = ui.audio_format;
        let size = selected.estimated_bytes(self.total_duration()) as f64 / (1024.0 * 1024.0);
        self.export_section(tr::editor::export::audio::file_type(), "icons/music.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-audio-format",
                    options
                        .iter()
                        .map(|format| {
                            ui::SegmentOption::new(
                                format.extension().to_ascii_uppercase(),
                                *format == selected,
                            )
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, _, cx| {
                    let Some(format) = options.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.audio_format = format;
                        ui.persist();
                    }
                    cx.notify();
                })),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(editor.text_2))
                    .child(match selected {
                        AudioExportFormat::Mp3 => tr::editor::export::audio::mp3_description(),
                        AudioExportFormat::Wav => tr::editor::export::audio::wav_description(),
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(Hsla::from(editor.text_3))
                    .child(tr::editor::export::stats::estimated_size())
                    .child(format_estimate_range([size, size], false)),
            )
    }

    fn render_audio_stage(&self, ui: &ExportUi) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let duration = self.total_duration();
        let name = export_file_name(
            self.summary()
                .map(|summary| summary.pretty_name.as_str())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("Cap Recording"),
            ui.audio_format.extension(),
        );
        let size = ui.audio_format.estimated_bytes(duration) as f64 / (1024.0 * 1024.0);
        let minutes = (duration.max(0.0) / 60.0).floor() as u64;
        let seconds = (duration.max(0.0) % 60.0).floor() as u64;
        div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .p(px(24.))
            .child(
                div()
                    .size(px(72.))
                    .rounded(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(Hsla::from(editor.seg_fill(gpui::rgb(
                        crate::editor_timeline::track_color::AUDIO,
                    ))))
                    .child(
                        svg()
                            .path("icons/music.svg")
                            .size(px(30.))
                            .text_color(Hsla::from(editor.text_1)),
                    ),
            )
            .child(
                div()
                    .max_w(px(360.))
                    .truncate()
                    .text_size(px(15.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_1))
                    .child(name),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(editor.text_2))
                    .child(format!(
                        "{minutes}:{seconds:02} · {}",
                        format_estimate_range([size, size], false)
                    )),
            )
    }

    fn retry_clipboard_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let Some(path) = ui.clipboard_retry_path().map(Path::to_path_buf) else {
            return;
        };
        ui.cancel = Arc::new(AtomicBool::new(false));
        ui.copy_completed_export(path, |path| {
            let result = platform::copy_file_to_clipboard(path, cx);
            crate::app_sounds::play_notification();
            result
        });
        cx.notify();
        self.finish_requested_export_close(window, cx);
    }

    fn subscribe_export_to_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let sign_in = SignIn::global(cx);
        let subscriptions = [
            cx.observe(&sign_in, |_, _, cx| cx.notify()),
            cx.subscribe_in(&sign_in, window, |this, _, event, _, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                match event {
                    SignInEvent::Finished {
                        outcome: SignInOutcome::SignedIn,
                        ..
                    } => {
                        ui.auth_rejected = false;
                        if ui.phase == ExportPhase::Failed {
                            ui.phase = ExportPhase::Idle;
                        }
                        ui.error = None;
                        ui.pick_default_organization();
                    }
                    SignInEvent::Finished {
                        origin: SignInOrigin::Editor,
                        outcome: SignInOutcome::Failed(error),
                    } => ui.error = Some(error.clone()),
                    SignInEvent::Finished { .. } => {}
                    SignInEvent::AccountRefreshed => ui.pick_default_organization(),
                }
                cx.notify();
            }),
        ];
        if let Some(ui) = self.export.as_mut() {
            ui.sign_in_subscriptions = Some(subscriptions);
        }
    }

    fn start_link_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let duration = self.total_duration();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if ui.phase.is_busy() || ui.close_requested {
            return;
        }

        let upgraded = store::auth_snapshot().is_upgraded();
        if !upgraded && duration >= 300.0 {
            cx.open_url(crate::auth::PRICING_URL);
            return;
        }

        let estimate = ui
            .estimate
            .as_ref()
            .map(|estimate| estimate.size_range_mb[1])
            .or_else(|| {
                ui.preview_stats
                    .as_ref()
                    .map(|stats| stats.estimated_size_mb)
            })
            .map(estimated_working_bytes)
            .unwrap_or(0);
        let format = ui.format;
        let cursor_only = ui.cursor_only;
        let fps = ui.fps;
        let (width, height) = ui.resolution.size();
        let compression = ui.compression;
        let custom_bpp = ui.custom_bpp;
        let gif_quality = ui.gif_quality.settings();
        let optimize = ui.optimize_filesize;
        let turbo = ui.turbo;
        let force = ui.force_ffmpeg;
        let project_path = self.project_path.clone();
        let mut project = self.project.clone();
        project.screen_enhancement = screen_enhancement(ui.enhance_quality);
        let organization_id = ui.organization_id.clone().or_else(|| {
            store::auth_snapshot()
                .organizations
                .first()
                .map(|org| org.id.clone())
        });
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::Starting;
        ui.reuploading = self.sharing.is_some();
        ui.error = None;
        ui.share_link = None;
        ui.upload_progress = 0.0;
        ui.rendered = 0;
        ui.total_frames = 0;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let save_path = RecordingMeta::load_for_project(&project_path)
                .ok()
                .map(|meta| meta.output_path());
            if let Some(path) = save_path.as_ref()
                && let Some(parent) = path.parent()
            {
                let _ = std::fs::create_dir_all(parent);
            }

            let resources = ExportResources::new(vec![DiskBudget {
                path: save_path
                    .clone()
                    .unwrap_or_else(|| project_path.join("output")),
                description: "your recording drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.phase = ExportPhase::Rendering;
                }
                cx.notify();
            });

            let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
            let export_cancel = cancel.clone();
            let export_path = project_path.clone();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources
                    .supervise(
                        run_export(
                            export_path,
                            project,
                            format,
                            cursor_only,
                            fps,
                            width,
                            height,
                            compression,
                            custom_bpp,
                            gif_quality,
                            optimize,
                            turbo,
                            force,
                            save_path.clone(),
                            progress_tx,
                            export_cancel,
                        ),
                        || stopped.store(true, Ordering::Release),
                    )
                    .await
            });

            loop {
                let mut latest: Option<(u32, u32)> = None;
                while let Ok((rendered, total)) = progress_rx.try_recv() {
                    latest = Some((rendered, total));
                }
                if let Some((rendered, total)) = latest {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = rendered;
                            ui.total_frames = total;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            match export.await {
                Ok(Ok(path)) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.phase = ExportPhase::Uploading;
                            ui.output_path = Some(path);
                            ui.upload_progress = 0.0;
                        }
                        cx.notify();
                    });

                    let (upload_tx, upload_rx) = flume::unbounded::<f64>();
                    let upload_cancel = cancel.clone();
                    let upload_project = project_path.clone();
                    let upload = gpui_tokio::Tokio::spawn(cx, async move {
                        crate::upload::upload_exported_video(
                            upload_project,
                            organization_id,
                            |progress| {
                                let _ = upload_tx.send(progress);
                            },
                            upload_cancel,
                        )
                        .await
                    });

                    loop {
                        let mut latest: Option<f64> = None;
                        while let Ok(progress) = upload_rx.try_recv() {
                            latest = Some(progress);
                        }
                        if let Some(progress) = latest {
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    ui.upload_progress = progress as f32;
                                    ui.phase = ExportPhase::Uploading;
                                }
                                cx.notify();
                            });
                        }
                        if upload_rx.is_disconnected() {
                            break;
                        }
                        cx.background_executor()
                            .timer(Duration::from_millis(50))
                            .await;
                    }

                    match upload.await {
                        Ok(Ok(crate::upload::UploadResult::Success(link))) => {
                            let _ = this.update(cx, |this, cx| {
                                if let Ok(meta) =
                                    RecordingMeta::load_for_project(&this.project_path)
                                {
                                    this.sharing = meta.sharing;
                                }
                                if let Some(ui) = this.export.as_mut() {
                                    ui.complete_share_export(link, |link| {
                                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            link,
                                        ));
                                        crate::app_sounds::play_notification();
                                    });
                                }
                                cx.notify();
                            });
                        }
                        Ok(Ok(crate::upload::UploadResult::NotAuthenticated)) => {
                            let _ = this.update(cx, |this, _| {
                                if let Some(ui) = this.export.as_mut() {
                                    ui.auth_rejected = true;
                                }
                            });
                            show_upload_failure(
                                &this,
                                cx,
                                tr::editor::export::sign_in_required(),
                                true,
                            );
                        }
                        Ok(Ok(crate::upload::UploadResult::UpgradeRequired)) => {
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    ui.phase = ExportPhase::Idle;
                                }
                                cx.notify();
                            });
                            let _ = this.update(cx, |_, cx| {
                                cx.open_url(crate::auth::PRICING_URL);
                            });
                            platform::alert_dialog(
                                tr::editor::export::upgrade_title(),
                                tr::editor::export::upgrade_message(),
                            );
                        }
                        Ok(Err(error)) => {
                            if error == "Export cancelled" || cancel.load(Ordering::Relaxed) {
                                let _ = this.update(cx, |this, cx| {
                                    if let Some(ui) = this.export.as_mut() {
                                        ui.phase = ExportPhase::Idle;
                                    }
                                    cx.notify();
                                });
                            } else {
                                show_upload_failure(&this, cx, &error, true);
                            }
                        }
                        Err(error) => {
                            tracing::error!(%error, "share upload task ended without a result");
                            show_upload_failure(
                                &this,
                                cx,
                                tr::editor::export::upload_failed(),
                                true,
                            );
                        }
                    }
                }
                Ok(Err(error)) => {
                    let cancelled = !is_resource_stop(&error)
                        && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                    if cancelled {
                        tracing::info!(error, "share export cancelled");
                    } else {
                        tracing::error!(error, "share export failed");
                    }
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            if cancelled {
                                ui.phase = ExportPhase::Idle;
                            } else {
                                ui.phase = ExportPhase::Failed;
                                ui.error = Some(error.clone());
                            }
                        }
                        cx.notify();
                    });
                    if !cancelled {
                        platform::alert_dialog(tr::editor::export::failed(), &error);
                    }
                }
                Err(error) => {
                    tracing::error!(%error, "share export task ended without a result");
                    show_upload_failure(&this, cx, tr::editor::export::task_failed(), false);
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    pub(crate) fn render_export_page(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let Some(ui) = self.export.as_ref() else {
            return div().into_any_element();
        };

        let header = div()
            .relative()
            .h(px(HEADER_HEIGHT))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .pl(px(if cfg!(target_os = "macos") { 92. } else { 12. }))
            .pr(px(12.))
            .border_b_1()
            .border_color(Hsla::from(editor.line))
            .when(cfg!(target_os = "windows"), |header| {
                header.window_control_area(gpui::WindowControlArea::Drag)
            })
            .when(!cfg!(target_os = "windows"), |header| {
                header.on_mouse_down(gpui::MouseButton::Left, |event, window, _| {
                    if event.click_count == 2 {
                        window.titlebar_double_click();
                    } else {
                        window.start_window_move();
                    }
                })
            })
            .child(
                div().flex_1().flex().flex_row().items_center().child(
                    div()
                        .id("export-back")
                        .when(cfg!(target_os = "windows"), |button| button.occlude())
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .h(px(28.))
                        .pl(px(8.))
                        .pr(px(10.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(editor.text_2))
                        .hover(move |style| {
                            style
                                .bg(Hsla::from(editor.ctl))
                                .text_color(Hsla::from(editor.text_1))
                        })
                        .child(
                            svg()
                                .path("icons/move-left.svg")
                                .size(px(14.))
                                .text_color(Hsla::from(editor.text_2)),
                        )
                        .child(tr::editor::export::back())
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.close_export(window, cx);
                        })),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_1))
                    .child(tr::editor::export::title()),
            )
            .child(div().flex_1());
        #[cfg(target_os = "windows")]
        let header = header.child(div().absolute().right_0().top_0().h_full().child(
            ui::windows_caption_controls(
                theme,
                window.is_window_active(),
                window.is_maximized(),
                true,
                true,
            ),
        ));

        let viewport = window.viewport_size();
        let preview_box = preview_fit(
            f32::from(viewport.width) - SIDEBAR_WIDTH - STAGE_PADDING_X * 2.,
            f32::from(viewport.height) - HEADER_HEIGHT - STAGE_VERTICAL_CHROME,
            ui.preview.as_ref().map(|image| {
                let size = image.size(0);
                (size.width.0 as f32, size.height.0 as f32)
            }),
        );

        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .child(header)
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(if ui.format == ExportFormatKind::Tracks {
                        self.render_tracks_stage(ui).into_any_element()
                    } else if ui.format == ExportFormatKind::Audio {
                        self.render_audio_stage(ui).into_any_element()
                    } else {
                        self.render_export_preview_pane(ui, preview_box)
                            .into_any_element()
                    })
                    .child(self.render_export_sidebar(ui, cx))
                    .when(ui.phase.shows_progress(), |this| {
                        this.child(self.render_export_overlay(ui, cx))
                    })
                    .when(ui.phase == ExportPhase::ChoosingFile, |this| {
                        this.child(div().absolute().inset_0().occlude())
                    }),
            )
            .when(ui.bpp_dragging, |this| {
                this.child(ui::Slider::drag_layer(
                    "export-bpp-drag",
                    cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                        this.export_bpp_drag_to(event.position.x, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.export_bpp_mouse_up(window, cx);
                    }),
                ))
            })
            .into_any_element()
    }

    fn render_export_preview_pane(
        &self,
        ui: &ExportUi,
        preview_box: (f32, f32),
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let stats = ui.preview_stats.as_ref();
        let duration = stats
            .map(|stats| {
                if ui.fps == 0 {
                    0.0
                } else {
                    stats.total_frames as f64 / ui.fps as f64
                }
            })
            .unwrap_or(0.0);
        let (box_w, box_h) = preview_box;

        let preview = match ui.preview.clone() {
            Some(image) => {
                use gpui::StyledImage as _;
                div()
                    .w(px(box_w))
                    .h(px(box_h))
                    .rounded(px(10.))
                    .overflow_hidden()
                    .shadow(crate::theme::preview_shadow())
                    .child(img(image).object_fit(gpui::ObjectFit::Contain).size_full())
                    .into_any_element()
            }
            None => div()
                .w(px(box_w))
                .h(px(box_h))
                .rounded(px(10.))
                .bg(Hsla::from(editor.ctl))
                .flex()
                .items_center()
                .justify_center()
                .px(px(24.))
                .text_size(px(12.))
                .text_color(Hsla::from(editor.text_2))
                .text_center()
                .child(
                    ui.preview_error
                        .clone()
                        .unwrap_or_else(|| tr::editor::export::generating_preview().into()),
                )
                .into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .bg(Hsla::from(editor.stage))
            .pt(px(16.))
            .px(px(STAGE_PADDING_X))
            .pb(px(20.))
            .child(
                div()
                    .h(px(22.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_2))
                            .child(tr::editor::export::preview()),
                    )
                    .child(
                        div()
                            .id("export-preview-info")
                            .flex()
                            .items_center()
                            .tooltip(move |_window, cx| {
                                crate::ui::Tooltip::new(&theme, tr::editor::export::preview_info())
                                    .view(cx)
                            })
                            .child(
                                svg()
                                    .path("icons/info.svg")
                                    .size(px(13.))
                                    .text_color(Hsla::from(editor.text_3)),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .justify_center()
                    .pt(px(14.))
                    .pb(px(18.))
                    .child(preview),
            )
            .child(
                div().flex().flex_row().justify_center().child(
                    div()
                        .h(px(STATS_HEIGHT))
                        .min_w(px(520.))
                        .flex()
                        .flex_row()
                        .rounded(px(10.))
                        .bg(Hsla::from(editor.card))
                        .shadow(editor.card_shadow())
                        .child(export_stat(
                            &theme,
                            tr::editor::export::stats::duration(),
                            stats.map(|_| format_duration(duration)),
                            false,
                        ))
                        .child(export_stat(
                            &theme,
                            tr::editor::export::stats::output(),
                            stats.map(|stats| {
                                tr::editor::export::stats::output_value(
                                    stats.width,
                                    stats.height,
                                    ui.fps,
                                )
                            }),
                            true,
                        ))
                        .child(export_stat(
                            &theme,
                            if ui.estimate_loading && ui.estimate.is_some() {
                                tr::editor::export::stats::refining_size()
                            } else {
                                tr::editor::export::stats::estimated_size()
                            },
                            Some(
                                ui.estimate
                                    .as_ref()
                                    .map(|estimate| {
                                        format_estimate_range(estimate.size_range_mb, false)
                                    })
                                    .unwrap_or_else(|| {
                                        if ui.estimate_loading {
                                            tr::editor::export::stats::calculating().into()
                                        } else {
                                            tr::editor::export::stats::unavailable().into()
                                        }
                                    }),
                            ),
                            true,
                        ))
                        .child(export_stat(
                            &theme,
                            if ui.estimate_loading && ui.estimate.is_some() {
                                tr::editor::export::stats::refining_time()
                            } else {
                                tr::editor::export::stats::export_time()
                            },
                            Some(
                                ui.estimate
                                    .as_ref()
                                    .map(|estimate| {
                                        format_estimate_range(estimate.time_range_seconds, true)
                                    })
                                    .unwrap_or_else(|| {
                                        if ui.estimate_loading {
                                            tr::editor::export::stats::calculating().into()
                                        } else {
                                            tr::editor::export::stats::unavailable().into()
                                        }
                                    }),
                            ),
                            true,
                        )),
                ),
            )
    }

    fn render_tracks_stage(&self, ui: &ExportUi) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let duration = self.total_duration();
        let folder = export_name_stem(
            self.summary()
                .map(|summary| summary.pretty_name.as_str())
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("Cap Recording"),
            0,
        );
        let clips = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                timeline
                    .segments
                    .iter()
                    .map(|segment| segment.duration())
                    .filter(|duration| duration.is_finite() && *duration > 0.0)
                    .collect::<Vec<_>>()
            })
            .filter(|clips| !clips.is_empty())
            .unwrap_or_else(|| vec![1.0]);
        let clips_total = clips.iter().sum::<f64>();
        let selected = ui.tracks.len();
        let size = estimated_tracks_bytes(&ui.track_options, &ui.tracks, ui.fps, duration) as f64
            / (1024.0 * 1024.0);

        let lane = |option: &TrackOption| {
            let checked = ui.tracks.contains(&option.kind);
            let color = gpui::rgb(if option.kind.is_video() {
                crate::editor_timeline::track_color::CLIP
            } else {
                crate::editor_timeline::track_color::AUDIO
            });
            let fill = Hsla::from(editor.seg_fill(color));
            let border = Hsla::from(editor.seg_border(color));
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(14.))
                .h(px(44.))
                .when(!checked, |lane| lane.opacity(0.35))
                .child(
                    div()
                        .w(px(176.))
                        .flex_none()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex_none()
                                .size(px(28.))
                                .rounded(px(7.))
                                .bg(Hsla::from(editor.ctl))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    svg()
                                        .path(track_icon(option.kind))
                                        .size(px(14.))
                                        .text_color(Hsla::from(editor.text_2)),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .min_w_0()
                                .gap(px(1.))
                                .child(
                                    div()
                                        .text_size(px(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(Hsla::from(editor.text_1))
                                        .truncate()
                                        .child(option.kind.file_name()),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(Hsla::from(editor.text_3))
                                        .truncate()
                                        .child(track_detail(option)),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h(px(26.))
                        .flex()
                        .flex_row()
                        .children(clips.iter().map(|clip| {
                            div()
                                .h_full()
                                .w(gpui::relative((clip / clips_total) as f32))
                                .px(px(1.))
                                .child(
                                    div()
                                        .size_full()
                                        .rounded(px(6.))
                                        .bg(fill)
                                        .border_1()
                                        .border_color(border),
                                )
                        })),
                )
        };

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .bg(Hsla::from(editor.stage))
            .pt(px(16.))
            .px(px(STAGE_PADDING_X))
            .pb(px(20.))
            .child(
                div()
                    .h(px(22.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_2))
                    .child(tr::editor::export::section::tracks()),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .justify_center()
                    .pt(px(14.))
                    .pb(px(18.))
                    .child(
                        div()
                            .w_full()
                            .max_w(px(640.))
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .p(px(16.))
                            .rounded(px(12.))
                            .bg(Hsla::from(editor.card))
                            .shadow(editor.card_shadow())
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.))
                                    .pb(px(8.))
                                    .mb(px(4.))
                                    .border_b_1()
                                    .border_color(Hsla::from(editor.line))
                                    .child(
                                        svg()
                                            .path("icons/folder.svg")
                                            .size(px(16.))
                                            .flex_none()
                                            .text_color(Hsla::from(editor.text_2)),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(Hsla::from(editor.text_1))
                                            .truncate()
                                            .child(folder),
                                    ),
                            )
                            .children(ui.track_options.iter().map(lane)),
                    ),
            )
            .child(
                div().flex().flex_row().justify_center().child(
                    div()
                        .h(px(STATS_HEIGHT))
                        .min_w(px(420.))
                        .flex()
                        .flex_row()
                        .rounded(px(10.))
                        .bg(Hsla::from(editor.card))
                        .shadow(editor.card_shadow())
                        .child(export_stat(
                            &theme,
                            tr::editor::export::stats::duration(),
                            Some(format_duration(duration)),
                            false,
                        ))
                        .child(export_stat(
                            &theme,
                            tr::editor::export::tracks::files(),
                            Some(tr::editor::export::tracks::file_count(selected)),
                            true,
                        ))
                        .child(export_stat(
                            &theme,
                            tr::editor::export::stats::estimated_size(),
                            Some(if selected == 0 {
                                tr::editor::export::stats::unavailable().into()
                            } else {
                                format_estimate_range([size, size], false)
                            }),
                            true,
                        )),
                ),
            )
    }

    fn render_export_sidebar(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let transparent = has_transparent_background(&self.project);
        let tracks_mode = ui.format == ExportFormatKind::Tracks;
        let audio_mode = ui.format == ExportFormatKind::Audio;
        let link_disabled = transparent || ui.cursor_only || tracks_mode;
        let resolutions = self.export_resolutions(ui);
        let fps_options = self.export_fps_options(ui);

        div()
            .w(px(SIDEBAR_WIDTH))
            .flex_shrink_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(Hsla::from(editor.card))
            .border_l_1()
            .border_color(Hsla::from(editor.line))
            .child(
                div()
                    .id("export-settings")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(16.))
                    .gap(px(20.))
                    .when(!audio_mode, |this| {
                        this.child(self.export_destination_field(ui, link_disabled, cx))
                    })
                    .child(self.export_format_field(ui, transparent, cx))
                    .when(audio_mode, |this| {
                        this.child(self.export_audio_format_field(ui, cx))
                    })
                    .when(tracks_mode, |this| {
                        this.child(self.export_tracks_field(ui, cx))
                    })
                    .when(!tracks_mode && !audio_mode, |this| {
                        this.child(self.export_resolution_field(ui, &resolutions, cx))
                    })
                    .when(!audio_mode, |this| {
                        this.child(self.export_fps_field(ui, fps_options, cx))
                    })
                    .when(
                        ui.format == ExportFormatKind::Mp4 && !ui.cursor_only,
                        |this| this.child(self.export_quality_field(ui, cx)),
                    )
                    .when(
                        ui.format == ExportFormatKind::Gif && !ui.cursor_only,
                        |this| this.child(self.export_gif_quality_field(ui, cx)),
                    )
                    .when(!tracks_mode && !audio_mode, |this| {
                        this.child(div().h(px(1.)).flex_none().bg(Hsla::from(editor.line)))
                            .child(self.export_advanced(ui, cx))
                    }),
            )
            .child(
                div()
                    .px(px(16.))
                    .pt(px(12.))
                    .pb(px(16.))
                    .border_t_1()
                    .border_color(Hsla::from(editor.line))
                    .child(self.export_cta(ui, cx)),
            )
    }

    fn export_cta(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let signed_in = !ui.auth_rejected && store::auth_snapshot().signed_in();
        let sign_in_pending = SignIn::global(cx).read(cx).is_pending();
        let (label, icon, primary) = match ui.destination {
            ExportDestination::File if ui.format == ExportFormatKind::Tracks => (
                tr::editor::export::tracks::cta(),
                Some("icons/folder.svg"),
                true,
            ),
            ExportDestination::File if ui.format == ExportFormatKind::Audio => (
                tr::editor::export::audio::cta(),
                Some("icons/music.svg"),
                true,
            ),
            ExportDestination::File => (
                tr::editor::export::cta::file(),
                Some("icons/folder.svg"),
                true,
            ),
            ExportDestination::Clipboard => (
                tr::editor::export::cta::clipboard(),
                Some("icons/copy.svg"),
                true,
            ),
            ExportDestination::Link if sign_in_pending => {
                (tr::editor::export::cta::cancel_sign_in(), None, false)
            }
            ExportDestination::Link if !signed_in => (
                tr::editor::export::cta::sign_in(),
                Some("icons/link.svg"),
                true,
            ),
            ExportDestination::Link => (
                if self.sharing.is_some() {
                    tr::editor::export::cta::reupload()
                } else {
                    tr::editor::export::cta::create_link()
                },
                Some("icons/link.svg"),
                true,
            ),
        };
        let busy =
            ui.phase.is_busy() || (ui.format == ExportFormatKind::Tracks && ui.tracks.is_empty());
        let (bg, hover_bg, text) = if primary {
            (
                Hsla::from(editor.accent),
                Hsla::from(editor.accent_2),
                gpui::white(),
            )
        } else {
            (
                Hsla::from(editor.ctl),
                Hsla::from(editor.ctl_hover),
                Hsla::from(editor.text_1),
            )
        };

        div()
            .id("export-cta")
            .tab_index(0)
            .w_full()
            .h(px(40.))
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .rounded(px(10.))
            .bg(bg)
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(text)
            .when(primary, |this| {
                this.shadow(vec![gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 1., 0.18),
                    offset: gpui::point(px(0.), px(1.)),
                    blur_radius: px(0.),
                    spread_radius: px(0.),
                    inset: true,
                }])
            })
            .when(busy, |this| this.opacity(0.5))
            .when(!busy, |this| {
                this.cursor_pointer()
                    .hover(move |style| style.bg(hover_bg))
                    .on_click(cx.listener(|this, _, window, cx| this.start_export(window, cx)))
            })
            .children(icon.map(|icon| svg().path(icon).size(px(16.)).text_color(text)))
            .child(label)
    }

    fn export_section(&self, name: &'static str, icon: &'static str) -> ui::Field {
        ui::Field::section(&self.theme, name)
            .icon(icon)
            .icon_size(px(14.))
            .gap(px(8.))
    }

    fn export_destination_field(
        &self,
        ui: &ExportUi,
        link_disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        self.export_section(
            tr::editor::export::section::destination(),
            "icons/upload-arrow.svg",
        )
        .child(
            ui::SegmentedControl::editor(
                &theme,
                "export-destination",
                ExportDestination::ALL
                    .iter()
                    .map(|dest| {
                        let label = if *dest == ExportDestination::Link && self.sharing.is_some() {
                            tr::editor::export::reupload()
                        } else {
                            dest.label()
                        };
                        let mut option = ui::SegmentOption::new(label, ui.destination == *dest)
                            .disabled(
                                (*dest == ExportDestination::Link && link_disabled)
                                    || (*dest == ExportDestination::Clipboard
                                        && ui.format == ExportFormatKind::Tracks),
                            );
                        option.icon = Some(dest.icon().into());
                        option
                    })
                    .collect(),
            )
            .stretch()
            .item_height(px(30.))
            .on_select(cx.listener(|this, index: &usize, window, cx| {
                let Some(dest) = ui::option_at(ExportDestination::ALL, *index) else {
                    return;
                };
                if let Some(ui) = this.export.as_mut() {
                    if ui.format == ExportFormatKind::Tracks && dest != ExportDestination::File {
                        return;
                    }
                    if dest == ExportDestination::Link
                        && (has_transparent_background(&this.project) || ui.cursor_only)
                    {
                        return;
                    }
                    ui.destination = dest;
                    if dest == ExportDestination::Link && ui.format == ExportFormatKind::Gif {
                        ui.format = ExportFormatKind::Mp4;
                    }
                }
                this.normalize_loaded_export_options();
                if let Some(ui) = this.export.as_mut() {
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            })),
        )
        .when(link_disabled, |field| {
            field.child(
                div()
                    .text_size(px(11.))
                    .text_color(Hsla::from(editor.text_3))
                    .child(if ui.format == ExportFormatKind::Tracks {
                        tr::editor::export::tracks::file_only()
                    } else if ui.cursor_only {
                        tr::editor::export::link_unavailable_cursor()
                    } else {
                        tr::editor::export::link_unavailable_transparent()
                    }),
            )
        })
        .when(
            ui.destination == ExportDestination::Link && self.sharing.is_some(),
            |field| {
                let link = self
                    .sharing
                    .as_ref()
                    .map(|sharing| sharing.link.clone())
                    .unwrap_or_default();
                field.child(
                    div()
                        .p(px(12.))
                        .rounded(px(10.))
                        .bg(Hsla::from(editor.card_2))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(editor.text_1))
                                .child(tr::editor::export::existing_link_title()),
                        )
                        .child(
                            div()
                                .text_size(px(11.5))
                                .line_height(px(15.))
                                .text_color(Hsla::from(editor.text_3))
                                .child(tr::editor::export::existing_link_description()),
                        )
                        .child(
                            div()
                                .id("reupload-existing-link")
                                .text_size(px(11.5))
                                .text_color(Hsla::from(editor.accent))
                                .truncate()
                                .cursor_pointer()
                                .child(link.clone())
                                .on_click(move |_, _, cx| cx.open_url(&link)),
                        ),
                )
            },
        )
        .when(
            ui.destination == ExportDestination::Link
                && self.sharing.is_none()
                && store::auth_snapshot().organizations.len() > 1,
            |this| {
                let orgs = store::auth_snapshot().organizations;
                let selected = ui
                    .organization_id
                    .clone()
                    .or_else(|| orgs.first().map(|org| org.id.clone()));
                let label = orgs
                    .iter()
                    .find(|org| Some(org.id.as_str()) == selected.as_deref())
                    .or(orgs.first())
                    .map(|org| org.name.clone())
                    .unwrap_or_else(|| tr::editor::export::organization().into());
                this.child(
                    div()
                        .id("export-organization")
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .h(px(30.))
                        .px(px(10.))
                        .rounded(px(7.))
                        .bg(Hsla::from(editor.ctl))
                        .cursor_pointer()
                        .hover(move |style| style.bg(Hsla::from(editor.ctl_hover)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let orgs = store::auth_snapshot().organizations;
                            if orgs.is_empty() {
                                return;
                            }
                            if let Some(ui) = this.export.as_mut() {
                                let current = ui
                                    .organization_id
                                    .as_deref()
                                    .or(orgs.first().map(|org| org.id.as_str()));
                                let index = orgs
                                    .iter()
                                    .position(|org| Some(org.id.as_str()) == current)
                                    .unwrap_or(0);
                                let next = orgs[(index + 1) % orgs.len()].id.clone();
                                ui.organization_id = Some(next);
                                ui.persist();
                            }
                            cx.notify();
                        }))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(Hsla::from(editor.text_2))
                                .child(tr::editor::export::organization()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(4.))
                                .text_size(px(12.))
                                .text_color(Hsla::from(editor.text_1))
                                .child(label)
                                .child(
                                    svg()
                                        .path("icons/caret-down.svg")
                                        .size(px(14.))
                                        .text_color(Hsla::from(editor.text_3)),
                                ),
                        ),
                )
            },
        )
    }

    fn export_format_field(
        &self,
        ui: &ExportUi,
        transparent: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let options = ExportFormatKind::options(self.is_audio_only(), self.audio_visuals_enabled());
        let cursor_only = ui.cursor_only;
        let no_tracks = ui.track_options.is_empty();
        let offers_tracks = options.contains(&ExportFormatKind::Tracks);
        let disabled = move |format: ExportFormatKind| match format {
            ExportFormatKind::Mp4 => transparent || cursor_only,
            ExportFormatKind::Gif => cursor_only,
            ExportFormatKind::Tracks => no_tracks,
            ExportFormatKind::Audio => false,
        };
        self.export_section(tr::editor::export::section::format(), "icons/video.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-format",
                    options
                        .iter()
                        .map(|format| {
                            ui::SegmentOption::new(format.label(), ui.format == *format)
                                .disabled(disabled(*format))
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some(format) = options.get(*index).copied() else {
                        return;
                    };
                    if disabled(format) {
                        return;
                    }
                    if let Some(ui) = this.export.as_mut() {
                        ui.format = format;
                        if !format.writes_video() {
                            ui.destination = ExportDestination::File;
                            ui.cursor_only = false;
                        }
                        if format == ExportFormatKind::Gif {
                            if ui.destination == ExportDestination::Link {
                                ui.destination = ExportDestination::File;
                            }
                            if ui.resolution == ExportResolution::P4k {
                                ui.resolution = ExportResolution::P1080;
                            }
                        }
                    }
                    this.normalize_loaded_export_options();
                    if let Some(ui) = this.export.as_mut() {
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
            .when(no_tracks && offers_tracks, |field| {
                field.child(
                    div()
                        .text_size(px(11.))
                        .text_color(Hsla::from(editor.text_3))
                        .child(tr::editor::export::tracks::studio_only()),
                )
            })
    }

    fn export_tracks_field(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let editor = self.theme.editor;
        self.export_section(tr::editor::export::section::tracks(), "icons/layers.svg")
            .children(ui.track_options.iter().map(|option| {
                self.export_track_row(option, ui.tracks.contains(&option.kind), cx)
                    .into_any_element()
            }))
            .child(
                div()
                    .text_size(px(11.))
                    .line_height(px(14.))
                    .text_color(Hsla::from(editor.text_3))
                    .child(if ui.tracks.is_empty() {
                        tr::editor::export::tracks::choose_one()
                    } else {
                        tr::editor::export::tracks::aligned()
                    }),
            )
    }

    fn export_track_row(
        &self,
        option: &TrackOption,
        checked: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let editor = self.theme.editor;
        let kind = option.kind;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .min_h(px(36.))
            .child(
                div()
                    .flex_none()
                    .size(px(28.))
                    .rounded(px(7.))
                    .bg(Hsla::from(editor.ctl))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        svg()
                            .path(track_icon(kind))
                            .size(px(14.))
                            .text_color(Hsla::from(if checked {
                                editor.text_1
                            } else {
                                editor.text_3
                            })),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_1))
                            .child(track_label(kind)),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(Hsla::from(editor.text_3))
                            .truncate()
                            .child(track_detail(option)),
                    ),
            )
            .child(
                ui::Toggle::plain(&self.theme, track_toggle_id(kind), checked).on_click(
                    cx.listener(move |this, _, _, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.toggle_track(kind);
                            ui.persist();
                        }
                        cx.notify();
                    }),
                ),
            )
    }

    fn export_resolution_field(
        &self,
        ui: &ExportUi,
        resolutions: &[ExportResolution],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let resolutions = resolutions.to_vec();
        self.export_section(
            tr::editor::export::section::resolution(),
            "icons/monitor-outline.svg",
        )
        .child(
            ui::SegmentedControl::editor(
                &theme,
                "export-resolution",
                resolutions
                    .iter()
                    .map(|res| ui::SegmentOption::new(res.label(), ui.resolution == *res))
                    .collect(),
            )
            .stretch()
            .item_height(px(SEGMENT_HEIGHT))
            .on_select(cx.listener(move |this, index: &usize, window, cx| {
                let Some(resolution) = resolutions.get(*index).copied() else {
                    return;
                };
                if let Some(ui) = this.export.as_mut() {
                    ui.choose_resolution(resolution);
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            })),
        )
    }

    fn export_fps_field(
        &self,
        ui: &ExportUi,
        options: &[u32],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let options = options.to_vec();
        self.export_section(tr::editor::export::section::frame_rate(), "icons/gauge.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-fps",
                    options
                        .iter()
                        .map(|fps| {
                            ui::SegmentOption::new(tr::editor::export::fps(fps), ui.fps == *fps)
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some(fps) = options.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.choose_fps(fps);
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
    }

    fn export_quality_field(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        self.export_section(tr::editor::export::section::quality(), "icons/gem.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-quality",
                    COMPRESSION_PRESETS
                        .iter()
                        .map(|(value, label)| {
                            ui::SegmentOption::new(
                                label(),
                                !ui.is_custom_bpp() && matches_compression(ui.compression, *value),
                            )
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some((compression, _)) = COMPRESSION_PRESETS.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.compression = compression;
                        ui.custom_bpp = None;
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .px(px(2.))
                    .text_size(px(10.5))
                    .text_color(Hsla::from(editor.text_3))
                    .child(tr::editor::export::quality::smaller())
                    .child(tr::editor::export::quality::larger()),
            )
            .child(self.export_optimize_row(ui, cx))
            .child(self.export_enhance_row(ui, cx))
            .when(turbo_available(), |this| {
                this.child(self.export_turbo_row(ui, cx))
            })
    }

    fn export_gif_quality_field(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        self.export_section(tr::editor::export::section::quality(), "icons/gem.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-gif-quality",
                    GifQualityPreset::ALL
                        .iter()
                        .map(|preset| {
                            ui::SegmentOption::new(preset.label(), ui.gif_quality == *preset)
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some(preset) = GifQualityPreset::ALL.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.gif_quality = preset;
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .px(px(2.))
                    .text_size(px(10.5))
                    .text_color(Hsla::from(editor.text_3))
                    .child(tr::editor::export::quality::smaller())
                    .child(tr::editor::export::quality::larger()),
            )
            .child(self.export_enhance_row(ui, cx))
    }

    fn export_enhance_row(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        self.export_toggle_row(
            "export-enhance",
            tr::editor::export::enhance::title(),
            tr::editor::export::enhance::description(),
            ui.enhance_quality,
            cx.listener(|this, _, window, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.enhance_quality = !ui.enhance_quality;
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            }),
        )
    }

    fn export_toggle_row(
        &self,
        id: &'static str,
        title: &'static str,
        description: &'static str,
        checked: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> impl IntoElement {
        let editor = self.theme.editor;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .min_h(px(34.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_1))
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(Hsla::from(editor.text_3))
                            .child(description),
                    ),
            )
            .child(ui::Toggle::plain(&self.theme, id, checked).on_click(on_click))
    }

    fn export_optimize_row(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        self.export_toggle_row(
            "export-optimize",
            tr::editor::export::optimize::title(),
            tr::editor::export::optimize::description(),
            ui.optimize_filesize,
            cx.listener(|this, _, window, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.optimize_filesize = !ui.optimize_filesize;
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            }),
        )
    }

    fn export_turbo_row(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let editor = self.theme.editor;
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(self.export_toggle_row(
                "export-turbo",
                tr::editor::export::turbo::title(),
                tr::editor::export::turbo::description(),
                ui.turbo,
                cx.listener(|this, _, window, cx| {
                    if let Some(ui) = this.export.as_mut() {
                        ui.turbo = !ui.turbo;
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                }),
            ))
            .when(ui.turbo, |this| {
                this.child(
                    div()
                        .p(px(12.))
                        .rounded(px(10.))
                        .bg(Hsla::from(editor.card_2))
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(8.))
                        .child(
                            svg()
                                .path("icons/triangle-alert.svg")
                                .size(px(14.))
                                .flex_shrink_0()
                                .mt(px(1.))
                                .text_color(Hsla::from(editor.text_2)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(11.5))
                                .line_height(px(15.))
                                .text_color(Hsla::from(editor.text_2))
                                .child(tr::editor::export::turbo::warning()),
                        ),
                )
            })
    }

    fn export_advanced(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let show_bpp = ui.format == ExportFormatKind::Mp4 && !ui.cursor_only;
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .id("export-advanced-toggle")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .h(px(30.))
                    .mx(px(-6.))
                    .px(px(6.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_2))
                    .hover(move |style| {
                        style
                            .bg(Hsla::from(editor.ctl))
                            .text_color(Hsla::from(editor.text_1))
                    })
                    .on_click(cx.listener(|this, _, _window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.advanced_open = !ui.advanced_open;
                            ui.persist();
                        }
                        cx.notify();
                    }))
                    .child(
                        svg()
                            .path("icons/sliders-horizontal.svg")
                            .size(px(14.))
                            .text_color(Hsla::from(editor.text_2)),
                    )
                    .child(tr::editor::export::advanced::title())
                    .child(
                        svg()
                            .path(if ui.advanced_open {
                                "icons/chevron-up.svg"
                            } else {
                                "icons/chevron-down.svg"
                            })
                            .size(px(14.))
                            .ml_auto()
                            .text_color(Hsla::from(editor.text_3)),
                    ),
            )
            .when(ui.advanced_open, |this| {
                this.child(self.export_toggle_row(
                    "export-cursor-only",
                    tr::editor::export::advanced::cursor_only(),
                    tr::editor::export::advanced::cursor_only_description(),
                    ui.cursor_only,
                    cx.listener(|this, _, window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.cursor_only = !ui.cursor_only;
                            if ui.cursor_only && ui.destination == ExportDestination::Link {
                                ui.destination = ExportDestination::File;
                            }
                        }
                        this.normalize_loaded_export_options();
                        if let Some(ui) = this.export.as_mut() {
                            ui.persist();
                        }
                        this.refresh_export_preview(window, cx);
                        cx.notify();
                    }),
                ))
                .when(ui.cursor_only, |this| {
                    this.child(
                        div()
                            .mt(px(4.))
                            .p(px(12.))
                            .rounded(px(10.))
                            .bg(Hsla::from(editor.card_2))
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                svg()
                                    .path("icons/triangle-alert.svg")
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .mt(px(1.))
                                    .text_color(Hsla::from(editor.text_2)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .line_height(px(15.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child(tr::editor::export::advanced::transparent_mov()),
                            ),
                    )
                })
                .when(show_bpp, |this| {
                    let fraction = ((ui.bpp() - BPP_MIN) / (BPP_MAX - BPP_MIN)).clamp(0., 1.);
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .h(px(34.))
                            .gap(px(10.))
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(96.))
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(editor.text_1))
                                    .child(tr::editor::export::advanced::bits_per_pixel()),
                            )
                            .child(
                                div()
                                    .id("export-bpp-row")
                                    .flex_1()
                                    .min_w_0()
                                    .px(px(4.))
                                    .h(px(32.))
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .child(
                                        ui::Slider::new(
                                            "export-bpp",
                                            fraction,
                                            ui.bpp_track.clone(),
                                        )
                                        .flex()
                                        .row_height(px(28.))
                                        .track(px(3.), Hsla::from(editor.ctl_active))
                                        .fill(Hsla::from(editor.accent))
                                        .thumb(
                                            px(14.),
                                            Hsla::from(editor.thumb),
                                            Some(gpui::hsla(0., 0., 0., 0.12)),
                                        )
                                        .thumb_shadow()
                                        .on_drag_start(
                                            cx.listener(
                                                |this, event: &MouseDownEvent, _window, cx| {
                                                    this.export_bpp_mouse_down(event, cx);
                                                },
                                            ),
                                        ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(36.))
                                    .text_right()
                                    .text_size(px(11.))
                                    .text_color(Hsla::from(editor.text_3))
                                    .child(format!("{:.2}", ui.bpp())),
                            ),
                    )
                    .when(ui.is_custom_bpp(), |this| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .text_color(Hsla::from(editor.text_3))
                                .child(tr::editor::export::advanced::custom_bitrate()),
                        )
                    })
                })
                .when(cfg!(target_os = "macos") && show_bpp, |this| {
                    this.child(self.export_toggle_row(
                        "export-force-ffmpeg",
                        tr::editor::export::advanced::force_ffmpeg(),
                        tr::editor::export::advanced::force_ffmpeg_description(),
                        ui.force_ffmpeg,
                        cx.listener(|this, _, window, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.force_ffmpeg = !ui.force_ffmpeg;
                                ui.persist();
                            }
                            this.refresh_export_preview(window, cx);
                            cx.notify();
                        }),
                    ))
                })
            })
    }

    fn export_bpp_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        if let Some(ui) = self.export.as_mut() {
            ui.bpp_dragging = true;
        }
        self.export_bpp_drag_to(event.position.x, cx);
        cx.notify();
    }

    fn export_bpp_drag_to(&mut self, x: gpui::Pixels, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let Some(bounds) = ui.bpp_track.get() else {
            return;
        };
        let Some(fraction) = ui::fraction_from_x(x, bounds) else {
            return;
        };
        let value = ui::snap_to_step(
            ui::value_from_fraction(fraction, BPP_MIN, BPP_MAX),
            BPP_MIN,
            BPP_MAX,
            BPP_STEP,
        );
        if (value - ui.bpp()).abs() < f32::EPSILON {
            return;
        }
        ui.custom_bpp = Some(value);
        if let Some((preset, _)) = COMPRESSION_PRESETS
            .iter()
            .find(|(preset, _)| (preset.bits_per_pixel() - value).abs() < 0.001)
        {
            ui.compression = *preset;
        }
        cx.notify();
    }

    fn export_bpp_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if !ui.bpp_dragging {
            return;
        }
        ui.bpp_dragging = false;
        ui.persist();
        self.refresh_export_preview(window, cx);
        cx.notify();
    }

    fn render_export_overlay(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let fraction = if ui.phase == ExportPhase::Uploading {
            Some(ui.upload_progress.clamp(0.0, 1.0))
        } else if ui.total_frames == 0 {
            None
        } else {
            Some(ui.rendered as f32 / ui.total_frames as f32)
        };
        let heading = match ui.phase {
            ExportPhase::Starting => tr::editor::export::phase::starting(),
            ExportPhase::Rendering if ui.format == ExportFormatKind::Tracks => {
                tr::editor::export::tracks::exporting()
            }
            ExportPhase::Rendering if ui.format == ExportFormatKind::Audio => {
                tr::editor::export::audio::exporting()
            }
            ExportPhase::Rendering if ui.cursor_only => {
                tr::editor::export::phase::rendering_cursor()
            }
            ExportPhase::Rendering if ui.format == ExportFormatKind::Gif => {
                tr::editor::export::phase::rendering_gif()
            }
            ExportPhase::Rendering => tr::editor::export::phase::rendering_video(),
            ExportPhase::Copying if ui.destination == ExportDestination::Clipboard => {
                tr::editor::export::phase::copying_to_clipboard()
            }
            ExportPhase::Copying => tr::editor::export::phase::saving_to_file(),
            ExportPhase::Uploading if ui.reuploading => tr::editor::export::phase::reuploading(),
            ExportPhase::Uploading => tr::editor::export::phase::uploading(),
            ExportPhase::Done if ui.destination == ExportDestination::Clipboard => {
                tr::editor::export::phase::copied()
            }
            ExportPhase::Done if ui.destination == ExportDestination::Link && ui.reuploading => {
                tr::editor::export::phase::reupload_complete()
            }
            ExportPhase::Done if ui.destination == ExportDestination::Link => {
                tr::editor::export::phase::upload_complete()
            }
            ExportPhase::Done if ui.format == ExportFormatKind::Tracks => {
                tr::editor::export::tracks::exported()
            }
            ExportPhase::Done if ui.format == ExportFormatKind::Audio => {
                tr::editor::export::audio::exported()
            }
            ExportPhase::Done => tr::editor::export::phase::complete(),
            ExportPhase::Failed if ui.clipboard_retry_path().is_some() => {
                tr::editor::export::phase::clipboard_failed()
            }
            ExportPhase::Failed => tr::editor::export::failed(),
            ExportPhase::Idle | ExportPhase::ChoosingFile => "",
        };

        let mut wash: Hsla = editor.window.into();
        wash.a = 0.94;

        div()
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.))
            .bg(wash)
            .text_color(Hsla::from(editor.text_1))
            .child({
                let ring = ui::CircularProgress::new(
                    px(80.),
                    px(6.),
                    Hsla::from(editor.ctl_active),
                    Hsla::from(editor.accent),
                )
                .label(Hsla::from(editor.text_1), px(14.));
                if let Some(fraction) = fraction {
                    ring.progress(fraction)
                } else {
                    ring.indeterminate()
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(heading),
                    )
                    .when(
                        ui.phase == ExportPhase::Done && ui.destination == ExportDestination::Link,
                        |this| {
                            this.child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child(if ui.reuploading {
                                        tr::editor::export::done::reuploaded()
                                    } else {
                                        tr::editor::export::done::uploaded()
                                    }),
                            )
                        },
                    ),
            )
            .when(
                ui.phase == ExportPhase::Rendering
                    && ui.total_frames > 0
                    && ui.format.writes_video(),
                |this| {
                    this.child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(editor.text_2))
                            .child(tr::editor::export::frames(
                                ui.total_frames as usize,
                                ui.rendered,
                            )),
                    )
                },
            )
            .when_some(ui.error.clone(), |this, error| {
                this.child(
                    div()
                        .max_w(px(360.))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.red_9))
                        .text_center()
                        .child(error),
                )
            })
            .when(ui.phase.is_busy(), |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "export-cancel",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label(tr::common::cancel())
                    .on_click(cx.listener(|this, _, window, cx| {
                        let Some(ui) = this.export.as_mut() else {
                            return;
                        };
                        let cancel = ui.cancel.clone();
                        #[cfg(target_os = "linux")]
                        {
                            if !ui.phase.is_busy() {
                                return;
                            }
                            let response = crate::editor_modal::confirm_cancel_export(window, cx);
                            cx.spawn_in(window, async move |this, cx| {
                                let confirmed = response.await;
                                let _ = this.update_in(cx, |this, _, cx| {
                                    if let Some(ui) = this.export.as_mut()
                                        && ui.phase.is_busy()
                                    {
                                        cancel_matching_export(&ui.cancel, &cancel, confirmed);
                                    }
                                    cx.notify();
                                });
                            })
                            .detach();
                        }
                        #[cfg(not(target_os = "linux"))]
                        cx.spawn_in(window, async move |this, cx| {
                            let confirmed = platform::confirm_dialog(
                                tr::editor::modal::cancel_export_title(),
                                tr::editor::modal::cancel_export_message(),
                                tr::editor::modal::cancel_export(),
                                tr::editor::modal::keep_exporting(),
                                true,
                            );
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    cancel_matching_export(&ui.cancel, &cancel, confirmed);
                                }
                                cx.notify();
                            });
                        })
                        .detach();
                    })),
                )
                .when(ui.format.writes_video(), |this| {
                    this.child(
                        div()
                            .max_w(px(320.))
                            .text_size(px(12.))
                            .text_color(Hsla::from(editor.text_2))
                            .text_center()
                            .child(tr::editor::export::done::instant_hint()),
                    )
                })
            })
            .when(
                ui.phase == ExportPhase::Done || ui.phase == ExportPhase::Failed,
                |this| {
                    this.when(ui.clipboard_retry_path().is_some(), |this| {
                        this.child(
                            ui::Button::plain(
                                &theme,
                                "export-retry-copy",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .icon("icons/copy.svg")
                            .label(tr::editor::export::done::retry_copy())
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.retry_clipboard_copy(window, cx);
                                },
                            )),
                        )
                    })
                    .when(
                        (ui.phase == ExportPhase::Done
                            && ui.destination == ExportDestination::File)
                            || ui.clipboard_retry_path().is_some(),
                        |this| {
                            let path = ui.output_path.clone();
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "export-open-file",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Md,
                                )
                                .label(if ui.format == ExportFormatKind::Tracks {
                                    tr::editor::export::tracks::open_folder()
                                } else {
                                    tr::editor::export::done::open_file()
                                })
                                .on_click(move |_, _, cx| {
                                    if let Some(path) = &path {
                                        library::open_with_system(path, cx);
                                    }
                                }),
                            )
                        },
                    )
                    .when(
                        ui.phase == ExportPhase::Done
                            && ui.destination == ExportDestination::Link
                            && ui.share_link.is_some(),
                        |this| {
                            let copied = ui.copy_link_pressed;
                            let open = ui.share_link.clone().unwrap_or_default();
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "export-copy-link",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Md,
                                )
                                .icon(if copied {
                                    "icons/check.svg"
                                } else {
                                    "icons/copy.svg"
                                })
                                .label(if copied {
                                    tr::editor::export::done::link_copied()
                                } else {
                                    tr::editor::export::done::copy_link()
                                })
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.copy_share_link(window, cx);
                                    },
                                )),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "export-open-link",
                                    ui::ButtonVariant::Primary,
                                    ui::ButtonSize::Md,
                                )
                                .icon("icons/link.svg")
                                .label(tr::editor::export::done::open_link())
                                .on_click(move |_, _, cx| {
                                    cx.open_url(&open);
                                }),
                            )
                        },
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "export-back-done",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .label(tr::editor::export::back())
                        .on_click(cx.listener(|this, _, window, cx| this.close_export(window, cx))),
                    )
                },
            )
    }
}

/// The largest box of the preview's aspect that fits the stage, so the frame's
/// rounded corners and shadow hug the picture instead of a letterboxed pane.
fn preview_fit(avail_w: f32, avail_h: f32, image: Option<(f32, f32)>) -> (f32, f32) {
    let avail_w = avail_w.max(120.);
    let avail_h = avail_h.max(68.);
    let (iw, ih) = match image {
        Some((w, h)) if w > 0. && h > 0. => (w, h),
        _ => (16., 9.),
    };
    let scale = (avail_w / iw).min(avail_h / ih);
    ((iw * scale).floor(), (ih * scale).floor())
}

async fn confirm_export_resources(
    this: &gpui::WeakEntity<EditorWindow>,
    cx: &mut gpui::AsyncWindowContext,
    resources: &ExportResources,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let check = {
        let resources = resources.clone();
        gpui_tokio::Tokio::spawn(cx, async move { resources.check().await }).await
    };
    let result = async {
        let warning = check.map_err(|error| error.to_string())??;
        if let Some(message) = warning {
            // The `CAP_GPUI_AUTO_EXPORT` hook runs unattended, so nobody is
            // there to answer the prompt. It goes on as "Proceed anyway" would;
            // a drive too full to export has already failed the check above.
            if std::env::var_os("CAP_GPUI_AUTO_EXPORT").is_some() {
                tracing::warn!(%message, "auto export proceeds past the resources warning");
                return Ok(true);
            }
            tracing::info!(%message, "export waits for the user to confirm its resources");
            #[cfg(target_os = "linux")]
            let confirmed = {
                let response = loop {
                    let pending = this.update_in(cx, |this, window, cx| {
                        let current = this.export.as_ref().is_some_and(|ui| {
                            Arc::ptr_eq(&ui.cancel, cancel)
                                && !ui.close_requested
                                && !cancel.load(Ordering::Acquire)
                        });
                        let response = (current && !window.has_active_prompt()).then(|| {
                            crate::editor_modal::confirm_action(
                                tr::editor::export::resources::title(),
                                &message,
                                tr::editor::export::resources::proceed(),
                                tr::common::go_back(),
                                window,
                                cx,
                            )
                        });
                        (current, response)
                    });
                    match pending {
                        Ok((true, Some(response))) => break response,
                        Ok((true, None)) => {
                            cx.background_executor()
                                .timer(Duration::from_millis(50))
                                .await;
                        }
                        _ => return Ok(false),
                    }
                };
                response.await
            };
            #[cfg(not(target_os = "linux"))]
            let confirmed = {
                let current = this
                    .update(cx, |this, _| {
                        this.export.as_ref().is_some_and(|ui| {
                            Arc::ptr_eq(&ui.cancel, cancel)
                                && !ui.close_requested
                                && !cancel.load(Ordering::Acquire)
                        })
                    })
                    .unwrap_or(false);
                if !current {
                    return Ok(false);
                }
                platform::confirm_dialog(
                    tr::editor::export::resources::title(),
                    &message,
                    tr::editor::export::resources::proceed(),
                    tr::common::go_back(),
                    false,
                )
            };
            if !confirmed {
                return Ok(false);
            }
            let resources = resources.clone();
            let _ = gpui_tokio::Tokio::spawn(cx, async move { resources.check().await })
                .await
                .map_err(|error| error.to_string())??;
        }
        Ok::<bool, String>(true)
    }
    .await;
    this.update(cx, |this, cx| {
        let Some(ui) = this.export.as_mut() else {
            return false;
        };
        if !Arc::ptr_eq(&ui.cancel, cancel) {
            return false;
        }
        let accepted = result.as_ref().is_ok_and(|accepted| *accepted)
            && !ui.close_requested
            && !cancel.load(Ordering::Acquire);
        if !accepted {
            match result {
                Err(error) if !ui.close_requested && !cancel.load(Ordering::Acquire) => {
                    tracing::error!(error, "export stopped before it started");
                    ui.phase = ExportPhase::Failed;
                    ui.error = Some(error);
                }
                _ => ui.phase = ExportPhase::Idle,
            }
            cx.notify();
        }
        accepted
    })
    .unwrap_or(false)
}

fn cancel_matching_export(current: &Arc<AtomicBool>, requested: &Arc<AtomicBool>, confirmed: bool) {
    if confirmed && Arc::ptr_eq(current, requested) {
        current.store(true, Ordering::Relaxed);
    }
}

fn show_upload_failure(
    this: &gpui::WeakEntity<EditorWindow>,
    cx: &mut gpui::AsyncWindowContext,
    message: &str,
    dialog: bool,
) {
    tracing::error!(error = message, "share upload failed");
    let message = message.to_string();
    let _ = this.update(cx, |this, cx| {
        if let Some(ui) = this.export.as_mut() {
            ui.phase = ExportPhase::Failed;
            ui.error = Some(message.clone());
        }
        cx.notify();
    });
    if dialog {
        platform::alert_dialog(tr::editor::export::upload_failed(), &message);
    }
}

fn export_stat(
    theme: &crate::theme::Theme,
    label: &'static str,
    value: Option<String>,
    divided: bool,
) -> impl IntoElement {
    let editor = theme.editor;
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .flex_col()
        .justify_center()
        .px(px(16.))
        .gap(px(1.))
        .when(divided, |this| {
            this.border_l_1().border_color(Hsla::from(editor.line))
        })
        .child(
            div()
                .text_size(px(10.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(editor.text_3))
                .truncate()
                .child(label),
        )
        .child(match value {
            Some(value) => div()
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(editor.text_1))
                .whitespace_nowrap()
                .child(value)
                .into_any_element(),
            None => div()
                .my(px(3.))
                .h(px(12.))
                .w(px(56.))
                .rounded(px(4.))
                .bg(Hsla::from(editor.ctl_active))
                .into_any_element(),
        })
}

/// Turbo trades the hardware encoder for libx264 on every core, which is
/// only measured faster on macOS so far.
fn turbo_available() -> bool {
    cfg!(target_os = "macos")
        && std::thread::available_parallelism().is_ok_and(|cores| cores.get() >= 8)
}

fn export_fps_options(format: ExportFormatKind, cursor_only: bool) -> &'static [u32] {
    if format == ExportFormatKind::Tracks {
        &[15, 30, 60]
    } else if format == ExportFormatKind::Gif && !cursor_only {
        &[5, 10, 15, 20, 25, 30]
    } else {
        &[15, 30, 60]
    }
}

fn export_resolutions(
    format: ExportFormatKind,
    cursor_only: bool,
    transparent: bool,
) -> &'static [ExportResolution] {
    if cursor_only {
        &[ExportResolution::P720, ExportResolution::P1080]
    } else if format == ExportFormatKind::Gif {
        &[
            ExportResolution::P480,
            ExportResolution::P720,
            ExportResolution::P1080,
        ]
    } else if transparent {
        &[ExportResolution::P720, ExportResolution::P1080]
    } else {
        &[
            ExportResolution::P720,
            ExportResolution::P1080,
            ExportResolution::P4k,
        ]
    }
}

fn normalize_export_options(ui: &mut ExportUi, transparent: bool) {
    if ui.format == ExportFormatKind::Tracks {
        ui.destination = ExportDestination::File;
    }
    if ui.format == ExportFormatKind::Audio {
        ui.destination = ExportDestination::File;
        ui.cursor_only = false;
    }
    let fps_options = export_fps_options(ui.format, ui.cursor_only);
    if ui.fps_from_source {
        ui.fps = source_fps(ui.source.fps, fps_options);
    }
    let resolutions = export_resolutions(ui.format, ui.cursor_only, transparent);
    if ui.resolution_from_source {
        let largest = if ui.format == ExportFormatKind::Gif && !ui.cursor_only {
            ExportResolution::P720
        } else {
            ExportResolution::P1080
        };
        ui.resolution = source_resolution(ui.source.size, resolutions, largest);
    }
    if !fps_options.contains(&ui.fps) {
        ui.fps = if ui.format == ExportFormatKind::Gif {
            15
        } else {
            30
        };
    }
    if !resolutions.contains(&ui.resolution) {
        ui.resolution = if ui.resolution == ExportResolution::P4k {
            ExportResolution::P1080
        } else {
            ExportResolution::P720
        };
    }
}

/// The rate a track was captured at. The probed rate is the track's average,
/// which a mostly still screen keeps far below its capture rate (a 60 fps
/// macOS capture of a still page averages a few fps), so the rate the recorder
/// stored wins when it is higher.
fn capture_fps(probed: u32, recorded: Option<u32>) -> u32 {
    probed.max(recorded.unwrap_or(0))
}

fn highest_recorded_fps(
    segments: impl IntoIterator<Item = (u32, Option<u32>)>,
    camera_visible: bool,
) -> Option<u32> {
    segments
        .into_iter()
        .flat_map(|(display, camera)| [Some(display), camera.filter(|_| camera_visible)])
        .flatten()
        .max()
        .filter(|fps| *fps > 0)
}

fn source_resolution(
    source: Option<XY<u32>>,
    options: &[ExportResolution],
    largest: ExportResolution,
) -> ExportResolution {
    let allowed = || options.iter().copied().filter(|res| *res <= largest);
    let Some(smallest) = allowed().min() else {
        return largest;
    };
    let Some(source) = source.filter(|size| size.x > 0 && size.y > 0) else {
        return allowed().max().unwrap_or(smallest);
    };
    allowed()
        .filter(|res| {
            let (width, height) = res.size();
            let scale = (width as f64 / source.x as f64).min(height as f64 / source.y as f64);
            scale <= 1.0
        })
        .max()
        .unwrap_or(smallest)
}

fn source_fps(source: Option<u32>, options: &[u32]) -> u32 {
    let highest = options.iter().copied().max().unwrap_or(30);
    let Some(source) = source else {
        return highest;
    };
    // A variable-rate recording's average frame rate reads a little under
    // the rate it was captured at (a 60 fps recording reads 57 to 59).
    options
        .iter()
        .copied()
        .filter(|fps| u64::from(*fps) * 10 >= u64::from(source) * 9)
        .min()
        .unwrap_or(highest)
}

fn matches_compression(current: ExportCompression, expected: ExportCompression) -> bool {
    std::mem::discriminant(&current) == std::mem::discriminant(&expected)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_export(
    project_path: PathBuf,
    project: cap_project::ProjectConfiguration,
    format: ExportFormatKind,
    cursor_only: bool,
    fps: u32,
    width: u32,
    height: u32,
    compression: ExportCompression,
    custom_bpp: Option<f32>,
    gif_quality: Option<GifQuality>,
    optimize: bool,
    turbo: bool,
    force: bool,
    save_path: Option<PathBuf>,
    progress_tx: flume::Sender<(u32, u32)>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Export cancelled".into());
    }
    let mut builder = ExporterBase::builder(project_path).with_force_ffmpeg_decoder(force);
    if cursor_only {
        builder = builder.with_config(make_cursor_only_project(project));
    } else {
        builder = builder.with_config(project);
    }
    if let Some(path) = save_path.clone() {
        builder = builder.with_output_path(path);
    }

    enum PreparedBase {
        Mp4(cap_export::Mp4ExporterBase),
        Other(ExporterBase),
    }
    let (base, total) = if !cursor_only && format != ExportFormatKind::Gif {
        let base = builder
            .build_for_mp4(cancel.clone())
            .await
            .map_err(|error| error.to_string())?;
        let total = base.total_frames(fps);
        (PreparedBase::Mp4(base), total)
    } else {
        let base = builder
            .build_video_only()
            .await
            .map_err(|error| error.to_string())?;
        let total = base.total_frames(fps);
        (PreparedBase::Other(base), total)
    };
    let _ = progress_tx.send((0, total));

    let progress = export_progress(total, progress_tx, cancel);

    let resolution = XY::new(width, height);
    match base {
        PreparedBase::Other(base) if cursor_only => {
            MovExportSettings {
                fps,
                resolution_base: resolution,
                cursor_only: true,
            }
            .export(base, progress)
            .await
        }
        PreparedBase::Other(base) => {
            GifExportSettings {
                fps,
                resolution_base: resolution,
                quality: gif_quality,
            }
            .export(base, progress)
            .await
        }
        PreparedBase::Mp4(base) => {
            let settings = Mp4ExportSettings {
                fps,
                resolution_base: resolution,
                compression,
                custom_bpp,
                force_ffmpeg_decoder: force,
                optimize_filesize: optimize,
            };
            if turbo {
                settings
                    .export_prepared_turbo(base, TurboOptions::default(), progress)
                    .await
            } else {
                settings.export_prepared(base, progress).await
            }
        }
    }
}

fn export_progress(
    total: u32,
    progress_tx: flume::Sender<(u32, u32)>,
    cancel: Arc<AtomicBool>,
) -> impl FnMut(u32) -> bool + Send + 'static {
    let mut rendered = 0;
    move |frame_index: u32| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        rendered = rendered.max((frame_index + 1).min(total));
        progress_tx.send((rendered, total)).is_ok()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn export_progress_does_not_restart_when_turbo_falls_back() {
        let (tx, rx) = flume::unbounded();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut progress = super::export_progress(300, tx, cancel.clone());

        for frame in [0, 149, 0, 1, 149, 150, 299] {
            assert!(progress(frame));
        }
        assert_eq!(
            rx.try_iter().collect::<Vec<_>>(),
            [
                (1, 300),
                (150, 300),
                (150, 300),
                (150, 300),
                (150, 300),
                (151, 300),
                (300, 300)
            ]
        );

        cancel.store(true, Ordering::Relaxed);
        assert!(!progress(299));
        assert!(rx.is_empty());
    }

    #[test]
    fn export_progress_stops_when_the_editor_drops_its_receiver() {
        let (tx, rx) = flume::unbounded();
        let mut progress = super::export_progress(300, tx, Arc::new(AtomicBool::new(false)));
        drop(rx);
        assert!(!progress(0));
    }

    #[test]
    fn estimate_ranges_keep_their_english_wording() {
        use super::format_estimate_range;

        assert_eq!(format_estimate_range([0.2, 0.5], false), "< 1 MB");
        assert_eq!(format_estimate_range([0.2, 0.5], true), "< 1s");
        assert_eq!(format_estimate_range([12.0, 12.0], false), "~12 MB");
        assert_eq!(format_estimate_range([12.3, 40.7], false), "~12–41 MB");
        assert_eq!(format_estimate_range([2048.0, 3500.0], false), "~2–3.4 GB");
        assert_eq!(format_estimate_range([30.0, 45.0], true), "~30–45 s");
        assert_eq!(format_estimate_range([90.0, 150.0], true), "~1.5–2.5 min");
        assert_eq!(format_estimate_range([7200.0, 7200.0], true), "~2 hr");
    }

    use super::{
        ExportDestination, ExportFormatKind, ExportPhase, ExportResolution, ExportSource, ExportUi,
        GifQualityPreset, TrackKind, TrackOption, cancel_matching_export, capture_fps,
        estimated_tracks_bytes, export_file_name, export_fps_options, export_name_stem,
        export_resolutions, highest_recorded_fps, normalize_export_options, selected_tracks,
    };
    use crate::store::ExportPrefs;
    use cap_project::XY;
    use std::path::PathBuf;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn clipboard_export() -> ExportUi {
        ExportUi::from_preferences(prefs())
    }

    fn prefs() -> ExportPrefs {
        ExportPrefs {
            format: "Mp4".into(),
            fps: 30,
            export_to: "clipboard".into(),
            resolution: "720p".into(),
            compression: "Maximum".into(),
            optimize_filesize: false,
            cursor_only: false,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            advanced_open: false,
            organization_id: None,
            turbo: false,
            gif_quality: None,
            excluded_tracks: None,
            resolution_from_source: false,
            fps_from_source: false,
            audio_format: None,
            enhance_quality: false,
        }
    }

    #[test]
    fn gif_exports_offer_smaller_options_that_other_formats_do_not() {
        assert_eq!(
            export_fps_options(ExportFormatKind::Gif, false),
            [5, 10, 15, 20, 25, 30]
        );
        assert_eq!(
            export_fps_options(ExportFormatKind::Mp4, false),
            [15, 30, 60]
        );
        assert_eq!(
            export_fps_options(ExportFormatKind::Gif, true),
            [15, 30, 60]
        );

        for transparent in [false, true] {
            assert_eq!(
                export_resolutions(ExportFormatKind::Gif, false, transparent),
                [
                    ExportResolution::P480,
                    ExportResolution::P720,
                    ExportResolution::P1080
                ]
            );
            for format in [ExportFormatKind::Gif, ExportFormatKind::Mp4] {
                assert_eq!(
                    export_resolutions(format, true, transparent),
                    [ExportResolution::P720, ExportResolution::P1080]
                );
            }
        }
        assert_eq!(
            export_resolutions(ExportFormatKind::Mp4, false, false),
            [
                ExportResolution::P720,
                ExportResolution::P1080,
                ExportResolution::P4k
            ]
        );
    }

    fn new_export(width: u32, height: u32, fps: u32) -> ExportUi {
        let mut ui = ExportUi::from_preferences(ExportPrefs {
            export_to: "file".into(),
            resolution: "1080p".into(),
            fps: 60,
            resolution_from_source: true,
            fps_from_source: true,
            ..prefs()
        });
        ui.source = ExportSource {
            size: Some(XY::new(width, height)),
            fps: Some(fps),
        };
        normalize_export_options(&mut ui, false);
        ui
    }

    fn chosen(ui: &ExportUi) -> (ExportResolution, u32) {
        (ui.resolution, ui.fps)
    }

    #[test]
    fn new_exports_default_to_1080p60_without_upscaling_the_source() {
        let p1080 = ExportResolution::P1080;
        let p720 = ExportResolution::P720;
        for (width, height, fps, expected) in [
            (3840, 2160, 60, (p1080, 60)),
            (4148, 2332, 60, (p1080, 60)),
            (3024, 1964, 60, (p1080, 60)),
            (1920, 1080, 60, (p1080, 60)),
            (2074, 1166, 60, (p1080, 60)),
            (1080, 1920, 60, (p1080, 60)),
            (1920, 1080, 30, (p1080, 30)),
            (1918, 1078, 60, (p720, 60)),
            (1382, 778, 60, (p720, 60)),
            (1280, 720, 60, (p720, 60)),
            (1280, 720, 30, (p720, 30)),
            (800, 600, 30, (p720, 30)),
        ] {
            assert_eq!(
                chosen(&new_export(width, height, fps)),
                expected,
                "{width}x{height} at {fps} fps"
            );
        }
    }

    #[test]
    fn new_exports_keep_every_source_frame_without_inventing_frames() {
        for (source, expected) in [
            (120, 60),
            (60, 60),
            (58, 60),
            (50, 60),
            (34, 60),
            (31, 30),
            (30, 30),
            (29, 30),
            (24, 30),
            (15, 15),
        ] {
            assert_eq!(new_export(1920, 1080, source).fps, expected, "{source} fps");
        }

        let mut unknown = new_export(1920, 1080, 60);
        unknown.source = ExportSource::default();
        normalize_export_options(&mut unknown, false);
        assert_eq!(chosen(&unknown), (ExportResolution::P1080, 60));
    }

    #[test]
    fn a_visible_faster_camera_sets_the_frame_rate() {
        let segments = [(30, Some(60)), (30, None)];
        assert_eq!(highest_recorded_fps(segments, true), Some(60));
        assert_eq!(highest_recorded_fps(segments, false), Some(30));
        assert_eq!(highest_recorded_fps([(0, None)], true), None);
    }

    #[test]
    fn a_still_screen_exports_at_the_rate_it_was_captured_at() {
        // A 60 fps macOS capture of a mostly still screen averages 4.7 fps.
        assert_eq!(capture_fps(5, Some(60)), 60);
        assert_eq!(new_export(1920, 1200, capture_fps(5, Some(60))).fps, 60);
        // A stored placeholder or a missing rate leaves the probed one.
        assert_eq!(capture_fps(60, Some(30)), 60);
        assert_eq!(capture_fps(24, Some(0)), 24);
        assert_eq!(capture_fps(48, None), 48);
    }

    #[test]
    fn new_gif_exports_keep_their_smaller_defaults() {
        let mut ui = new_export(3840, 2160, 60);
        ui.format = ExportFormatKind::Gif;
        normalize_export_options(&mut ui, false);
        assert_eq!(chosen(&ui), (ExportResolution::P720, 30));

        ui.format = ExportFormatKind::Mp4;
        normalize_export_options(&mut ui, false);
        assert_eq!(chosen(&ui), (ExportResolution::P1080, 60));
    }

    #[test]
    fn a_remembered_choice_wins_over_the_source() {
        let saved_before_this_change: ExportPrefs = serde_json::from_str(
            r#"{"format":"Mp4","fps":30,"export_to":"file","resolution":"720p","compression":"Maximum","optimize_filesize":false,"cursor_only":false,"custom_bpp":null,"force_ffmpeg_decoder":false,"advanced_open":false,"organization_id":null,"turbo":false,"gif_quality":"High"}"#,
        )
        .unwrap();
        assert!(!saved_before_this_change.resolution_from_source);
        assert!(!saved_before_this_change.fps_from_source);
        let mut ui = ExportUi::from_preferences(saved_before_this_change);
        ui.source = ExportSource {
            size: Some(XY::new(3840, 2160)),
            fps: Some(60),
        };
        normalize_export_options(&mut ui, false);
        assert_eq!(chosen(&ui), (ExportResolution::P720, 30));

        let mut ui = new_export(1280, 720, 30);
        ui.choose_resolution(ExportResolution::P4k);
        ui.choose_fps(60);
        let mut reopened = ExportUi::from_preferences(ui.preferences());
        reopened.source = ExportSource {
            size: Some(XY::new(1280, 720)),
            fps: Some(30),
        };
        normalize_export_options(&mut reopened, false);
        assert_eq!(chosen(&reopened), (ExportResolution::P4k, 60));
    }

    #[test]
    fn audio_exports_keep_the_latest_video_format() {
        let mut ui = new_export(1920, 1080, 30);
        ui.format = ExportFormatKind::Mp4;
        ui.remember_video_format();
        ui.format = ExportFormatKind::Gif;
        ui.remember_video_format();
        ui.format = ExportFormatKind::Audio;
        ui.remember_video_format();
        assert_eq!(ui.preferences().format, ExportFormatKind::Gif.slug());
    }

    #[test]
    fn untouched_defaults_follow_each_project() {
        let first = new_export(3840, 2160, 60);
        let mut second = ExportUi::from_preferences(first.preferences());
        second.source = ExportSource {
            size: Some(XY::new(1280, 720)),
            fps: Some(30),
        };
        normalize_export_options(&mut second, false);
        assert_eq!(chosen(&second), (ExportResolution::P720, 30));

        let mut picked_fps_only = new_export(3840, 2160, 60);
        picked_fps_only.choose_fps(30);
        let mut third = ExportUi::from_preferences(picked_fps_only.preferences());
        third.source = ExportSource {
            size: Some(XY::new(1280, 720)),
            fps: Some(60),
        };
        normalize_export_options(&mut third, false);
        assert_eq!(chosen(&third), (ExportResolution::P720, 30));
    }

    #[test]
    fn gif_only_options_fall_back_when_the_format_changes() {
        let mut ui = clipboard_export();
        ui.format = ExportFormatKind::Gif;
        ui.resolution = ExportResolution::P480;
        ui.fps = 5;
        normalize_export_options(&mut ui, false);
        assert_eq!((ui.resolution, ui.fps), (ExportResolution::P480, 5));

        ui.format = ExportFormatKind::Mp4;
        normalize_export_options(&mut ui, false);
        assert_eq!((ui.resolution, ui.fps), (ExportResolution::P720, 30));

        ui.format = ExportFormatKind::Gif;
        ui.resolution = ExportResolution::P480;
        ui.fps = 5;
        ui.cursor_only = true;
        normalize_export_options(&mut ui, false);
        assert_eq!((ui.resolution, ui.fps), (ExportResolution::P720, 15));

        ui.cursor_only = false;
        ui.resolution = ExportResolution::P4k;
        ui.fps = 60;
        normalize_export_options(&mut ui, false);
        assert_eq!((ui.resolution, ui.fps), (ExportResolution::P1080, 15));
    }

    #[test]
    fn only_gif_exports_preview_with_a_gif_palette() {
        let mut ui = clipboard_export();
        assert!(ui.gif_preview_quality().is_none());
        ui.format = ExportFormatKind::Gif;
        assert!(
            ui.gif_preview_quality()
                .is_some_and(|q| q.quality.is_none())
        );
        ui.gif_quality = GifQualityPreset::Low;
        assert_eq!(ui.gif_preview_quality().and_then(|q| q.quality), Some(50));
        ui.cursor_only = true;
        assert!(ui.gif_preview_quality().is_none());
    }

    #[test]
    fn gif_quality_defaults_to_the_encoder_default_and_round_trips() {
        let ui = clipboard_export();
        assert_eq!(ui.gif_quality, GifQualityPreset::High);
        assert!(ui.gif_quality.settings().is_none());
        assert_eq!(
            GifQualityPreset::from_slug(Some("Sharp")),
            GifQualityPreset::High
        );

        let mut qualities = Vec::new();
        for preset in GifQualityPreset::ALL {
            assert_eq!(GifQualityPreset::from_slug(Some(preset.slug())), preset);
            qualities.push(
                preset
                    .settings()
                    .and_then(|settings| settings.quality)
                    .unwrap_or(90),
            );
        }
        assert!(qualities.is_sorted_by(|a, b| a < b), "{qualities:?}");
    }

    #[test]
    fn export_names_sanitize_titles_and_preserve_the_format_extension() {
        for extension in ["mp4", "gif", "mov"] {
            for (title, expected) in [
                ("Sprint 1/2", "Sprint 12"),
                (r#"a/b\c:d*e?f"g<h>i|j"#, "abcdefghij"),
                ("\0\n", "Cap Recording"),
                ("/\\:*?\"<>|", "Cap Recording"),
                ("...", "Cap Recording"),
                ("   ", "Cap Recording"),
                ("CON", "Cap Recording"),
                ("Clip final. ", "Clip final"),
                ("My Clip 2026", "My Clip 2026"),
                ("你好 🎬", "你好 🎬"),
            ] {
                let filename = export_file_name(title, extension);
                assert_eq!(filename, format!("{expected}.{extension}"), "{title:?}");
                assert_eq!(PathBuf::from(&filename).components().count(), 1);
            }
        }
    }

    #[test]
    fn long_export_names_leave_room_for_the_format_extension() {
        for title in ["a".repeat(300), "🎬".repeat(100)] {
            for extension in ["mp4", "gif", "mov"] {
                let filename = export_file_name(&title, extension);
                assert!(filename.len() <= 255, "{} bytes", filename.len());
                assert!(filename.ends_with(&format!(".{extension}")));
                assert!(
                    title.starts_with(filename.strip_suffix(&format!(".{extension}")).unwrap())
                );
            }
        }
    }

    #[test]
    fn stale_preview_results_cannot_replace_the_latest_or_reopened_preview() {
        let mut ui = clipboard_export();
        let previous = ui.preview_request.clone();
        let current = Arc::new(());
        ui.preview_request = current.clone();
        assert!(ui.update_preview(&current, |ui| ui.preview_error = Some("Latest".into())));
        assert!(!ui.update_preview(&previous, |ui| ui.preview_error = Some("Stale".into())));
        assert_eq!(ui.preview_error.as_deref(), Some("Latest"));

        let mut reopened = clipboard_export();
        assert!(!reopened.update_preview(&current, |ui| ui.preview_error = Some("Closed".into())));
        assert!(reopened.preview_error.is_none());
    }

    #[test]
    fn failed_clipboard_copy_retries_the_completed_file() {
        let mut ui = clipboard_export();
        let output = PathBuf::from("finished recording.mp4");
        ui.copy_completed_export(output.clone(), |path| {
            assert_eq!(path, output);
            Err("Clipboard is busy".into())
        });
        assert_eq!(ui.phase, ExportPhase::Failed);
        assert_eq!(ui.error.as_deref(), Some("Clipboard is busy"));
        let retry = ui.clipboard_retry_path().unwrap().to_path_buf();
        assert_eq!(retry, output);

        ui.copy_completed_export(retry, |path| {
            assert_eq!(path, output);
            Ok(())
        });
        assert_eq!(ui.phase, ExportPhase::Done);
        assert_eq!(ui.output_path, Some(output));
        assert!(ui.error.is_none());
        assert!(ui.clipboard_retry_path().is_none());
    }

    #[test]
    fn cancellation_or_close_prevents_late_clipboard_mutation() {
        for closing in [false, true] {
            let mut ui = clipboard_export();
            ui.close_requested = closing;
            ui.cancel.store(!closing, Ordering::Relaxed);
            let output = PathBuf::from("finished recording.mp4");
            ui.copy_completed_export(output.clone(), |_| {
                panic!("cancelled exports must not replace the clipboard")
            });
            assert_eq!(ui.phase, ExportPhase::Idle);
            assert_eq!(ui.output_path, Some(output));
            assert!(ui.clipboard_retry_path().is_none());
        }
    }

    #[test]
    fn completed_share_export_copies_the_link_and_shows_success() {
        let mut ui = clipboard_export();
        ui.destination = ExportDestination::Link;
        ui.phase = ExportPhase::Uploading;
        ui.upload_progress = 0.9;
        let link = "https://cap.link/finished".to_string();
        let mut copied = None;

        ui.complete_share_export(link.clone(), |link| copied = Some(link));

        assert_eq!(ui.phase, ExportPhase::Done);
        assert_eq!(ui.share_link, Some(link.clone()));
        assert_eq!(ui.upload_progress, 1.0);
        assert_eq!(copied, Some(link));
    }

    #[test]
    fn cancellation_or_close_ignores_a_completed_share_export() {
        for closing in [false, true] {
            let mut ui = clipboard_export();
            ui.destination = ExportDestination::Link;
            ui.phase = ExportPhase::Uploading;
            ui.upload_progress = 0.9;
            let completed_link = "https://cap.link/finished".to_string();
            ui.close_requested = closing;
            ui.cancel.store(!closing, Ordering::Relaxed);

            ui.complete_share_export(completed_link, |_| {
                panic!("cancelled share exports must not copy a link or notify")
            });

            assert_eq!(ui.phase, ExportPhase::Idle);
            assert!(ui.share_link.is_none());
            assert_eq!(ui.upload_progress, 0.9);
        }
    }

    #[test]
    fn incomplete_or_non_clipboard_exports_cannot_retry_copy() {
        let mut ui = clipboard_export();
        ui.phase = ExportPhase::Failed;
        assert!(ui.clipboard_retry_path().is_none());
        ui.output_path = Some(PathBuf::from("finished recording.mp4"));
        ui.destination = ExportDestination::File;
        assert!(ui.clipboard_retry_path().is_none());
        ui.destination = ExportDestination::Link;
        assert!(ui.clipboard_retry_path().is_none());
    }

    #[test]
    fn declining_cancel_preserves_the_running_export() {
        let cancel = Arc::new(AtomicBool::new(false));
        cancel_matching_export(&cancel, &cancel, false);
        assert!(!cancel.load(Ordering::Relaxed));
        cancel_matching_export(&cancel, &cancel, true);
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn late_confirmation_cannot_cancel_a_subsequent_export() {
        let previous = Arc::new(AtomicBool::new(false));
        let current = Arc::new(AtomicBool::new(false));
        cancel_matching_export(&current, &previous, true);
        assert!(!current.load(Ordering::Relaxed));
        assert!(!previous.load(Ordering::Relaxed));
    }

    fn options(kinds: &[TrackKind]) -> Vec<TrackOption> {
        kinds
            .iter()
            .map(|kind| TrackOption {
                kind: *kind,
                size: kind.is_video().then_some((1920, 1080)),
            })
            .collect()
    }

    #[test]
    fn every_available_track_starts_on_unless_turned_off_before() {
        let all = options(&TrackKind::ALL);
        assert_eq!(selected_tracks(&all, &[]), TrackKind::ALL);
        assert_eq!(
            selected_tracks(&all, &[TrackKind::Camera, TrackKind::SystemAudio]),
            [TrackKind::Screen, TrackKind::Microphone]
        );
        let screen_only = options(&[TrackKind::Screen]);
        assert_eq!(
            selected_tracks(&screen_only, &[TrackKind::Screen]),
            [TrackKind::Screen]
        );
        assert!(selected_tracks(&[], &[]).is_empty());
    }

    #[test]
    fn turning_tracks_off_is_remembered_and_turning_them_on_forgets_it() {
        let mut ui = clipboard_export();
        ui.set_track_options(options(&[TrackKind::Screen, TrackKind::Microphone]));
        ui.toggle_track(TrackKind::Microphone);
        assert_eq!(ui.tracks, [TrackKind::Screen]);
        ui.toggle_track(TrackKind::Camera);
        assert_eq!(ui.tracks, [TrackKind::Screen]);

        let prefs = ExportPrefs {
            excluded_tracks: Some(vec!["microphone".into(), "unknown".into()]),
            ..prefs()
        };
        let mut reopened = ExportUi::from_preferences(prefs);
        reopened.set_track_options(options(&TrackKind::ALL));
        assert_eq!(
            reopened.tracks,
            [TrackKind::Screen, TrackKind::Camera, TrackKind::SystemAudio]
        );
        reopened.toggle_track(TrackKind::Microphone);
        assert_eq!(reopened.tracks, TrackKind::ALL);
        assert!(reopened.excluded_tracks.is_empty());
    }

    #[test]
    fn tracks_need_a_studio_recording_and_save_to_a_folder() {
        let mut ui = ExportUi::from_preferences(ExportPrefs {
            format: "Tracks".into(),
            ..prefs()
        });
        ui.set_track_options(Vec::new());
        assert_eq!(ui.format, ExportFormatKind::Mp4);
        ui.use_tracks(None);
        assert_eq!(ui.format, ExportFormatKind::Mp4);

        ui.set_track_options(options(&TrackKind::ALL));
        ui.cursor_only = true;
        ui.use_tracks(Some("mic, screen,cursor"));
        assert_eq!(ui.format, ExportFormatKind::Tracks);
        assert!(!ui.cursor_only);
        assert_eq!(ui.tracks, [TrackKind::Screen, TrackKind::Microphone]);

        ui.destination = ExportDestination::Clipboard;
        ui.fps = 25;
        normalize_export_options(&mut ui, true);
        assert_eq!(ui.destination, ExportDestination::File);
        assert_eq!(ui.fps, 30);
        assert_eq!(
            ExportFormatKind::from_slug(ExportFormatKind::Tracks.slug()),
            ExportFormatKind::Tracks
        );
    }

    #[test]
    fn track_size_estimates_count_only_selected_tracks() {
        let all = options(&TrackKind::ALL);
        assert_eq!(estimated_tracks_bytes(&all, &[], 30, 60.0), 0);
        let audio = estimated_tracks_bytes(&all, &[TrackKind::Microphone], 30, 60.0);
        assert_eq!(audio, 48_000 * 2 * 3 * 60);
        let screen = estimated_tracks_bytes(&all, &[TrackKind::Screen], 30, 60.0);
        assert!(screen > audio);
        assert_eq!(
            estimated_tracks_bytes(&all, &[TrackKind::Screen, TrackKind::Microphone], 30, 60.0),
            screen + audio
        );
    }

    #[test]
    fn tracks_folder_names_are_safe_and_whole() {
        assert_eq!(export_name_stem("Sprint 1/2", 0), "Sprint 12");
        assert_eq!(export_name_stem("   ", 0), "Cap Recording");
        assert_eq!(export_name_stem(&"a".repeat(300), 0).len(), 255);
    }

    #[test]
    fn choosing_a_file_blocks_duplicate_exports_without_showing_progress() {
        assert!(ExportPhase::ChoosingFile.is_busy());
        assert!(!ExportPhase::ChoosingFile.shows_progress());
    }

    #[test]
    fn cancelling_file_selection_returns_to_the_idle_page() {
        assert!(!ExportPhase::Idle.is_busy());
        assert!(!ExportPhase::Idle.shows_progress());
    }

    #[test]
    fn export_work_and_results_remain_visible() {
        for phase in [
            ExportPhase::Starting,
            ExportPhase::Rendering,
            ExportPhase::Copying,
            ExportPhase::Uploading,
            ExportPhase::Done,
            ExportPhase::Failed,
        ] {
            assert!(phase.shows_progress());
        }
    }
}
