use cap_media_info::AudioInfo;
use cap_timestamp::{Timestamp, Timestamps};
use futures::channel::{mpsc, oneshot};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
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

        let mut abuffers = self
            .sources
            .iter()
            .enumerate()
            .map(|(i, source)| {
                let info = &source.info;
                let args = format!(
                    "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
                    info.time_base,
                    info.rate(),
                    info.sample_format.name(),
                    info.channel_layout().bits()
                );

                debug!("audio mixer input {i}: {args}");

                filter_graph.add(
                    &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
                    &format!("src{i}"),
                    &args,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut amix = filter_graph.add(
            &ffmpeg::filter::find("amix").expect("Failed to find amix filter"),
            "amix",
            &format!(
                "inputs={}:duration=first:dropout_transition=0",
                abuffers.len()
            ),
        )?;

        let aformat_args = "sample_fmts=flt:sample_rates=48000:channel_layouts=stereo";

        let mut aformat = filter_graph.add(
            &ffmpeg::filter::find("aformat").expect("Failed to find aformat filter"),
            "aformat",
            aformat_args,
        )?;

        let mut abuffersink = filter_graph.add(
            &ffmpeg::filter::find("abuffersink").expect("Failed to find abuffersink filter"),
            "sink",
            "",
        )?;

        for (i, abuffer) in abuffers.iter_mut().enumerate() {
            abuffer.link(0, &mut amix, i as u32);
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
            _filter_graph: filter_graph,
            _amix: amix,
            _aformat: aformat,
            start_timestamp: None,
            timestamps: Timestamps::now(),
            max_buffer_timeout,
        })
    }

    async fn spawn(self, output: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioMixerHandle> {
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();
        let stop_flag = Arc::new(AtomicBool::new(false));

        let thread_handle = std::thread::spawn({
            let stop_flag = stop_flag.clone();
            move || self.run(output, ready_tx, stop_flag)
        });

        ready_rx
            .await
            .map_err(|_| anyhow::format_err!("Audio mixer crashed"))??;

        info!("Audio mixer ready");

        Ok(AudioMixerHandle {
            thread_handle,
            stop_flag,
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

            if let Err(()) = mixer.tick(start, Timestamp::Instant(Instant::now())) {
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
            let buffer_timeout = source.buffer_timeout;

            if let Some(last) = source.buffer_last {
                let last_end = last.0 + last.1;
                if let Some(elapsed_since_last) = now
                    .duration_since(self.timestamps)
                    .checked_sub(last_end.duration_since(self.timestamps))
                {
                    let mut remaining = elapsed_since_last;

                    while remaining > buffer_timeout {
                        let chunk_samples = samples_for_timeout(rate, buffer_timeout);
                        let frame_duration = duration_from_samples(chunk_samples, rate);

                        let mut frame = ffmpeg::frame::Audio::new(
                            source.info.sample_format,
                            chunk_samples,
                            source.info.channel_layout(),
                        );
                        frame.set_rate(source.info.rate() as u32);

                        for i in 0..frame.planes() {
                            frame.data_mut(i).fill(0);
                        }

                        let timestamp = last_end + (elapsed_since_last - remaining);
                        source.buffer_last = Some((timestamp, frame_duration));
                        source.buffer.push_back(AudioFrame::new(frame, timestamp));

                        if frame_duration.is_zero() {
                            break;
                        }

                        remaining = remaining.saturating_sub(frame_duration);
                    }
                }
            }

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
                        let elapsed_since_last_frame = timestamp_elapsed - buffer_last_elapsed;

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

                                let timestamp = buffer_last_timestamp + gap;
                                source.buffer_last = Some((
                                    timestamp,
                                    Duration::from_secs_f64(
                                        silence_samples_count as f64 / rate as f64,
                                    ),
                                ));
                                source.buffer.push_back(AudioFrame::new(frame, timestamp));
                            }
                        }
                    }
                }

                source.buffer_last = Some((
                    timestamp,
                    Duration::from_secs_f64(frame.samples() as f64 / frame.rate() as f64),
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

        if let Some(start_timestamp) = self.start_timestamp {
            if let Some(elapsed_since_start) = now
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

                            let timestamp = start_timestamp + (elapsed_since_start - remaining);
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
    }

    fn tick(&mut self, start: Timestamps, now: Timestamp) -> Result<(), ()> {
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
            let elapsed = Duration::from_secs_f64(self.samples_out as f64 / filtered.rate() as f64);
            let timestamp = start.instant() + start_timestamp.duration_since(start) + elapsed;

            self.samples_out += filtered.samples();

            if self
                .output
                .try_send(AudioFrame::new(filtered, Timestamp::Instant(timestamp)))
                .is_err()
            {
                return Err(());
            }

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

pub struct AudioMixerHandle {
    thread_handle: std::thread::JoinHandle<()>,
    stop_flag: Arc<AtomicBool>,
}

impl AudioMixerHandle {
    pub fn new(thread_handle: std::thread::JoinHandle<()>, stop_flag: Arc<AtomicBool>) -> Self {
        Self {
            thread_handle,
            stop_flag,
        }
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}

impl Drop for AudioMixerHandle {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod test {
    use super::*;

    const SAMPLE_RATE: u32 = 48_000;
    const SOURCE_INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::U8(cap_media_info::Type::Packed),
        SAMPLE_RATE,
        1,
    );
    const ONE_SECOND: Duration = Duration::from_secs(1);
    const SAMPLES_SECOND: usize = SOURCE_INFO.rate() as usize;

    #[test]
    fn mix_sources() {
        let (tx, output_rx) = flume::bounded(4);
        let mut mixer = AudioMixerBuilder::new(tx);

        let (tx1, rx) = flume::bounded(4);
        mixer.add_source(SOURCE_INFO, rx);

        let (tx2, rx) = flume::bounded(4);
        mixer.add_source(SOURCE_INFO, rx);

        let mut mixer = mixer.build().unwrap();
        let start = mixer.timestamps;

        tx1.send((
            SOURCE_INFO.wrap_frame(&vec![128, 255, 255, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .unwrap();
        tx2.send((
            SOURCE_INFO.wrap_frame(&vec![128, 128, 1, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .unwrap();

        let _ = mixer.tick(
            start,
            Timestamp::Instant(start.instant() + Duration::from_secs_f64(4.0 / SAMPLE_RATE as f64)),
        );

        let (frame, _) = output_rx.recv().expect("No output frame");

        let byte_count = frame.samples() * frame.channels() as usize;
        let samples: &[f32] = unsafe { std::mem::transmute(&frame.data(0)[0..byte_count]) };

        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[0], samples[1]);

        assert_eq!(samples[4], 0.0);
        assert_eq!(samples[4], samples[5]);
    }

    mod source_buffer {
        use super::*;

        #[test]
        fn single_frame() {
            let (output_tx, _) = flume::bounded(4);
            let mut mixer = AudioMixerBuilder::new(output_tx);
            let start = Timestamps::now();

            let (tx, rx) = flume::bounded(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build().unwrap();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            assert_eq!(mixer.sources[0].buffer.len(), 1);
            assert!(mixer.sources[0].rx.is_empty());
        }

        #[test]
        fn frame_gap() {
            let (output_tx, _) = flume::bounded(4);
            let mut mixer = AudioMixerBuilder::new(output_tx);

            let (tx, rx) = flume::bounded(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build().unwrap();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant()),
            ))
            .unwrap();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant() + ONE_SECOND),
            ))
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(mixer.timestamps.instant()));

            let source = &mixer.sources[0];

            assert_eq!(source.buffer.len(), 3);
            assert!(source.rx.is_empty());

            assert_eq!(
                source.buffer[1].1.duration_since(mixer.timestamps),
                ONE_SECOND / 2
            );
            assert_eq!(
                source.buffer[1].0.samples(),
                SOURCE_INFO.rate() as usize / 2
            );
        }

        #[test]
        fn start_gap() {
            let (output_tx, _) = flume::bounded(4);
            let mut mixer = AudioMixerBuilder::new(output_tx);

            let (tx, rx) = flume::bounded(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build().unwrap();
            let start = mixer.timestamps;

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND / 2),
            ))
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            let source = &mixer.sources[0];

            assert_eq!(source.buffer.len(), 1);
            assert!(source.rx.is_empty());

            assert_eq!(source.buffer[0].1.duration_since(start), ONE_SECOND / 2);
            assert_eq!(
                source.buffer[0].0.samples(),
                SOURCE_INFO.rate() as usize / 2
            );
        }

        #[test]
        fn after_draining() {
            let (output_tx, _) = flume::bounded(4);
            let mut mixer = AudioMixerBuilder::new(output_tx);

            let (tx, rx) = flume::bounded(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build().unwrap();
            let start = mixer.timestamps;

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            mixer.sources[0].buffer.clear();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND));

            let source = &mixer.sources[0];

            assert_eq!(source.buffer.len(), 2);
            assert!(source.rx.is_empty());

            let item = &source.buffer[0];
            assert_eq!(item.1.duration_since(start), ONE_SECOND / 2);
            assert_eq!(item.0.samples(), SOURCE_INFO.rate() as usize / 2);

            let item = &source.buffer[1];
            assert_eq!(item.1.duration_since(start), ONE_SECOND);
            assert_eq!(item.0.samples(), SOURCE_INFO.rate() as usize / 2);
        }
    }
}
