use anyhow::{Context, Result, anyhow};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY};
use cap_rendering::{ProjectRecordingsMeta, ProjectUniforms, RenderOptions};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

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
        let config = ProjectConfiguration::load(path).context("project-config.json")?;
        let mut config = cap_export::prepare_project_for_export(config);
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
        cap_export::synthesize_default_timeline(&mut config, &recordings);
        cap_project::synchronize_legacy_keyboard(&recording_meta, &mut config);
        cap_project::synchronize_captions(
            &mut config,
            &recordings
                .segments
                .iter()
                .map(|segment| segment.display.duration)
                .collect::<Vec<_>>(),
        );
        Ok(Self {
            path: path.to_path_buf(),
            config,
            recording_meta,
            studio_meta,
            recordings,
        })
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
                camera3d_segments: Vec::new(),
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
