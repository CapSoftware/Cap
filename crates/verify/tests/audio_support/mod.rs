#![allow(dead_code)]

//! Shared pieces of the audio, captions and editing tests: marker fixtures,
//! the offline playback driver and export helpers.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_editor::{AudioOutput, AudioSegment, MusicTracks, OfflineAudioSink, PlaySpec};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY};
use cap_verify::{
    audio_fixture,
    audio_model::{self, AudioModel, AudioReport, AudioTruth},
    fixture::{self, FixtureSpec, SourceTruth},
    media,
    report::Case,
    video_code::StreamKind,
};
use tokio::sync::watch;

use crate::common::{self, OutputFrame, Project};

pub const RATE: u32 = cap_editor::HEADLESS_SAMPLE_RATE;
pub const CHANNELS: usize = cap_editor::HEADLESS_CHANNELS as usize;
pub const BLOCK: usize = cap_editor::HEADLESS_BLOCK_FRAMES;
/// A pull waits at most this long for its samples to render.
const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

pub fn project(spec: &FixtureSpec) -> Project {
    common::init();
    let path = fixture::ensure_fixture(spec, audio_fixture::write)
        .unwrap_or_else(|e| panic!("fixture {}: {e:?}", spec.name));
    let meta = RecordingMeta::load_for_project(&path).expect("fixture meta");
    let truth = SourceTruth::read(&path).expect("fixture truth");
    Project {
        name: spec.name.clone(),
        path,
        meta,
        truth,
    }
}

pub fn audio_model(project: &Project, config: &ProjectConfiguration) -> AudioModel {
    let truth = AudioTruth::read(&project.path, config).expect("audio truth");
    AudioModel::new(&project.meta, config, &truth).expect("audio model")
}

/// Records an audio verdict on a case.
pub fn judge(case: &mut Case, label: &str, report: &AudioReport) {
    if report.passed() {
        case.note(format!("{label}: {}", report.summary()));
    } else {
        let classes = report.classes();
        for class in &classes[1..] {
            case.classes.insert((*class).to_string());
        }
        case.problem(classes[0], format!("{label}: {}", report.summary()));
    }
}

/// Checks a mono output starting at output time `start_secs`.
pub fn check_pcm(case: &mut Case, label: &str, model: &AudioModel, mono: &[f32]) -> AudioReport {
    let heard = audio_model::hear(mono, 0.0, &model.rate_windows);
    let report = audio_model::check(model, &heard);
    if std::env::var_os("CAP_VERIFY_DUMP_AUDIO").is_some() {
        for h in &heard {
            eprintln!("  heard {label}: {h:?}");
        }
        for e in &model.expected {
            eprintln!("  expected {label}: {e:?}");
        }
    }
    judge(case, label, &report);
    report
}

pub fn check_music_contribution(
    case: &mut Case,
    project: &Project,
    config: &ProjectConfiguration,
    recording: &[f32],
    combined: &[f32],
) {
    let mut recording_config = config.clone();
    recording_config
        .timeline
        .as_mut()
        .expect("timeline")
        .audio_segments
        .clear();
    check_pcm(
        case,
        "recording",
        &audio_model(project, &recording_config),
        recording,
    );
    if recording.len() != combined.len() {
        case.problem(
            "audio-duration",
            format!(
                "adding music changed the sample count: {} to {}",
                recording.len(),
                combined.len()
            ),
        );
        return;
    }
    // Enhanced mic markers overlap the music's chirp band. Subtraction removes
    // their unknown waveform while retaining music timing, payload and gain checks.
    let music: Vec<f32> = combined
        .iter()
        .zip(recording)
        .map(|(combined, recording)| combined - recording)
        .collect();
    let mut model = audio_model(project, config);
    model
        .expected
        .retain(|marker| marker.source == cap_verify::audio_code::AudioSource::Media);
    check_pcm(case, "music contribution", &model, &music);
}

/// Plays a project's audio through the editor's real output source
/// pipeline (`AudioOutput::play` -> `install_source` -> pre-render buffer
/// -> playhead sync -> fill), pulled offline block by block.
pub struct OfflinePlayer {
    output: AudioOutput,
    sink: OfflineAudioSink,
    segments: Vec<AudioSegment>,
    music: MusicTracks,
    pub config: ProjectConfiguration,
    pub duration: f64,
    playhead: Option<watch::Sender<f64>>,
    generation: Option<u64>,
    /// Pulls whose samples did not render in time (silence was played).
    pub starved: usize,
}

impl OfflinePlayer {
    pub fn open(
        rt: &tokio::runtime::Runtime,
        project: &Project,
        config: ProjectConfiguration,
    ) -> Self {
        let meta = project.meta.studio_meta().expect("studio").clone();
        let segments = rt.block_on(async {
            let media = cap_editor::create_segments(&project.meta, &meta, false)
                .await
                .expect("segments");
            cap_editor::get_audio_segments(&media).await
        });
        let music = cap_editor::load_music_tracks_uncached(&config, &project.path);
        let (output, sink) = AudioOutput::new_offline();
        let duration = config.timeline.as_ref().map_or(0.0, |t| t.duration());
        Self {
            output,
            sink,
            segments,
            music,
            config,
            duration,
            playhead: None,
            generation: None,
            starved: 0,
        }
    }

    /// Presses play at `start` (stopping any current playback first).
    pub fn play(&mut self, start: f64) {
        self.stop();
        let (tx, rx) = watch::channel(start);
        let generation = self
            .output
            .play(PlaySpec {
                segments: self.segments.clone(),
                music: self.music.clone(),
                project: self.config.clone(),
                duration_secs: self.duration,
                start_playhead_secs: start,
                playhead_rx: rx,
            })
            .expect("offline audio output accepted the play request");
        self.playhead = Some(tx);
        self.generation = Some(generation);
    }

    /// Live seek while playing, as the playback loop sends it.
    pub fn seek(&mut self, to: f64) {
        if let Some(tx) = &self.playhead {
            let _ = tx.send(to);
        }
    }

    pub fn stop(&mut self) {
        if let Some(generation) = self.generation.take() {
            self.output.stop_playback(generation);
        }
        self.playhead = None;
    }

    /// Pulls at least `secs` of interleaved output in device-sized blocks.
    pub fn pull(&mut self, secs: f64) -> Vec<f32> {
        let blocks = (secs * f64::from(RATE) / BLOCK as f64).ceil() as usize;
        let mut out = Vec::with_capacity(blocks * BLOCK * CHANNELS);
        let mut block = vec![0.0f32; BLOCK * CHANNELS];
        for _ in 0..blocks {
            if !self.sink.pull(&mut block, RENDER_TIMEOUT) {
                self.starved += 1;
            }
            out.extend_from_slice(&block);
        }
        out
    }
}

impl Drop for OfflinePlayer {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn frames_secs(interleaved: &[f32]) -> f64 {
    (interleaved.len() / CHANNELS) as f64 / f64::from(RATE)
}

pub fn mono(interleaved: &[f32]) -> Vec<f32> {
    audio_model::interleaved_mono(interleaved, CHANNELS)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportPath {
    /// What the app does: `build_for_mp4` (streaming audio when eligible)
    /// then `export_prepared`.
    App,
    /// `build` then `export` (CLI and other callers).
    Plain,
    Mov,
    Gif,
}

impl ExportPath {
    pub fn label(self) -> &'static str {
        match self {
            ExportPath::App => "mp4-app",
            ExportPath::Plain => "mp4-plain",
            ExportPath::Mov => "mov",
            ExportPath::Gif => "gif",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            ExportPath::App | ExportPath::Plain => "mp4",
            ExportPath::Mov => "mov",
            ExportPath::Gif => "gif",
        }
    }
}

pub async fn export(
    project: &Project,
    config: ProjectConfiguration,
    path: ExportPath,
    fps: u32,
    resolution: (u32, u32),
    dir: &Path,
) -> Result<PathBuf, String> {
    export_failing_encoder_at(project, config, path, fps, resolution, dir, None).await
}

/// [`export`], with the MP4 video encoder failing after
/// `video_encoder_failure_at` frames as a hardware encoder does at runtime.
pub async fn export_failing_encoder_at(
    project: &Project,
    config: ProjectConfiguration,
    path: ExportPath,
    fps: u32,
    resolution: (u32, u32),
    dir: &Path,
    video_encoder_failure_at: Option<u32>,
) -> Result<PathBuf, String> {
    let out = dir.join(format!("out.{}", path.extension()));
    let builder = cap_export::ExporterBase::builder(project.path.clone())
        .with_config(config)
        .with_output_path(out);
    let resolution_base = XY::new(resolution.0, resolution.1);
    let mp4 = cap_export::mp4::Mp4ExportSettings {
        fps,
        resolution_base,
        compression: cap_export::mp4::ExportCompression::Social,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    };
    match path {
        ExportPath::App => {
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut base = builder
                .build_for_mp4(cancel)
                .await
                .map_err(|e| format!("exporter build: {e}"))?;
            if let Some(frames) = video_encoder_failure_at {
                base.fail_video_encoder_at(frames);
            }
            mp4.export_prepared(base, |_| true).await
        }
        ExportPath::Plain => {
            let mut base = builder
                .build()
                .await
                .map_err(|e| format!("exporter build: {e}"))?;
            if let Some(frames) = video_encoder_failure_at {
                base.fail_video_encoder_at(frames);
            }
            mp4.export(base, |_| true).await
        }
        ExportPath::Mov => {
            let base = builder
                .build()
                .await
                .map_err(|e| format!("exporter build: {e}"))?;
            cap_export::mov::MovExportSettings {
                fps,
                resolution_base,
                cursor_only: false,
            }
            .export(base, |_| true)
            .await
        }
        ExportPath::Gif => {
            let base = builder
                .build()
                .await
                .map_err(|e| format!("exporter build: {e}"))?;
            cap_export::gif::GifExportSettings {
                fps,
                resolution_base,
                quality: None,
            }
            .export(base, |_| true)
            .await
        }
    }
}

/// Whether a media file has an audio stream.
pub fn has_audio_stream(path: &Path) -> bool {
    media::init();
    ffmpeg::format::input(&path)
        .map(|input| input.streams().best(ffmpeg::media::Type::Audio).is_some())
        .unwrap_or(false)
}

/// Decodes an exported file's audio as mono at the analysis rate, with
/// sample 0 at output time 0.
pub fn exported_mono(path: &Path) -> Result<Vec<f32>, String> {
    let decoded = media::decode_audio(path, Some(audio_model::ANALYSIS_RATE))
        .map_err(|e| format!("decode audio: {e:?}"))?;
    let mut mono = decoded.mono();
    let lead = (decoded.start_secs * f64::from(audio_model::ANALYSIS_RATE)).round() as i64;
    if lead > 0 {
        let mut padded = vec![0.0; lead as usize];
        padded.extend_from_slice(&mono);
        mono = padded;
    } else if lead < 0 {
        mono.drain(..(-lead as usize).min(mono.len()));
    }
    Ok(mono)
}

/// Per clip: (display alignment offset, display nominal fps).
pub fn display_timing(meta: &RecordingMeta) -> Vec<(f64, u32)> {
    let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        return Vec::new();
    };
    inner
        .segments
        .iter()
        .map(|segment| {
            let starts = [
                segment.display.start_time,
                segment.camera.as_ref().and_then(|c| c.start_time),
                segment.mic.as_ref().and_then(|m| m.start_time),
                segment.system_audio.as_ref().and_then(|s| s.start_time),
            ];
            let latest = starts
                .iter()
                .flatten()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            let offset = match segment.display.start_time {
                Some(start) if latest.is_finite() => latest - start,
                _ => 0.0,
            };
            (offset, segment.display.fps)
        })
        .collect()
}

/// A/V offset per heard recording marker: the output time the marker is
/// heard minus the output time the screen first shows the source frame
/// that contains the marker's recording time. Must be within one output
/// frame (or one source frame at the segment's speed) plus 5 ms.
pub fn check_av(
    case: &mut Case,
    meta: &RecordingMeta,
    report: &AudioReport,
    frames: &[OutputFrame],
    fps: u32,
) {
    let timing = display_timing(meta);
    // Screen frames the video oracle already found wrong show the wrong
    // source frame, so they cannot time a marker: a marker whose first
    // showing is one of them is not measured (the video failure is judged
    // on its own).
    let wrong: std::collections::BTreeSet<usize> = case
        .streams
        .iter()
        .filter(|s| s.stream == Some(StreamKind::Screen))
        .flat_map(|s| s.mismatches.iter().map(|m| m.output_frame as usize))
        .collect();
    let mut worst = 0.0f64;
    let mut bad = Vec::new();
    let mut checked = 0;
    let mut unmeasured = 0;
    for (expected, heard) in &report.pairs {
        // Partial markers and markers inside a transition (a video blend)
        // have no single source frame to compare with.
        if expected.presence != audio_model::Presence::Required || expected.blended {
            continue;
        }
        let Some((clip, recording_time)) = expected.recording else {
            continue;
        };
        let Some(&(offset, src_fps)) = timing.get(clip) else {
            continue;
        };
        let slot = ((recording_time + offset) * f64::from(src_fps)).floor() as i64;
        // Search near the heard time only: a timeline can show the same
        // source frame again elsewhere (backward jumps, reorders).
        let first = ((heard.time_secs - 0.2) * f64::from(fps)).floor().max(0.0) as usize;
        let shown = frames
            .iter()
            .enumerate()
            .skip(first)
            .take((0.4 * f64::from(fps)).ceil() as usize)
            .find(|(_, f)| {
                f.readout.get(StreamKind::Screen).marker().is_some_and(|m| {
                    usize::from(m.segment) == clip
                        && (slot..=slot + i64::from(src_fps) / 4).contains(&i64::from(m.index))
                })
            });
        let Some((i, _)) = shown else {
            continue;
        };
        if wrong.contains(&i) {
            unmeasured += 1;
            continue;
        }
        checked += 1;
        let av = heard.time_secs - i as f64 / f64::from(fps);
        let limit = (1.0 / f64::from(fps)).max(1.0 / (f64::from(src_fps) * heard.rate)) + 0.005;
        worst = worst.max(av.abs());
        if av.abs() > limit {
            bad.push(format!(
                "{} #{} heard at {:.4}s, its source frame first shown at {:.4}s ({:+.1} ms)",
                expected.source.name(),
                expected.index,
                heard.time_secs,
                i as f64 / f64::from(fps),
                av * 1000.0
            ));
        }
    }
    let summary = format!(
        "A/V: {checked} markers, worst offset {:.1} ms (limit one frame + 5 ms)",
        worst * 1000.0
    );
    if unmeasured > 0 {
        case.note(format!(
            "A/V: {unmeasured} markers not measured: their source frame first shows on a frame the video oracle found wrong"
        ));
        if checked == 0 {
            case.unobserved(
                "av-sync",
                format!("all {unmeasured} timeable markers first show on wrong video frames"),
            );
        }
    }
    if bad.is_empty() {
        case.note(summary);
    } else {
        case.problem(
            "av-sync",
            format!(
                "{summary}, {} out of sync (first: {})",
                bad.len(),
                bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")
            ),
        );
    }
}
