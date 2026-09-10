use crate::SegmentAudioTimingRepair;
use cap_audio::{
    AudioData, AudioRendererTrack, AudioSampleSource, AudioSampleWindow, AudioWindowRead,
    ProgressiveAudio,
};
use cap_project::ProjectConfiguration;
use std::{ops::Range, sync::Arc};

const RATE: f64 = AudioData::SAMPLE_RATE as f64;
const MAX_FRAME: usize = 1 << 40;
const MAX_CHUNK_FRAMES: usize = 65_536;

#[derive(Clone)]
pub(crate) struct PreparingAudioSources {
    pub(crate) project: Arc<ProjectConfiguration>,
    pub(crate) tracks: Vec<[Option<ProgressiveAudio>; 2]>,
    pub(crate) required: Vec<[bool; 2]>,
    pub(crate) repairs: Vec<SegmentAudioTimingRepair>,
}

struct ClipLayout {
    start: usize,
    end: usize,
    offsets: [isize; 2],
}

impl PreparingAudioSources {
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.layout().map(drop)
    }

    pub(crate) fn total_duration(&self) -> f64 {
        self.project.timeline.as_ref().map_or(0.0, |timeline| {
            timeline.segments.iter().map(|segment| segment.end).sum()
        })
    }

    fn layout(&self) -> Result<Vec<ClipLayout>, String> {
        let timeline = self
            .project
            .timeline
            .as_ref()
            .ok_or("Preparing audio timeline is absent")?;
        let count = self.tracks.len();
        if count == 0
            || count > 1024
            || self.required.len() != count
            || self.repairs.len() != count
            || timeline.segments.len() != count
            || self.project.clips.len() != count
            || !timeline.transitions.is_empty()
            || !timeline.audio_segments.is_empty()
            || !timeline.hold_windows().is_empty()
            || !self.project.audio.mic_volume_db.is_finite()
            || !self.project.audio.system_volume_db.is_finite()
        {
            return Err("Preparing audio layout is unsupported".into());
        }
        let mut offsets = vec![None; count];
        for clip in &self.project.clips {
            let slot = offsets
                .get_mut(clip.index as usize)
                .ok_or("Preparing audio clip index is invalid")?;
            if slot.replace(clip.offsets).is_some() {
                return Err("Preparing audio clip index is duplicated".into());
            }
        }
        let mut duration = 0.0;
        let mut start = 0;
        let mut clips = Vec::with_capacity(count);
        for (index, segment) in timeline.segments.iter().enumerate() {
            if segment.recording_clip as usize != index
                || segment.start != 0.0
                || segment.timescale != 1.0
                || segment.speed_audio_mode.is_some()
                || !segment.end.is_finite()
                || segment.end <= 0.0
            {
                return Err("Preparing audio requires the stopped 1x timeline".into());
            }
            duration += segment.end;
            if !duration.is_finite() || duration * RATE > MAX_FRAME as f64 {
                return Err("Preparing audio timeline exceeds sample limits".into());
            }
            let end = (duration * RATE).round() as usize;
            if end <= start {
                return Err("Preparing audio clip has no sample frames".into());
            }
            let offset = offsets[index].ok_or("Preparing audio clip offsets are absent")?;
            let repair = self.repairs[index];
            let mut samples = [0; 2];
            for (track, (base, repair)) in [
                (offset.mic, repair.mic_offset_secs),
                (offset.system_audio, repair.system_audio_offset_secs),
            ]
            .into_iter()
            .enumerate()
            {
                let sum = base + repair;
                let rounded = (sum * AudioData::SAMPLE_RATE as f32).round();
                if !base.is_finite()
                    || !repair.is_finite()
                    || !rounded.is_finite()
                    || rounded.abs() > MAX_FRAME as f32
                    || (!self.required[index][track] && self.tracks[index][track].is_some())
                {
                    return Err("Preparing audio track timing or presence is invalid".into());
                }
                samples[track] = rounded as isize;
            }
            clips.push(ClipLayout {
                start,
                end,
                offsets: samples,
            });
            start = end;
        }
        Ok(clips)
    }

    fn check_terminal(&self) -> Result<(), String> {
        for loader in self.tracks.iter().flatten().flatten() {
            let progress = loader.progress();
            if let Some(error) = progress.error {
                return Err(error);
            }
            if progress.ready_frames > MAX_FRAME
                || progress
                    .channels
                    .is_some_and(|channels| !matches!(channels, 1 | 2))
            {
                return Err("Preparing audio sample layout is invalid".into());
            }
        }
        Ok(())
    }

    pub(crate) fn playable_prefix(&self) -> Result<f64, String> {
        let clips = self.layout()?;
        self.check_terminal()?;
        for (index, clip) in clips.iter().enumerate() {
            let frames = clip.end - clip.start;
            let mut available = frames;
            for (track, required) in self.required[index].iter().enumerate() {
                if !required {
                    continue;
                }
                let Some(loader) = &self.tracks[index][track] else {
                    available = 0;
                    continue;
                };
                let progress = loader.progress();
                let end = progress.ready_frames;
                let covered = match loader.try_window(end.saturating_sub(1)..end)? {
                    AudioWindowRead::Ready(Some(window)) => {
                        if window.complete_sample_count().is_some() {
                            frames
                        } else if progress.channels.is_some() && window.available_range().end >= end
                        {
                            (end as i128 - clip.offsets[track] as i128).clamp(0, frames as i128)
                                as usize
                        } else {
                            0
                        }
                    }
                    AudioWindowRead::Pending | AudioWindowRead::Ready(None) => 0,
                };
                available = available.min(covered);
            }
            if available < frames {
                return Ok(((clip.start + available) as f64 / RATE).min(self.total_duration()));
            }
        }
        self.check_terminal()?;
        Ok(self.total_duration())
    }
}

pub(crate) enum PreparingAudioRead {
    Samples {
        start_frame: usize,
        frames: usize,
        samples: Vec<f32>,
    },
    Pending {
        loader: Option<ProgressiveAudio>,
        range: Range<usize>,
    },
    Eof,
}

pub(crate) struct PreparingAudioMixer {
    sources: PreparingAudioSources,
    clips: Vec<ClipLayout>,
    position: usize,
}

struct PreparedSpan {
    clip: usize,
    local: usize,
    output: usize,
    frames: usize,
    windows: [Option<AudioSampleWindow>; 2],
}

impl PreparingAudioMixer {
    pub(crate) fn new(sources: PreparingAudioSources, start_seconds: f64) -> Result<Self, String> {
        let clips = sources.layout()?;
        if !start_seconds.is_finite()
            || start_seconds < 0.0
            || start_seconds > sources.total_duration()
        {
            return Err("Preparing audio start is outside the timeline".into());
        }
        let position = (start_seconds * RATE).round() as usize;
        Ok(Self {
            sources,
            clips,
            position,
        })
    }

    pub(crate) fn next(&mut self, requested_frames: usize) -> Result<PreparingAudioRead, String> {
        if requested_frames == 0 || requested_frames > MAX_CHUNK_FRAMES {
            return Err("Preparing audio chunk size is invalid".into());
        }
        self.sources.check_terminal()?;
        let total = self
            .clips
            .last()
            .ok_or("Preparing audio timeline is empty")?
            .end;
        if self.position >= total {
            return Ok(PreparingAudioRead::Eof);
        }
        let end = self.position + requested_frames.min(total - self.position);
        let mut spans = Vec::new();
        let mut pending = None;
        for (index, clip) in self.clips.iter().enumerate() {
            let start = self.position.max(clip.start);
            let until = end.min(clip.end);
            if start >= until {
                continue;
            }
            let local = start - clip.start;
            let frames = until - start;
            let mut windows = [None, None];
            for (track, slot) in windows.iter_mut().enumerate() {
                if !self.sources.required[index][track] {
                    continue;
                }
                let first = local as i128 + clip.offsets[track] as i128;
                let range = first.max(0) as usize..(first + frames as i128).max(0) as usize;
                let Some(loader) = &self.sources.tracks[index][track] else {
                    pending.get_or_insert(PreparingAudioRead::Pending {
                        loader: None,
                        range,
                    });
                    continue;
                };
                match loader.try_window(range.clone())? {
                    AudioWindowRead::Pending => {
                        pending.get_or_insert_with(|| PreparingAudioRead::Pending {
                            loader: Some(loader.clone()),
                            range,
                        });
                    }
                    AudioWindowRead::Ready(None) => {
                        pending.get_or_insert(PreparingAudioRead::Pending {
                            loader: None,
                            range,
                        });
                    }
                    AudioWindowRead::Ready(Some(window)) => {
                        let covered = window.available_range();
                        let required = match window.complete_sample_count() {
                            Some(total) => range.start.min(total)..range.end.min(total),
                            None => range,
                        };
                        if !matches!(window.channels(), 1 | 2)
                            || (required.start < required.end
                                && (required.start < covered.start || required.end > covered.end))
                        {
                            return Err("Preparing audio window does not cover its samples".into());
                        }
                        *slot = Some(window);
                    }
                }
            }
            spans.push(PreparedSpan {
                clip: index,
                local,
                output: start - self.position,
                frames,
                windows,
            });
        }
        self.sources.check_terminal()?;
        if let Some(pending) = pending {
            return Ok(pending);
        }
        let frames = end - self.position;
        let mut samples = vec![0.0; frames * 2];
        for span in spans {
            let tracks = span
                .windows
                .iter()
                .enumerate()
                .filter_map(|(track, window)| {
                    let data = window.as_ref()?;
                    let audio = &self.sources.project.audio;
                    let gain = if track == 0 {
                        audio.mic_volume_db
                    } else {
                        audio.system_volume_db
                    };
                    Some(AudioRendererTrack {
                        data,
                        gain: if audio.mute || gain < -30.0 {
                            f32::NEG_INFINITY
                        } else {
                            gain
                        },
                        stereo_mode: if track == 0 {
                            match audio.mic_stereo_mode {
                                cap_project::StereoMode::Stereo => cap_audio::StereoMode::Stereo,
                                cap_project::StereoMode::MonoL => cap_audio::StereoMode::MonoL,
                                cap_project::StereoMode::MonoR => cap_audio::StereoMode::MonoR,
                            }
                        } else {
                            cap_audio::StereoMode::Stereo
                        },
                        offset: self.clips[span.clip].offsets[track],
                    })
                })
                .collect::<Vec<_>>();
            cap_audio::render_audio(
                &tracks,
                span.local,
                span.frames,
                span.output * 2,
                &mut samples,
            );
        }
        self.sources.check_terminal()?;
        let start_frame = self.position;
        self.position = end;
        Ok(PreparingAudioRead::Samples {
            start_frame,
            frames,
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_audio::{AudioChunk, DecodedAudio, ProgressiveAudioTestProducer};
    use cap_project::{ClipConfiguration, TimelineConfiguration, TimelineSegment};

    fn audio(frames: usize, channels: u16, seed: usize) -> Arc<AudioData> {
        Arc::new(AudioData::from_raw_f32(
            (0..frames * usize::from(channels))
                .map(|index| ((index * 97 + seed) % 127) as f32 / 90.0 - 0.7)
                .collect(),
            channels,
        ))
    }

    fn append(producer: &ProgressiveAudioTestProducer, audio: &AudioData, range: Range<usize>) {
        let channels = usize::from(audio.channels());
        producer
            .append(AudioChunk {
                source_start_sample: range.start as u64,
                channels: audio.channels(),
                samples: audio.samples()[range.start * channels..range.end * channels].to_vec(),
            })
            .unwrap();
    }

    fn sources(
        durations: &[f64],
        tracks: Vec<[Option<ProgressiveAudio>; 2]>,
    ) -> PreparingAudioSources {
        let count = durations.len();
        PreparingAudioSources {
            project: Arc::new(ProjectConfiguration {
                timeline: Some(TimelineConfiguration {
                    segments: durations
                        .iter()
                        .enumerate()
                        .map(|(index, &end)| TimelineSegment {
                            recording_clip: index as u32,
                            start: 0.0,
                            end,
                            timescale: 1.0,
                            ..Default::default()
                        })
                        .collect(),
                    transitions: Vec::new(),
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
                clips: (0..count)
                    .map(|index| ClipConfiguration {
                        index: index as u32,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }),
            required: tracks
                .iter()
                .map(|tracks| tracks.each_ref().map(Option::is_some))
                .collect(),
            tracks,
            repairs: vec![SegmentAudioTimingRepair::default(); count],
        }
    }

    fn reference(
        sources: &PreparingAudioSources,
        audio: Vec<[Option<Arc<AudioData>>; 2]>,
        start: f64,
        frames: usize,
    ) -> (usize, Vec<f32>) {
        let segments = audio
            .into_iter()
            .zip(&sources.repairs)
            .map(|([mic, system], &repair)| {
                let decoded = |audio: Arc<AudioData>| Arc::new(DecodedAudio::from(audio));
                crate::audio_segment_from_decoded(mic.map(decoded), system.map(decoded), repair)
            })
            .collect();
        let mut renderer = crate::AudioRenderer::new(segments);
        renderer.set_playhead(start, &sources.project);
        renderer.render_frame_raw(frames, &sources.project).unwrap()
    }

    fn assert_samples(
        actual: PreparingAudioRead,
        expected_start: usize,
        expected: (usize, Vec<f32>),
    ) {
        let PreparingAudioRead::Samples {
            start_frame,
            frames,
            samples,
        } = actual
        else {
            panic!("Expected real mixed audio samples");
        };
        assert_eq!(start_frame, expected_start);
        assert_eq!(frames, expected.0);
        assert_eq!(samples.len(), frames * 2);
        assert_eq!(samples.len(), expected.1.len());
        for (index, (actual, expected)) in samples.iter().zip(&expected.1).enumerate() {
            assert_eq!(actual.to_bits(), expected.to_bits(), "sample {index}");
        }
    }

    #[test]
    fn pending_blocks_match_ordinary_offset_gain_stereo_and_mute_mixing() {
        for channels in [1, 2] {
            for mode in [
                cap_project::StereoMode::Stereo,
                cap_project::StereoMode::MonoL,
                cap_project::StereoMode::MonoR,
            ] {
                for mute in [false, true] {
                    let mic = audio(65_536, channels, 17);
                    let system = audio(65_536, 2, 53);
                    let (mic_loader, mic_producer) = ProgressiveAudioTestProducer::new();
                    let (system_loader, system_producer) = ProgressiveAudioTestProducer::new();
                    append(&mic_producer, &mic, 0..32_768);
                    append(&system_producer, &system, 0..32_768);
                    let mut sources =
                        sources(&[1.25], vec![[Some(mic_loader), Some(system_loader)]]);
                    let project = Arc::make_mut(&mut sources.project);
                    project.audio.mute = mute;
                    project.audio.mic_stereo_mode = mode.clone();
                    project.audio.mic_volume_db = -3.0;
                    project.audio.system_volume_db = if mute { -31.0 } else { 1.0 };
                    project.clips[0].offsets.mic = 13.25 / RATE as f32;
                    project.clips[0].offsets.system_audio = -11.75 / RATE as f32;
                    sources.repairs[0] = SegmentAudioTimingRepair {
                        mic_offset_secs: -30.5 / RATE as f32,
                        system_audio_offset_secs: 28.25 / RATE as f32,
                    };
                    let expected = reference(&sources, vec![[Some(mic), Some(system)]], 0.0, 4096);
                    let mut mixer = PreparingAudioMixer::new(sources.clone(), 0.0).unwrap();
                    assert!(sources.playable_prefix().unwrap() < sources.total_duration());
                    assert_samples(mixer.next(4096).unwrap(), 0, expected);
                    assert!(!sources.tracks[0][0].as_ref().unwrap().progress().complete);
                }
            }
        }
    }

    #[test]
    fn cross_clip_pending_preflights_the_entire_chunk_without_advancing() {
        let first = audio(1500, 1, 7);
        let second = audio(40_000, 2, 71);
        let (loader, producer) = ProgressiveAudioTestProducer::new();
        let sources = sources(
            &[1000.0 / RATE, 40_000.0 / RATE],
            vec![
                [Some(ProgressiveAudio::ready(Some(first.clone()))), None],
                [Some(loader), None],
            ],
        );
        let start = 950.0 / RATE;
        let expected = reference(
            &sources,
            vec![[Some(first), None], [Some(second.clone()), None]],
            start,
            1024,
        );
        let mut mixer = PreparingAudioMixer::new(sources.clone(), start).unwrap();
        assert_eq!(sources.playable_prefix().unwrap(), 1000.0 / RATE);
        for _ in 0..2 {
            let PreparingAudioRead::Pending {
                loader: Some(_),
                range,
            } = mixer.next(1024).unwrap()
            else {
                panic!("Expected the second clip's actual pending loader");
            };
            assert_eq!(range, 0..974);
        }
        append(&producer, &second, 0..32_768);
        assert_eq!(sources.playable_prefix().unwrap(), 33_768.0 / RATE);
        assert_samples(mixer.next(1024).unwrap(), 950, expected);
        append(&producer, &second, 32_768..40_000);
        producer.finish().unwrap();
        assert_eq!(sources.playable_prefix().unwrap(), sources.total_duration());
    }

    #[test]
    fn clip_boundaries_use_ordinary_accumulated_rounding() {
        let first = audio(1100, 2, 5);
        let second = audio(1100, 1, 11);
        let sources = sources(
            &[1000.49 / RATE, 800.49 / RATE],
            vec![
                [Some(ProgressiveAudio::ready(Some(first.clone()))), None],
                [Some(ProgressiveAudio::ready(Some(second.clone()))), None],
            ],
        );
        let expected = reference(
            &sources,
            vec![[Some(first), None], [Some(second), None]],
            0.0,
            2048,
        );
        assert_eq!(expected.0, 1801);
        let mut mixer = PreparingAudioMixer::new(sources, 0.0).unwrap();
        assert_samples(mixer.next(2048).unwrap(), 0, expected);
        assert!(matches!(mixer.next(1024).unwrap(), PreparingAudioRead::Eof));
    }

    #[test]
    fn only_true_eof_admits_the_silent_tail() {
        let data = audio(64, 1, 3);
        let (loader, producer) = ProgressiveAudioTestProducer::new();
        append(&producer, &data, 0..64);
        let sources = sources(&[1000.0 / RATE], vec![[Some(loader), None]]);
        let expected = reference(&sources, vec![[Some(data), None]], 0.0, 1024);
        let mut mixer = PreparingAudioMixer::new(sources.clone(), 0.0).unwrap();
        assert_eq!(sources.playable_prefix().unwrap(), 64.0 / RATE);
        assert!(matches!(
            mixer.next(1024).unwrap(),
            PreparingAudioRead::Pending { .. }
        ));
        producer.finish().unwrap();
        assert_eq!(sources.playable_prefix().unwrap(), sources.total_duration());
        assert_samples(mixer.next(1024).unwrap(), 0, expected);
        assert!(matches!(mixer.next(1).unwrap(), PreparingAudioRead::Eof));
    }

    #[test]
    fn absent_audio_is_silence_but_declared_missing_or_empty_audio_is_pending() {
        let mut sources = sources(&[1.0], vec![[None, None]]);
        assert_eq!(sources.playable_prefix().unwrap(), 1.0);
        let mut mixer = PreparingAudioMixer::new(sources.clone(), 0.0).unwrap();
        assert_samples(mixer.next(1024).unwrap(), 0, (1024, vec![0.0; 2048]));
        sources.required[0][0] = true;
        for empty in [None, Some(ProgressiveAudio::none())] {
            sources.tracks[0][0] = empty;
            assert_eq!(sources.playable_prefix().unwrap(), 0.0);
            let mut mixer = PreparingAudioMixer::new(sources.clone(), 0.0).unwrap();
            assert!(matches!(
                mixer.next(1024).unwrap(),
                PreparingAudioRead::Pending { loader: None, .. }
            ));
        }
    }

    #[test]
    fn late_failure_is_terminal_even_when_muted_or_beyond_a_blocked_clip() {
        let data = audio(32_768, 2, 41);
        let (loader, producer) = ProgressiveAudioTestProducer::new();
        append(&producer, &data, 0..32_768);
        let mut sources = sources(&[1.0], vec![[Some(loader.clone()), None]]);
        Arc::make_mut(&mut sources.project).audio.mute = true;
        let mut mixer = PreparingAudioMixer::new(sources.clone(), 0.0).unwrap();
        assert_samples(mixer.next(1024).unwrap(), 0, (1024, vec![0.0; 2048]));
        producer.fail("corrupt tail".into());
        assert_eq!(sources.playable_prefix().unwrap_err(), "corrupt tail");
        assert_eq!(mixer.next(1024).err().unwrap(), "corrupt tail");
        let mut later = self::sources(&[1.0, 1.0], vec![[None, None], [Some(loader), None]]);
        later.required[0][0] = true;
        assert_eq!(later.playable_prefix().unwrap_err(), "corrupt tail");
    }

    #[test]
    fn validation_rejects_unbounded_or_changed_audio_layout() {
        let original = sources(&[1.0], vec![[None, None]]);
        original.validate().unwrap();
        let cases: [fn(&mut PreparingAudioSources); 7] = [
            |sources| sources.required.clear(),
            |sources| sources.repairs[0].mic_offset_secs = f32::NAN,
            |sources| Arc::make_mut(&mut sources.project).clips[0].index = 1,
            |sources| Arc::make_mut(&mut sources.project).audio.mic_volume_db = f32::INFINITY,
            |sources| {
                Arc::make_mut(&mut sources.project)
                    .timeline
                    .as_mut()
                    .unwrap()
                    .segments[0]
                    .end = f64::INFINITY
            },
            |sources| {
                Arc::make_mut(&mut sources.project)
                    .timeline
                    .as_mut()
                    .unwrap()
                    .segments[0]
                    .timescale = 2.0
            },
            |sources| {
                Arc::make_mut(&mut sources.project)
                    .timeline
                    .as_mut()
                    .unwrap()
                    .segments[0]
                    .end = MAX_FRAME as f64
            },
        ];
        for change in cases {
            let mut invalid = original.clone();
            change(&mut invalid);
            assert!(invalid.validate().is_err());
        }
        assert!(PreparingAudioMixer::new(original.clone(), f64::NAN).is_err());
        let mut mixer = PreparingAudioMixer::new(original, 0.0).unwrap();
        assert!(mixer.next(0).is_err());
        assert!(mixer.next(MAX_CHUNK_FRAMES + 1).is_err());
    }
}
