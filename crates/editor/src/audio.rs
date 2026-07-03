use cap_audio::{
    AudioData, AudioRendererTrack, FromSampleBytes, StereoMode, cast_f32_slice_to_bytes,
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{AudioConfiguration, ClipOffsets, ProjectConfiguration, TimelineConfiguration};
use ffmpeg::{
    ChannelLayout, Dictionary, format as avformat, frame::Audio as FFAudio, software::resampling,
};
use ringbuf::{
    HeapRb,
    traits::{Consumer, Observer, Producer},
};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
    },
};
use tracing::info;

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
    data: Arc<AudioData>,
    get_gain: fn(&AudioConfiguration) -> f32,
    get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
    get_offset: fn(&ClipOffsets) -> f32,
    timing_offset_secs: f32,
}

impl AudioSegmentTrack {
    pub fn new(
        data: Arc<AudioData>,
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
        }
    }

    pub fn with_timing_offset_secs(mut self, timing_offset_secs: f32) -> Self {
        self.timing_offset_secs = timing_offset_secs;
        self
    }

    pub fn data(&self) -> &Arc<AudioData> {
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
}

struct TimelineCursor<'a> {
    segment_end_samples: usize,
    segment_time: f64,
    segment: &'a cap_project::TimelineSegment,
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
        }
    }

    pub fn with_music(mut self, music: MusicTracks) -> Self {
        self.music = music;
        self
    }

    pub fn set_playhead(&mut self, playhead: f64, project: &ProjectConfiguration) {
        self.elapsed_samples = self.playhead_to_samples(playhead);

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

    fn render_timeline_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
        timeline: &TimelineConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
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

            if cursor.segment.timescale == 1.0 {
                self.render_current_chunk(project, chunk_samples, written * 2, &mut ret);
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

        for segment in &timeline.segments {
            accumulated_duration += segment.duration();
            let segment_end_samples = self.playhead_to_samples(accumulated_duration);

            if self.elapsed_samples < segment_end_samples {
                let local_samples = self.elapsed_samples - segment_start_samples;
                let local_time = local_samples as f64 / Self::SAMPLE_RATE as f64;
                return Some(TimelineCursor {
                    segment_end_samples,
                    segment_time: segment.start + local_time * segment.timescale,
                    segment,
                });
            }

            segment_start_samples = segment_end_samples;
        }

        None
    }

    fn render_current_chunk(
        &self,
        project: &ProjectConfiguration,
        samples: usize,
        out_offset: usize,
        out: &mut [f32],
    ) -> usize {
        let Some(segment) = self.data.get(self.cursor.clip_index as usize) else {
            return 0;
        };
        let tracks = &segment.tracks;

        if tracks.is_empty() {
            return 0;
        }

        let offsets = project
            .clips
            .iter()
            .find(|c| c.index == self.cursor.clip_index)
            .map(|c| c.offsets)
            .unwrap_or_default();

        let max_samples = tracks
            .iter()
            .map(|t| {
                let track_offset_samples =
                    (t.offset(&offsets) * Self::SAMPLE_RATE as f32).round() as isize;
                let available = t.data().sample_count() as isize - track_offset_samples;
                available.max(0) as usize
            })
            .max()
            .unwrap_or(0);

        if self.cursor.samples >= max_samples {
            return 0;
        }

        let samples = samples.min(max_samples - self.cursor.samples);

        let track_datas = tracks
            .iter()
            .map(|t| AudioRendererTrack {
                data: t.data().as_ref(),
                gain: if project.audio.mute {
                    f32::NEG_INFINITY
                } else {
                    let g = t.gain(&project.audio);
                    if g < -30.0 { f32::NEG_INFINITY } else { g }
                },
                stereo_mode: t.stereo_mode(&project.audio),
                offset: (t.offset(&offsets) * Self::SAMPLE_RATE as f32).round() as isize,
            })
            .collect::<Vec<_>>();

        cap_audio::render_audio(&track_datas, self.cursor.samples, samples, out_offset, out)
    }
}

/// Below this volume a music track is treated as silent and skipped entirely.
const MUSIC_SILENCE_DB: f32 = -60.0;

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
            let src_index = trim_sample + local;
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

            let out_index = ((out_sample - frame_start) as usize) * 2;
            out[out_index] = (out[out_index] + l * g).clamp(-1.0, 1.0);
            out[out_index + 1] = (out[out_index + 1] + r * g).clamp(-1.0, 1.0);
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

        let mut options = Dictionary::new();
        options.set("filter_size", "128");
        options.set("cutoff", "0.97");

        let context = resampling::Context::get_with(
            AudioData::SAMPLE_FORMAT,
            ChannelLayout::STEREO,
            AudioData::SAMPLE_RATE,
            output_info.sample_format,
            output_info.channel_layout(),
            output_info.sample_rate,
            options,
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
}

impl ProgressiveTimeline {
    /// `AtomicU32` has the same size, alignment and bit validity as `u32`
    /// (documented guarantee), so a zeroed `u32` allocation — which the
    /// allocator can hand out as untouched zero pages, unlike constructing
    /// millions of atomics one by one — can be reinterpreted directly.
    fn allocate_samples(len: usize) -> Box<[AtomicU32]> {
        let raw = vec![0u32; len].into_boxed_slice();
        unsafe { Box::from_raw(Box::into_raw(raw) as *mut [AtomicU32]) }
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
    timeline: Arc<ProgressiveTimeline>,
    ready_rx: std::sync::mpsc::Receiver<()>,
    read_position: usize,
    sample_rate: u32,
    channels: usize,
    _format: std::marker::PhantomData<T>,
}

impl<T: FromSampleBytes> Drop for ProgressiveAudioBuffer<T> {
    fn drop(&mut self) {
        self.timeline.stop.store(true, Ordering::Release);
    }
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> PrerenderedAudioBuffer<T> {
    pub fn new(
        segments: Vec<AudioSegment>,
        music: MusicTracks,
        project: &ProjectConfiguration,
        output_info: AudioInfo,
        duration_secs: f64,
        start_playhead_secs: f64,
    ) -> Self {
        let output_info = output_info.for_ffmpeg_output();
        let estimated_output_samples = progressive_buffer_samples(
            duration_secs,
            output_info.sample_rate,
            output_info.channels,
        );
        let estimated_memory_bytes = progressive_buffer_bytes(estimated_output_samples);

        let mode = if estimated_memory_bytes <= MAX_PROGRESSIVE_BUFFER_BYTES {
            PrerenderedAudioBufferMode::Progressive(ProgressiveAudioBuffer::new(
                segments,
                music,
                project,
                output_info,
                duration_secs,
                start_playhead_secs,
                estimated_output_samples,
            ))
        } else {
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

    pub fn wait_until_ready(&self, timeout: std::time::Duration) {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.wait_until_ready(timeout),
            PrerenderedAudioBufferMode::Streaming(_) => {}
        }
    }

    #[cfg(test)]
    fn wait_until_fully_rendered(&self) {
        match &self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.wait_until_fully_rendered(),
            PrerenderedAudioBufferMode::Streaming(_) => {}
        }
    }

    pub fn set_playhead(&mut self, playhead_secs: f64) {
        match &mut self.mode {
            PrerenderedAudioBufferMode::Progressive(buffer) => buffer.set_playhead(playhead_secs),
            PrerenderedAudioBufferMode::Streaming(buffer) => buffer.set_playhead(playhead_secs),
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

        let pass1_start_secs = (start_playhead_secs - Self::START_PREROLL_SECS)
            .max(0.0)
            .min(duration_secs);
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
        let ready_window_samples = output_sample_index(
            Self::READY_WINDOW_SECS,
            output_info.sample_rate,
            output_info.channels,
            usize::MAX,
        );
        let ready_at_index = start_index.saturating_add(ready_window_samples);

        let timeline = Arc::new(ProgressiveTimeline {
            samples: ProgressiveTimeline::allocate_samples(estimated_output_samples),
            primary_start,
            primary_end: AtomicUsize::new(primary_start),
            wrap_end: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            complete: AtomicBool::new(false),
        });

        let (ready_tx, ready_rx) = std::sync::mpsc::channel();

        spawn_progressive_render(
            timeline.clone(),
            segments,
            music,
            project.clone(),
            render_info,
            duration_secs,
            pass1_start_secs,
            ready_at_index,
            ready_tx,
        );

        Self {
            timeline,
            ready_rx,
            read_position: 0,
            sample_rate: output_info.sample_rate,
            channels: output_info.channels,
            _format: std::marker::PhantomData,
        }
    }

    /// Blocks until the initial window around the start position is rendered
    /// (or the timeout elapses; unrendered reads are silence, never garbage).
    pub fn wait_until_ready(&self, timeout: std::time::Duration) {
        let _ = self.ready_rx.recv_timeout(timeout);
    }

    #[cfg(test)]
    fn wait_until_fully_rendered(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !self.timeline.complete.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "progressive audio render did not complete in time"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    pub fn set_playhead(&mut self, playhead_secs: f64) {
        let sample_position = (playhead_secs * self.sample_rate as f64) as usize * self.channels;
        self.read_position = sample_position.min(self.timeline.samples.len());
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
        let samples = &self.timeline.samples;
        let available = samples.len().saturating_sub(self.read_position);
        let to_copy = buffer.len().min(available);

        if to_copy > 0 {
            let primary_start = self.timeline.primary_start;
            let primary_end = self.timeline.primary_end.load(Ordering::Acquire);
            let wrap_end = self.timeline.wrap_end.load(Ordering::Acquire);

            for (i, slot) in buffer[..to_copy].iter_mut().enumerate() {
                let idx = self.read_position + i;
                let rendered = if idx >= primary_start {
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

struct StreamingAudioBuffer<T: FromSampleBytes> {
    renderer: AudioRenderer,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
    project: ProjectConfiguration,
    sample_rate: u32,
    channels: usize,
}

impl<T: FromSampleBytes> StreamingAudioBuffer<T> {
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
        self.renderer.set_playhead(playhead_secs, &self.project);
        self.prefill(self.ready_window_samples());
    }

    fn current_audible_playhead(&self, device_latency_secs: f64) -> f64 {
        let generated_secs = self.renderer.elapsed_samples_to_playhead();
        let buffered_frames = self.resampled_buffer.occupied_len() / self.channels;
        let buffered_secs = buffered_frames as f64 / self.sample_rate as f64;
        (generated_secs - buffered_secs - device_latency_secs.max(0.0)).max(0.0)
    }

    #[allow(dead_code)]
    fn current_playhead_secs(&self) -> f64 {
        self.renderer.elapsed_samples_to_playhead()
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
) {
    let spawn_result = std::thread::Builder::new()
        .name("cap-audio-prerender".into())
        .spawn(move || {
            let render_start = std::time::Instant::now();
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
                    if timeline.stop.load(Ordering::Acquire) {
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
                pass1_start_secs,
                pass1_source_start,
                total_source_samples,
                timeline.primary_start,
                buffer_len,
                &timeline.primary_end,
                Some(ready_at_index),
                &mut ready_sent,
            );

            // Pass 2: wrap around to cover [0, playhead) for backwards seeks.
            let pass2_ok = if pass1_ok && pass1_source_start > 0 {
                render_pass(
                    &mut renderer,
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

            if pass1_ok && pass2_ok {
                timeline.complete.store(true, Ordering::Release);
                info!(
                    total_samples = buffer_len,
                    memory_mb = (buffer_len * std::mem::size_of::<u32>()) / (1024 * 1024),
                    elapsed_ms = render_start.elapsed().as_millis() as u64,
                    "Progressive audio pre-render complete"
                );
            }
        });

    if let Err(e) = spawn_result {
        tracing::error!("Failed to spawn audio pre-render thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{
        ClipConfiguration, ProjectConfiguration, TimelineConfiguration, TimelineSegment,
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

    fn mean_abs(samples: &[f32]) -> f32 {
        samples.iter().map(|sample| sample.abs()).sum::<f32>() / samples.len() as f32
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
                    },
                    TimelineSegment {
                        recording_clip: 0,
                        timescale: 4.0,
                        start: 1.0,
                        end: 2.0,
                        name: None,
                    },
                    TimelineSegment {
                        recording_clip: 0,
                        timescale: 1.0,
                        start: 2.0,
                        end: 3.0,
                        name: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 1.0,
                        start: 0.0,
                        end: 1.0,
                        name: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 2.0,
                        start: 1.0,
                        end: 2.0,
                        name: None,
                    },
                    TimelineSegment {
                        recording_clip: 1,
                        timescale: 1.0,
                        start: 2.0,
                        end: 3.0,
                        name: None,
                    },
                ],
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            }),
            clips: vec![
                ClipConfiguration {
                    index: 0,
                    offsets: Default::default(),
                },
                ClipConfiguration {
                    index: 1,
                    offsets: Default::default(),
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
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                offsets: Default::default(),
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
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                offsets: Default::default(),
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
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                offsets: Default::default(),
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
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments,
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                offsets: Default::default(),
            }],
            ..Default::default()
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
}
