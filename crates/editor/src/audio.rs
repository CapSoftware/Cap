use crate::export_audio::{EXPORT_AUDIO_BLOCK_SAMPLES, ExportAudioError, ExportAudioSources};
use cap_audio::{
    AudioData, AudioRendererTrack, DecodedAudio, FromSampleBytes, StereoMode, VoiceAudio,
    VoiceEnhancer, VoiceSource, cast_bytes_to_f32_slice, cast_f32_slice_to_bytes,
    high_quality_resampler_options,
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{
    AudioConfiguration, ClipOffsets, ClipSpeedAudioMode, ClipTransitionType, ProjectConfiguration,
    TimelineConfiguration, TimelineFrameMapping, TimelineSource, VoiceIsolation,
};
use ffmpeg::{
    ChannelLayout, filter, format as avformat, frame::Audio as FFAudio, software::resampling,
};
use ringbuf::{
    HeapRb,
    traits::{Consumer, Observer, Producer},
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
};
use tracing::{info, warn};

/// Decoded music/imported-audio tracks, keyed by the path string stored in the
/// project config's `timeline.audio_segments`. The renderer mixes these on top
/// of the recording audio in output/timeline time.
pub type MusicTracks = HashMap<String, Arc<AudioData>>;

pub struct AudioRenderer {
    data: Vec<AudioSegment>,
    cursor: AudioRendererCursor,
    // sum of `frame.samples()` that have elapsed
    // this * channel count = cursor
    elapsed_samples: usize,
    music: MusicTracks,
    transition_outgoing: Vec<f32>,
    transition_incoming: Vec<f32>,
    speed_audio_processors: [Option<SpeedAudioProcessorSlot>; 2],
    speed_audio_use_counter: u64,
    voice_enhancement: VoiceEnhancementCache,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioRendererCursor {
    clip_index: u32,
    timescale: f64,
    // excludes channels
    samples: usize,
}

#[derive(Clone)]
pub struct AudioSegment {
    pub tracks: Vec<AudioSegmentTrack>,
}

// yeah this is cursed oh well
#[derive(Clone)]
pub struct AudioSegmentTrack {
    data: Arc<DecodedAudio>,
    get_gain: fn(&AudioConfiguration) -> f32,
    get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
    get_offset: fn(&ClipOffsets) -> f32,
    timing_offset_secs: f32,
    is_microphone: bool,
}

impl AudioSegmentTrack {
    pub fn new(
        data: Arc<AudioData>,
        get_gain: fn(&AudioConfiguration) -> f32,
        get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
        get_offset: fn(&ClipOffsets) -> f32,
    ) -> Self {
        Self::from_decoded(
            Arc::new(DecodedAudio::from(data)),
            get_gain,
            get_stereo_mode,
            get_offset,
        )
    }

    pub fn from_decoded(
        data: Arc<DecodedAudio>,
        get_gain: fn(&AudioConfiguration) -> f32,
        get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
        get_offset: fn(&ClipOffsets) -> f32,
    ) -> Self {
        Self {
            data,
            get_gain,
            get_stereo_mode,
            get_offset,
            timing_offset_secs: 0.0,
            is_microphone: false,
        }
    }

    pub fn with_microphone_enhancement(mut self) -> Self {
        self.is_microphone = true;
        self
    }

    pub fn with_timing_offset_secs(mut self, timing_offset_secs: f32) -> Self {
        self.timing_offset_secs = timing_offset_secs;
        self
    }

    pub fn data(&self) -> &Arc<DecodedAudio> {
        &self.data
    }

    pub fn gain(&self, config: &AudioConfiguration) -> f32 {
        (self.get_gain)(config)
    }

    pub fn stereo_mode(&self, config: &AudioConfiguration) -> StereoMode {
        (self.get_stereo_mode)(config)
    }

    pub fn offset(&self, offsets: &ClipOffsets) -> f32 {
        (self.get_offset)(offsets) + self.timing_offset_secs
    }

    fn same_source(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.data, &other.data)
            && std::ptr::fn_addr_eq(self.get_gain, other.get_gain)
            && std::ptr::fn_addr_eq(self.get_stereo_mode, other.get_stereo_mode)
            && std::ptr::fn_addr_eq(self.get_offset, other.get_offset)
            && self.timing_offset_secs.to_bits() == other.timing_offset_secs.to_bits()
            && self.is_microphone == other.is_microphone
    }
}

struct TimelineCursor<'a> {
    segment_end_samples: usize,
    segment_time: f64,
    segment_index: usize,
    segment: &'a cap_project::TimelineSegment,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SpeedAudioProcessorKey {
    segment_index: usize,
    recording_clip: u32,
    timescale_bits: u64,
    mode: ClipSpeedAudioMode,
    segment_start_samples: usize,
    segment_end_samples: usize,
    mic_volume_bits: u32,
    improve_microphone: bool,
    isolation: VoiceIsolation,
    system_volume_bits: u32,
    mic_stereo_mode: u8,
    mic_offset_bits: u32,
    system_offset_bits: u32,
}

struct SpeedAudioProcessorSlot {
    key: SpeedAudioProcessorKey,
    last_used: u64,
    state: SpeedAudioProcessorState,
}

enum SpeedAudioProcessorState {
    Ready(SpeedAudioProcessor),
    Failed,
}

struct SpeedAudioProcessor {
    graph: filter::Graph,
    pending: VecDeque<f32>,
    input_data: Vec<f32>,
    recording_clip: u32,
    input_samples: usize,
    segment_end_samples: usize,
    discard_output_samples: usize,
    expected_source_sample: f64,
    timescale: f64,
    flushed: bool,
    voice_enhancement: VoiceEnhancementCache,
}

impl AudioRenderer {
    pub const SAMPLE_FORMAT: avformat::Sample = AudioData::SAMPLE_FORMAT;
    pub const SAMPLE_RATE: u32 = AudioData::SAMPLE_RATE;
    pub const CHANNELS: u16 = 2;

    pub fn info() -> AudioInfo {
        AudioInfo::new(Self::SAMPLE_FORMAT, Self::SAMPLE_RATE, Self::CHANNELS).unwrap()
    }

    pub fn new(data: Vec<AudioSegment>) -> Self {
        Self {
            data,
            cursor: AudioRendererCursor {
                clip_index: 0,
                samples: 0,
                timescale: 1.0,
            },
            elapsed_samples: 0,
            music: MusicTracks::new(),
            transition_outgoing: Vec::new(),
            transition_incoming: Vec::new(),
            speed_audio_processors: [None, None],
            speed_audio_use_counter: 0,
            voice_enhancement: VoiceEnhancementCache::default(),
        }
    }

    pub fn with_music(mut self, music: MusicTracks) -> Self {
        self.music = music;
        self
    }

    pub fn set_playhead(&mut self, playhead: f64, project: &ProjectConfiguration) {
        self.elapsed_samples = self.playhead_to_samples(playhead);
        self.speed_audio_processors = [None, None];
        self.voice_enhancement = VoiceEnhancementCache::default();

        self.cursor = match project.get_segment_time(playhead) {
            Some((segment_time, segment)) => AudioRendererCursor {
                clip_index: segment.recording_clip,
                timescale: segment.timescale,
                samples: self.playhead_to_samples(segment_time),
            },
            None => AudioRendererCursor {
                clip_index: 0,
                timescale: 1.0,
                samples: self.elapsed_samples,
            },
        };
    }

    fn playhead_to_samples(&self, playhead: f64) -> usize {
        (playhead * AudioData::SAMPLE_RATE as f64).round() as usize
    }

    pub fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / AudioData::SAMPLE_RATE as f64
    }

    pub fn render_frame(
        &mut self,
        requested_samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<FFAudio> {
        self.render_frame_raw(requested_samples, project)
            .map(move |(samples, data)| {
                let mut raw_frame =
                    FFAudio::new(AudioData::SAMPLE_FORMAT, samples, ChannelLayout::STEREO);
                raw_frame.set_rate(AudioData::SAMPLE_RATE);
                raw_frame.data_mut(0)[0..data.len() * f32::BYTE_SIZE]
                    .copy_from_slice(unsafe { cast_f32_slice_to_bytes(&data) });

                raw_frame
            })
    }

    pub fn render_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        if let Some(timeline) = &project.timeline {
            // Capture the output-time playhead before the recording mix advances
            // it, so timeline-positioned music is aligned to the same grid.
            let frame_start = self.elapsed_samples;
            let (written, mut buf) = self.render_timeline_frame_raw(samples, project, timeline)?;

            if !self.music.is_empty() && !timeline.audio_segments.is_empty() {
                mix_music(&self.music, timeline, frame_start, written, &mut buf);
            }

            return Some((written, buf));
        }

        self.render_linear_frame_raw(samples, project)
    }

    pub(crate) fn render_export_chunks(
        &mut self,
        sources: &mut ExportAudioSources,
        samples: usize,
        project: &ProjectConfiguration,
        mut emit: impl FnMut(usize, &[f32]) -> Result<(), ExportAudioError>,
    ) -> Result<Option<usize>, ExportAudioError> {
        if samples == 0 {
            return Ok(None);
        }
        let mut output = [0.0; EXPORT_AUDIO_BLOCK_SAMPLES * 2];
        let mut outgoing_buffer = [0.0; EXPORT_AUDIO_BLOCK_SAMPLES * 2];
        let mut incoming_buffer = [0.0; EXPORT_AUDIO_BLOCK_SAMPLES * 2];
        let mut written = 0;
        let Some(timeline) = &project.timeline else {
            while written < samples {
                let count = (samples - written).min(EXPORT_AUDIO_BLOCK_SAMPLES);
                output[..count * 2].fill(0.0);
                let rendered = sources.render(
                    project,
                    self.cursor.clip_index,
                    self.cursor.samples + written,
                    count,
                    &mut output[..count * 2],
                )?;
                if rendered == 0 {
                    break;
                }
                emit(written, &output[..rendered * 2])?;
                written += rendered;
                if rendered < count {
                    break;
                }
            }
            self.elapsed_samples += if written == 0 { samples } else { written };
            self.cursor.samples += written;
            return Ok((written != 0).then_some(written));
        };
        while written < samples {
            sources.check_cancelled()?;
            let (mapping, span) = if !timeline.transitions.is_empty()
                || !timeline.hold_windows().is_empty()
            {
                let Some((mapping, output_end_samples)) = self.next_transition_mapping(timeline)
                else {
                    break;
                };
                (
                    mapping,
                    output_end_samples
                        .saturating_sub(self.elapsed_samples)
                        .min(samples - written),
                )
            } else {
                let Some(cursor) = self.timeline_cursor(timeline) else {
                    break;
                };
                (
                    TimelineFrameMapping::Single {
                        source: TimelineSource {
                            source_time: cursor.segment_time,
                            segment_index: cursor.segment_index,
                            segment: cursor.segment,
                        },
                        output_end: 0.0,
                    },
                    (cursor.segment_end_samples - self.elapsed_samples).min(samples - written),
                )
            };
            if span == 0 {
                break;
            }
            let mut span_offset = 0;
            while span_offset < span {
                sources.check_cancelled()?;
                let count = (span - span_offset).min(EXPORT_AUDIO_BLOCK_SAMPLES);
                let output = &mut output[..count * 2];
                output.fill(0.0);
                match mapping {
                    TimelineFrameMapping::Single { source, .. } => {
                        if source.segment.speed_audio_mode != Some(ClipSpeedAudioMode::Mute) {
                            sources.render(
                                project,
                                source.segment.recording_clip,
                                self.playhead_to_samples(source.source_time) + span_offset,
                                count,
                                output,
                            )?;
                            apply_clip_volume(output, source.segment);
                        }
                    }
                    TimelineFrameMapping::Hold { .. } => {}
                    TimelineFrameMapping::Transition {
                        outgoing,
                        incoming,
                        kind,
                        progress,
                        duration,
                        ..
                    } => {
                        let outgoing_buffer = &mut outgoing_buffer[..count * 2];
                        let incoming_buffer = &mut incoming_buffer[..count * 2];
                        outgoing_buffer.fill(0.0);
                        incoming_buffer.fill(0.0);
                        if outgoing.segment.speed_audio_mode != Some(ClipSpeedAudioMode::Mute) {
                            sources.render(
                                project,
                                outgoing.segment.recording_clip,
                                self.playhead_to_samples(outgoing.source_time) + span_offset,
                                count,
                                outgoing_buffer,
                            )?;
                            apply_clip_volume(outgoing_buffer, outgoing.segment);
                        }
                        if incoming.segment.speed_audio_mode != Some(ClipSpeedAudioMode::Mute) {
                            sources.render(
                                project,
                                incoming.segment.recording_clip,
                                self.playhead_to_samples(incoming.source_time) + span_offset,
                                count,
                                incoming_buffer,
                            )?;
                            apply_clip_volume(incoming_buffer, incoming.segment);
                        }
                        mix_transition_audio_at(
                            outgoing_buffer,
                            incoming_buffer,
                            output,
                            kind,
                            progress,
                            duration,
                            span_offset,
                        );
                    }
                }
                emit(written + span_offset, output)?;
                span_offset += count;
            }
            self.cursor = match mapping {
                TimelineFrameMapping::Single { source, .. } => {
                    source_cursor(source, self.playhead_to_samples(source.source_time) + span)
                }
                TimelineFrameMapping::Hold { source, .. } => {
                    source_cursor(source, self.playhead_to_samples(source.source_time))
                }
                TimelineFrameMapping::Transition { incoming, .. } => source_cursor(
                    incoming,
                    self.playhead_to_samples(incoming.source_time) + span,
                ),
            };
            self.elapsed_samples += span;
            written += span;
        }
        Ok((written != 0).then_some(written))
    }

    fn next_transition_mapping<'a>(
        &self,
        timeline: &'a TimelineConfiguration,
    ) -> Option<(TimelineFrameMapping<'a>, usize)> {
        let mut mapping_time = self.elapsed_samples_to_playhead();
        loop {
            let mapping = timeline.get_frame_mapping(mapping_time)?;
            let output_end = match mapping {
                TimelineFrameMapping::Single { output_end, .. }
                | TimelineFrameMapping::Transition { output_end, .. }
                | TimelineFrameMapping::Hold { output_end, .. } => output_end,
            };
            let output_end_samples = self.playhead_to_samples(output_end);
            if output_end_samples > self.elapsed_samples {
                return Some((mapping, output_end_samples));
            }
            if output_end <= mapping_time {
                return None;
            }
            mapping_time = output_end;
        }
    }

    fn render_timeline_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
        timeline: &TimelineConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        // Transitions and fullscreen-text holds both need the mapping-driven
        // path; the accumulation fast path below knows nothing about either.
        if !timeline.transitions.is_empty() || !timeline.hold_windows().is_empty() {
            return self.render_timeline_transition_frame_raw(samples, project, timeline);
        }

        if samples == 0 {
            return None;
        }

        let mut ret = vec![0.0; samples * 2];
        let mut written = 0usize;

        while written < samples {
            let Some(cursor) = self.timeline_cursor(timeline) else {
                break;
            };

            let chunk_samples =
                (cursor.segment_end_samples - self.elapsed_samples).min(samples - written);
            if chunk_samples == 0 {
                break;
            }

            self.cursor = AudioRendererCursor {
                clip_index: cursor.segment.recording_clip,
                timescale: cursor.segment.timescale,
                samples: self.playhead_to_samples(cursor.segment_time),
            };

            self.render_segment_chunk(
                project,
                TimelineSource {
                    source_time: cursor.segment_time,
                    segment_index: cursor.segment_index,
                    segment: cursor.segment,
                },
                chunk_samples,
                written * 2,
                &mut ret,
            );
            if cursor.segment.timescale == 1.0 {
                self.cursor.samples += chunk_samples;
            }

            self.elapsed_samples += chunk_samples;
            written += chunk_samples;
        }

        if written == 0 {
            None
        } else {
            ret.truncate(written * 2);
            Some((written, ret))
        }
    }

    fn render_timeline_transition_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
        timeline: &TimelineConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        if samples == 0 {
            return None;
        }

        let mut output = vec![0.0; samples * 2];
        let mut written = 0usize;
        while written < samples {
            let Some((mapping, output_end_samples)) = self.next_transition_mapping(timeline) else {
                break;
            };
            let chunk_samples = output_end_samples
                .saturating_sub(self.elapsed_samples)
                .min(samples - written);

            match mapping {
                TimelineFrameMapping::Single { source, .. } => {
                    let source_samples = self.playhead_to_samples(source.source_time);
                    self.render_segment_chunk(
                        project,
                        source,
                        chunk_samples,
                        written * 2,
                        &mut output,
                    );
                    self.cursor = source_cursor(source, source_samples + chunk_samples);
                }
                TimelineFrameMapping::Hold { source, .. } => {
                    // Recording clock is paused: the chunk stays silent (the
                    // buffer is zero-filled) and the cursor parks on the
                    // frozen instant so playback resumes seamlessly. Music
                    // keeps playing — it mixes in output time on top.
                    self.cursor =
                        source_cursor(source, self.playhead_to_samples(source.source_time));
                }
                TimelineFrameMapping::Transition {
                    outgoing,
                    incoming,
                    kind,
                    progress,
                    duration,
                    ..
                } => {
                    let mut outgoing_buffer = std::mem::take(&mut self.transition_outgoing);
                    let mut incoming_buffer = std::mem::take(&mut self.transition_incoming);
                    outgoing_buffer.resize(chunk_samples * 2, 0.0);
                    incoming_buffer.resize(chunk_samples * 2, 0.0);
                    outgoing_buffer.fill(0.0);
                    incoming_buffer.fill(0.0);
                    self.render_segment_chunk(
                        project,
                        outgoing,
                        chunk_samples,
                        0,
                        &mut outgoing_buffer,
                    );
                    self.render_segment_chunk(
                        project,
                        incoming,
                        chunk_samples,
                        0,
                        &mut incoming_buffer,
                    );
                    mix_transition_audio(
                        &outgoing_buffer,
                        &incoming_buffer,
                        &mut output[written * 2..(written + chunk_samples) * 2],
                        kind,
                        progress,
                        duration,
                    );
                    self.transition_outgoing = outgoing_buffer;
                    self.transition_incoming = incoming_buffer;
                    self.cursor = source_cursor(
                        incoming,
                        self.playhead_to_samples(incoming.source_time) + chunk_samples,
                    );
                }
            }

            self.elapsed_samples += chunk_samples;
            written += chunk_samples;
        }

        if written == 0 {
            None
        } else {
            output.truncate(written * 2);
            Some((written, output))
        }
    }

    fn render_linear_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        if samples == 0 {
            return None;
        }

        if self.cursor.timescale != 1.0 {
            self.elapsed_samples += samples;
            return None;
        }

        let mut ret = vec![0.0; samples * 2];
        let rendered = self.render_current_chunk(project, samples, 0, &mut ret);

        if rendered == 0 {
            self.elapsed_samples += samples;
            return None;
        }

        self.elapsed_samples += rendered;
        self.cursor.samples += rendered;
        ret.truncate(rendered * 2);

        Some((rendered, ret))
    }

    fn timeline_cursor<'a>(
        &self,
        timeline: &'a TimelineConfiguration,
    ) -> Option<TimelineCursor<'a>> {
        let mut segment_start_samples = 0usize;
        let mut accumulated_duration = 0.0;

        for (segment_index, segment) in timeline.segments.iter().enumerate() {
            accumulated_duration += segment.duration();
            let segment_end_samples = self.playhead_to_samples(accumulated_duration);

            if self.elapsed_samples < segment_end_samples {
                let local_samples = self.elapsed_samples - segment_start_samples;
                let local_time = local_samples as f64 / Self::SAMPLE_RATE as f64;
                return Some(TimelineCursor {
                    segment_end_samples,
                    segment_time: segment.start + local_time * segment.timescale,
                    segment_index,
                    segment,
                });
            }

            segment_start_samples = segment_end_samples;
        }

        None
    }

    fn render_current_chunk(
        &mut self,
        project: &ProjectConfiguration,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> usize {
        self.render_chunk_at_cursor(project, self.cursor, samples, out_offset, out)
    }

    fn render_segment_chunk(
        &mut self,
        project: &ProjectConfiguration,
        source: TimelineSource<'_>,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> usize {
        let rendered = if source.segment.timescale == 1.0 {
            if source.segment.speed_audio_mode == Some(ClipSpeedAudioMode::Mute) {
                return 0;
            }
            let cursor = source_cursor(source, self.playhead_to_samples(source.source_time));
            self.render_chunk_at_cursor(project, cursor, samples, out_offset, out)
        } else {
            self.render_speed_audio_chunk(project, source, samples, out_offset, out)
        };
        apply_clip_volume(
            &mut out[out_offset..out_offset + rendered * 2],
            source.segment,
        );
        rendered
    }

    fn render_speed_audio_chunk(
        &mut self,
        project: &ProjectConfiguration,
        source: TimelineSource<'_>,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> usize {
        if samples == 0
            || project.audio.mute
            || source.segment.speed_audio_mode.unwrap_or_default() == ClipSpeedAudioMode::Mute
            || !source.segment.timescale.is_finite()
            || !(0.25..=8.0).contains(&source.segment.timescale)
        {
            return 0;
        }

        let Some(audio_segment) = self.data.get(source.segment.recording_clip as usize) else {
            return 0;
        };
        if audio_segment.tracks.is_empty() {
            return 0;
        }

        let offsets = project
            .clips
            .iter()
            .find(|clip| clip.index == source.segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        let key = SpeedAudioProcessorKey {
            segment_index: source.segment_index,
            recording_clip: source.segment.recording_clip,
            timescale_bits: source.segment.timescale.to_bits(),
            mode: source.segment.speed_audio_mode.unwrap_or_default(),
            segment_start_samples: self.playhead_to_samples(source.segment.start),
            segment_end_samples: self.playhead_to_samples(source.segment.end),
            mic_volume_bits: project.audio.mic_volume_db.to_bits(),
            improve_microphone: project.audio.improve,
            isolation: project.audio.isolation,
            system_volume_bits: project.audio.system_volume_db.to_bits(),
            mic_stereo_mode: project_stereo_mode_key(&project.audio.mic_stereo_mode),
            mic_offset_bits: offsets.mic.to_bits(),
            system_offset_bits: offsets.system_audio.to_bits(),
        };
        let requested_source_sample = source.source_time * Self::SAMPLE_RATE as f64;
        self.speed_audio_use_counter = self.speed_audio_use_counter.saturating_add(1);

        let existing = self
            .speed_audio_processors
            .iter()
            .position(|slot| slot.as_ref().is_some_and(|slot| slot.key == key));
        let slot_index = existing.unwrap_or_else(|| {
            self.speed_audio_processors
                .iter()
                .position(Option::is_none)
                .unwrap_or_else(|| {
                    self.speed_audio_processors
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, slot)| {
                            slot.as_ref().map_or(u64::MIN, |slot| slot.last_used)
                        })
                        .map_or(0, |(index, _)| index)
                })
        });

        if existing.is_none() {
            self.speed_audio_processors[slot_index] = Some(SpeedAudioProcessorSlot {
                key,
                last_used: self.speed_audio_use_counter,
                state: speed_audio_processor_state(key, requested_source_sample),
            });
        }

        let slot = self.speed_audio_processors[slot_index].as_mut().unwrap();
        slot.last_used = self.speed_audio_use_counter;
        if matches!(
            &slot.state,
            SpeedAudioProcessorState::Ready(processor)
                if !processor.is_contiguous(requested_source_sample)
        ) {
            slot.state = speed_audio_processor_state(key, requested_source_sample);
        }

        let result = match &mut slot.state {
            SpeedAudioProcessorState::Ready(processor) => processor.render(
                &self.data,
                project,
                requested_source_sample,
                samples,
                out_offset,
                out,
            ),
            SpeedAudioProcessorState::Failed => return 0,
        };

        match result {
            Ok(written) => written,
            Err(error) => {
                warn!(
                    ?error,
                    segment_index = source.segment_index,
                    "Speed audio processing failed"
                );
                slot.state = SpeedAudioProcessorState::Failed;
                0
            }
        }
    }

    fn render_chunk_at_cursor(
        &mut self,
        project: &ProjectConfiguration,
        cursor: AudioRendererCursor,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> usize {
        render_audio_data_chunk(
            &self.data,
            project,
            cursor,
            samples,
            out_offset,
            out,
            &mut self.voice_enhancement,
        )
    }
}

fn apply_clip_volume(samples: &mut [f32], segment: &cap_project::TimelineSegment) {
    let volume = segment.volume() as f32;
    if volume != 1.0 {
        for sample in samples {
            *sample *= volume;
        }
    }
}

fn source_cursor(source: TimelineSource<'_>, samples: usize) -> AudioRendererCursor {
    AudioRendererCursor {
        clip_index: source.segment.recording_clip,
        timescale: source.segment.timescale,
        samples,
    }
}

fn render_audio_data_chunk(
    data: &[AudioSegment],
    project: &ProjectConfiguration,
    cursor: AudioRendererCursor,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
    enhancement: &mut VoiceEnhancementCache,
) -> usize {
    let Some(segment) = data.get(cursor.clip_index as usize) else {
        return 0;
    };
    let tracks = &segment.tracks;

    if tracks.is_empty() {
        return 0;
    }

    let offsets = project
        .clips
        .iter()
        .find(|clip| clip.index == cursor.clip_index)
        .map(|clip| clip.offsets)
        .unwrap_or_default();
    let max_samples = tracks
        .iter()
        .map(|track| {
            let track_offset_samples =
                (track.offset(&offsets) * AudioRenderer::SAMPLE_RATE as f32).round() as isize;
            let available = track.data().sample_count() as isize - track_offset_samples;
            available.max(0) as usize
        })
        .max()
        .unwrap_or(0);

    if cursor.samples >= max_samples {
        return 0;
    }

    let samples = samples.min(max_samples - cursor.samples);
    let track_datas = tracks
        .iter()
        .map(|track| AudioRendererTrack {
            data: track.data().as_ref(),
            gain: if project.audio.mute {
                f32::NEG_INFINITY
            } else {
                let gain = track.gain(&project.audio);
                if gain < -30.0 {
                    f32::NEG_INFINITY
                } else {
                    gain
                }
            },
            stereo_mode: track.stereo_mode(&project.audio),
            offset: (track.offset(&offsets) * AudioRenderer::SAMPLE_RATE as f32).round() as isize,
        })
        .collect::<Vec<_>>();

    if !project.audio.improve || project.audio.mute {
        return cap_audio::render_audio(&track_datas, cursor.samples, samples, out_offset, out);
    }
    let clip_key = cursor.clip_index as usize;
    for offset in (0..samples).step_by(EXPORT_AUDIO_BLOCK_SAMPLES) {
        let count = (samples - offset).min(EXPORT_AUDIO_BLOCK_SAMPLES);
        let cursor = cursor.samples + offset;
        let enhanced = tracks
            .iter()
            .zip(&track_datas)
            .enumerate()
            .map(|(index, (track, data))| {
                if !track.is_microphone
                    || !data.gain.is_finite()
                    || data.gain <= -30.0
                    || !(1..=2).contains(&data.data.channels())
                {
                    return None;
                }
                let start = cursor as i128 + data.offset as i128;
                let end = (start + count as i128).max(0) as usize;
                let start = start.max(0) as usize;
                if start >= end || start >= data.data.sample_count() {
                    return None;
                }
                Some(enhancement.render(
                    (clip_key, index),
                    data.data,
                    start,
                    end.saturating_sub(start),
                    project.audio.isolation,
                ))
            })
            .collect::<Vec<_>>();
        let sources = track_datas
            .iter()
            .zip(&enhanced)
            .map(|(track, enhanced)| {
                enhanced
                    .as_ref()
                    .map_or(VoiceSource::Original(track.data), VoiceSource::Enhanced)
            })
            .collect::<Vec<_>>();
        let mixed = track_datas
            .iter()
            .zip(&sources)
            .map(|(track, source)| AudioRendererTrack {
                data: source,
                gain: track.gain,
                stereo_mode: match track.stereo_mode {
                    StereoMode::Stereo => StereoMode::Stereo,
                    StereoMode::MonoL => StereoMode::MonoL,
                    StereoMode::MonoR => StereoMode::MonoR,
                },
                offset: track.offset,
            })
            .collect::<Vec<_>>();
        cap_audio::render_audio(&mixed, cursor, count, out_offset + offset * 2, out);
    }
    samples
}

#[derive(Default)]
struct VoiceEnhancementCache {
    slots: Vec<((usize, usize, VoiceIsolation), VoiceEnhancer)>,
}

impl VoiceEnhancementCache {
    fn render(
        &mut self,
        key: (usize, usize),
        source: &DecodedAudio,
        start: usize,
        count: usize,
        isolation: VoiceIsolation,
    ) -> VoiceAudio {
        let key = (key.0, key.1, isolation);
        let index = self
            .slots
            .iter()
            .position(|(candidate, state)| *candidate == key && state.is_contiguous(start));
        let slot = if let Some(index) = index {
            self.slots.remove(index)
        } else {
            (
                key,
                VoiceEnhancer::with_settings(
                    source.channels(),
                    isolation.strength(),
                    source.voice_profile(),
                ),
            )
        };
        if self.slots.len() == 4 {
            self.slots.remove(0);
        }
        self.slots.push(slot);
        self.slots
            .last_mut()
            .unwrap()
            .1
            .render(source, start, count)
    }
}

const SPEED_AUDIO_INPUT_BLOCK_SAMPLES: usize = 4_096;
const SPEED_AUDIO_PREROLL_SAMPLES: usize = 2_400;

fn project_stereo_mode_key(mode: &cap_project::StereoMode) -> u8 {
    match mode {
        cap_project::StereoMode::Stereo => 0,
        cap_project::StereoMode::MonoL => 1,
        cap_project::StereoMode::MonoR => 2,
    }
}

fn speed_audio_processor_state(
    key: SpeedAudioProcessorKey,
    requested_source_sample: f64,
) -> SpeedAudioProcessorState {
    match SpeedAudioProcessor::new(key, requested_source_sample) {
        Ok(processor) => SpeedAudioProcessorState::Ready(processor),
        Err(error) => {
            warn!(
                ?error,
                segment_index = key.segment_index,
                "Unable to initialize speed audio processor"
            );
            SpeedAudioProcessorState::Failed
        }
    }
}

impl SpeedAudioProcessor {
    fn new(
        key: SpeedAudioProcessorKey,
        requested_source_sample: f64,
    ) -> Result<Self, ffmpeg::Error> {
        let timescale = f64::from_bits(key.timescale_bits);
        let mut graph = filter::Graph::new();
        let input_args = format!(
            "time_base=1/{rate}:sample_rate={rate}:sample_fmt={format}:channel_layout=0x{layout:x}",
            rate = AudioRenderer::SAMPLE_RATE,
            format = AudioRenderer::SAMPLE_FORMAT.name(),
            layout = ChannelLayout::STEREO.bits(),
        );
        graph.add(
            &filter::find("abuffer").ok_or(ffmpeg::Error::FilterNotFound)?,
            "in",
            &input_args,
        )?;
        graph.add(
            &filter::find("abuffersink").ok_or(ffmpeg::Error::FilterNotFound)?,
            "out",
            "",
        )?;
        graph
            .output("in", 0)?
            .input("out", 0)?
            .parse(&speed_audio_filter(key.mode, timescale)?)?;
        graph.validate()?;

        let requested_source_sample = requested_source_sample.clamp(
            key.segment_start_samples as f64,
            key.segment_end_samples as f64,
        );
        let preroll_source_samples = (SPEED_AUDIO_PREROLL_SAMPLES as f64 * timescale).ceil();
        let input_samples = (requested_source_sample - preroll_source_samples)
            .floor()
            .max(key.segment_start_samples as f64) as usize;
        let discard_output_samples =
            ((requested_source_sample - input_samples as f64) / timescale).round() as usize;

        Ok(Self {
            graph,
            pending: VecDeque::with_capacity(SPEED_AUDIO_INPUT_BLOCK_SAMPLES * 2),
            input_data: Vec::with_capacity(SPEED_AUDIO_INPUT_BLOCK_SAMPLES * 2),
            recording_clip: key.recording_clip,
            input_samples,
            segment_end_samples: key.segment_end_samples,
            discard_output_samples,
            expected_source_sample: requested_source_sample,
            timescale,
            flushed: false,
            voice_enhancement: VoiceEnhancementCache::default(),
        })
    }

    fn is_contiguous(&self, requested_source_sample: f64) -> bool {
        (requested_source_sample - self.expected_source_sample).abs() <= 2.0
    }

    fn render(
        &mut self,
        data: &[AudioSegment],
        project: &ProjectConfiguration,
        requested_source_sample: f64,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> Result<usize, ffmpeg::Error> {
        let target_samples = samples.saturating_add(self.discard_output_samples);
        while self.pending.len() / 2 < target_samples {
            if self.input_samples < self.segment_end_samples {
                self.feed_input(data, project)?;
            } else if !self.flushed {
                let mut source = self.graph.get("in").ok_or(ffmpeg::Error::InvalidData)?;
                source.source().flush()?;
                self.flushed = true;
            } else {
                break;
            }
            self.drain_output()?;
        }

        let discard = self.discard_output_samples.min(self.pending.len() / 2);
        for _ in 0..discard * 2 {
            self.pending.pop_front();
        }
        self.discard_output_samples -= discard;

        let available_output = out.len().saturating_sub(out_offset) / 2;
        let written = samples.min(available_output).min(self.pending.len() / 2);
        for target in &mut out[out_offset..out_offset + written * 2] {
            *target = self.pending.pop_front().unwrap();
        }
        self.expected_source_sample = requested_source_sample + samples as f64 * self.timescale;

        Ok(written)
    }

    fn feed_input(
        &mut self,
        data: &[AudioSegment],
        project: &ProjectConfiguration,
    ) -> Result<(), ffmpeg::Error> {
        let samples = SPEED_AUDIO_INPUT_BLOCK_SAMPLES
            .min(self.segment_end_samples.saturating_sub(self.input_samples));
        self.input_data.resize(samples * 2, 0.0);
        self.input_data.fill(0.0);
        render_audio_data_chunk(
            data,
            project,
            AudioRendererCursor {
                clip_index: self.recording_clip,
                timescale: self.timescale,
                samples: self.input_samples,
            },
            samples,
            0,
            &mut self.input_data,
            &mut self.voice_enhancement,
        );

        let mut frame = FFAudio::new(AudioRenderer::SAMPLE_FORMAT, samples, ChannelLayout::STEREO);
        frame.set_rate(AudioRenderer::SAMPLE_RATE);
        frame.set_pts(Some(self.input_samples as i64));
        let byte_len = self.input_data.len() * f32::BYTE_SIZE;
        frame.data_mut(0)[..byte_len]
            .copy_from_slice(unsafe { cast_f32_slice_to_bytes(&self.input_data) });
        let mut source = self.graph.get("in").ok_or(ffmpeg::Error::InvalidData)?;
        source.source().add(&frame)?;
        self.input_samples += samples;

        Ok(())
    }

    fn drain_output(&mut self) -> Result<(), ffmpeg::Error> {
        let mut sink = self.graph.get("out").ok_or(ffmpeg::Error::InvalidData)?;
        let mut frame = FFAudio::empty();
        while sink.sink().frame(&mut frame).is_ok() {
            if frame.channels() != AudioRenderer::CHANNELS {
                return Err(ffmpeg::Error::InvalidData);
            }
            let value_count = frame.samples() * usize::from(frame.channels());
            let byte_len = value_count * f32::BYTE_SIZE;
            let values = unsafe { cast_bytes_to_f32_slice(&frame.data(0)[..byte_len]) };
            self.pending.extend(values.iter().copied());
            unsafe { ffmpeg::ffi::av_frame_unref(frame.as_mut_ptr()) };
        }

        Ok(())
    }
}

fn speed_audio_filter(mode: ClipSpeedAudioMode, timescale: f64) -> Result<String, ffmpeg::Error> {
    let retiming = match mode {
        ClipSpeedAudioMode::Mute => return Err(ffmpeg::Error::InvalidData),
        ClipSpeedAudioMode::MaintainPitch => {
            let mut remaining = timescale;
            let mut filters = Vec::new();
            while remaining < 0.5 {
                filters.push("atempo=0.5".to_string());
                remaining /= 0.5;
            }
            while remaining > 2.0 {
                filters.push("atempo=2.0".to_string());
                remaining /= 2.0;
            }
            if (remaining - 1.0).abs() > 1e-9 || filters.is_empty() {
                filters.push(format!("atempo={remaining:.10}"));
            }
            filters.join(",")
        }
        ClipSpeedAudioMode::MatchSpeed => {
            let rate = (AudioRenderer::SAMPLE_RATE as f64 * timescale).round() as u32;
            format!("asetrate={rate},aresample={}", AudioRenderer::SAMPLE_RATE)
        }
    };

    Ok(format!(
        "{retiming},aformat=sample_fmts={}:sample_rates={}:channel_layouts=0x{:x}",
        AudioRenderer::SAMPLE_FORMAT.name(),
        AudioRenderer::SAMPLE_RATE,
        ChannelLayout::STEREO.bits(),
    ))
}

fn mix_transition_audio(
    outgoing: &[f32],
    incoming: &[f32],
    output: &mut [f32],
    kind: ClipTransitionType,
    progress: f64,
    duration: f64,
) {
    mix_transition_audio_at(outgoing, incoming, output, kind, progress, duration, 0);
}

fn mix_transition_audio_at(
    outgoing: &[f32],
    incoming: &[f32],
    output: &mut [f32],
    kind: ClipTransitionType,
    progress: f64,
    duration: f64,
    sample_offset: usize,
) {
    let progress_per_sample = 1.0 / (duration * AudioData::SAMPLE_RATE as f64);
    for (sample_index, ((outgoing_frame, incoming_frame), output_frame)) in outgoing
        .chunks_exact(2)
        .zip(incoming.chunks_exact(2))
        .zip(output.chunks_exact_mut(2))
        .enumerate()
    {
        let progress = (progress + (sample_offset + sample_index) as f64 * progress_per_sample)
            .clamp(0.0, 1.0);
        let (outgoing_gain, incoming_gain) = match kind {
            ClipTransitionType::CrossFade => {
                let angle = progress * std::f64::consts::FRAC_PI_2;
                (angle.cos() as f32, angle.sin() as f32)
            }
            ClipTransitionType::FadeThroughBlack => (
                (1.0 - progress * 2.0).max(0.0) as f32,
                (progress * 2.0 - 1.0).max(0.0) as f32,
            ),
        };
        output_frame[0] = (outgoing_frame[0] * outgoing_gain + incoming_frame[0] * incoming_gain)
            .clamp(-1.0, 1.0);
        output_frame[1] = (outgoing_frame[1] * outgoing_gain + incoming_frame[1] * incoming_gain)
            .clamp(-1.0, 1.0);
    }
}

/// Below this volume a music track is treated as silent and skipped entirely.
pub(crate) const MUSIC_SILENCE_DB: f32 = -60.0;

fn music_gain(volume_db: f32) -> f32 {
    if volume_db <= MUSIC_SILENCE_DB {
        0.0
    } else {
        10.0_f32.powf(volume_db / 20.0)
    }
}

/// Mixes timeline-positioned music tracks into an already-rendered, interleaved
/// stereo buffer covering output samples `[frame_start, frame_start + samples)`.
///
/// Each segment is placed in output time (`start`/`end`), reads its source from
/// `trim_start`, and applies linear fade-in/out ramps. Sources may be mono or
/// stereo; mono is centre-panned at -3dB to match `cap_audio::render_audio`.
fn mix_music(
    music: &MusicTracks,
    timeline: &TimelineConfiguration,
    frame_start: usize,
    samples: usize,
    out: &mut [f32],
) {
    if samples == 0 {
        return;
    }

    let sample_rate = AudioData::SAMPLE_RATE as f64;
    let frame_start = frame_start as i64;
    let frame_end = frame_start + samples as i64;
    let mut mixed = vec![false; samples];

    for segment in &timeline.audio_segments {
        if !segment.enabled || segment.end <= segment.start {
            continue;
        }

        let gain = music_gain(segment.volume_db);
        if gain <= 0.0 {
            continue;
        }

        let Some(data) = music.get(&segment.path) else {
            continue;
        };

        let start_sample = (segment.start * sample_rate).round() as i64;
        let end_sample = (segment.end * sample_rate).round() as i64;
        let segment_len = end_sample - start_sample;
        if segment_len <= 0 {
            continue;
        }

        // Window of this segment that intersects the current frame.
        let lo = start_sample.max(frame_start);
        let hi = end_sample.min(frame_end);
        if lo >= hi {
            continue;
        }

        let trim_sample = (segment.trim_start.max(0.0) * sample_rate).round() as i64;
        let fade_in = (segment.fade_in.max(0.0) * sample_rate).round() as i64;
        let fade_out = (segment.fade_out.max(0.0) * sample_rate).round() as i64;

        let channels = data.channels() as usize;
        let src = data.samples();
        let src_frames = data.sample_count() as i64;

        for out_sample in lo..hi {
            let local = out_sample - start_sample;
            let src_index = trim_sample + local - data.source_start_sample() as i64;
            if src_index < 0 || src_index >= src_frames {
                continue;
            }

            let mut g = gain;
            if fade_in > 0 && local < fade_in {
                g *= local as f32 / fade_in as f32;
            }
            let until_end = segment_len - local;
            if fade_out > 0 && until_end <= fade_out {
                g *= (until_end as f32 / fade_out as f32).clamp(0.0, 1.0);
            }
            if g <= 0.0 {
                continue;
            }

            let (l, r) = if channels == 1 {
                let Some(sample) = src.get(src_index as usize) else {
                    continue;
                };
                let s = sample * 0.707;
                (s, s)
            } else {
                let base = (src_index as usize) * channels;
                let (Some(l), Some(r)) = (src.get(base), src.get(base + 1)) else {
                    continue;
                };
                (*l, *r)
            };

            let frame = (out_sample - frame_start) as usize;
            out[frame * 2] += l * g;
            out[frame * 2 + 1] += r * g;
            mixed[frame] = true;
        }
    }

    // Only frames that received music are clipped: recording audio can sit
    // above 1.0 (clip volume goes to 2x) and must not change because music
    // plays elsewhere on the timeline.
    for (frame, _) in out[..samples * 2]
        .chunks_exact_mut(2)
        .zip(&mixed)
        .filter(|(_, mixed)| **mixed)
    {
        for sample in frame {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }
}

pub struct AudioResampler {
    pub context: resampling::Context,
    pub output_frame: FFAudio,
    delay: Option<resampling::Delay>,
    output: AudioInfo,
}

impl AudioResampler {
    pub fn new(output_info: AudioInfo) -> Result<Self, MediaError> {
        // Clamp output info for FFmpeg compatibility (max 8 channels)
        let output_info = output_info.for_ffmpeg_output();

        let context = resampling::Context::get_with(
            AudioData::SAMPLE_FORMAT,
            ChannelLayout::STEREO,
            AudioData::SAMPLE_RATE,
            output_info.sample_format,
            output_info.channel_layout(),
            output_info.sample_rate,
            high_quality_resampler_options(),
        )?;

        info!(
            input_rate = AudioData::SAMPLE_RATE,
            output_rate = output_info.sample_rate,
            output_format = ?output_info.sample_format,
            "Audio resampler created with high-quality settings (filter_size=128)"
        );

        Ok(Self {
            output: output_info,
            context,
            output_frame: FFAudio::empty(),
            delay: None,
        })
    }

    fn current_frame_data(&self) -> &[u8] {
        let end = self.output_frame.samples() * self.output.channels * self.output.sample_size();
        &self.output_frame.data(0)[0..end]
    }

    pub fn queue_and_process_frame<'a>(&'a mut self, frame: &FFAudio) -> &'a [u8] {
        self.delay = self.context.run(frame, &mut self.output_frame).unwrap();

        // Teeechnically this doesn't work for planar output
        self.current_frame_data()
    }

    pub fn flush_frame(&mut self) -> Option<&[u8]> {
        self.delay?;

        self.delay = self.context.flush(&mut self.output_frame).unwrap();

        Some(self.current_frame_data())
    }

    fn reset(&mut self) {
        *self = Self::new(self.output).unwrap();
    }
}

fn silent_audio_frame(samples: usize) -> FFAudio {
    let mut frame = FFAudio::new(AudioData::SAMPLE_FORMAT, samples, ChannelLayout::STEREO);
    frame.set_rate(AudioData::SAMPLE_RATE);
    let data_len = samples * usize::from(AudioRenderer::CHANNELS) * f32::BYTE_SIZE;
    frame.data_mut(0)[..data_len].fill(0);
    frame
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Shared state between the background render thread and the audio callback.
///
/// The timeline mix is rendered progressively into `samples` (f32 bit
/// patterns; zero-initialised == silence). The producer publishes how far it
/// has rendered through the two watermarks, so the callback never reads a
/// partially-written chunk: pass 1 covers `[primary_start, len)` starting at
/// the playhead (minus a short pre-roll), then pass 2 wraps around to cover
/// `[0, primary_start)` for backwards seeks.
struct ProgressiveTimeline {
    samples: Box<[AtomicU32]>,
    /// First sample index of the initial render pass. Fixed at construction.
    primary_start: usize,
    /// Rendered watermark of `[primary_start, len)`. Stored with `Release`
    /// after the samples it covers are written; loaded with `Acquire`.
    primary_end: AtomicUsize,
    /// Rendered watermark of the wrap-around pass over `[0, primary_start)`.
    wrap_end: AtomicUsize,
    /// Tells the producer to bail out early (playback stopped).
    stop: AtomicBool,
    complete: AtomicBool,
    /// Pass 1 has written everything it ever will.
    pass1_done: AtomicBool,
    /// A playback cache keeps this render once its readers are gone.
    retained: AtomicBool,
    retain_slot: Mutex<RetainSlot>,
    readers: AtomicUsize,
    wake: Mutex<u64>,
    woken: Condvar,
    created: std::time::Instant,
    paused_at_nanos: AtomicU64,
    retired: Mutex<Retired>,
}

/// A replaced cached render, released only once this render stops working
/// (finished, stopped or parked), so freeing its buffer never competes with
/// the start of playback.
#[derive(Default)]
struct Retired {
    idle: bool,
    render: Option<CachedProgressiveRender>,
}

#[derive(Default)]
struct RetainSlot {
    release: Option<CacheRelease>,
    exited: bool,
}

impl ProgressiveTimeline {
    fn new(len: usize, primary_start: usize) -> Self {
        Self {
            samples: Self::allocate_samples(len),
            primary_start,
            primary_end: AtomicUsize::new(primary_start),
            wrap_end: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            complete: AtomicBool::new(false),
            pass1_done: AtomicBool::new(false),
            retained: AtomicBool::new(false),
            retain_slot: Mutex::default(),
            readers: AtomicUsize::new(1),
            wake: Mutex::new(0),
            woken: Condvar::new(),
            created: std::time::Instant::now(),
            paused_at_nanos: AtomicU64::new(0),
            retired: Mutex::default(),
        }
    }

    /// `AtomicU32` has the same size, alignment and bit validity as `u32`
    /// (documented guarantee), so a zeroed `u32` allocation — which the
    /// allocator can hand out as untouched zero pages, unlike constructing
    /// millions of atomics one by one — can be reinterpreted directly.
    fn allocate_samples(len: usize) -> Box<[AtomicU32]> {
        let raw = vec![0u32; len].into_boxed_slice();
        unsafe { Box::from_raw(Box::into_raw(raw) as *mut [AtomicU32]) }
    }

    /// Whether every sample in `[from, to)` is already rendered (or will
    /// never be written, so it reads as silence either way).
    fn covers(&self, from: usize, to: usize) -> bool {
        let to = to.min(self.samples.len());
        if from >= to || self.complete.load(Ordering::Acquire) {
            return true;
        }
        let primary = to <= self.primary_start
            || self.pass1_done.load(Ordering::Acquire)
            || self.primary_end.load(Ordering::Acquire) >= to;
        let wrap = from >= self.primary_start
            || self.wrap_end.load(Ordering::Acquire) >= to.min(self.primary_start);
        primary && wrap
    }

    /// Hands the render to a playback cache. Fails once the render thread
    /// has exited, since nothing would release it then.
    fn retain(&self, release: CacheRelease) -> bool {
        let mut slot = lock(&self.retain_slot);
        if slot.exited {
            return false;
        }
        slot.release = Some(release);
        self.retained.store(true, Ordering::Release);
        true
    }

    fn retire(&self, previous: Option<CachedProgressiveRender>) {
        let mut retired = lock(&self.retired);
        if retired.idle {
            drop(retired);
            drop(previous);
        } else {
            retired.render = previous;
        }
    }

    /// Releases the retired render. `idle` marks a render that will not
    /// resume, so later retirements are released at once.
    fn release_retired(&self, idle: bool) {
        let previous = {
            let mut retired = lock(&self.retired);
            retired.idle |= idle;
            retired.render.take()
        };
        drop(previous);
    }

    fn attach_reader(&self) {
        self.readers.fetch_add(1, Ordering::AcqRel);
        self.notify();
    }

    fn notify(&self) {
        *lock(&self.wake) += 1;
        self.woken.notify_all();
    }

    fn wake_generation(&self) -> u64 {
        *lock(&self.wake)
    }

    /// Parks the render thread until a `notify` after `seen` was read, or
    /// the timeout. Callers read `seen` before checking the conditions they
    /// wait on, so a notify racing those checks is never missed.
    fn wait(&self, seen: u64, timeout: std::time::Duration) {
        let deadline = std::time::Instant::now() + timeout;
        let mut wake = lock(&self.wake);
        while *wake == seen {
            let now = std::time::Instant::now();
            if now >= deadline {
                return;
            }
            wake = self
                .woken
                .wait_timeout(wake, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn detach_reader(&self) {
        if self.readers.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.paused_at_nanos
                .store(self.created.elapsed().as_nanos() as u64, Ordering::Release);
        }
    }

    fn paused_for(&self) -> std::time::Duration {
        self.created
            .elapsed()
            .saturating_sub(std::time::Duration::from_nanos(
                self.paused_at_nanos.load(Ordering::Acquire),
            ))
    }

    fn shut_down(&self) {
        self.stop.store(true, Ordering::Release);
        self.notify();
    }
}

const MAX_PROGRESSIVE_BUFFER_BYTES: usize = 512 * 1024 * 1024;

fn output_sample_index(secs: f64, sample_rate: u32, channels: usize, limit: usize) -> usize {
    if !(secs.is_finite() && secs > 0.0) {
        return 0;
    }

    ((secs * f64::from(sample_rate)) as usize)
        .saturating_mul(channels)
        .min(limit)
}

fn progressive_buffer_samples(duration_secs: f64, sample_rate: u32, channels: usize) -> usize {
    output_sample_index(
        duration_secs,
        sample_rate,
        channels,
        usize::MAX.saturating_sub(10_000),
    )
    .saturating_add(10_000)
}

fn progressive_buffer_bytes(samples: usize) -> usize {
    samples.saturating_mul(std::mem::size_of::<u32>())
}

pub(crate) struct PreparingAudioOutputPolicy {
    pub render_info: AudioInfo,
    pub render_start_seconds: f64,
    pub skip_output_frames: usize,
    pub convert_from_f32: bool,
}

pub(crate) fn preparing_audio_output_policy(
    duration_secs: f64,
    output_info: AudioInfo,
    start_playhead_secs: f64,
) -> Result<PreparingAudioOutputPolicy, String> {
    if !duration_secs.is_finite()
        || duration_secs <= 0.0
        || !start_playhead_secs.is_finite()
        || start_playhead_secs < 0.0
        || output_info.sample_rate == 0
        || output_info.channels == 0
    {
        return Err("Preparing audio output timing is invalid".into());
    }
    let output_info = output_info.for_ffmpeg_output();
    let estimated_output_samples =
        progressive_buffer_samples(duration_secs, output_info.sample_rate, output_info.channels);
    let convert_from_f32 =
        progressive_buffer_bytes(estimated_output_samples) <= MAX_PROGRESSIVE_BUFFER_BYTES;
    let render_start_seconds = if convert_from_f32 {
        (start_playhead_secs - ProgressiveAudioBuffer::<f32>::START_PREROLL_SECS)
            .max(0.0)
            .min(duration_secs)
    } else {
        start_playhead_secs
    };
    let skip_output_frames = if convert_from_f32 {
        let index = |seconds| {
            output_sample_index(
                seconds,
                output_info.sample_rate,
                output_info.channels,
                estimated_output_samples,
            ) / output_info.channels
        };
        index(start_playhead_secs).saturating_sub(index(render_start_seconds))
    } else {
        0
    };
    Ok(PreparingAudioOutputPolicy {
        render_info: if convert_from_f32 {
            AudioInfo::new_raw(
                AudioData::SAMPLE_FORMAT,
                output_info.sample_rate,
                output_info.channels as u16,
            )
        } else {
            output_info
        },
        render_start_seconds,
        skip_output_frames,
        convert_from_f32,
    })
}

const PLAYBACK_AUDIO_IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(120);

type CacheEntry = Arc<Mutex<Option<CachedProgressiveRender>>>;

static PLAYBACK_AUDIO_CACHES: Mutex<Vec<Weak<Mutex<Option<CachedProgressiveRender>>>>> =
    Mutex::new(Vec::new());

/// Drops every cached playback render in the process, so memory returns to
/// what it is on main while paused. Called before exports and on memory
/// pressure.
pub fn release_playback_audio_caches() {
    let caches = lock(&PLAYBACK_AUDIO_CACHES)
        .iter()
        .filter_map(Weak::upgrade)
        .collect::<Vec<_>>();
    for cache in caches {
        *lock(&cache) = None;
    }
}

#[derive(Clone)]
pub struct PlaybackAudioCache {
    entry: CacheEntry,
    idle_release: std::time::Duration,
}

impl Default for PlaybackAudioCache {
    fn default() -> Self {
        Self::with_idle_release(PLAYBACK_AUDIO_IDLE_RELEASE)
    }
}

impl PlaybackAudioCache {
    fn with_idle_release(idle_release: std::time::Duration) -> Self {
        #[cfg(target_os = "macos")]
        memory_pressure::watch();
        let entry = CacheEntry::default();
        let mut caches = lock(&PLAYBACK_AUDIO_CACHES);
        caches.retain(|cache| cache.strong_count() > 0);
        caches.push(Arc::downgrade(&entry));
        Self {
            entry,
            idle_release,
        }
    }

    pub fn clear(&self) {
        *lock(&self.entry) = None;
    }
}

#[cfg(target_os = "macos")]
mod memory_pressure {
    use std::ffi::c_void;

    #[repr(C)]
    struct DispatchSourceType {
        _private: [u8; 0],
    }

    const DISPATCH_MEMORYPRESSURE_WARN: usize = 0x02;
    const DISPATCH_MEMORYPRESSURE_CRITICAL: usize = 0x04;
    const QOS_CLASS_UTILITY: isize = 0x11;

    unsafe extern "C" {
        static _dispatch_source_type_memorypressure: DispatchSourceType;
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
        fn dispatch_source_create(
            kind: *const DispatchSourceType,
            handle: usize,
            mask: usize,
            queue: *mut c_void,
        ) -> *mut c_void;
        fn dispatch_source_set_event_handler_f(
            source: *mut c_void,
            handler: extern "C" fn(*mut c_void),
        );
        fn dispatch_resume(object: *mut c_void);
    }

    pub(super) extern "C" fn on_memory_pressure(_context: *mut c_void) {
        super::release_playback_audio_caches();
    }

    /// Installs one process-wide memory pressure source. It lives for the
    /// rest of the process, so it is never released.
    ///
    /// Not installed in unit tests: a real pressure event on the host would
    /// release the caches of every test running in the process at once.
    /// Tests drive `on_memory_pressure` directly instead.
    pub(super) fn watch() {
        if cfg!(test) {
            return;
        }
        static WATCH: std::sync::Once = std::sync::Once::new();
        WATCH.call_once(|| unsafe {
            let source = dispatch_source_create(
                &_dispatch_source_type_memorypressure,
                0,
                DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL,
                dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
            );
            if source.is_null() {
                return;
            }
            dispatch_source_set_event_handler_f(source, on_memory_pressure);
            dispatch_resume(source);
        });
    }
}

struct CachePlan {
    key: ProgressiveRenderKey,
    shift_from: usize,
    shift: usize,
    ready_at: usize,
    rate: u32,
    channels: usize,
}

struct CachedProgressiveRender {
    key: ProgressiveRenderKey,
    render: Arc<ProgressiveRender>,
}

struct ProgressiveRenderKey {
    segments: Vec<AudioSegment>,
    music: Vec<(String, Arc<AudioData>)>,
    project: Vec<u8>,
    duration_bits: u64,
    sample_rate: u32,
    channels: usize,
}

impl ProgressiveRenderKey {
    fn new(
        segments: Vec<AudioSegment>,
        music: &MusicTracks,
        project: &ProjectConfiguration,
        duration_secs: f64,
        output_info: AudioInfo,
    ) -> Option<Self> {
        let mut music = music
            .iter()
            .map(|(path, data)| (path.clone(), data.clone()))
            .collect::<Vec<_>>();
        music.sort_by(|a, b| a.0.cmp(&b.0));
        Some(Self {
            segments,
            music,
            project: audio_project_key(project)?,
            duration_bits: duration_secs.to_bits(),
            sample_rate: output_info.sample_rate,
            channels: output_info.channels,
        })
    }
}

impl PartialEq for ProgressiveRenderKey {
    fn eq(&self, other: &Self) -> bool {
        self.project == other.project
            && self.duration_bits == other.duration_bits
            && self.sample_rate == other.sample_rate
            && self.channels == other.channels
            && self.music.len() == other.music.len()
            && self
                .music
                .iter()
                .zip(&other.music)
                .all(|(a, b)| a.0 == b.0 && Arc::ptr_eq(&a.1, &b.1))
            && self.segments.len() == other.segments.len()
            && self.segments.iter().zip(&other.segments).all(|(a, b)| {
                a.tracks.len() == b.tracks.len()
                    && a.tracks
                        .iter()
                        .zip(&b.tracks)
                        .all(|(a, b)| a.same_source(b))
            })
    }
}

/// Serializes everything the audio renderer reads from a project. Both
/// structs are destructured without `..`, so a new field fails to compile
/// here until someone decides whether it changes playback audio. Fields
/// below `segments`, `clips` and `audio` are kept whole, so new nested
/// fields change the key on their own.
fn audio_project_key(project: &ProjectConfiguration) -> Option<Vec<u8>> {
    let ProjectConfiguration {
        aspect_ratio: _,
        background: _,
        camera: _,
        audio,
        cursor: _,
        hotkeys: _,
        timeline,
        overlay_order: _,
        captions: _,
        keyboard: _,
        clips,
        annotations: _,
        hidden_text_segments: _,
        screen_motion_blur: _,
        screen_movement_spring: _,
        color_correction: _,
        text_size_version: _,
        text_anim_version: _,
    } = project;
    let timeline = timeline.as_ref().map(|timeline| {
        let TimelineConfiguration {
            segments,
            transitions,
            zoom_segments: _,
            scene_segments: _,
            mask_segments: _,
            text_segments: _,
            caption_segments: _,
            keyboard_segments: _,
            audio_segments,
            style_segments: _,
            image_segments: _,
            camera3d_segments: _,
        } = timeline;
        let segments = segments
            .iter()
            .map(|segment| cap_project::TimelineSegment {
                name: None,
                hide_cursor: None,
                ..segment.clone()
            })
            .collect::<Vec<_>>();
        (
            segments,
            transitions,
            audio_segments,
            timeline.hold_windows(),
        )
    });
    serde_json::to_vec(&(audio, clips, timeline)).ok()
}

/// Owner handle of a progressive render. Dropping the last one (readers and
/// the cache) stops its render thread.
struct ProgressiveRender {
    timeline: Arc<ProgressiveTimeline>,
}

impl Drop for ProgressiveRender {
    fn drop(&mut self) {
        self.timeline.shut_down();
    }
}

/// Whether every sample of a progressive render is a pure function of its
/// timeline position, so a render started anywhere holds the same samples a
/// render started at another playhead would. Studio Sound, retimed audio,
/// transitions, text holds and resampling all carry state from wherever the
/// render began, so any of them rules reuse out.
fn render_is_origin_independent(
    project: &ProjectConfiguration,
    output_info: AudioInfo,
    duration_secs: f64,
) -> bool {
    if output_info.sample_rate != AudioData::SAMPLE_RATE
        || output_info.channels != usize::from(AudioRenderer::CHANNELS)
        || (project.audio.improve && !project.audio.mute)
    {
        return false;
    }
    let Some(timeline) = &project.timeline else {
        return false;
    };
    if !timeline.transitions.is_empty() || !timeline.hold_windows().is_empty() {
        return false;
    }
    let rate = AudioData::SAMPLE_RATE as f64;
    let mut content_end = 0.0;
    let segments_stateless = timeline.segments.iter().all(|segment| {
        content_end += segment.duration();
        if segment.speed_audio_mode == Some(ClipSpeedAudioMode::Mute) {
            return true;
        }
        let start = segment.start * rate;
        segment.timescale == 1.0 && (start - start.floor() - 0.5).abs() > 1e-4
    });
    segments_stateless
        && duration_secs.to_bits() == timeline.duration().to_bits()
        && (content_end * rate).round() as usize <= (duration_secs * rate) as usize
}

/// Frames between the slot pass 1 starts writing at and the source sample it
/// starts rendering from. The two round differently, so a render begun at
/// `pass1_start_secs` holds the origin independent samples shifted by this
/// many frames from its first slot on.
fn origin_shift(pass1_start_secs: f64) -> Option<usize> {
    let slot = output_sample_index(pass1_start_secs, AudioData::SAMPLE_RATE, 1, usize::MAX);
    let source = (pass1_start_secs * AudioData::SAMPLE_RATE as f64).round() as usize;
    source.checked_sub(slot).filter(|shift| *shift <= 1)
}

struct CacheRelease {
    cache: Weak<Mutex<Option<CachedProgressiveRender>>>,
    idle_release: std::time::Duration,
}

impl CacheRelease {
    fn release(self, timeline: &Arc<ProgressiveTimeline>) {
        timeline.retained.store(false, Ordering::Release);
        let Some(cache) = self.cache.upgrade() else {
            return;
        };
        let mut entry = lock(&cache);
        if entry
            .as_ref()
            .is_some_and(|cached| Arc::ptr_eq(&cached.render.timeline, timeline))
        {
            *entry = None;
        }
    }
}

enum PrerenderedAudioBufferMode<T: FromSampleBytes> {
    Progressive(ProgressiveAudioBuffer<T>),
    Streaming(Box<StreamingAudioBuffer<T>>),
}

/// Plays the timeline mix while it renders on a background thread.
///
/// Rendering the entire timeline up front is O(duration) — it made pressing
/// play take seconds on long recordings (and on unoptimised dev builds), on
/// every press. Instead the stream becomes ready as soon as a small window
/// around the playhead is rendered; the producer runs hundreds of times
/// faster than realtime, so playback never catches up to it in practice. A
/// read of a not-yet-rendered region produces silence rather than blocking.
pub struct PrerenderedAudioBuffer<T: FromSampleBytes> {
    mode: PrerenderedAudioBufferMode<T>,
}

struct ProgressiveAudioBuffer<T: FromSampleBytes> {
    render: Arc<ProgressiveRender>,
    ready_rx: Option<std::sync::mpsc::Receiver<()>>,
    /// A reader replaying a cached render reads slot `index + shift` from
    /// `shift_from` on, which is where its own fresh render would have put
    /// each sample.
    shift_from: usize,
    shift: usize,
    read_position: usize,
    sample_rate: u32,
    channels: usize,
    _format: std::marker::PhantomData<T>,
}

impl<T: FromSampleBytes> Drop for ProgressiveAudioBuffer<T> {
    fn drop(&mut self) {
        self.render.timeline.detach_reader();
    }
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> PrerenderedAudioBuffer<T> {
    #[cfg(test)]
    fn new(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
    ) -> Self {
        Self::create(
            segments,
            music,
            project,
            output_info,
            duration_secs,
            start_playhead_secs,
            None,
        )
    }

    /// Like [`Self::new`], but replays the cache's render when it provably
    /// holds the same samples a fresh render would, and otherwise keeps the
    /// fresh render for the next play when it can be replayed later.
    #[allow(clippy::too_many_arguments)]
    pub fn new_cached(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
        cache: &PlaybackAudioCache,
    ) -> Self {
        Self::create(
            segments,
            music,
            project,
            output_info,
            duration_secs,
            start_playhead_secs,
            Some(cache),
        )
    }

    fn create(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
        cache: Option<&PlaybackAudioCache>,
    ) -> Self {
        let output_info = output_info.for_ffmpeg_output();
        let estimated_output_samples = progressive_buffer_samples(
            duration_secs,
            output_info.sample_rate,
            output_info.channels,
        );
        let estimated_memory_bytes = progressive_buffer_bytes(estimated_output_samples);

        let mode = if estimated_memory_bytes <= MAX_PROGRESSIVE_BUFFER_BYTES {
            let plan = cache.and_then(|_| {
                ProgressiveAudioBuffer::<T>::cache_plan(
                    segments.clone(),
                    &music,
                    project,
                    output_info,
                    duration_secs,
                    start_playhead_secs,
                    estimated_output_samples,
                )
            });
            let cached = cache
                .zip(plan.as_ref())
                .and_then(|(cache, plan)| ProgressiveAudioBuffer::from_cache(cache, plan));
            PrerenderedAudioBufferMode::Progressive(match cached {
                Some(cached) => cached,
                None => {
                    let fresh = ProgressiveAudioBuffer::new(
                        segments,
                        music,
                        project,
                        output_info,
                        duration_secs,
                        start_playhead_secs,
                        estimated_output_samples,
                    );
                    match cache {
                        Some(cache) => fresh.retain_in_cache(cache, plan),
                        None => fresh,
                    }
                }
            })
        } else {
            if let Some(cache) = cache {
                cache.clear();
            }
            info!(
                duration_secs = duration_secs,
                estimated_memory_mb = estimated_memory_bytes / (1024 * 1024),
                max_memory_mb = MAX_PROGRESSIVE_BUFFER_BYTES / (1024 * 1024),
                "Using bounded streaming audio renderer for long playback"
            );
            PrerenderedAudioBufferMode::Streaming(Box::new(StreamingAudioBuffer::new(
                segments,
                music,
                project.clone(),
                output_info,
                start_playhead_secs,
            )))
        };

        Self { mode }
    }

    pub(crate) fn bounded(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        start_playhead_secs: f64,
    ) -> Self {
        Self {
            mode: PrerenderedAudioBufferMode::Streaming(Box::new(StreamingAudioBuffer::new(
                segments,
                music,
                project.clone(),
                output_info,
                start_playhead_secs,
            ))),
        }
    }

    pub fn wait_until_ready(&self, timeout: std::time::Duration) -> bool {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => {
                buffer.wait_until_ready(timeout);
                true
            }
            PrerenderedAudioBufferMode::Streaming(buffer) => buffer.wait_until_ready(timeout),
        }
    }

    #[cfg(test)]
    fn wait_until_fully_rendered(&self) {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.wait_until_fully_rendered(),
            PrerenderedAudioBufferMode::Streaming(_) => {}
        }
    }

    /// Blocks until the next `samples` reads are rendered (or the render
    /// finished or failed). Returns false on timeout or failure.
    #[cfg(feature = "test-hooks")]
    pub(crate) fn wait_until_rendered(&self, samples: usize, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let ready = match &self.mode {
                PrerenderedAudioBufferMode::Progressive(buffer) => buffer.rendered(samples),
                PrerenderedAudioBufferMode::Streaming(buffer) => buffer.rendered(samples),
            };
            match ready {
                Some(ready) if !ready && std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_micros(200));
                }
                Some(ready) => return ready,
                None => return false,
            }
        }
    }

    pub fn set_playhead(&mut self, playhead_secs: f64) {
        match &mut self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.set_playhead(playhead_secs),
            PrerenderedAudioBufferMode::Streaming(buffer) => buffer.set_playhead(playhead_secs),
        }
    }

    pub(crate) fn try_align_prepared_playhead(&mut self, playhead_secs: f64) -> bool {
        match &mut self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => {
                buffer.set_playhead(playhead_secs);
                true
            }
            PrerenderedAudioBufferMode::Streaming(buffer) => {
                buffer.try_align_prepared_playhead(playhead_secs)
            }
        }
    }

    pub fn current_audible_playhead(&self, device_latency_secs: f64) -> f64 {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => {
                buffer.current_audible_playhead(device_latency_secs)
            }
            PrerenderedAudioBufferMode::Streaming(buffer) => {
                buffer.current_audible_playhead(device_latency_secs)
            }
        }
    }

    #[allow(dead_code)]
    pub fn current_playhead_secs(&self) -> f64 {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.current_playhead_secs(),
            PrerenderedAudioBufferMode::Streaming(buffer) => buffer.current_playhead_secs(),
        }
    }

    pub fn fill(&mut self, buffer: &mut [T]) {
        match &mut self.mode {
            PrerenderedAudioBufferMode::Progressive(source) => source.fill(buffer),
            PrerenderedAudioBufferMode::Streaming(source) => source.fill(buffer),
        }
    }
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> ProgressiveAudioBuffer<T> {
    /// Audio rendered ahead of the start position before the stream is
    /// considered ready.
    const READY_WINDOW_SECS: f64 = 0.25;
    /// Pass 1 starts this far before the playhead so latency compensation and
    /// small backwards drift corrections stay inside the first rendered pass.
    const START_PREROLL_SECS: f64 = 1.0;

    fn new(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
        estimated_output_samples: usize,
    ) -> Self {
        // Clamp output info for FFmpeg compatibility (max 8 channels)
        let output_info = output_info.for_ffmpeg_output();
        // The producer renders f32 at the device rate/channel count; the
        // callback converts to the device sample format on the fly.
        let render_info = AudioInfo::new_raw(
            AudioData::SAMPLE_FORMAT,
            output_info.sample_rate,
            output_info.channels as u16,
        );

        info!(
            duration_secs = duration_secs,
            sample_rate = output_info.sample_rate,
            channels = output_info.channels,
            start_playhead_secs = start_playhead_secs,
            "Starting progressive audio pre-render"
        );

        let pass1_start_secs = Self::pass1_start_secs(start_playhead_secs, duration_secs);
        let primary_start = output_sample_index(
            pass1_start_secs,
            output_info.sample_rate,
            output_info.channels,
            estimated_output_samples,
        );
        // The ready signal is anchored at the actual start playhead (not the
        // pre-roll start), guaranteeing the samples the stream begins reading
        // exist before playback starts.
        let start_index = output_sample_index(
            start_playhead_secs,
            output_info.sample_rate,
            output_info.channels,
            estimated_output_samples,
        );
        let ready_at_index = start_index.saturating_add(Self::ready_window_samples(output_info));

        let timeline = Arc::new(ProgressiveTimeline::new(
            estimated_output_samples,
            primary_start,
        ));

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();

        if !spawn_progressive_render(
            timeline.clone(),
            segments,
            music,
            project.clone(),
            render_info,
            duration_secs,
            pass1_start_secs,
            ready_at_index,
            ready_tx,
        ) {
            lock(&timeline.retain_slot).exited = true;
        }

        Self {
            render: Arc::new(ProgressiveRender { timeline }),
            ready_rx: Some(ready_rx),
            shift_from: usize::MAX,
            shift: 0,
            read_position: 0,
            sample_rate: output_info.sample_rate,
            channels: output_info.channels,
            _format: std::marker::PhantomData,
        }
    }

    fn pass1_start_secs(start_playhead_secs: f64, duration_secs: f64) -> f64 {
        (start_playhead_secs - Self::START_PREROLL_SECS)
            .max(0.0)
            .min(duration_secs)
    }

    fn ready_window_samples(output_info: AudioInfo) -> usize {
        output_sample_index(
            Self::READY_WINDOW_SECS,
            output_info.sample_rate,
            output_info.channels,
            usize::MAX,
        )
    }

    /// Runs after this fresh render is already on its way, so a play that
    /// misses the cache starts exactly like an uncached one. Replays the
    /// cached render when it holds this play's samples and has rendered at
    /// least what the fresh render would have by now; otherwise keeps the
    /// fresh render for later plays when its samples are origin independent.
    #[allow(clippy::too_many_arguments)]
    /// The cache key and sample offsets a render starting at
    /// `start_playhead_secs` would use, when its output can be shared.
    fn cache_plan(
        segments: Vec<AudioSegment>,
        music: &MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
        len: usize,
    ) -> Option<CachePlan> {
        let pass1_start_secs = Self::pass1_start_secs(start_playhead_secs, duration_secs);
        let shift = origin_shift(pass1_start_secs)?;
        let key = render_is_origin_independent(project, output_info, duration_secs)
            .then(|| {
                ProgressiveRenderKey::new(segments, music, project, duration_secs, output_info)
            })
            .flatten()?;
        let (rate, channels) = (output_info.sample_rate, output_info.channels);
        Some(CachePlan {
            key,
            shift_from: output_sample_index(pass1_start_secs, rate, channels, len),
            shift: shift * channels,
            ready_at: output_sample_index(start_playhead_secs, rate, channels, len)
                .saturating_add(Self::ready_window_samples(output_info)),
            rate,
            channels,
        })
    }

    /// A reader over the cached render when it matches `plan` and already
    /// covers the start window. Checked before a fresh render is built, so a
    /// replay never allocates a second full-timeline buffer.
    fn from_cache(cache: &PlaybackAudioCache, plan: &CachePlan) -> Option<Self> {
        let entry = lock(&cache.entry);
        let cached = entry.as_ref()?;
        if cached.key != plan.key
            || cached.render.timeline.stop.load(Ordering::Acquire)
            || !cached.render.timeline.covers(
                plan.shift_from + plan.shift,
                plan.ready_at.saturating_add(plan.shift),
            )
        {
            return None;
        }
        let render = cached.render.clone();
        drop(entry);
        render.timeline.attach_reader();
        info!("Reusing rendered playback audio");
        Some(Self {
            render,
            ready_rx: None,
            shift_from: plan.shift_from,
            shift: plan.shift,
            read_position: 0,
            sample_rate: plan.rate,
            channels: plan.channels,
            _format: std::marker::PhantomData,
        })
    }

    fn retain_in_cache(self, cache: &PlaybackAudioCache, plan: Option<CachePlan>) -> Self {
        let Some(plan) = plan else {
            let previous = lock(&cache.entry).take();
            self.render.timeline.retire(previous);
            return self;
        };
        let mut entry = lock(&cache.entry);
        let previous = if plan.shift == 0
            && self.render.timeline.retain(CacheRelease {
                cache: Arc::downgrade(&cache.entry),
                idle_release: cache.idle_release,
            }) {
            entry.replace(CachedProgressiveRender {
                key: plan.key,
                render: self.render.clone(),
            })
        } else if entry.as_ref().is_some_and(|cached| cached.key != plan.key) {
            entry.take()
        } else {
            None
        };
        drop(entry);
        self.render.timeline.retire(previous);
        self
    }

    /// Blocks until the initial window around the start position is rendered
    /// (or the timeout elapses; unrendered reads are silence, never garbage).
    pub fn wait_until_ready(&self, timeout: std::time::Duration) {
        if let Some(ready_rx) = &self.ready_rx {
            let _ = ready_rx.recv_timeout(timeout);
        }
    }

    #[cfg(test)]
    fn wait_until_fully_rendered(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !self.render.timeline.complete.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "progressive audio render did not complete in time"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    /// Whether the next `samples` reads are rendered; `None` once the
    /// render can no longer produce them.
    #[cfg(feature = "test-hooks")]
    fn rendered(&self, samples: usize) -> Option<bool> {
        let timeline = &self.render.timeline;
        let start = self.read_position.min(timeline.samples.len());
        let end = (self.read_position + samples).min(timeline.samples.len());
        if start >= end || timeline.complete.load(Ordering::Acquire) {
            return Some(true);
        }
        let primary_end = timeline.primary_end.load(Ordering::Acquire);
        let wrap_end = timeline.wrap_end.load(Ordering::Acquire);
        let primary = timeline.primary_start;
        let covered = if start >= primary {
            primary_end >= end
        } else if end <= primary {
            wrap_end >= end
        } else {
            wrap_end >= primary && primary_end >= end
        };
        if covered {
            Some(true)
        } else if timeline.stop.load(Ordering::Acquire) {
            None
        } else {
            Some(false)
        }
    }

    pub fn set_playhead(&mut self, playhead_secs: f64) {
        let sample_position = (playhead_secs * self.sample_rate as f64) as usize * self.channels;
        self.read_position = sample_position.min(self.render.timeline.samples.len());
    }

    pub fn current_audible_playhead(&self, device_latency_secs: f64) -> f64 {
        let generated_secs = (self.read_position / self.channels) as f64 / self.sample_rate as f64;
        (generated_secs - device_latency_secs.max(0.0)).max(0.0)
    }

    #[allow(dead_code)]
    pub fn current_playhead_secs(&self) -> f64 {
        (self.read_position / self.channels) as f64 / self.sample_rate as f64
    }

    pub fn fill(&mut self, buffer: &mut [T]) {
        let timeline = &self.render.timeline;
        let samples = &timeline.samples;
        let available = samples.len().saturating_sub(self.read_position);
        let to_copy = buffer.len().min(available);

        if to_copy > 0 {
            let primary_start = timeline.primary_start;
            let primary_end = timeline.primary_end.load(Ordering::Acquire);
            let wrap_end = timeline.wrap_end.load(Ordering::Acquire);

            for (i, slot) in buffer[..to_copy].iter_mut().enumerate() {
                let mut idx = self.read_position + i;
                if idx >= self.shift_from {
                    idx += self.shift;
                }
                let rendered = idx < samples.len()
                    && if idx >= primary_start {
                        idx < primary_end
                    } else {
                        idx < wrap_end
                    };
                *slot = if rendered {
                    <T as cpal::Sample>::from_sample(f32::from_bits(
                        samples[idx].load(Ordering::Relaxed),
                    ))
                } else {
                    T::EQUILIBRIUM
                };
            }
            self.read_position += to_copy;
        }

        if to_copy < buffer.len() {
            buffer[to_copy..].fill(T::EQUILIBRIUM);
        }
    }
}

struct StreamingAudioTimeline {
    samples: Box<[AtomicU32]>,
    requested_position: AtomicUsize,
    consumed_position: AtomicUsize,
    generation: AtomicUsize,
    published_generation: AtomicUsize,
    published_start: AtomicUsize,
    published_end: AtomicUsize,
    stop: AtomicBool,
    failed: AtomicBool,
}

struct StreamingAudioBuffer<T: FromSampleBytes> {
    timeline: Arc<StreamingAudioTimeline>,
    worker: Option<std::thread::JoinHandle<()>>,
    ready: std::sync::mpsc::Receiver<()>,
    generation: usize,
    read_position: usize,
    sample_rate: u32,
    channels: usize,
    _format: std::marker::PhantomData<T>,
}

impl<T: FromSampleBytes> Drop for StreamingAudioBuffer<T> {
    fn drop(&mut self) {
        self.timeline.stop.store(true, Ordering::Release);
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
    }
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> StreamingAudioBuffer<T> {
    fn new(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: ProjectConfiguration,
        output_info: AudioInfo,
        start_playhead_secs: f64,
    ) -> Self {
        let output_info = output_info.for_ffmpeg_output();
        let sample_rate = output_info.sample_rate;
        let channels = output_info.channels;
        let capacity = (sample_rate as usize)
            .saturating_mul(channels)
            .saturating_mul(2)
            .max(4096 * channels);
        let start = output_sample_index(start_playhead_secs, sample_rate, channels, usize::MAX);
        let timeline = Arc::new(StreamingAudioTimeline {
            samples: (0..capacity).map(|_| AtomicU32::new(0)).collect(),
            requested_position: AtomicUsize::new(start),
            consumed_position: AtomicUsize::new(start),
            generation: AtomicUsize::new(1),
            published_generation: AtomicUsize::new(0),
            published_start: AtomicUsize::new(start),
            published_end: AtomicUsize::new(start),
            stop: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        });
        let (ready_tx, ready) = std::sync::mpsc::sync_channel(1);
        let state = timeline.clone();
        let worker = std::thread::Builder::new()
            .name("cap-audio-stream".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let render_info =
                        AudioInfo::new(AudioData::SAMPLE_FORMAT, sample_rate, channels as u16)
                            .unwrap();
                    let mut producer = StreamingAudioProducer::<f32>::new(
                        segments,
                        music,
                        project,
                        render_info,
                        start_playhead_secs,
                    );
                    let mut generation = 1;
                    let mut first = start;
                    let mut position = start;
                    let mut block = vec![0.0; 1024 * channels];
                    while !state.stop.load(Ordering::Acquire) {
                        let requested_generation = state.generation.load(Ordering::Acquire);
                        if requested_generation != generation {
                            generation = requested_generation;
                            first = state.requested_position.load(Ordering::Acquire);
                            position = first;
                            producer
                                .set_playhead((first / channels) as f64 / f64::from(sample_rate));
                        }
                        let consumed = state.consumed_position.load(Ordering::Acquire);
                        if position
                            .saturating_sub(consumed)
                            .saturating_add(block.len())
                            > capacity
                        {
                            std::thread::park_timeout(std::time::Duration::from_millis(10));
                            continue;
                        }
                        producer.fill(&mut block);
                        if state.generation.load(Ordering::Acquire) != generation {
                            continue;
                        }
                        for (offset, sample) in block.iter().enumerate() {
                            state.samples[(position + offset) % capacity]
                                .store(sample.to_bits(), Ordering::Relaxed);
                        }
                        position += block.len();
                        state.published_start.store(first, Ordering::Relaxed);
                        state.published_end.store(position, Ordering::Release);
                        state
                            .published_generation
                            .store(generation, Ordering::Release);
                        if position - first >= sample_rate as usize / 4 * channels {
                            let _ = ready_tx.try_send(());
                        }
                    }
                }));
                if result.is_err() {
                    state.failed.store(true, Ordering::Release);
                    let _ = ready_tx.try_send(());
                    warn!("Streaming audio worker failed");
                }
            })
            .map_err(|error| {
                timeline.failed.store(true, Ordering::Release);
                warn!(%error, "Could not start streaming audio worker");
            })
            .ok();
        Self {
            timeline,
            worker,
            ready,
            generation: 1,
            read_position: start,
            sample_rate,
            channels,
            _format: std::marker::PhantomData,
        }
    }

    fn wait_until_ready(&self, timeout: std::time::Duration) -> bool {
        let started = std::time::Instant::now();
        loop {
            if self.timeline.failed.load(Ordering::Acquire) {
                return false;
            }
            if self.timeline.published_generation.load(Ordering::Acquire) == self.generation
                && self
                    .timeline
                    .published_end
                    .load(Ordering::Acquire)
                    .saturating_sub(self.read_position)
                    >= self.sample_rate as usize / 4 * self.channels
            {
                return true;
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() || self.ready.recv_timeout(remaining).is_err() {
                return false;
            }
        }
    }

    #[cfg(feature = "test-hooks")]
    fn rendered(&self, samples: usize) -> Option<bool> {
        if self.timeline.failed.load(Ordering::Acquire) {
            return None;
        }
        Some(
            self.timeline.published_generation.load(Ordering::Acquire) == self.generation
                && self.timeline.published_end.load(Ordering::Acquire)
                    >= self.read_position + samples,
        )
    }

    fn set_playhead(&mut self, playhead_secs: f64) {
        let position =
            output_sample_index(playhead_secs, self.sample_rate, self.channels, usize::MAX);
        if position == self.read_position || self.try_align_prepared_playhead(playhead_secs) {
            return;
        }
        self.read_position = position;
        self.timeline
            .requested_position
            .store(position, Ordering::Release);
        self.timeline
            .consumed_position
            .store(position, Ordering::Release);
        self.generation = self.timeline.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
    }

    fn try_align_prepared_playhead(&mut self, playhead_secs: f64) -> bool {
        if !playhead_secs.is_finite()
            || self.timeline.published_generation.load(Ordering::Acquire) != self.generation
        {
            return false;
        }
        let position =
            output_sample_index(playhead_secs, self.sample_rate, self.channels, usize::MAX);
        if position < self.read_position
            || position > self.timeline.published_end.load(Ordering::Acquire)
        {
            return false;
        }
        self.read_position = position;
        self.timeline
            .consumed_position
            .store(position, Ordering::Release);
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
        true
    }

    fn current_audible_playhead(&self, device_latency_secs: f64) -> f64 {
        ((self.read_position / self.channels) as f64 / f64::from(self.sample_rate)
            - device_latency_secs.max(0.0))
        .max(0.0)
    }

    fn current_playhead_secs(&self) -> f64 {
        self.current_audible_playhead(0.0)
    }

    fn fill(&mut self, buffer: &mut [T]) {
        let generation = self.timeline.published_generation.load(Ordering::Acquire);
        let start = self.timeline.published_start.load(Ordering::Acquire);
        let end = self.timeline.published_end.load(Ordering::Acquire);
        for (offset, sample) in buffer.iter_mut().enumerate() {
            let position = self.read_position + offset;
            *sample = if generation == self.generation && position >= start && position < end {
                T::from_sample(f32::from_bits(
                    self.timeline.samples[position % self.timeline.samples.len()]
                        .load(Ordering::Relaxed),
                ))
            } else {
                T::EQUILIBRIUM
            };
        }
        self.read_position = self.read_position.saturating_add(buffer.len());
        self.timeline
            .consumed_position
            .store(self.read_position, Ordering::Release);
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
    }
}

struct StreamingAudioProducer<T: FromSampleBytes> {
    renderer: AudioRenderer,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
    project: ProjectConfiguration,
    sample_rate: u32,
    channels: usize,
    read_position: usize,
}

impl<T: FromSampleBytes> StreamingAudioProducer<T> {
    const PROCESSING_SAMPLES_COUNT: usize = 1024;
    const READY_WINDOW_SECS: f64 = 0.25;
    const BUFFER_SECS: usize = 2;

    fn new(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: ProjectConfiguration,
        output_info: AudioInfo,
        start_playhead_secs: f64,
    ) -> Self {
        let output_info = output_info.for_ffmpeg_output();
        let capacity = (output_info.sample_rate as usize)
            .saturating_mul(output_info.channels)
            .saturating_mul(Self::BUFFER_SECS)
            .max(Self::PROCESSING_SAMPLES_COUNT * output_info.channels * 4);

        let mut buffer = Self {
            renderer: AudioRenderer::new(segments).with_music(music),
            resampler: AudioResampler::new(output_info).unwrap(),
            resampled_buffer: HeapRb::new(capacity),
            project,
            sample_rate: output_info.sample_rate,
            channels: output_info.channels,
            read_position: 0,
        };
        buffer.set_playhead(start_playhead_secs);
        buffer
    }

    fn ready_window_samples(&self) -> usize {
        output_sample_index(
            Self::READY_WINDOW_SECS,
            self.sample_rate,
            self.channels,
            usize::MAX,
        )
    }

    fn set_playhead(&mut self, playhead_secs: f64) {
        self.resampler.reset();
        self.resampled_buffer.clear();
        self.read_position =
            output_sample_index(playhead_secs, self.sample_rate, self.channels, usize::MAX);
        self.renderer.set_playhead(playhead_secs, &self.project);
        self.prefill(self.ready_window_samples());
    }

    #[cfg(test)]
    fn try_align_prepared_playhead(&mut self, playhead_secs: f64) -> bool {
        let delta = playhead_secs - self.current_audible_playhead(0.0);
        let samples = ((delta.max(0.0) * f64::from(self.sample_rate)).round() as usize)
            .saturating_mul(self.channels);
        if delta.is_finite()
            && delta >= -1.0 / f64::from(self.sample_rate)
            && samples <= self.resampled_buffer.occupied_len()
        {
            self.read_position = self
                .read_position
                .saturating_add(self.resampled_buffer.skip(samples));
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    fn current_audible_playhead(&self, device_latency_secs: f64) -> f64 {
        let consumed_secs =
            (self.read_position / self.channels) as f64 / f64::from(self.sample_rate);
        (consumed_secs - device_latency_secs.max(0.0)).max(0.0)
    }

    fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len() <= 2 * Self::PROCESSING_SAMPLES_COUNT * self.channels
    }

    fn render_chunk(&mut self) -> bool {
        if self.buffer_reaching_limit() {
            return false;
        }

        let bytes_per_sample = self.resampler.output.sample_size();
        let rendered = match self
            .renderer
            .render_frame(Self::PROCESSING_SAMPLES_COUNT, &self.project)
        {
            Some(frame) => self.resampler.queue_and_process_frame(&frame),
            None => {
                let frame = silent_audio_frame(Self::PROCESSING_SAMPLES_COUNT);
                self.resampler.queue_and_process_frame(&frame)
            }
        };

        if rendered.is_empty() {
            return false;
        }

        let mut typed_data = vec![T::EQUILIBRIUM; rendered.len() / bytes_per_sample];
        for (src, dest) in std::iter::zip(rendered.chunks(bytes_per_sample), &mut typed_data) {
            *dest = T::from_bytes(src);
        }
        self.resampled_buffer.push_slice(&typed_data);
        true
    }

    fn prefill(&mut self, min_samples: usize) {
        if min_samples == 0 {
            return;
        }

        let target = min_samples.min(self.resampled_buffer.capacity().get());
        while self.resampled_buffer.occupied_len() < target {
            if !self.render_chunk() {
                break;
            }
        }
    }

    fn fill(&mut self, playback_buffer: &mut [T]) {
        if self.resampled_buffer.occupied_len() < playback_buffer.len() {
            self.prefill(playback_buffer.len());
        }

        let filled = self.resampled_buffer.pop_slice(playback_buffer);
        self.read_position = self.read_position.saturating_add(filled);
        playback_buffer[filled..].fill(T::EQUILIBRIUM);

        self.prefill(self.ready_window_samples().max(playback_buffer.len()));
    }
}

/// Writes resampler output (packed f32 bytes) into the shared buffer,
/// stopping at `limit`. Returns the next write index.
fn store_progressive_samples(
    timeline: &ProgressiveTimeline,
    bytes: &[u8],
    mut out_idx: usize,
    limit: usize,
) -> usize {
    for chunk in bytes.chunks_exact(f32::BYTE_SIZE) {
        if out_idx >= limit {
            break;
        }
        timeline.samples[out_idx].store(f32::from_bytes(chunk).to_bits(), Ordering::Relaxed);
        out_idx += 1;
    }
    out_idx
}

#[allow(clippy::too_many_arguments)]
fn spawn_progressive_render(
    timeline: Arc<ProgressiveTimeline>,
    segments: Vec<AudioSegment>,
    music: MusicTracks,
    project: ProjectConfiguration,
    render_info: AudioInfo,
    duration_secs: f64,
    pass1_start_secs: f64,
    ready_at_index: usize,
    ready_tx: std::sync::mpsc::Sender<()>,
) -> bool {
    let spawn_result = std::thread::Builder::new()
        .name("cap-audio-prerender".into())
        .spawn(move || {
            let render_start = std::time::Instant::now();
            let mut control = RenderControl {
                timeline: timeline.clone(),
                release: None,
                adopted: false,
            };
            let mut renderer = AudioRenderer::new(segments).with_music(music);

            let chunk_size = 1024usize;

            let total_source_samples = (duration_secs * AudioData::SAMPLE_RATE as f64) as usize;
            let pass1_source_start = (pass1_start_secs * AudioData::SAMPLE_RATE as f64) as usize;
            let buffer_len = timeline.samples.len();
            let mut ready_sent = false;
            let send_ready = |sent: &mut bool| {
                if !*sent {
                    *sent = true;
                    let _ = ready_tx.send(());
                }
            };

            // Renders source samples [from_source, to_source) into the shared
            // buffer starting at out_idx, bounded by out_limit. Mirrors the
            // original blocking pre-render loop chunk for chunk so the sample
            // values are identical.
            let render_pass = |renderer: &mut AudioRenderer,
                               control: &mut RenderControl,
                               start_secs: f64,
                               from_source: usize,
                               to_source: usize,
                               mut out_idx: usize,
                               out_limit: usize,
                               watermark: &AtomicUsize,
                               ready_at: Option<usize>,
                               ready_sent: &mut bool|
             -> bool {
                let Ok(mut resampler) = AudioResampler::new(render_info) else {
                    return false;
                };
                renderer.set_playhead(start_secs, &project);

                let mut rendered_source = from_source;

                while rendered_source < to_source {
                    if !control.should_continue() {
                        return false;
                    }

                    match renderer.render_frame(chunk_size, &project) {
                        Some(frame) => {
                            let resampled = resampler.queue_and_process_frame(&frame);
                            out_idx =
                                store_progressive_samples(&timeline, resampled, out_idx, out_limit);
                        }
                        None => {
                            let frame = silent_audio_frame(chunk_size);
                            let resampled = resampler.queue_and_process_frame(&frame);
                            out_idx =
                                store_progressive_samples(&timeline, resampled, out_idx, out_limit);
                        }
                    }

                    rendered_source += chunk_size;
                    watermark.store(out_idx, Ordering::Release);

                    if let Some(ready_at) = ready_at
                        && out_idx >= ready_at
                    {
                        send_ready(ready_sent);
                    }
                }

                while let Some(flushed) = resampler.flush_frame() {
                    if flushed.is_empty() || out_idx >= out_limit {
                        break;
                    }
                    out_idx = store_progressive_samples(&timeline, flushed, out_idx, out_limit);
                    watermark.store(out_idx, Ordering::Release);
                }

                if ready_at.is_some() {
                    send_ready(ready_sent);
                }
                true
            };

            // Pass 1: playhead (minus pre-roll) to the end of the timeline.
            let pass1_ok = render_pass(
                &mut renderer,
                &mut control,
                pass1_start_secs,
                pass1_source_start,
                total_source_samples,
                timeline.primary_start,
                buffer_len,
                &timeline.primary_end,
                Some(ready_at_index),
                &mut ready_sent,
            );

            if pass1_ok {
                timeline.pass1_done.store(true, Ordering::Release);
            }

            // Pass 2: wrap around to cover [0, playhead) for backwards seeks.
            let pass2_ok = if pass1_ok && pass1_source_start > 0 {
                render_pass(
                    &mut renderer,
                    &mut control,
                    0.0,
                    0,
                    pass1_source_start,
                    0,
                    timeline.primary_start,
                    &timeline.wrap_end,
                    None,
                    &mut ready_sent,
                )
            } else {
                pass1_ok
            };

            send_ready(&mut ready_sent);

            let completed = pass1_ok && pass2_ok;
            if completed {
                timeline.complete.store(true, Ordering::Release);
                info!(
                    total_samples = buffer_len,
                    memory_mb = (buffer_len * std::mem::size_of::<u32>()) / (1024 * 1024),
                    elapsed_ms = render_start.elapsed().as_millis() as u64,
                    "Progressive audio pre-render complete"
                );
            }
            drop(renderer);
            timeline.release_retired(true);
            control.finish(completed);
        });

    if let Err(e) = &spawn_result {
        tracing::error!("Failed to spawn audio pre-render thread: {e}");
    }
    spawn_result.is_ok()
}

/// Lets a cached render outlive its readers: it parks while nobody is
/// playing, resumes when a replay attaches, and frees itself once the editor
/// stays paused for the idle timeout.
struct RenderControl {
    timeline: Arc<ProgressiveTimeline>,
    release: Option<CacheRelease>,
    adopted: bool,
}

impl RenderControl {
    fn should_continue(&mut self) -> bool {
        loop {
            let seen = self.timeline.wake_generation();
            if self.timeline.stop.load(Ordering::Acquire) {
                return false;
            }
            if !self.timeline.retained.load(Ordering::Acquire) {
                return true;
            }
            self.adopt_release();
            if self.release_if_idle() {
                continue;
            }
            if self.timeline.readers.load(Ordering::Acquire) > 0 {
                return true;
            }
            self.timeline.release_retired(false);
            self.wait_for_wake(seen);
        }
    }

    fn adopt_release(&mut self) {
        if !self.adopted {
            self.adopted = true;
            self.release = lock(&self.timeline.retain_slot).release.take();
        }
    }

    fn finish(mut self, completed: bool) {
        {
            let mut slot = lock(&self.timeline.retain_slot);
            slot.exited = true;
            if !self.adopted {
                self.adopted = true;
                self.release = slot.release.take();
            }
        }
        if completed {
            loop {
                let seen = self.timeline.wake_generation();
                if self.release.is_none() || self.timeline.stop.load(Ordering::Acquire) {
                    break;
                }
                if self.release_if_idle() {
                    return;
                }
                self.wait_for_wake(seen);
            }
        }
        if let Some(release) = self.release.take() {
            release.release(&self.timeline);
        }
    }

    fn release_if_idle(&mut self) -> bool {
        let Some(release) = &self.release else {
            return false;
        };
        if self.timeline.readers.load(Ordering::Acquire) == 0
            && self.timeline.paused_for() >= release.idle_release
            && let Some(release) = self.release.take()
        {
            release.release(&self.timeline);
            return true;
        }
        false
    }

    fn wait_for_wake(&self, seen: u64) {
        let idle_release = self
            .release
            .as_ref()
            .map_or(PLAYBACK_AUDIO_IDLE_RELEASE, |release| release.idle_release);
        let timeout = if self.timeline.readers.load(Ordering::Acquire) > 0 {
            idle_release
        } else {
            idle_release.saturating_sub(self.timeline.paused_for())
        };
        self.timeline.wait(seen, timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{
        ClipConfiguration, ClipTransition, ClipTransitionType, ProjectConfiguration,
        TimelineConfiguration, TimelineSegment,
    };
    use std::{path::Path, sync::Arc};
    use tempfile::TempDir;

    fn gain(_: &AudioConfiguration) -> f32 {
        0.0
    }

    fn stereo(_: &AudioConfiguration) -> StereoMode {
        StereoMode::Stereo
    }

    fn no_offset(_: &ClipOffsets) -> f32 {
        0.0
    }

    fn write_step_wav(path: &Path, section_values: &[i16]) {
        let sample_rate = AudioData::SAMPLE_RATE;
        let channels = 2u16;
        let bits_per_sample = 16u16;
        let section_frames = sample_rate as usize;
        let total_frames = section_frames * section_values.len();
        let bytes_per_frame = usize::from(channels) * usize::from(bits_per_sample / 8);
        let data_size = total_frames * bytes_per_frame;
        let mut bytes = Vec::with_capacity(44 + data_size);

        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * bytes_per_frame as u32).to_le_bytes());
        bytes.extend_from_slice(&(bytes_per_frame as u16).to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_size as u32).to_le_bytes());

        for value in section_values {
            for _ in 0..section_frames {
                bytes.extend_from_slice(&value.to_le_bytes());
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }

        std::fs::write(path, bytes).unwrap();
    }

    fn write_sine_wav(path: &Path, frequency: f64, duration: f64) {
        let sample_rate = AudioData::SAMPLE_RATE;
        let channels = 2u16;
        let bits_per_sample = 16u16;
        let total_frames = (duration * sample_rate as f64).round() as usize;
        let bytes_per_frame = usize::from(channels) * usize::from(bits_per_sample / 8);
        let data_size = total_frames * bytes_per_frame;
        let mut bytes = Vec::with_capacity(44 + data_size);

        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * bytes_per_frame as u32).to_le_bytes());
        bytes.extend_from_slice(&(bytes_per_frame as u16).to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_size as u32).to_le_bytes());

        for frame in 0..total_frames {
            let phase = std::f64::consts::TAU * frequency * frame as f64 / sample_rate as f64;
            let value = (phase.sin() * 16_000.0).round() as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }

        std::fs::write(path, bytes).unwrap();
    }

    fn mean_abs(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample.abs()).sum::<f32>() / samples.len() as f32
    }

    fn estimate_left_frequency(samples: &[f32], start: f64, end: f64) -> f64 {
        let sample_rate = AudioData::SAMPLE_RATE as f64;
        let start = (start * sample_rate).round() as usize;
        let end = (end * sample_rate).round() as usize;
        let mut crossings = 0usize;
        let mut previous = samples[start * 2];
        for frame in start + 1..end {
            let current = samples[frame * 2];
            if previous <= 0.0 && current > 0.0 {
                crossings += 1;
            }
            previous = current;
        }
        crossings as f64 / ((end - start) as f64 / sample_rate)
    }

    fn build_renderer_fixture() -> (TempDir, AudioRenderer, ProjectConfiguration) {
        let _ = ffmpeg::init();

        let dir = tempfile::tempdir().unwrap();
        let clip0_path = dir.path().join("clip0.wav");
        let clip1_path = dir.path().join("clip1.wav");

        write_step_wav(&clip0_path, &[1000, 2000, 3000]);
        write_step_wav(&clip1_path, &[4000, 5000, 6000]);

        let segments = vec![
            AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    Arc::new(AudioData::from_file(&clip0_path).unwrap()),
                    gain,
                    stereo,
                    no_offset,
                )],
            },
            AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    Arc::new(AudioData::from_file(&clip1_path).unwrap()),
                    gain,
                    stereo,
                    no_offset,
                )],
            },
        ];

        let project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![
                    TimelineSegment {
                        recording_clip: 0,
                        timescale: 1.0,
                        start: 0.0,
                        end: 1.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                    TimelineSegment {
                        recording_clip: 0,
                        timescale: 4.0,
                        start: 1.0,
                        end: 2.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                    TimelineSegment {
                        recording_clip: 0,
                        timescale: 1.0,
                        start: 2.0,
                        end: 3.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 1.0,
                        start: 0.0,
                        end: 1.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 2.0,
                        start: 1.0,
                        end: 2.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 1.0,
                        start: 2.0,
                        end: 3.0,
                        name: None,
                        speed_audio_mode: None,
                        hide_cursor: None,
                        volume: None,
                    },
                ],
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![
                ClipConfiguration {
                    index: 0,
                    ..Default::default()
                },
                ClipConfiguration {
                    index: 1,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        (dir, AudioRenderer::new(segments), project)
    }

    #[test]
    fn prerendered_audio_reports_audible_playhead_after_output_latency() {
        let _ = ffmpeg::init();

        let mut buffer = PrerenderedAudioBuffer::<f32>::new(
            Vec::new(),
            MusicTracks::new(),
            &ProjectConfiguration::default(),
            AudioRenderer::info(),
            1.0,
            0.0,
        );

        buffer.set_playhead(0.5);

        assert!((buffer.current_audible_playhead(0.2) - 0.3).abs() < 0.000_1);
        assert_eq!(buffer.current_audible_playhead(1.0), 0.0);
    }

    #[test]
    fn long_prerender_uses_bounded_streaming_buffer() {
        let _ = ffmpeg::init();

        let output_info = AudioRenderer::info();
        let bytes_per_second = (output_info.sample_rate as usize)
            .saturating_mul(output_info.channels)
            .saturating_mul(std::mem::size_of::<u32>())
            .max(1);
        let duration_secs = (MAX_PROGRESSIVE_BUFFER_BYTES / bytes_per_second) as f64 + 2.0;

        let buffer = PrerenderedAudioBuffer::<f32>::new(
            Vec::new(),
            MusicTracks::new(),
            &ProjectConfiguration::default(),
            output_info,
            duration_secs,
            0.0,
        );

        assert!(matches!(
            &buffer.mode,
            PrerenderedAudioBufferMode::Streaming(_)
        ));
    }

    #[test]
    fn speed_segment_start_cuts_audio_inside_a_single_request() {
        let (_dir, mut renderer, project) = build_renderer_fixture();
        let boundary = 1.0 + 0.25 + 1.0 + 1.0;

        renderer.set_playhead(boundary - 0.01, &project);

        let (rendered, samples) = renderer.render_frame_raw(1920, &project).unwrap();
        assert_eq!(rendered, 1920);

        let boundary_samples = (0.01 * AudioData::SAMPLE_RATE as f64) as usize;
        let before = mean_abs(&samples[..boundary_samples * 2]);
        let after = mean_abs(&samples[boundary_samples * 2..]);

        assert!(before > 0.1);
        assert!(after < 0.0001);
        assert!(renderer.speed_audio_processors.iter().all(Option::is_none));
    }

    #[test]
    fn speed_segment_end_resumes_audio_inside_a_single_request() {
        let (_dir, mut renderer, project) = build_renderer_fixture();
        let boundary = 1.0 + 0.25 + 1.0 + 1.0 + 0.5;

        renderer.set_playhead(boundary - 0.01, &project);

        let (rendered, samples) = renderer.render_frame_raw(1920, &project).unwrap();
        assert_eq!(rendered, 1920);

        let boundary_samples = (0.01 * AudioData::SAMPLE_RATE as f64) as usize;
        let before = mean_abs(&samples[..boundary_samples * 2]);
        let after = mean_abs(&samples[boundary_samples * 2..]);

        assert!(before < 0.0001);
        assert!(after > 0.15);
    }

    #[test]
    fn speed_audio_modes_preserve_or_shift_pitch() {
        for (timescale, mode, expected_frequency) in [
            (0.25, ClipSpeedAudioMode::MaintainPitch, 440.0),
            (0.25, ClipSpeedAudioMode::MatchSpeed, 110.0),
            (8.0, ClipSpeedAudioMode::MaintainPitch, 440.0),
            (8.0, ClipSpeedAudioMode::MatchSpeed, 3_520.0),
        ] {
            let dir = TempDir::new().unwrap();
            let path = dir.path().join("tone.wav");
            write_sine_wav(&path, 440.0, 8.0);
            let audio_segments = vec![AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    Arc::new(AudioData::from_file(&path).unwrap()),
                    gain,
                    stereo,
                    no_offset,
                )],
            }];
            let segment_end = if timescale < 1.0 { 1.0 } else { timescale };
            let output_duration = segment_end / timescale;
            let mut speed_segment = segment(0, 0.0, segment_end, timescale);
            speed_segment.speed_audio_mode = Some(mode);
            let project = ProjectConfiguration {
                timeline: Some(TimelineConfiguration {
                    segments: vec![speed_segment],
                    transitions: Vec::new(),
                    zoom_segments: Vec::new(),
                    scene_segments: Vec::new(),
                    style_segments: Vec::new(),
                    image_segments: Vec::new(),
                    mask_segments: Vec::new(),
                    text_segments: Vec::new(),
                    caption_segments: Vec::new(),
                    keyboard_segments: Vec::new(),
                    audio_segments: Vec::new(),
                    camera3d_segments: Vec::new(),
                }),
                clips: vec![ClipConfiguration {
                    index: 0,
                    ..Default::default()
                }],
                ..Default::default()
            };
            let mut renderer = AudioRenderer::new(audio_segments);
            let stream = render_export_audio(
                &mut renderer,
                &project,
                30,
                (output_duration * 30.0).round() as u64,
            );
            let frequency =
                estimate_left_frequency(&stream, output_duration * 0.2, output_duration * 0.8);
            let tolerance = expected_frequency * 0.01 + 5.0;

            assert!(mean_abs(&stream) > 0.1);
            assert!(
                (frequency - expected_frequency).abs() < tolerance,
                "{timescale}x {mode:?}: expected {expected_frequency} Hz, measured {frequency} Hz"
            );
            assert!(renderer.speed_audio_processors.iter().flatten().count() <= 2);

            if timescale == 0.25 && mode == ClipSpeedAudioMode::MaintainPitch {
                renderer.set_playhead(1.0, &project);
                let (_, seek_samples) = renderer.render_frame_raw(4_800, &project).unwrap();
                assert!(mean_abs(&seek_samples) > 0.1);
            }
        }
    }

    #[test]
    fn speed_audio_filter_rejects_mute_and_omits_near_unit_stage() {
        assert!(speed_audio_filter(ClipSpeedAudioMode::Mute, 2.0).is_err());

        let filter = speed_audio_filter(ClipSpeedAudioMode::MaintainPitch, 4.0 + 1e-10).unwrap();
        assert_eq!(filter.matches("atempo=").count(), 2);
    }

    #[test]
    fn one_x_audio_bypasses_speed_processing() {
        let (_dir, mut renderer, mut project) = build_renderer_fixture();
        for mode in [
            None,
            Some(ClipSpeedAudioMode::MaintainPitch),
            Some(ClipSpeedAudioMode::MatchSpeed),
        ] {
            project.timeline.as_mut().unwrap().segments[0].speed_audio_mode = mode;
            renderer.set_playhead(0.0, &project);
            let (_, samples) = renderer.render_frame_raw(4_800, &project).unwrap();

            assert!(mean_abs(&samples) > 0.01);
            assert!(renderer.speed_audio_processors.iter().all(Option::is_none));
        }
    }

    #[test]
    fn one_x_split_clip_mute_is_local_in_playback_and_export() {
        let (_dir, mut renderer, mut project) = single_clip_fixture(
            &[4000, 8000, 12000],
            vec![
                segment(0, 0.0, 1.0, 1.0),
                segment(0, 1.0, 2.0, 1.0),
                segment(0, 2.0, 3.0, 1.0),
            ],
        );
        project.timeline.as_mut().unwrap().segments[1].speed_audio_mode =
            Some(ClipSpeedAudioMode::Mute);

        let samples_per_second = AudioData::SAMPLE_RATE as usize * 2;
        let export_stream = render_export_audio(&mut renderer, &project, 30, 90);
        assert_eq!(export_stream.len(), samples_per_second * 3);
        assert!((left_at_second(&export_stream, 0) - expected(4000)).abs() < 0.001);
        assert!(
            export_stream[samples_per_second..samples_per_second * 2]
                .iter()
                .all(|sample| *sample == 0.0)
        );
        assert!((left_at_second(&export_stream, 2) - expected(12000)).abs() < 0.001);
        assert!(renderer.speed_audio_processors.iter().all(Option::is_none));

        for duration_secs in [3.0, 3600.0] {
            let mut playback = PrerenderedAudioBuffer::<f32>::new(
                renderer.data.clone(),
                MusicTracks::new(),
                &project,
                AudioRenderer::info(),
                duration_secs,
                0.0,
            );
            playback.wait_until_fully_rendered();
            let mut playback_stream = vec![0.0; export_stream.len()];
            for block in playback_stream.chunks_mut(1024) {
                assert!(playback.wait_until_ready(std::time::Duration::from_secs(5)));
                playback.fill(block);
            }
            for (index, (playback_sample, export_sample)) in
                playback_stream.iter().zip(&export_stream).enumerate()
            {
                assert!(
                    (playback_sample - export_sample).abs() < 0.000_001,
                    "duration {duration_secs}, sample {index}: playback {playback_sample}, export {export_sample}"
                );
            }

            playback.set_playhead(1.5);
            let mut seek_samples = [1.0; 1024];
            playback.fill(&mut seek_samples);
            assert!(seek_samples.iter().all(|sample| *sample == 0.0));
        }

        project.timeline.as_mut().unwrap().segments[1].speed_audio_mode = None;
        renderer.set_playhead(1.5, &project);
        let (_, samples) = renderer.render_frame_raw(1024, &project).unwrap();
        assert!((samples[0] - expected(8000)).abs() < 0.001);
    }

    #[test]
    fn clip_volume_is_local_across_boundaries_playback_and_export() {
        let (_dir, mut renderer, mut project) = single_clip_fixture(
            &[4000, 8000, 12000],
            vec![
                segment(0, 0.0, 1.0, 1.0),
                segment(0, 1.0, 2.0, 1.0),
                segment(0, 2.0, 3.0, 1.0),
            ],
        );
        for volume in [0.0, 0.5, 2.0] {
            project.timeline.as_mut().unwrap().segments[1].volume = Some(volume);
            renderer.set_playhead(0.0, &project);
            let exported = render_export_audio(&mut renderer, &project, 30, 90);
            for (second, value) in [
                expected(4000),
                expected(8000) * volume as f32,
                expected(12000),
            ]
            .into_iter()
            .enumerate()
            {
                assert!((left_at_second(&exported, second) - value).abs() < 0.001);
            }
            renderer.set_playhead(0.99, &project);
            let (_, boundary) = renderer.render_frame_raw(1920, &project).unwrap();
            assert!((boundary[0] - expected(4000)).abs() < 0.001);
            assert!((boundary[boundary.len() - 1] - expected(8000) * volume as f32).abs() < 0.001);

            for duration in [3.0, 3600.0] {
                let mut playback = PrerenderedAudioBuffer::<f32>::new(
                    renderer.data.clone(),
                    MusicTracks::new(),
                    &project,
                    AudioRenderer::info(),
                    duration,
                    0.0,
                );
                playback.wait_until_fully_rendered();
                let mut played = vec![0.0; exported.len()];
                for block in played.chunks_mut(1024) {
                    assert!(playback.wait_until_ready(std::time::Duration::from_secs(5)));
                    playback.fill(block);
                }
                assert!(
                    played
                        .iter()
                        .zip(&exported)
                        .all(|(a, b)| (a - b).abs() < 0.000_001)
                );
                playback.set_playhead(1.5);
                let mut seek = [0.0; 1024];
                assert!(playback.wait_until_ready(std::time::Duration::from_secs(5)));
                playback.fill(&mut seek);
                assert!((seek[0] - expected(8000) * volume as f32).abs() < 0.001);
            }
        }
    }

    #[test]
    fn clip_volume_scales_retimed_audio_without_changing_pitch_processing() {
        for mode in [
            ClipSpeedAudioMode::MaintainPitch,
            ClipSpeedAudioMode::MatchSpeed,
        ] {
            let (_dir, mut renderer, mut project) = build_renderer_fixture();
            let segment = &mut project.timeline.as_mut().unwrap().segments[0];
            segment.timescale = 2.0;
            segment.speed_audio_mode = Some(mode);
            renderer.set_playhead(0.0, &project);
            let (_, original) = renderer.render_frame_raw(4800, &project).unwrap();
            assert!(mean_abs(&original) > 0.01);
            project.timeline.as_mut().unwrap().segments[0].volume = Some(0.5);
            renderer.set_playhead(0.0, &project);
            let (_, quieter) = renderer.render_frame_raw(4800, &project).unwrap();
            assert!(
                original
                    .iter()
                    .zip(quieter)
                    .all(|(a, b)| (a * 0.5 - b).abs() < 0.000_001)
            );
        }
    }

    #[test]
    fn clip_volume_does_not_scale_timeline_music() {
        let (dir, mut renderer, mut project) =
            single_clip_fixture(&[4000], vec![segment(0, 0.0, 1.0, 1.0)]);
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[8000]);
        renderer.music.insert(
            "music.wav".into(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );
        let timeline = project.timeline.as_mut().unwrap();
        timeline
            .audio_segments
            .push(music_track_segment("music.wav", 0.0, 1.0, 0.0, 0.0));
        timeline.segments[0].volume = Some(0.5);
        renderer.set_playhead(0.0, &project);
        let (_, samples) = renderer.render_frame_raw(4800, &project).unwrap();
        assert!((samples[0] - expected(4000) * 0.5 - expected(8000)).abs() < 0.001);
    }

    #[test]
    fn one_x_clip_mute_cuts_and_resumes_inside_a_single_request() {
        let (_dir, mut renderer, mut project) = single_clip_fixture(
            &[4000, 8000, 12000],
            vec![
                segment(0, 0.0, 1.0, 1.0),
                segment(0, 1.0, 2.0, 1.0),
                segment(0, 2.0, 3.0, 1.0),
            ],
        );
        project.timeline.as_mut().unwrap().segments[1].speed_audio_mode =
            Some(ClipSpeedAudioMode::Mute);

        for (playhead, before, after) in [(0.99, 4000, 0), (1.99, 0, 12000)] {
            renderer.set_playhead(playhead, &project);
            let (written, samples) = renderer.render_frame_raw(1920, &project).unwrap();
            assert_eq!(written, 1920);
            let boundary = (0.01 * AudioData::SAMPLE_RATE as f64).round() as usize * 2;
            assert!(
                samples[..boundary]
                    .iter()
                    .all(|sample| (*sample - expected(before)).abs() < 0.001)
            );
            assert!(
                samples[boundary..]
                    .iter()
                    .all(|sample| (*sample - expected(after)).abs() < 0.001)
            );
        }
    }

    /// One clip per second `section_values`, on a timeline made of `segments`.
    fn single_clip_fixture(
        section_values: &[i16],
        segments: Vec<TimelineSegment>,
    ) -> (TempDir, AudioRenderer, ProjectConfiguration) {
        let _ = ffmpeg::init();

        let dir = tempfile::tempdir().unwrap();
        let clip_path = dir.path().join("clip.wav");
        write_step_wav(&clip_path, section_values);

        let data = vec![AudioSegment {
            tracks: vec![AudioSegmentTrack::new(
                Arc::new(AudioData::from_file(&clip_path).unwrap()),
                gain,
                stereo,
                no_offset,
            )],
        }];

        let project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments,
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                ..Default::default()
            }],
            ..Default::default()
        };

        (dir, AudioRenderer::new(data), project)
    }

    fn segment(recording_clip: u32, start: f64, end: f64, timescale: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip,
            timescale,
            start,
            end,
            name: None,
            speed_audio_mode: None,
            hide_cursor: None,
            volume: None,
        }
    }

    /// Mirrors the export encoder loop in `crates/export/src/mp4.rs`: seed the
    /// playhead once at 0.0, then render `((n+1)*sr)/fps - cursor` samples per
    /// output frame. Returns the interleaved-stereo stream, padded so that output
    /// sample index `j` maps to output presentation time `j / sr`.
    fn render_export_audio(
        renderer: &mut AudioRenderer,
        project: &ProjectConfiguration,
        fps: u64,
        frames: u64,
    ) -> Vec<f32> {
        let sr = u64::from(AudioData::SAMPLE_RATE);
        renderer.set_playhead(0.0, project);

        let mut cursor = 0u64;
        let mut out = Vec::new();
        for n in 0..frames {
            let end = ((n + 1) * sr) / fps;
            if end <= cursor {
                continue;
            }
            let budget = (end - cursor) as usize;
            cursor = end;

            let mut chunk = renderer
                .render_frame_raw(budget, project)
                .map(|(_, samples)| samples)
                .unwrap_or_default();
            chunk.resize(budget * 2, 0.0);
            out.extend(chunk);
        }
        out
    }

    /// Left channel value at the middle of output second `out_second`. The fixture
    /// holds a constant value per source second, so this reveals which source
    /// sample the export read for that presentation time.
    fn left_at_second(stream: &[f32], out_second: usize) -> f32 {
        let mid = (out_second * AudioData::SAMPLE_RATE as usize
            + AudioData::SAMPLE_RATE as usize / 2)
            * 2;
        stream[mid]
    }

    fn expected(value: i16) -> f32 {
        value as f32 / 32768.0
    }

    fn transition_fixture(
        kind: ClipTransitionType,
    ) -> (TempDir, AudioRenderer, ProjectConfiguration) {
        let _ = ffmpeg::init();
        let dir = TempDir::new().unwrap();
        let outgoing_path = dir.path().join("outgoing.wav");
        let incoming_path = dir.path().join("incoming.wav");
        write_step_wav(&outgoing_path, &[8000]);
        write_step_wav(&incoming_path, &[16000]);
        let audio_segments = vec![
            AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    Arc::new(AudioData::from_file(&outgoing_path).unwrap()),
                    gain,
                    stereo,
                    no_offset,
                )],
            },
            AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    Arc::new(AudioData::from_file(&incoming_path).unwrap()),
                    gain,
                    stereo,
                    no_offset,
                )],
            },
        ];
        let project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![segment(0, 0.0, 1.0, 1.0), segment(1, 0.0, 1.0, 1.0)],
                transitions: vec![ClipTransition {
                    segment_index: 1,
                    kind,
                    duration: 0.5,
                }],
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![
                ClipConfiguration {
                    index: 0,
                    ..Default::default()
                },
                ClipConfiguration {
                    index: 1,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        (dir, AudioRenderer::new(audio_segments), project)
    }

    fn left_at_time(stream: &[f32], time: f64) -> f32 {
        let sample = (time * AudioData::SAMPLE_RATE as f64).round() as usize;
        stream[sample * 2]
    }

    #[test]
    fn crossfade_audio_uses_equal_power_weights() {
        let (_dir, mut renderer, project) = transition_fixture(ClipTransitionType::CrossFade);
        let stream = render_export_audio(&mut renderer, &project, 30, 45);
        let midpoint = left_at_time(&stream, 0.75);
        let expected_midpoint =
            (expected(8000) + expected(16000)) * std::f32::consts::FRAC_1_SQRT_2;

        assert!((midpoint - expected_midpoint).abs() < 0.01);
    }

    #[test]
    fn one_x_clip_mute_preserves_the_other_side_of_a_transition() {
        for muted_index in [0, 1] {
            let (_dir, mut renderer, mut project) =
                transition_fixture(ClipTransitionType::CrossFade);
            project.timeline.as_mut().unwrap().segments[muted_index].speed_audio_mode =
                Some(ClipSpeedAudioMode::Mute);
            let stream = render_export_audio(&mut renderer, &project, 30, 45);
            let audible_value = if muted_index == 0 { 16000 } else { 8000 };
            let midpoint = expected(audible_value) * std::f32::consts::FRAC_1_SQRT_2;
            assert!((left_at_time(&stream, 0.75) - midpoint).abs() < 0.001);
            let muted_time = if muted_index == 0 { 0.25 } else { 1.25 };
            assert_eq!(left_at_time(&stream, muted_time), 0.0);
        }
    }

    #[test]
    fn fade_through_black_audio_reaches_silence_at_midpoint() {
        let (_dir, mut renderer, project) =
            transition_fixture(ClipTransitionType::FadeThroughBlack);
        let stream = render_export_audio(&mut renderer, &project, 30, 45);

        assert!(left_at_time(&stream, 0.75).abs() < 0.0001);
    }

    #[test]
    fn transition_audio_advances_past_fractional_sample_boundaries() {
        let (_dir, mut renderer, mut project) = transition_fixture(ClipTransitionType::CrossFade);
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments[0].end = 1.100_01;
        timeline.segments[1].end = 1.100_01;
        let expected = (timeline.duration() * AudioData::SAMPLE_RATE as f64).round() as usize;

        renderer.set_playhead(0.0, &project);
        let (written, samples) = renderer.render_frame_raw(expected, &project).unwrap();

        assert_eq!(written, expected);
        assert_eq!(samples.len(), expected * 2);
    }

    #[test]
    fn transition_audio_retimes_each_segment_before_mixing() {
        let (_dir, mut renderer, mut project) = transition_fixture(ClipTransitionType::CrossFade);
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments[0].timescale = 2.0;
        timeline.segments[0].speed_audio_mode = Some(ClipSpeedAudioMode::MaintainPitch);
        timeline.segments[1].timescale = 2.0;
        timeline.segments[1].speed_audio_mode = Some(ClipSpeedAudioMode::MatchSpeed);
        let frames = (timeline.duration() * 30.0).ceil() as u64;

        let stream = render_export_audio(&mut renderer, &project, 30, frames);

        assert!(mean_abs(&stream) > 0.1);
        assert_eq!(renderer.speed_audio_processors.iter().flatten().count(), 2);
    }

    #[test]
    fn studio_sound_streaming_worker_preserves_ring_wraps_and_seek_generations() {
        use std::time::Duration;
        let (_dir, mut renderer, mut project) = build_renderer_fixture();
        renderer.data[0].tracks[0].is_microphone = true;
        project.audio.improve = true;
        for sample_rate in [44_100, 48_000] {
            let info = AudioInfo::new(AudioRenderer::SAMPLE_FORMAT, sample_rate, 2).unwrap();
            let mut reference = StreamingAudioProducer::<f32>::new(
                renderer.data.clone(),
                MusicTracks::new(),
                project.clone(),
                info,
                0.0,
            );
            let mut candidate = StreamingAudioBuffer::<f32>::new(
                renderer.data.clone(),
                MusicTracks::new(),
                project.clone(),
                info,
                0.0,
            );
            assert_eq!(candidate.timeline.samples.len(), sample_rate as usize * 4);
            for block in 0..300 {
                if block == 180 {
                    for position in [0.25, 2.5, 0.75] {
                        candidate.set_playhead(position);
                    }
                    reference.set_playhead(0.75);
                }
                assert!(candidate.wait_until_ready(Duration::from_secs(5)));
                let mut expected = [0.0; 1024];
                let mut actual = [0.0; 1024];
                reference.fill(&mut expected);
                candidate.fill(&mut actual);
                assert_eq!(actual, expected, "rate {sample_rate}, block {block}");
            }
            let worker = candidate.worker.take().unwrap();
            drop(candidate);
            worker.join().unwrap();
        }
    }

    #[test]
    fn studio_sound_prepared_alignment_reuses_samples_without_rendering() {
        let (_dir, mut renderer, mut project) = build_renderer_fixture();
        renderer.data[0].tracks[0].is_microphone = true;
        project.audio.improve = true;
        for sample_rate in [44_100, 48_000] {
            let info = AudioInfo::new(AudioRenderer::SAMPLE_FORMAT, sample_rate, 2).unwrap();
            let make = || {
                StreamingAudioProducer::<f32>::new(
                    renderer.data.clone(),
                    MusicTracks::new(),
                    project.clone(),
                    info,
                    0.0,
                )
            };
            let mut reference = make();
            let mut candidate = make();
            reference.fill(&mut vec![0.0; sample_rate as usize / 8 * 2]);
            let target = reference.current_audible_playhead(0.0);
            let rendered_before = candidate.renderer.elapsed_samples;
            assert!(candidate.try_align_prepared_playhead(target));
            assert_eq!(candidate.renderer.elapsed_samples, rendered_before);
            assert!(
                (candidate.current_audible_playhead(0.0) - target).abs()
                    <= 1.0 / f64::from(sample_rate)
            );
            let mut expected = [0.0; 512 * 2];
            let mut actual = [0.0; 512 * 2];
            reference.fill(&mut expected);
            candidate.fill(&mut actual);
            assert_eq!(actual, expected);
            for target in [1.0, 0.0] {
                let before = candidate.renderer.elapsed_samples;
                assert!(!candidate.try_align_prepared_playhead(target));
                assert_eq!(candidate.renderer.elapsed_samples, before);
                candidate.set_playhead(target);
                assert!((candidate.current_audible_playhead(0.0) - target).abs() < 0.01);
            }
        }
    }

    #[test]
    fn studio_sound_changes_only_the_microphone_and_preserves_system_audio() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("audio.wav");
        write_step_wav(&path, &[12_000]);
        let data = Arc::new(DecodedAudio::from(Arc::new(
            AudioData::from_file(&path).unwrap(),
        )));
        for microphone in [false, true] {
            let segment = crate::segments::audio_segment_from_decoded(
                microphone.then(|| data.clone()),
                (!microphone).then(|| data.clone()),
                crate::SegmentAudioTimingRepair::default(),
            );
            let mut project = ProjectConfiguration::default();
            let original = AudioRenderer::new(vec![segment.clone()])
                .render_frame_raw(48_000, &project)
                .unwrap();
            project.audio.improve = true;
            let enhanced = AudioRenderer::new(vec![segment])
                .render_frame_raw(48_000, &project)
                .unwrap();
            assert_eq!(original.0, enhanced.0);
            if microphone {
                assert_ne!(original.1, enhanced.1);
            } else {
                assert_eq!(original.1, enhanced.1);
            }
        }
    }

    #[test]
    fn export_audio_virtual_negative_timing_offset_inserts_leading_silence() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("delayed.wav");
        write_step_wav(&path, &[12000, 24000]);

        let data = Arc::new(AudioData::from_file(&path).unwrap());
        let mut renderer = AudioRenderer::new(vec![AudioSegment {
            tracks: vec![
                AudioSegmentTrack::new(data, gain, stereo, no_offset).with_timing_offset_secs(-1.0),
            ],
        }]);
        let project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![segment(0, 0.0, 3.0, 1.0)],
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                ..Default::default()
            }],
            ..Default::default()
        };

        let stream = render_export_audio(&mut renderer, &project, 30, 3 * 30);

        assert_eq!(left_at_second(&stream, 0), 0.0);
        assert!((left_at_second(&stream, 1) - expected(12000)).abs() < 0.01);
        assert!((left_at_second(&stream, 2) - expected(24000)).abs() < 0.01);
    }

    #[test]
    fn prerendered_playback_and_export_apply_negative_timing_offset_consistently() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("delayed.wav");
        write_step_wav(&path, &[12000, 24000]);

        let data = Arc::new(AudioData::from_file(&path).unwrap());
        let segments = vec![AudioSegment {
            tracks: vec![
                AudioSegmentTrack::new(data, gain, stereo, no_offset)
                    .with_timing_offset_secs(-0.867),
            ],
        }];
        let project = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![segment(0, 0.0, 3.0, 1.0)],
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                ..Default::default()
            }],
            ..Default::default()
        };

        let mut export_renderer = AudioRenderer::new(segments.clone());
        let export_stream = render_export_audio(&mut export_renderer, &project, 30, 3 * 30);

        let mut playback_buffer = PrerenderedAudioBuffer::<f32>::new(
            segments,
            MusicTracks::new(),
            &project,
            AudioRenderer::info(),
            3.0,
            0.0,
        );
        playback_buffer.wait_until_fully_rendered();
        let mut playback_stream = vec![0.0; 3 * AudioData::SAMPLE_RATE as usize * 2];
        playback_buffer.fill(&mut playback_stream);

        for second in 0..3usize {
            let export_sample = left_at_second(&export_stream, second);
            let playback_sample = left_at_second(&playback_stream, second);
            assert!(
                (export_sample - playback_sample).abs() < 0.01,
                "second {second}: export {export_sample}, playback {playback_sample}"
            );
        }
        assert_eq!(left_at_second(&export_stream, 0), 0.0);
        assert_eq!(left_at_second(&playback_stream, 0), 0.0);
    }

    // Time->sample conversion rounds to nearest (not truncates), so a fractional
    // sample position lands on the nearest sample rather than biasing downward.
    #[test]
    fn playhead_to_samples_rounds_to_nearest() {
        let renderer = AudioRenderer::new(vec![]);
        let sr = AudioData::SAMPLE_RATE as f64;
        // 5.7 samples of time -> 6 (rounded); truncation would give 5.
        assert_eq!(renderer.playhead_to_samples(5.7 / sr), 6);
        // 5.2 samples of time -> 5 (rounded down).
        assert_eq!(renderer.playhead_to_samples(5.2 / sr), 5);
    }

    // Invariant: with a full, untrimmed, 1.0-timescale segment the exported audio
    // reads the source 1:1 — output presentation time T contains source audio at
    // time T — and this holds identically across every fps (no fps-dependent
    // positional shift).
    #[test]
    fn export_audio_tracks_presentation_time_across_fps() {
        let values = [3000i16, 6000, 9000, 12000, 15000];
        for fps in [24u64, 30, 60] {
            let (_dir, mut renderer, project) =
                single_clip_fixture(&values, vec![segment(0, 0.0, 5.0, 1.0)]);
            let stream = render_export_audio(&mut renderer, &project, fps, 5 * fps);

            for (sec, value) in values.iter().enumerate() {
                let got = left_at_second(&stream, sec);
                assert!(
                    (got - expected(*value)).abs() < 0.01,
                    "fps {fps} second {sec}: read {got}, expected {}",
                    expected(*value)
                );
            }
        }
    }

    // Invariant #1: a trimmed segment (start = 2.0s) must offset the audio read
    // position by the trim, exactly like the video timeline mapping.
    #[test]
    fn export_audio_honors_timeline_trim_offset() {
        let values = [3000i16, 6000, 9000, 12000, 15000];
        let (_dir, mut renderer, project) =
            single_clip_fixture(&values, vec![segment(0, 2.0, 5.0, 1.0)]);
        let stream = render_export_audio(&mut renderer, &project, 30, 3 * 30);

        // Output second k reads source second 2 + k.
        for out_second in 0..3usize {
            let got = left_at_second(&stream, out_second);
            let want = expected(values[2 + out_second]);
            assert!(
                (got - want).abs() < 0.01,
                "out second {out_second}: read {got}, expected {want}"
            );
        }
    }

    // Invariant #1: a multi-segment jump cut must re-anchor the audio read at the
    // boundary (no carry-over from segment 0), keeping audio aligned to the cut.
    #[test]
    fn export_audio_reanchors_across_segment_boundary() {
        let values = [3000i16, 6000, 9000, 12000, 15000];
        let (_dir, mut renderer, project) = single_clip_fixture(
            &values,
            vec![segment(0, 0.0, 1.0, 1.0), segment(0, 3.0, 4.0, 1.0)],
        );
        let stream = render_export_audio(&mut renderer, &project, 30, 2 * 30);

        // Output second 0 -> source second 0; output second 1 -> source second 3.
        assert!((left_at_second(&stream, 0) - expected(values[0])).abs() < 0.01);
        assert!((left_at_second(&stream, 1) - expected(values[3])).abs() < 0.01);
    }

    fn music_track_segment(
        path: &str,
        start: f64,
        end: f64,
        fade_in: f64,
        fade_out: f64,
    ) -> cap_project::AudioTrackSegment {
        cap_project::AudioTrackSegment {
            start,
            end,
            track: 0,
            path: path.to_string(),
            name: None,
            enabled: true,
            trim_start: 0.0,
            volume_db: 0.0,
            fade_in,
            fade_out,
            duration: Some(end - start),
        }
    }

    fn music_project(audio_segments: Vec<cap_project::AudioTrackSegment>) -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![segment(0, 0.0, 3.0, 1.0)],
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments,
                camera3d_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn music_mixing_leaves_recording_only_frames_unclipped() {
        let music: MusicTracks = [(
            "a.wav".to_string(),
            Arc::new(AudioData::from_raw_f32(vec![0.25, 0.25, 0.25, 0.25], 2)),
        )]
        .into_iter()
        .collect();
        let project = music_project(vec![music_track_segment("a.wav", 0.0, 3.0, 0.0, 0.0)]);
        let mut out = [1.5, -1.5].repeat(4);
        mix_music(&music, project.timeline.as_ref().unwrap(), 0, 4, &mut out);
        assert_eq!(out, [1.0, -1.0, 1.0, -1.0, 1.5, -1.5, 1.5, -1.5]);
    }

    #[test]
    fn overlapping_music_clips_only_after_all_tracks_are_mixed() {
        let music: MusicTracks = [
            ("a.wav", vec![0.75, -0.75, 0.75, -0.75]),
            ("b.wav", vec![0.75, -0.75, 0.75, -0.75]),
            ("c.wav", vec![-0.75, 0.75, 0.75, -0.75]),
        ]
        .into_iter()
        .map(|(path, samples)| {
            (
                path.to_string(),
                Arc::new(AudioData::from_raw_f32(samples, 2)),
            )
        })
        .collect();
        for paths in [
            ["a.wav", "b.wav", "c.wav"],
            ["a.wav", "c.wav", "b.wav"],
            ["c.wav", "a.wav", "b.wav"],
        ] {
            let project = music_project(
                paths
                    .map(|path| music_track_segment(path, 0.0, 3.0, 0.0, 0.0))
                    .to_vec(),
            );
            for block in [1, 2] {
                let recording = AudioSegment {
                    tracks: vec![AudioSegmentTrack::new(
                        Arc::new(AudioData::from_raw_f32(
                            vec![0.125, -0.125, 0.125, -0.125],
                            2,
                        )),
                        gain,
                        stereo,
                        no_offset,
                    )],
                };
                let mut renderer = AudioRenderer::new(vec![recording]).with_music(music.clone());
                let mut output = Vec::new();
                for _ in 0..2 / block {
                    let (written, chunk) = renderer.render_frame_raw(block, &project).unwrap();
                    assert_eq!(written, block);
                    output.extend(chunk);
                }
                assert_eq!(output, [0.875, -0.875, 1.0, -1.0], "{paths:?}, {block}");
            }
        }
    }

    // Timeline music must be mixed on top of the recording even when the
    // recording itself carries no audio (empty renderer `data`).
    #[test]
    fn mixes_timeline_music_over_silent_recording() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[8000, 8000, 8000]);

        let mut music = MusicTracks::new();
        music.insert(
            "music.wav".to_string(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );

        let project = music_project(vec![music_track_segment("music.wav", 0.0, 3.0, 0.0, 0.0)]);
        let mut renderer = AudioRenderer::new(vec![]).with_music(music);
        let stream = render_export_audio(&mut renderer, &project, 30, 3 * 30);

        for second in 0..3usize {
            assert!(
                (left_at_second(&stream, second) - expected(8000)).abs() < 0.02,
                "second {second}: music not mixed",
            );
        }
    }

    #[test]
    fn speed_audio_mode_does_not_retime_timeline_music() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[8000, 8000]);
        let mut music = MusicTracks::new();
        music.insert(
            "music.wav".to_string(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );
        let mut project = music_project(vec![music_track_segment("music.wav", 0.0, 1.0, 0.0, 0.0)]);
        let segment = &mut project.timeline.as_mut().unwrap().segments[0];
        segment.end = 2.0;
        segment.timescale = 2.0;
        segment.speed_audio_mode = Some(ClipSpeedAudioMode::MaintainPitch);
        let mut renderer = AudioRenderer::new(vec![]).with_music(music);

        let stream = render_export_audio(&mut renderer, &project, 30, 30);

        assert!((left_at_time(&stream, 0.5) - expected(8000)).abs() < 0.02);
    }

    #[test]
    fn one_x_clip_mute_keeps_timeline_music_audible() {
        let (dir, mut renderer, mut project) =
            single_clip_fixture(&[16000], vec![segment(0, 0.0, 1.0, 1.0)]);
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[4000]);
        let mut music = MusicTracks::new();
        music.insert(
            "music.wav".to_string(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );
        renderer = renderer.with_music(music);
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments[0].speed_audio_mode = Some(ClipSpeedAudioMode::Mute);
        timeline
            .audio_segments
            .push(music_track_segment("music.wav", 0.0, 1.0, 0.0, 0.0));

        let stream = render_export_audio(&mut renderer, &project, 30, 30);
        assert!((left_at_time(&stream, 0.5) - expected(4000)).abs() < 0.001);
    }

    // A timeline-positioned music clip only sounds inside its [start, end) window.
    #[test]
    fn timeline_music_respects_start_offset() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[8000, 8000, 8000]);

        let mut music = MusicTracks::new();
        music.insert(
            "music.wav".to_string(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );

        // Starts at 1.0s, so output second 0 is silent and 1..3 play.
        let project = music_project(vec![music_track_segment("music.wav", 1.0, 3.0, 0.0, 0.0)]);
        let mut renderer = AudioRenderer::new(vec![]).with_music(music);
        let stream = render_export_audio(&mut renderer, &project, 30, 3 * 30);

        assert!(
            left_at_second(&stream, 0).abs() < 0.001,
            "before start must be silent"
        );
        assert!((left_at_second(&stream, 1) - expected(8000)).abs() < 0.02);
        assert!((left_at_second(&stream, 2) - expected(8000)).abs() < 0.02);
    }

    // A linear fade-in ramps the gain from 0 at the clip start to full at
    // `fade_in` seconds. Sampling the mid-point of each output second reveals
    // the ramp.
    #[test]
    fn timeline_music_applies_fade_in() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[8000, 8000, 8000]);

        let mut music = MusicTracks::new();
        music.insert(
            "music.wav".to_string(),
            Arc::new(AudioData::from_file(&music_path).unwrap()),
        );

        // 2s fade-in over a 3s clip: 0.5s -> ~25%, 1.5s -> ~75%, 2.5s -> 100%.
        let project = music_project(vec![music_track_segment("music.wav", 0.0, 3.0, 2.0, 0.0)]);
        let mut renderer = AudioRenderer::new(vec![]).with_music(music);
        let stream = render_export_audio(&mut renderer, &project, 30, 3 * 30);

        let full = expected(8000);
        assert!((left_at_second(&stream, 0) - full * 0.25).abs() < 0.03);
        assert!((left_at_second(&stream, 1) - full * 0.75).abs() < 0.03);
        assert!((left_at_second(&stream, 2) - full).abs() < 0.03);
    }

    #[test]
    fn bounded_timeline_music_preserves_trimmed_source_and_cache_coverage() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        let values = [2_000, 4_000, 6_000, 8_000, 10_000, 12_000];
        write_step_wav(&music_path, &values);

        let mut segment = music_track_segment("music.wav", 0.0, 2.0, 0.0, 0.0);
        segment.trim_start = 3.0;
        let mut project = music_project(vec![segment]);
        let mut cache = MusicTracks::new();
        let music = crate::load_music_tracks(&project, dir.path(), &mut cache);
        let original = music.get("music.wav").unwrap();

        assert_eq!(
            original.source_start_sample(),
            AudioData::SAMPLE_RATE as usize * 3
        );
        assert_eq!(original.sample_count(), AudioData::SAMPLE_RATE as usize * 2);

        let repeated = crate::load_music_tracks(&project, dir.path(), &mut cache);
        assert!(Arc::ptr_eq(original, repeated.get("music.wav").unwrap()));

        let mut renderer = AudioRenderer::new(vec![]).with_music(music.clone());
        let stream = render_export_audio(&mut renderer, &project, 30, 2 * 30);
        assert!((left_at_second(&stream, 0) - expected(values[3])).abs() < 0.02);
        assert!((left_at_second(&stream, 1) - expected(values[4])).abs() < 0.02);

        project.timeline.as_mut().unwrap().audio_segments[0].trim_start = 1.0;
        let updated = crate::load_music_tracks(&project, dir.path(), &mut cache);
        let replacement = updated.get("music.wav").unwrap();

        assert!(!Arc::ptr_eq(original, replacement));
        assert_eq!(
            replacement.source_start_sample(),
            AudioData::SAMPLE_RATE as usize
        );

        let mut renderer = AudioRenderer::new(vec![]).with_music(updated);
        let stream = render_export_audio(&mut renderer, &project, 30, 2 * 30);
        assert!((left_at_second(&stream, 0) - expected(values[1])).abs() < 0.02);
        assert!((left_at_second(&stream, 1) - expected(values[2])).abs() < 0.02);
    }

    #[test]
    fn bounded_timeline_music_unions_segments_and_skips_inaudible_tracks() {
        let _ = ffmpeg::init();
        let dir = tempfile::tempdir().unwrap();
        let music_path = dir.path().join("music.wav");
        write_step_wav(&music_path, &[2_000, 4_000, 6_000, 8_000, 10_000, 12_000]);

        let mut early = music_track_segment("music.wav", 0.0, 1.0, 0.0, 0.0);
        early.trim_start = 1.0;
        let mut late = music_track_segment("music.wav", 1.0, 2.0, 0.0, 0.0);
        late.trim_start = 4.0;
        let mut disabled = music_track_segment("missing-disabled.wav", 0.0, 1.0, 0.0, 0.0);
        disabled.enabled = false;
        let mut muted = music_track_segment("missing-muted.wav", 0.0, 1.0, 0.0, 0.0);
        muted.volume_db = -60.0;

        let project = music_project(vec![early, late, disabled, muted]);
        let mut cache = MusicTracks::new();
        let tracks = crate::load_music_tracks(&project, dir.path(), &mut cache);
        let music = tracks.get("music.wav").unwrap();

        assert_eq!(tracks.len(), 1);
        assert_eq!(music.source_start_sample(), AudioData::SAMPLE_RATE as usize);
        assert_eq!(music.sample_count(), AudioData::SAMPLE_RATE as usize * 4);

        let mut renderer = AudioRenderer::new(vec![]).with_music(tracks);
        let stream = render_export_audio(&mut renderer, &project, 30, 2 * 30);
        assert!((left_at_second(&stream, 0) - expected(4_000)).abs() < 0.02);
        assert!((left_at_second(&stream, 1) - expected(10_000)).abs() < 0.02);
    }

    static CACHE_RELEASE: std::sync::RwLock<()> = std::sync::RwLock::new(());

    struct ProgressiveFixture {
        _dir: TempDir,
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        music_path: String,
        project: ProjectConfiguration,
    }

    impl ProgressiveFixture {
        fn new() -> Self {
            let _ = ffmpeg::init();
            let dir = tempfile::tempdir().unwrap();
            let mic_path = dir.path().join("mic.wav");
            let system_path = dir.path().join("system.wav");
            let music_path = dir.path().join("music.wav");
            write_sine_wav(&mic_path, 440.0, 8.0);
            write_sine_wav(&system_path, 220.0, 8.0);
            write_step_wav(&music_path, &[3_000, 6_000]);
            let load = |path: &Path| {
                Arc::new(DecodedAudio::from(Arc::new(
                    AudioData::from_file(path).unwrap(),
                )))
            };
            let segments = vec![crate::segments::audio_segment_from_decoded(
                Some(load(&mic_path)),
                Some(load(&system_path)),
                crate::SegmentAudioTimingRepair::default(),
            )];
            let mut quiet = segment(0, 6.0, 8.0, 1.0);
            quiet.volume = Some(0.5);
            let music_path = music_path.to_string_lossy().into_owned();
            let project = ProjectConfiguration {
                timeline: Some(TimelineConfiguration {
                    segments: vec![segment(0, 0.0, 3.0, 1.0), segment(0, 3.5, 6.0, 1.0), quiet],
                    transitions: Vec::new(),
                    zoom_segments: Vec::new(),
                    scene_segments: Vec::new(),
                    style_segments: Vec::new(),
                    image_segments: Vec::new(),
                    mask_segments: Vec::new(),
                    text_segments: Vec::new(),
                    caption_segments: Vec::new(),
                    keyboard_segments: Vec::new(),
                    audio_segments: vec![music_track_segment(&music_path, 0.5, 4.0, 0.3, 0.4)],
                    camera3d_segments: Vec::new(),
                }),
                clips: vec![ClipConfiguration {
                    index: 0,
                    ..Default::default()
                }],
                ..Default::default()
            };
            let mut music = MusicTracks::new();
            music.insert(
                music_path.clone(),
                Arc::new(AudioData::from_file(&music_path).unwrap()),
            );
            Self {
                _dir: dir,
                segments,
                music,
                music_path,
                project,
            }
        }

        fn timeline(&mut self) -> &mut TimelineConfiguration {
            self.project.timeline.as_mut().unwrap()
        }

        fn duration(&self) -> f64 {
            self.project.timeline.as_ref().unwrap().duration()
        }

        fn buffer(&self, output_info: AudioInfo, start: f64) -> PrerenderedAudioBuffer<f32> {
            PrerenderedAudioBuffer::new(
                self.segments.clone(),
                self.music.clone(),
                &self.project,
                output_info,
                self.duration(),
                start,
            )
        }

        fn cached(
            &self,
            cache: &PlaybackAudioCache,
            output_info: AudioInfo,
            start: f64,
        ) -> PrerenderedAudioBuffer<f32> {
            PrerenderedAudioBuffer::new_cached(
                self.segments.clone(),
                self.music.clone(),
                &self.project,
                output_info,
                self.duration(),
                start,
                cache,
            )
        }

        fn reference(&self, output_info: AudioInfo, start: f64) -> Vec<f32> {
            reference_progressive_render(
                self.segments.clone(),
                self.music.clone(),
                &self.project,
                output_info,
                self.duration(),
                start,
            )
        }
    }

    type FixtureEdit = fn(&mut ProgressiveFixture);

    fn stateful_edits() -> [(&'static str, FixtureEdit); 5] {
        [
            ("studio sound", |f| f.project.audio.improve = true),
            ("speed", |f| f.timeline().segments[1].timescale = 1.5),
            ("transition", |f| {
                f.timeline().transitions = vec![ClipTransition {
                    segment_index: 1,
                    kind: ClipTransitionType::CrossFade,
                    duration: 0.5,
                }]
            }),
            ("text hold", |f| {
                let mut text: cap_project::TextSegment =
                    serde_json::from_value(serde_json::json!({ "start": 2.0, "end": 3.0 }))
                        .unwrap();
                text.enabled = true;
                text.layout = cap_project::TextLayout::Fullscreen;
                f.timeline().text_segments = vec![text];
            }),
            ("segment start on a sample tie", |f| {
                f.timeline().segments[1].start = 3.5 + 0.5 / AudioData::SAMPLE_RATE as f64
            }),
        ]
    }

    fn stereo_48k() -> AudioInfo {
        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 48_000, 2)
    }

    #[allow(clippy::too_many_arguments)]
    fn reference_pass(
        out: &mut [f32],
        renderer: &mut AudioRenderer,
        project: &ProjectConfiguration,
        render_info: AudioInfo,
        start_secs: f64,
        from_source: usize,
        to_source: usize,
        mut out_idx: usize,
        out_limit: usize,
    ) {
        let mut resampler = AudioResampler::new(render_info).unwrap();
        renderer.set_playhead(start_secs, project);
        let mut store = |bytes: &[u8], out_idx: &mut usize| {
            for chunk in bytes.chunks_exact(f32::BYTE_SIZE) {
                if *out_idx >= out_limit {
                    break;
                }
                out[*out_idx] = f32::from_bytes(chunk);
                *out_idx += 1;
            }
        };
        let mut rendered = from_source;
        while rendered < to_source {
            let frame = match renderer.render_frame(1024, project) {
                Some(frame) => frame,
                None => silent_audio_frame(1024),
            };
            store(resampler.queue_and_process_frame(&frame), &mut out_idx);
            rendered += 1024;
        }
        while let Some(flushed) = resampler.flush_frame() {
            if flushed.is_empty() || out_idx >= out_limit {
                break;
            }
            store(flushed, &mut out_idx);
        }
    }

    fn reference_progressive_render(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration: f64,
        start: f64,
    ) -> Vec<f32> {
        let output_info = output_info.for_ffmpeg_output();
        let (rate, channels) = (output_info.sample_rate, output_info.channels);
        let render_info = AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, rate, channels as u16);
        let len = progressive_buffer_samples(duration, rate, channels);
        let mut out = vec![0.0f32; len];
        let mut renderer = AudioRenderer::new(segments).with_music(music);
        let pass1_start = (start - 1.0).max(0.0).min(duration);
        let primary_start = output_sample_index(pass1_start, rate, channels, len);
        let total = (duration * AudioData::SAMPLE_RATE as f64) as usize;
        let pass1_source = (pass1_start * AudioData::SAMPLE_RATE as f64) as usize;
        reference_pass(
            &mut out,
            &mut renderer,
            project,
            render_info,
            pass1_start,
            pass1_source,
            total,
            primary_start,
            len,
        );
        if pass1_source > 0 {
            reference_pass(
                &mut out,
                &mut renderer,
                project,
                render_info,
                0.0,
                0,
                pass1_source,
                0,
                primary_start,
            );
        }
        out
    }

    fn progressive_timeline(buffer: &PrerenderedAudioBuffer<f32>) -> Arc<ProgressiveTimeline> {
        let PrerenderedAudioBufferMode::Progressive(progressive) = &buffer.mode else {
            panic!("expected a progressive buffer");
        };
        progressive.render.timeline.clone()
    }

    fn read_everything(buffer: &mut PrerenderedAudioBuffer<f32>) -> Vec<f32> {
        buffer.wait_until_fully_rendered();
        let len = progressive_timeline(buffer).samples.len();
        buffer.set_playhead(0.0);
        let mut out = vec![1.0f32; len];
        buffer.fill(&mut out);
        out
    }

    fn assert_bit_identical(actual: &[f32], expected: &[f32], context: &str) {
        assert_eq!(actual.len(), expected.len(), "{context}");
        if let Some(index) = actual
            .iter()
            .zip(expected)
            .position(|(a, b)| a.to_bits() != b.to_bits())
        {
            panic!(
                "{context}: sample {index} differs: {} vs {}",
                actual[index], expected[index]
            );
        }
    }

    fn wait_until_released(timeline: Weak<ProgressiveTimeline>, within: std::time::Duration) {
        let deadline = std::time::Instant::now() + within;
        while timeline.strong_count() > 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "cached render was not released"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    #[test]
    fn origin_shift_matches_the_render_rounding() {
        let rate = AudioData::SAMPLE_RATE as f64;
        assert_eq!(origin_shift(0.0), Some(0));
        assert_eq!(origin_shift(1.0), Some(0));
        assert_eq!(origin_shift(2.0 + 0.4 / rate), Some(0));
        assert_eq!(origin_shift(2.0 + 0.6 / rate), Some(1));
        for frame in 0..2_000u32 {
            let secs = (f64::from(frame) / 30.0 + 0.0123 - 1.0).max(0.0);
            let slot = output_sample_index(secs, AudioData::SAMPLE_RATE, 1, usize::MAX);
            let source = (secs * rate).round() as usize;
            assert_eq!(origin_shift(secs), Some(source - slot));
        }
    }

    #[test]
    fn uncached_progressive_playback_is_one_uninterrupted_render() {
        let mut fixture = ProgressiveFixture::new();
        for improve in [false, true] {
            fixture.project.audio.improve = improve;
            for output_info in [
                stereo_48k(),
                AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, 44_100, 2),
            ] {
                for start in [0.0, 2.7] {
                    let context = format!(
                        "improve {improve}, {} Hz, start {start}",
                        output_info.sample_rate
                    );
                    let mut buffer = fixture.buffer(output_info, start);
                    buffer.set_playhead(start);
                    assert!(buffer.wait_until_ready(std::time::Duration::from_secs(30)));
                    assert_bit_identical(
                        &read_everything(&mut buffer),
                        &fixture.reference(output_info, start),
                        &context,
                    );
                }
            }
        }
    }

    #[test]
    fn replays_from_any_start_match_a_fresh_render_from_that_start() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        let rate = AudioData::SAMPLE_RATE as f64;
        let cache = PlaybackAudioCache::default();
        let first = fixture.cached(&cache, output_info, 1.0);
        first.wait_until_fully_rendered();
        let timeline = progressive_timeline(&first);
        drop(first);

        let mut shifts = [0usize; 2];
        let starts = [
            0.0,
            0.4,
            2.7,
            3.0 + 1.0 / 3.0,
            4.0 + 0.6 / rate,
            5.0 + 0.4 / rate,
            6.123_456_789,
            7.4,
            7.5,
            9.0,
        ]
        .into_iter()
        .chain((0..40).map(|frame| f64::from(frame) * 0.187 + 0.0213));
        for start in starts {
            let context = format!("start {start}");
            shifts[origin_shift((start - 1.0).clamp(0.0, fixture.duration())).unwrap()] += 1;
            let mut replay = fixture.cached(&cache, output_info, start);
            assert!(
                Arc::ptr_eq(&timeline, &progressive_timeline(&replay)),
                "{context}: must replay the cached render"
            );
            replay.set_playhead(start);
            assert!(replay.wait_until_ready(std::time::Duration::from_secs(1)));
            let replayed = read_everything(&mut replay);
            drop(replay);
            assert_bit_identical(&replayed, &fixture.reference(output_info, start), &context);
            let mut fresh = fixture.buffer(output_info, start);
            assert_bit_identical(&replayed, &read_everything(&mut fresh), &context);
        }
        assert!(shifts.iter().all(|count| *count > 0), "{shifts:?}");
    }

    #[test]
    fn stateful_audio_and_resampled_output_never_replay() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let mut cases: Vec<(String, ProgressiveFixture, AudioInfo)> = stateful_edits()
            .into_iter()
            .map(|(name, edit)| {
                let mut fixture = ProgressiveFixture::new();
                edit(&mut fixture);
                (name.to_string(), fixture, stereo_48k())
            })
            .collect();
        for (rate, channels) in [(44_100, 2), (96_000, 2), (48_000, 1), (48_000, 6)] {
            cases.push((
                format!("{rate} Hz x{channels}"),
                ProgressiveFixture::new(),
                AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, rate, channels),
            ));
        }
        for (name, fixture, output_info) in cases {
            let cache = PlaybackAudioCache::default();
            let first = fixture.cached(&cache, output_info, 1.0);
            first.wait_until_fully_rendered();
            let timeline = progressive_timeline(&first);
            drop(first);
            assert!(lock(&cache.entry).is_none(), "{name} must not be cached");
            for start in [1.0, 3.3] {
                let mut replay = fixture.cached(&cache, output_info, start);
                assert!(
                    !Arc::ptr_eq(&timeline, &progressive_timeline(&replay)),
                    "{name} must render fresh"
                );
                assert_bit_identical(
                    &read_everything(&mut replay),
                    &fixture.reference(output_info, start),
                    &name,
                );
            }
        }
    }

    #[test]
    fn an_unrendered_start_renders_fresh() {
        let fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        let len = progressive_buffer_samples(fixture.duration(), 48_000, 2);
        let primary_start = output_sample_index(4.0, 48_000, 2, len);
        let timeline = ProgressiveTimeline::new(len, primary_start);
        timeline
            .primary_end
            .store(primary_start + 1_000, Ordering::Release);
        assert!(timeline.covers(primary_start, primary_start + 1_000));
        assert!(!timeline.covers(primary_start, primary_start + 1_001));
        assert!(!timeline.covers(primary_start - 2, primary_start + 10));
        timeline.wrap_end.store(primary_start, Ordering::Release);
        assert!(timeline.covers(0, primary_start + 1_000));
        timeline.pass1_done.store(true, Ordering::Release);
        assert!(timeline.covers(0, len + 10));

        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let cache = PlaybackAudioCache::default();
        let parked = fixture.cached(&cache, output_info, 0.0);
        let cached = progressive_timeline(&parked);
        cached.stop.store(true, Ordering::Release);
        drop(parked);
        let replay = fixture.cached(&cache, output_info, 0.0);
        assert!(!Arc::ptr_eq(&cached, &progressive_timeline(&replay)));
    }

    #[test]
    fn every_audio_change_renders_fresh_and_visual_changes_reuse() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let audio_edits: [(&str, FixtureEdit); 11] = [
            ("mic volume", |f| f.project.audio.mic_volume_db = -6.0),
            ("system volume", |f| f.project.audio.system_volume_db = -6.0),
            ("mute", |f| f.project.audio.mute = true),
            ("stereo mode", |f| {
                f.project.audio.mic_stereo_mode = cap_project::StereoMode::MonoL;
                f.project.audio.mic_volume_db = -1.0;
            }),
            ("clip volume", |f| {
                f.timeline().segments[0].volume = Some(0.25)
            }),
            ("muted speed", |f| {
                let segment = &mut f.timeline().segments[1];
                segment.timescale = 1.5;
                segment.speed_audio_mode = Some(ClipSpeedAudioMode::Mute);
            }),
            ("trim", |f| f.timeline().segments[2].end = 7.0),
            ("clip offset", |f| f.project.clips[0].offsets.mic = 0.2),
            ("music volume", |f| {
                f.timeline().audio_segments[0].volume_db = -9.0
            }),
            ("music", |f| {
                let path = f.music_path.clone();
                f.timeline()
                    .audio_segments
                    .push(music_track_segment(&path, 5.0, 6.0, 0.0, 0.0))
            }),
            ("split", |f| {
                let timeline = f.timeline();
                let mut second = timeline.segments[0].clone();
                timeline.segments[0].end = 1.5;
                second.start = 1.5;
                timeline.segments.insert(1, second);
            }),
        ];
        let visual_edits: [(&str, FixtureEdit); 4] = [
            ("zoom", |f| {
                f.timeline().zoom_segments = vec![cap_project::ZoomSegment {
                    start: 1.0,
                    end: 2.0,
                    amount: 2.0,
                    mode: cap_project::ZoomMode::Auto,
                    glide_direction: Default::default(),
                    glide_speed: 1.0,
                    instant_animation: false,
                    edge_snap_ratio: 0.1,
                }]
            }),
            ("motion blur", |f| f.project.screen_motion_blur = 0.9),
            ("clip name", |f| {
                f.timeline().segments[0].name = Some("Intro".into())
            }),
            ("hide cursor", |f| {
                f.timeline().segments[0].hide_cursor = Some(true)
            }),
        ];
        let output_info = stereo_48k();

        for (name, edit) in audio_edits.into_iter().chain(stateful_edits()) {
            let mut fixture = ProgressiveFixture::new();
            let cache = PlaybackAudioCache::default();
            let mut before = fixture.cached(&cache, output_info, 0.0);
            let before_audio = read_everything(&mut before);
            let before_timeline = progressive_timeline(&before);
            drop(before);
            edit(&mut fixture);
            let mut after = fixture.cached(&cache, output_info, 0.0);
            assert!(
                !Arc::ptr_eq(&before_timeline, &progressive_timeline(&after)),
                "{name} must not reuse the cached render"
            );
            let after_audio = read_everything(&mut after);
            assert_bit_identical(&after_audio, &fixture.reference(output_info, 0.0), name);
            assert!(
                name == "split"
                    || before_audio.len() != after_audio.len()
                    || before_audio
                        .iter()
                        .zip(&after_audio)
                        .any(|(a, b)| a.to_bits() != b.to_bits()),
                "{name} must change the rendered audio"
            );
        }

        for (name, edit) in visual_edits {
            let mut fixture = ProgressiveFixture::new();
            let cache = PlaybackAudioCache::default();
            let before = fixture.cached(&cache, output_info, 0.0);
            before.wait_until_fully_rendered();
            let before_timeline = progressive_timeline(&before);
            drop(before);
            edit(&mut fixture);
            let after = fixture.cached(&cache, output_info, 0.0);
            assert!(
                Arc::ptr_eq(&before_timeline, &progressive_timeline(&after)),
                "{name} must reuse the cached render"
            );
        }
    }

    #[test]
    fn a_stale_render_is_released_once_the_next_render_finishes() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let mut fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        let within = std::time::Duration::from_secs(10);

        let cache = PlaybackAudioCache::default();
        let mut playing = fixture.cached(&cache, output_info, 0.0);
        read_everything(&mut playing);
        let stale = Arc::downgrade(&progressive_timeline(&playing));
        drop(playing);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(stale.strong_count() > 0, "a paused render stays cached");

        fixture.project.audio.mic_volume_db = -12.0;
        let mut edited = fixture.cached(&cache, output_info, 2.0);
        let fresh = progressive_timeline(&edited);
        assert!(!Arc::ptr_eq(&fresh, &stale.upgrade().unwrap()));
        edited.set_playhead(2.0);
        assert!(edited.wait_until_ready(std::time::Duration::from_secs(30)));
        wait_until_released(stale, within);
        assert!(
            lock(&cache.entry)
                .as_ref()
                .is_some_and(|cached| Arc::ptr_eq(&cached.render.timeline, &fresh))
        );
        drop(fresh);
        read_everything(&mut edited);
        let kept = Arc::downgrade(&progressive_timeline(&edited));
        drop(edited);

        fixture.project.audio.improve = true;
        let mut stateful = fixture.cached(&cache, output_info, 2.0);
        stateful.set_playhead(2.0);
        assert!(stateful.wait_until_ready(std::time::Duration::from_secs(30)));
        wait_until_released(kept, within);
        assert!(lock(&cache.entry).is_none());
        drop(stateful);

        fixture.project.audio.improve = false;
        let closed = fixture.cached(&cache, output_info, 0.0);
        let timeline = Arc::downgrade(&progressive_timeline(&closed));
        drop(closed);
        drop(cache);
        wait_until_released(timeline, within);
    }

    #[test]
    fn cache_key_changes_with_every_audio_input_and_ignores_visual_fields() {
        let fixture = ProgressiveFixture::new();
        let original = audio_project_key(&fixture.project).unwrap();
        let key = |edit: FixtureEdit| {
            let mut edited = ProgressiveFixture::new();
            edited.project = fixture.project.clone();
            edit(&mut edited);
            audio_project_key(&edited.project).unwrap()
        };

        let audio: [(&str, FixtureEdit); 9] = [
            ("audio", |f| f.project.audio.system_volume_db = -3.0),
            ("clip offsets", |f| {
                f.project.clips[0].offsets.system_audio = 0.1
            }),
            ("segment", |f| f.timeline().segments[0].end = 2.5),
            ("segment volume", |f| {
                f.timeline().segments[0].volume = Some(0.8)
            }),
            ("speed mode", |f| {
                f.timeline().segments[0].speed_audio_mode = Some(ClipSpeedAudioMode::Mute)
            }),
            ("music", |f| f.timeline().audio_segments[0].fade_in = 0.1),
            ("transition", |f| {
                f.timeline().transitions = vec![ClipTransition {
                    segment_index: 1,
                    kind: ClipTransitionType::CrossFade,
                    duration: 0.25,
                }]
            }),
            ("text hold", stateful_edits()[3].1),
            ("no timeline", |f| f.project.timeline = None),
        ];
        for (name, edit) in audio {
            assert_ne!(key(edit), original, "{name} must change the key");
        }

        let visual: [(&str, FixtureEdit); 6] = [
            ("background", |f| f.project.background.padding = 12.5),
            ("cursor", |f| f.project.cursor.size = 150),
            ("motion blur", |f| f.project.screen_motion_blur = 0.9),
            ("clip name", |f| {
                f.timeline().segments[0].name = Some("Intro".into())
            }),
            ("hide cursor", |f| {
                f.timeline().segments[0].hide_cursor = Some(true)
            }),
            ("overlay text", |f| {
                let mut text: cap_project::TextSegment =
                    serde_json::from_value(serde_json::json!({ "start": 2.0, "end": 3.0 }))
                        .unwrap();
                text.enabled = true;
                f.timeline().text_segments = vec![text];
            }),
        ];
        for (name, edit) in visual {
            assert_eq!(key(edit), original, "{name} must keep the key");
        }
    }

    #[test]
    fn a_replay_resumes_a_parked_render() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        for _ in 0..20 {
            let cache = PlaybackAudioCache::default();
            let mut first = fixture.cached(&cache, output_info, 0.0);
            first.set_playhead(0.0);
            assert!(first.wait_until_ready(std::time::Duration::from_secs(30)));
            let timeline = progressive_timeline(&first);
            drop(first);
            let mut replay = fixture.cached(&cache, output_info, 0.0);
            assert!(Arc::ptr_eq(&timeline, &progressive_timeline(&replay)));
            assert_bit_identical(
                &read_everything(&mut replay),
                &fixture.reference(output_info, 0.0),
                "resumed render",
            );
        }
    }

    #[test]
    fn idle_pause_releases_the_cached_render() {
        let _reuse = CACHE_RELEASE.read().unwrap_or_else(PoisonError::into_inner);
        let fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        let idle = std::time::Duration::from_millis(300);

        for complete in [true, false] {
            let cache = PlaybackAudioCache::with_idle_release(idle);
            let mut playing = fixture.cached(&cache, output_info, 0.0);
            if complete {
                read_everything(&mut playing);
            }
            std::thread::sleep(idle * 2);
            assert!(
                lock(&cache.entry).is_some(),
                "a playing render must stay cached"
            );
            let timeline = Arc::downgrade(&progressive_timeline(&playing));
            let paused = std::time::Instant::now();
            drop(playing);
            wait_until_released(timeline, std::time::Duration::from_secs(10));
            assert!(paused.elapsed() >= idle);
            assert!(lock(&cache.entry).is_none());
        }
    }

    #[test]
    fn export_and_memory_pressure_release_every_cached_render() {
        let _release = CACHE_RELEASE
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        let fixture = ProgressiveFixture::new();
        let output_info = stereo_48k();
        type Release = fn();
        let releases: Vec<(&str, Release)> = vec![
            ("export", release_playback_audio_caches),
            #[cfg(target_os = "macos")]
            ("memory pressure", || {
                memory_pressure::on_memory_pressure(std::ptr::null_mut())
            }),
        ];
        for (name, release) in releases {
            let caches = [PlaybackAudioCache::default(), PlaybackAudioCache::default()];
            let timelines = caches
                .iter()
                .map(|cache| {
                    let paused = fixture.cached(cache, output_info, 0.0);
                    Arc::downgrade(&progressive_timeline(&paused))
                })
                .collect::<Vec<_>>();
            assert!(
                caches.iter().all(|cache| lock(&cache.entry).is_some()),
                "{name}"
            );
            release();
            for timeline in timelines {
                wait_until_released(timeline, std::time::Duration::from_secs(10));
            }
            assert!(
                caches.iter().all(|cache| lock(&cache.entry).is_none()),
                "{name}"
            );
        }
    }
}
