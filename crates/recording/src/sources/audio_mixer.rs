use cap_media_info::AudioInfo;
use cap_timestamp::{Timestamp, Timestamps};
use futures::channel::{mpsc, oneshot};
#[cfg(not(any(target_os = "macos", windows)))]
use std::time::Instant;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tracing::{debug, info};

use crate::output_pipeline::AudioFrame;

const DEFAULT_BUFFER_TIMEOUT: Duration = Duration::from_millis(80);
const MIN_BUFFER_TIMEOUT: Duration = Duration::from_millis(20);
const MAX_BUFFER_TIMEOUT: Duration = Duration::from_millis(180);
const BUFFER_TIMEOUT_HEADROOM: f64 = 2.0;

// Wait TICK_MS for frames to arrive
// Assume all sources' frames for that tick have arrived after TICK_MS
// Insert silence where necessary for sources with no frames
//
// Current problem is generating an output timestamp that lines up with the input's timestamp

struct MixerSource {
    rx: mpsc::Receiver<AudioFrame>,
    info: AudioInfo,
    buffer_timeout: Duration,
    buffer: VecDeque<AudioFrame>,
    buffer_last: Option<(Timestamp, Duration)>,
}

pub struct AudioMixerBuilder {
    sources: Vec<MixerSource>,
}

impl Default for AudioMixerBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioMixerBuilder {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
        }
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn add_source(&mut self, info: AudioInfo, rx: mpsc::Receiver<AudioFrame>) {
        let buffer_timeout = buffer_timeout_for(&info);

        self.sources.push(MixerSource {
            info,
            rx,
            buffer_timeout,
            buffer: VecDeque::new(),
            buffer_last: None,
        });
    }

    pub fn build(self, output: mpsc::Sender<AudioFrame>) -> Result<AudioMixer, ffmpeg::Error> {
        let mut filter_graph = ffmpeg::filter::Graph::new();

        let mut abuffers = Vec::new();
        let mut resamplers = Vec::new();

        let target_info = AudioMixer::INFO;
        let target_rate = target_info.rate();
        let target_sample_fmt = target_info.sample_format.name();
        let target_channel_layout_bits = target_info.channel_layout().bits();

        for (i, source) in self.sources.iter().enumerate() {
            let info = &source.info;
            let args = format!(
                "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
                info.time_base,
                info.rate(),
                info.sample_format.name(),
                info.channel_layout().bits()
            );

            debug!("audio mixer input {i}: {args}");

            let mut abuffer = filter_graph.add(
                &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
                &format!("src{i}"),
                &args,
            )?;

            let mut resample = filter_graph.add(
                &ffmpeg::filter::find("aresample").expect("Failed to find aresample filter"),
                &format!("resample{i}"),
                &format!(
                    "out_sample_rate={target_rate}:out_sample_fmt={target_sample_fmt}:out_chlayout=0x{target_channel_layout_bits:x}"
                ),
            )?;

            abuffer.link(0, &mut resample, 0);

            abuffers.push(abuffer);
            resamplers.push(resample);
        }

        let mut amix = filter_graph.add(
            &ffmpeg::filter::find("amix").expect("Failed to find amix filter"),
            "amix",
            &format!("inputs={}:duration=longest", abuffers.len()),
        )?;

        let aformat_args = format!(
            "sample_fmts={target_sample_fmt}:sample_rates={target_rate}:channel_layouts=0x{target_channel_layout_bits:x}"
        );

        let mut aformat = filter_graph.add(
            &ffmpeg::filter::find("aformat").expect("Failed to find aformat filter"),
            "aformat",
            &aformat_args,
        )?;

        let mut abuffersink = filter_graph.add(
            &ffmpeg::filter::find("abuffersink").expect("Failed to find abuffersink filter"),
            "sink",
            "",
        )?;

        for (i, resample) in resamplers.iter_mut().enumerate() {
            resample.link(0, &mut amix, i as u32);
        }

        amix.link(0, &mut aformat, 0);
        aformat.link(0, &mut abuffersink, 0);

        filter_graph.validate()?;

        let max_buffer_timeout = self
            .sources
            .iter()
            .map(|source| source.buffer_timeout)
            .max()
            .unwrap_or(DEFAULT_BUFFER_TIMEOUT);

        Ok(AudioMixer {
            sources: self.sources,
            samples_out: 0,
            last_tick: None,
            abuffers,
            abuffersink,
            output,
            _resamplers: resamplers,
            _filter_graph: filter_graph,
            _amix: amix,
            _aformat: aformat,
            start_timestamp: None,
            timestamps: Timestamps::now(),
            max_buffer_timeout,
        })
    }

    pub fn run(
        self,
        output: mpsc::Sender<AudioFrame>,
        ready_tx: oneshot::Sender<anyhow::Result<()>>,
        stop_flag: Arc<AtomicBool>,
    ) {
        let start = Timestamps::now();

        let mut mixer = match self.build(output) {
            Ok(mixer) => mixer,
            Err(e) => {
                tracing::error!("Failed to build audio mixer: {}", e);
                let _ = ready_tx.send(Err(e.into()));
                return;
            }
        };

        let _ = ready_tx.send(Ok(()));

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                info!("Mixer stop flag triggered");
                break;
            }

            #[cfg(target_os = "macos")]
            let now = Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::now());
            #[cfg(windows)]
            let now =
                Timestamp::PerformanceCounter(cap_timestamp::PerformanceCounterTimestamp::now());
            #[cfg(not(any(target_os = "macos", windows)))]
            let now = Timestamp::Instant(Instant::now());

            if let Err(()) = mixer.tick(start, now) {
                info!("Mixer tick errored");
                break;
            }

            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

pub struct AudioMixer {
    sources: Vec<MixerSource>,
    samples_out: usize,
    output: mpsc::Sender<AudioFrame>,
    last_tick: Option<Timestamp>,
    // sample_timestamps: VecDeque<(usize, Timestamp)>,
    abuffers: Vec<ffmpeg::filter::Context>,
    abuffersink: ffmpeg::filter::Context,
    _resamplers: Vec<ffmpeg::filter::Context>,
    _filter_graph: ffmpeg::filter::Graph,
    _amix: ffmpeg::filter::Context,
    _aformat: ffmpeg::filter::Context,
    timestamps: Timestamps,
    start_timestamp: Option<Timestamp>,
    max_buffer_timeout: Duration,
}

impl AudioMixer {
    pub const INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::F32(cap_media_info::Type::Packed),
        48_000,
        2,
    );

    fn buffer_sources(&mut self, now: Timestamp) {
        for source in &mut self.sources {
            let rate = source.info.rate();
            let _buffer_timeout = source.buffer_timeout;

            // Do not inject silence based on wall-clock pacing. We only bridge actual gaps
            // when a new frame arrives (below), to keep emission data-driven.

            while let Ok(Some(AudioFrame {
                inner: frame,
                timestamp,
            })) = source.rx.try_next()
            {
                // if gap between incoming and last, insert silence
                if let Some((buffer_last_timestamp, buffer_last_duration)) = source.buffer_last {
                    let timestamp_elapsed = timestamp.duration_since(self.timestamps);
                    let buffer_last_elapsed = buffer_last_timestamp.duration_since(self.timestamps);

                    if timestamp_elapsed > buffer_last_elapsed {
                        let elapsed_since_last_frame =
                            timestamp_elapsed.saturating_sub(buffer_last_elapsed);

                        if let Some(diff) =
                            elapsed_since_last_frame.checked_sub(buffer_last_duration)
                        {
                            let min_gap = if buffer_last_duration.is_zero() {
                                Duration::from_micros(1)
                            } else {
                                buffer_last_duration
                            };

                            if diff >= min_gap {
                                let gap = diff;

                                debug!(?gap, "Gap between last buffer frame, inserting silence");

                                let silence_samples_needed = (gap.as_secs_f64()) * rate as f64;
                                let silence_samples_count = silence_samples_needed.ceil() as usize;

                                let mut frame = ffmpeg::frame::Audio::new(
                                    source.info.sample_format,
                                    silence_samples_count,
                                    source.info.channel_layout(),
                                );

                                for i in 0..frame.planes() {
                                    frame.data_mut(i).fill(0);
                                }

                                frame.set_rate(source.info.rate() as u32);

                                let silence_duration = Duration::from_secs_f64(
                                    silence_samples_count as f64 / rate as f64,
                                );
                                let timestamp = buffer_last_timestamp + buffer_last_duration;
                                source.buffer_last = Some((timestamp, silence_duration));
                                source.buffer.push_back(AudioFrame::new(frame, timestamp));
                            }
                        }
                    }
                }

                source.buffer_last = Some((
                    timestamp,
                    Duration::from_secs_f64(frame.samples() as f64 / rate as f64),
                ));
                source.buffer.push_back(AudioFrame::new(frame, timestamp));
            }
        }

        if self.start_timestamp.is_none() {
            self.start_timestamp = self
                .sources
                .iter()
                .filter_map(|s| s.buffer.front())
                .min_by(|a, b| {
                    a.timestamp
                        .duration_since(self.timestamps)
                        .cmp(&b.timestamp.duration_since(self.timestamps))
                })
                .map(|v| v.timestamp);
        }

        if let Some(start_timestamp) = self.start_timestamp
            && let Some(elapsed_since_start) = now
                .duration_since(self.timestamps)
                .checked_sub(start_timestamp.duration_since(self.timestamps))
            && elapsed_since_start > self.max_buffer_timeout
        {
            for source in &mut self.sources {
                if source.buffer_last.is_none() {
                    let rate = source.info.rate();
                    let buffer_timeout = source.buffer_timeout;

                    let mut remaining = elapsed_since_start;
                    while remaining > buffer_timeout {
                        let chunk_samples = samples_for_timeout(rate, buffer_timeout);
                        let frame_duration = duration_from_samples(chunk_samples, rate);

                        let mut frame = ffmpeg::frame::Audio::new(
                            source.info.sample_format,
                            chunk_samples,
                            source.info.channel_layout(),
                        );

                        for i in 0..frame.planes() {
                            frame.data_mut(i).fill(0);
                        }

                        frame.set_rate(source.info.rate() as u32);

                        let timestamp =
                            start_timestamp + elapsed_since_start.saturating_sub(remaining);
                        source.buffer_last = Some((timestamp, frame_duration));
                        source.buffer.push_front(AudioFrame::new(frame, timestamp));

                        if frame_duration.is_zero() {
                            break;
                        }

                        remaining = remaining.saturating_sub(frame_duration);
                    }
                }
            }
        }
    }

    fn tick(&mut self, _start: Timestamps, now: Timestamp) -> Result<(), ()> {
        self.buffer_sources(now);

        let Some(start_timestamp) = self.start_timestamp else {
            return Ok(());
        };

        for (i, source) in self.sources.iter_mut().enumerate() {
            for buffer in source.buffer.drain(..) {
                let _ = self.abuffers[i].source().add(&buffer.inner);
            }
        }

        let mut filtered = ffmpeg::frame::Audio::empty();
        while self.abuffersink.sink().frame(&mut filtered).is_ok() {
            let output_rate_i32 = Self::INFO.rate();
            let output_rate = output_rate_i32 as f64;

            // Downstream encoders assume the mixer outputs at AudioMixer::INFO.rate().
            // Normalize the frame metadata so we don't inherit whatever FFmpeg propagated
            // from upstream sources (some CoreAudio devices report 16 kHz).
            filtered.set_rate(output_rate_i32 as u32);

            let elapsed = Duration::from_secs_f64(self.samples_out as f64 / output_rate);
            let output_timestamp = start_timestamp + elapsed;

            let frame_samples = filtered.samples();
            let mut frame = AudioFrame::new(filtered, output_timestamp);

            loop {
                match self.output.try_send(frame) {
                    Ok(()) => break,
                    Err(err) if err.is_full() => {
                        frame = err.into_inner();
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }

            self.samples_out += frame_samples;
            filtered = ffmpeg::frame::Audio::empty();
        }

        self.last_tick = Some(now);

        Ok(())
    }

    pub fn builder() -> AudioMixerBuilder {
        AudioMixerBuilder::new()
    }
}

fn buffer_timeout_for(info: &AudioInfo) -> Duration {
    if info.sample_rate == 0 || info.buffer_size == 0 {
        return DEFAULT_BUFFER_TIMEOUT;
    }

    let base = Duration::from_secs_f64(info.buffer_size as f64 / info.sample_rate as f64);

    if base.is_zero() {
        return DEFAULT_BUFFER_TIMEOUT;
    }

    let with_headroom = base.mul_f64(BUFFER_TIMEOUT_HEADROOM);

    clamp_duration(with_headroom, MIN_BUFFER_TIMEOUT, MAX_BUFFER_TIMEOUT)
}

fn clamp_duration(value: Duration, min: Duration, max: Duration) -> Duration {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn samples_for_timeout(rate: i32, timeout: Duration) -> usize {
    if rate <= 0 {
        return 1;
    }

    let samples = (timeout.as_secs_f64() * rate as f64).round();
    samples.max(1.0) as usize
}

fn duration_from_samples(samples: usize, rate: i32) -> Duration {
    if rate <= 0 {
        return Duration::ZERO;
    }

    Duration::from_secs_f64(samples as f64 / rate as f64)
}

#[cfg(test)]
mod test {
    use futures::{SinkExt, StreamExt};

    use super::*;

    const SAMPLE_RATE: u32 = 48_000;
    const SOURCE_INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::U8(cap_media_info::Type::Packed),
        SAMPLE_RATE,
        1,
    );
    const ONE_SECOND: Duration = Duration::from_secs(1);
    const SAMPLES_SECOND: usize = SOURCE_INFO.rate() as usize;

    #[tokio::test]
    async fn mix_sources() {
        let (tx, mut output_rx) = mpsc::channel(4);
        let mut mixer = AudioMixerBuilder::new();

        let (mut tx1, rx) = mpsc::channel(4);
        mixer.add_source(SOURCE_INFO, rx);

        let (mut tx2, rx) = mpsc::channel(4);
        mixer.add_source(SOURCE_INFO, rx);

        let mut mixer = mixer.build(tx).unwrap();
        let start = mixer.timestamps;

        tx1.send(AudioFrame::new(
            SOURCE_INFO.wrap_frame(&[128, 255, 255, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .await
        .unwrap();
        tx2.send(AudioFrame::new(
            SOURCE_INFO.wrap_frame(&[128, 128, 1, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .await
        .unwrap();

        let _ = mixer.tick(
            start,
            Timestamp::Instant(start.instant() + Duration::from_secs_f64(4.0 / SAMPLE_RATE as f64)),
        );

        let frame = output_rx.next().await.expect("No output frame");

        let byte_count = frame.samples() * frame.channels() as usize;
        let samples: &[f32] = unsafe { std::mem::transmute(&frame.data(0)[0..byte_count]) };

        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[0], samples[1]);

        assert_eq!(samples[4], 0.0);
        assert_eq!(samples[4], samples[5]);
    }

    mod source_buffer {
        use super::*;

        #[tokio::test]
        async fn single_frame() {
            let (output_tx, _) = mpsc::channel::<AudioFrame>(4);
            let mut mixer = AudioMixerBuilder::new();
            let start = Timestamps::now();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            assert_eq!(mixer.sources[0].buffer.len(), 1);
            assert!(mixer.sources[0].rx.try_next().is_err());
        }

        #[tokio::test]
        async fn frame_gap() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant()),
            ))
            .await
            .unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant() + ONE_SECOND),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(mixer.timestamps.instant()));

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 3);
            assert!(source.rx.try_next().is_err());

            assert_eq!(
                source.buffer[1].timestamp.duration_since(mixer.timestamps),
                ONE_SECOND / 2
            );
            assert_eq!(source.buffer[1].samples(), SOURCE_INFO.rate() as usize / 2);
        }

        #[tokio::test]
        async fn start_gap() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();
            let start = mixer.timestamps;

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND / 2),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 1);
            assert!(source.rx.try_next().is_err());

            assert_eq!(
                source.buffer[0].timestamp.duration_since(start),
                ONE_SECOND / 2
            );
            assert_eq!(source.buffer[0].samples(), SOURCE_INFO.rate() as usize / 2);
        }

        #[tokio::test]
        async fn after_draining() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();
            let start = mixer.timestamps;

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            mixer.sources[0].buffer.clear();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND));

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 2);
            assert!(source.rx.try_next().is_err());

            let item = &source.buffer[0];
            assert_eq!(item.timestamp.duration_since(start), ONE_SECOND / 2);
            assert_eq!(item.inner.samples(), SOURCE_INFO.rate() as usize / 2);

            let item = &source.buffer[1];
            assert_eq!(item.timestamp.duration_since(start), ONE_SECOND);
            assert_eq!(item.inner.samples(), SOURCE_INFO.rate() as usize / 2);
        }
    }
}
