use anyhow::{Context, Result, anyhow, bail};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY};
use cap_rendering::{ProjectRecordingsMeta, ProjectUniforms, RenderOptions, Video};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// Largest source frame a cloud export accepts, the same limit the media
/// server holds uploads to. Recordings are uploaded by users, and decoding
/// allocates per pixel, so one oversized stream could exhaust a shared worker.
pub const MAX_SOURCE_PIXELS: u64 = 40_000_000;
pub const MAX_SOURCE_SIDE: u32 = 16_384;
/// FFmpeg checks whole macroblock rows and 64-byte aligned widths against
/// `max_pixels`, up to `(width + 63) * (height + 15)` for an accepted source.
pub const DECODE_MAX_PIXELS: i64 = MAX_SOURCE_PIXELS as i64 + 80 * MAX_SOURCE_SIDE as i64 + 1024;

/// Longest source or edit a cloud export reads: 5M frames at 60 fps, the
/// coordinator's own index limit. Declared lengths size the probe's spans and
/// each audio track's buffer, and uploads declare whatever they like.
pub const MAX_SOURCE_SECONDS: f64 = 5_000_000.0 / 60.0;
/// Fewest bytes a second of recorded audio can take. Encoded silence is the
/// smallest audio there is: 150 bytes a second for Opus in Ogg with 120 ms
/// frames, 240 for Chrome's 60 ms Opus in WebM, 380 for AAC, 1000 for MP3. A
/// file that declares more seconds than this allows misstates its length.
pub const MIN_AUDIO_BYTES_PER_SECOND: f64 = 16.0;
pub const MAX_AUDIO_SAMPLE_RATE: u32 = 768_000;
pub const MAX_AUDIO_CHANNELS: u16 = 64;

/// A probed length the engine can rely on. Browser WebM carries none, and
/// probing it gives a negative one.
pub fn usable_duration(duration: f64) -> Option<f64> {
    (duration.is_finite() && duration > 0.0).then_some(duration)
}

fn check_video_duration(kind: &str, clip: usize, video: &Video) -> Result<()> {
    if video.duration.is_nan() || video.duration > MAX_SOURCE_SECONDS {
        bail!(
            "the {kind} video of clip {} declares {:.0} s, longer than cloud export supports ({MAX_SOURCE_SECONDS:.0} s)",
            clip + 1,
            video.duration
        );
    }
    Ok(())
}

/// `probed` is the file's sample rate, channel count and declared length.
fn check_audio_source(kind: &str, clip: usize, probed: (u32, u16, f64), path: &Path) -> Result<()> {
    let (sample_rate, channels, duration) = probed;
    if sample_rate > MAX_AUDIO_SAMPLE_RATE || channels > MAX_AUDIO_CHANNELS {
        bail!(
            "the {kind} audio of clip {} is {sample_rate} Hz with {channels} channels, more than cloud export supports ({MAX_AUDIO_SAMPLE_RATE} Hz, {MAX_AUDIO_CHANNELS} channels)",
            clip + 1
        );
    }
    let Some(duration) = usable_duration(duration) else {
        return Ok(());
    };
    if duration > MAX_SOURCE_SECONDS {
        bail!(
            "the {kind} audio of clip {} declares {duration:.0} s, longer than cloud export supports ({MAX_SOURCE_SECONDS:.0} s)",
            clip + 1
        );
    }
    let bytes = std::fs::metadata(path)
        .with_context(|| format!("{kind} audio of clip {}", clip + 1))?
        .len();
    if duration * MIN_AUDIO_BYTES_PER_SECOND > bytes as f64 {
        bail!(
            "the {kind} audio of clip {} declares {duration:.0} s in {bytes} bytes, more than the file can hold",
            clip + 1
        );
    }
    Ok(())
}

/// Each clip's mic and system audio files, in recording order.
pub fn audio_tracks(
    recording_meta: &RecordingMeta,
    studio_meta: &StudioRecordingMeta,
) -> Vec<(Option<PathBuf>, Option<PathBuf>)> {
    match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => vec![(
            segment
                .audio
                .as_ref()
                .map(|audio| recording_meta.path(&audio.path)),
            None,
        )],
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| {
                (
                    segment
                        .mic
                        .as_ref()
                        .map(|audio| recording_meta.path(&audio.path)),
                    segment
                        .usable_system_audio()
                        .map(|audio| recording_meta.path(&audio.path)),
                )
            })
            .collect(),
    }
}

fn check_source_size(kind: &str, clip: usize, video: &Video) -> Result<()> {
    let pixels = u64::from(video.width) * u64::from(video.height);
    if pixels > MAX_SOURCE_PIXELS || video.width.max(video.height) > MAX_SOURCE_SIDE {
        bail!(
            "the {kind} video of clip {} is {}x{}, larger than cloud export supports ({MAX_SOURCE_PIXELS} pixels, {MAX_SOURCE_SIDE} on a side)",
            clip + 1,
            video.width,
            video.height
        );
    }
    Ok(())
}

/// Everything a chunk needs to agree on with every other chunk of the same
/// export: the prepared config, the recording, and the frame count. Loading
/// it the same way as `ExporterBase` keeps the timeline identical to a
/// single-machine export.
pub struct LoadedProject {
    pub path: PathBuf,
    pub config: ProjectConfiguration,
    pub recording_meta: RecordingMeta,
    pub studio_meta: StudioRecordingMeta,
    pub recordings: Arc<ProjectRecordingsMeta>,
}

impl LoadedProject {
    pub fn load(path: &Path) -> Result<Self> {
        let mut config = ProjectConfiguration::load(path).context("project-config.json")?;
        let recording_meta = RecordingMeta::load_for_project(path)
            .map_err(|error| anyhow!("recording-meta.json: {error}"))?;
        let studio_meta = recording_meta
            .studio_meta()
            .ok_or_else(|| anyhow!("not a studio recording"))?
            .clone();
        let recordings = Arc::new(
            ProjectRecordingsMeta::new(&recording_meta.project_path, &studio_meta)
                .map_err(|error| anyhow!("recordings: {error}"))?,
        );
        let tracks = audio_tracks(&recording_meta, &studio_meta);
        for (clip, segment) in recordings.segments.iter().enumerate() {
            check_source_size("screen", clip, &segment.display)?;
            check_video_duration("screen", clip, &segment.display)?;
            if let Some(camera) = &segment.camera {
                check_source_size("camera", clip, camera)?;
                check_video_duration("camera", clip, camera)?;
            }
            let (mic_path, system_path) = tracks.get(clip).cloned().unwrap_or_default();
            for (kind, audio, path) in [
                ("mic", segment.mic.as_ref(), mic_path),
                ("system", segment.system_audio.as_ref(), system_path),
            ] {
                if let (Some(audio), Some(path)) = (audio, path) {
                    check_audio_source(
                        kind,
                        clip,
                        (audio.sample_rate, audio.channels, audio.duration),
                        &path,
                    )?;
                }
            }
        }
        cap_export::synthesize_default_timeline(&mut config, &recordings);
        cap_project::migrate_late_audio_alignment(&mut config, &studio_meta, || {
            recordings
                .segments
                .iter()
                .map(|segment| segment.display.duration)
                .collect()
        });
        cap_project::synchronize_legacy_keyboard(&recording_meta, &mut config);
        cap_project::synchronize_captions(
            &mut config,
            &recordings
                .segments
                .iter()
                .map(|segment| segment.display.duration)
                .collect::<Vec<_>>(),
        );
        let project = Self {
            path: path.to_path_buf(),
            config,
            recording_meta,
            studio_meta,
            recordings,
        };
        let duration = project.duration();
        if duration.is_nan() || duration > MAX_SOURCE_SECONDS {
            bail!(
                "the edited project is {duration:.0} s long, longer than cloud export supports ({MAX_SOURCE_SECONDS:.0} s)"
            );
        }
        Ok(project)
    }

    pub fn duration(&self) -> f64 {
        cap_rendering::get_duration(
            &self.recordings,
            &self.recording_meta,
            &self.studio_meta,
            &self.config,
        )
    }

    pub fn total_frames(&self, fps: u32) -> u32 {
        (fps as f64 * self.duration()).ceil() as u32
    }

    pub fn render_options(&self) -> Result<RenderOptions> {
        let first = self
            .recordings
            .segments
            .first()
            .ok_or_else(|| anyhow!("recording has no segments"))?;
        Ok(RenderOptions {
            screen_size: XY::new(first.display.width, first.display.height),
            camera_size: first
                .camera
                .as_ref()
                .map(|camera| XY::new(camera.width, camera.height)),
            preserve_screen_alpha: false,
        })
    }

    pub fn output_size(&self, resolution: [u32; 2]) -> Result<(u32, u32)> {
        Ok(ProjectUniforms::get_output_size(
            &self.render_options()?,
            &self.config,
            XY::new(resolution[0], resolution[1]),
        ))
    }

    /// Source-time extent each output frame range reads, per recording clip.
    /// The coordinator widens these by keyframe distance and clip offsets to
    /// decide which bytes of each source a chunk worker has to download.
    pub fn source_spans(&self, fps: u32, frames: [u32; 2]) -> Vec<ClipSpan> {
        source_spans(&self.config, fps, frames)
    }
}

fn source_spans(config: &ProjectConfiguration, fps: u32, frames: [u32; 2]) -> Vec<ClipSpan> {
    use cap_project::TimelineFrameMapping;
    let mut spans: Vec<ClipSpan> = Vec::new();
    let Some(timeline) = &config.timeline else {
        return spans;
    };
    let mut include = |source: cap_project::TimelineSource<'_>| {
        let clip = source.segment.recording_clip;
        match spans.iter_mut().find(|span| span.clip == clip) {
            Some(span) => {
                span.start = span.start.min(source.source_time);
                span.end = span.end.max(source.source_time);
            }
            None => spans.push(ClipSpan {
                clip,
                start: source.source_time,
                end: source.source_time,
            }),
        }
    };
    for frame in frames[0]..frames[1] {
        match timeline.get_frame_mapping(frame as f64 / fps as f64) {
            Some(
                TimelineFrameMapping::Single { source, .. }
                | TimelineFrameMapping::Hold { source, .. },
            ) => include(source),
            Some(TimelineFrameMapping::Transition {
                outgoing, incoming, ..
            }) => {
                include(outgoing);
                include(incoming);
            }
            None => {}
        }
    }
    spans
}

fn mapping_key(timeline: &cap_project::TimelineConfiguration, time: f64) -> Option<(u8, usize)> {
    use cap_project::TimelineFrameMapping;
    Some(match timeline.get_frame_mapping(time)? {
        TimelineFrameMapping::Single { source, .. } => (0, source.segment_index),
        TimelineFrameMapping::Hold { source, .. } => (1, source.segment_index),
        TimelineFrameMapping::Transition { incoming, .. } => (2, incoming.segment_index),
    })
}

impl LoadedProject {
    /// Output sample positions where the timeline switches clip segment (or
    /// enters/leaves a hold or transition). The audio renderer starts every
    /// segment with fresh Studio Sound and speed state, so an audio section
    /// that begins at one of these points renders bit-identically to an
    /// unbroken export.
    pub fn audio_cuts(&self, fps: u32, sample_rate: i64) -> Vec<i64> {
        let Some(timeline) = &self.config.timeline else {
            return Vec::new();
        };
        let total = self.total_frames(fps);
        let mut cuts = Vec::new();
        let mut previous = mapping_key(timeline, 0.0);
        for frame in 1..total {
            let time = frame as f64 / fps as f64;
            let key = mapping_key(timeline, time);
            if key != previous {
                let (mut low, mut high) = ((frame - 1) as f64 / fps as f64, time);
                while high - low > 0.25 / sample_rate as f64 {
                    let middle = (low + high) / 2.0;
                    if mapping_key(timeline, middle) == previous {
                        low = middle;
                    } else {
                        high = middle;
                    }
                }
                cuts.push((high * sample_rate as f64).ceil() as i64);
                previous = key;
            }
        }
        cuts
    }
}

#[derive(Serialize, Clone, Copy)]
pub struct ClipSpan {
    pub clip: u32,
    pub start: f64,
    pub end: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{ClipTransition, ClipTransitionType, TimelineConfiguration, TimelineSegment};

    fn config(second_clip: u32) -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![
                    TimelineSegment {
                        recording_clip: 0,
                        start: 0.0,
                        end: 6.0,
                        timescale: 1.0,
                        ..Default::default()
                    },
                    TimelineSegment {
                        recording_clip: second_clip,
                        start: 10.0,
                        end: 16.0,
                        timescale: 1.0,
                        ..Default::default()
                    },
                ],
                transitions: vec![ClipTransition {
                    segment_index: 1,
                    kind: ClipTransitionType::CrossFade,
                    duration: 2.0,
                }],
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                shape_segments: Vec::new(),
                camera3d_segments: Vec::new(),
                waveform_segments: Vec::new(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn transition_chunk_includes_both_sources_from_its_first_frame() {
        let spans = source_spans(&config(1), 30, [120, 180]);
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].clip, 0);
        assert_eq!(spans[0].start, 4.0);
        assert!((spans[0].end - (6.0 - 1.0 / 30.0)).abs() < 1e-9);
        assert_eq!(spans[1].clip, 1);
        assert_eq!(spans[1].start, 10.0);
        assert!((spans[1].end - (12.0 - 1.0 / 30.0)).abs() < 1e-9);
    }

    #[test]
    fn transition_between_edits_of_one_clip_unions_both_time_ranges() {
        let spans = source_spans(&config(0), 30, [120, 121]);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 4.0);
        assert_eq!(spans[0].end, 10.0);
    }

    #[test]
    fn frames_after_transition_only_need_incoming_clip() {
        let spans = source_spans(&config(1), 30, [180, 181]);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].clip, 1);
        assert_eq!(spans[0].start, 12.0);
    }
}
