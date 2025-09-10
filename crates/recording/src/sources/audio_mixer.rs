use crate::pipeline::task::PipelineSourceTask;
use cap_media_info::AudioInfo;
use cap_timestamp::{Timestamp, Timestamps};
use flume::{Receiver, Sender};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use tracing::debug;

// Wait TICK_MS for frames to arrive
// Assume all sources' frames for that tick have arrived after TICK_MS
// Insert silence where necessary for sources with no frames
//
// Current problem is generating an output timestamp that lines up with the input's timestamp

struct MixerSource {
    rx: std::iter::Peekable<flume::IntoIter<(ffmpeg::frame::Audio, Timestamp)>>,
    info: AudioInfo,
    buffer: VecDeque<(ffmpeg::frame::Audio, Timestamp)>,
    buffer_last: Option<(Timestamp, Duration)>,
}

pub struct AudioMixerBuilder {
    sources: Vec<MixerSource>,
    output: Sender<(ffmpeg::frame::Audio, Timestamp)>,
}

impl AudioMixerBuilder {
    pub fn new(output: Sender<(ffmpeg::frame::Audio, Timestamp)>) -> Self {
        Self {
            sources: Vec::new(),
            output,
        }
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn add_source(&mut self, info: AudioInfo, rx: Receiver<(ffmpeg::frame::Audio, Timestamp)>) {
        self.sources.push(MixerSource {
            info,
            rx: rx.into_iter().peekable(),
            buffer: VecDeque::new(),
            buffer_last: None,
        });
    }

    pub fn build(self) -> Result<AudioMixer, ffmpeg::Error> {
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

        Ok(AudioMixer {
            sources: self.sources,
            samples_out: 0,
            output: self.output,
            last_tick: None,
            abuffers,
            abuffersink,
            _filter_graph: filter_graph,
            _amix: amix,
            _aformat: aformat,
            start_timestamp: None,
            timestamps: Timestamps::now(),
        })
    }
}

pub struct AudioMixer {
    sources: Vec<MixerSource>,
    samples_out: usize,
    output: Sender<(ffmpeg::frame::Audio, Timestamp)>,
    last_tick: Option<Timestamp>,
    // sample_timestamps: VecDeque<(usize, Timestamp)>,
    abuffers: Vec<ffmpeg::filter::Context>,
    abuffersink: ffmpeg::filter::Context,
    _filter_graph: ffmpeg::filter::Graph,
    _amix: ffmpeg::filter::Context,
    _aformat: ffmpeg::filter::Context,
    timestamps: Timestamps,
    start_timestamp: Option<Timestamp>,
}

impl AudioMixer {
    pub const INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::F32(cap_media_info::Type::Packed),
        48_000,
        2,
    );
    pub const BUFFER_TIMEOUT: Duration = Duration::from_millis(200);

    fn buffer_sources(&mut self, now: Timestamp) {
        for source in &mut self.sources {
            let rate = source.info.rate();

            if let Some(last) = source.buffer_last {
                let last_end = last.0 + last.1;
                if let Some(elapsed_since_last) = now
                    .duration_since(self.timestamps)
                    .checked_sub(last_end.duration_since(self.timestamps))
                {
                    let mut remaining = elapsed_since_last;
                    while remaining > Self::BUFFER_TIMEOUT {
                        let chunk_samples =
                            (Self::BUFFER_TIMEOUT.as_secs_f64() * rate as f64) as usize;

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
                        dbg!(timestamp);
                        source.buffer_last = Some((
                            timestamp,
                            Duration::from_secs_f64(chunk_samples as f64 / rate as f64),
                        ));
                        source.buffer.push_back((frame, timestamp));

                        remaining -= Self::BUFFER_TIMEOUT;
                    }
                }
            }

            while let Some((frame, timestamp)) = source.rx.next() {
                // if gap between incoming and last, insert silence
                if let Some((buffer_last_timestamp, buffer_last_duration)) = source.buffer_last {
                    let timestamp_elapsed = timestamp.duration_since(self.timestamps);
                    let buffer_last_elapsed = buffer_last_timestamp.duration_since(self.timestamps);

                    if timestamp_elapsed > buffer_last_elapsed {
                        let elapsed_since_last_frame = timestamp_elapsed - buffer_last_elapsed;

                        if let Some(diff) =
                            elapsed_since_last_frame.checked_sub(buffer_last_duration)
                            && diff >= Duration::from_millis(1)
                        {
                            let gap = diff;

                            print!("Gap between last buffer frame, inserting {gap:?} of silence");

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
                            dbg!(timestamp);
                            source.buffer_last = Some((
                                timestamp,
                                Duration::from_secs_f64(silence_samples_count as f64 / rate as f64),
                            ));
                            source.buffer.push_back((frame, timestamp));
                        }
                    }
                }

                source.buffer_last = Some((
                    timestamp,
                    Duration::from_secs_f64(frame.samples() as f64 / frame.rate() as f64),
                ));
                source.buffer.push_back((frame, timestamp));
            }
        }

        if self.start_timestamp.is_none() {
            self.start_timestamp = self
                .sources
                .iter()
                .filter_map(|s| s.buffer.get(0))
                .min_by(|a, b| {
                    a.1.duration_since(self.timestamps)
                        .cmp(&b.1.duration_since(self.timestamps))
                })
                .map(|v| v.1);
        }

        if let Some(start_timestamp) = self.start_timestamp {
            if let Some(elapsed_since_start) = now
                .duration_since(self.timestamps)
                .checked_sub(start_timestamp.duration_since(self.timestamps))
                && elapsed_since_start > Self::BUFFER_TIMEOUT
            {
                for source in &mut self.sources {
                    if source.buffer_last.is_none() {
                        let rate = source.info.rate();

                        let mut remaining = elapsed_since_start;
                        while remaining > Self::BUFFER_TIMEOUT {
                            let chunk_samples =
                                (Self::BUFFER_TIMEOUT.as_secs_f64() * rate as f64) as usize;

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
                            dbg!(timestamp);
                            source.buffer_last = Some((
                                timestamp,
                                Duration::from_secs_f64(chunk_samples as f64 / rate as f64),
                            ));
                            source.buffer.push_front((frame, timestamp));

                            remaining -= Self::BUFFER_TIMEOUT;
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
                let _ = self.abuffers[i].source().add(&buffer.0);
            }
        }

        let mut filtered = ffmpeg::frame::Audio::empty();
        while self.abuffersink.sink().frame(&mut filtered).is_ok() {
            let elapsed = Duration::from_secs_f64(self.samples_out as f64 / filtered.rate() as f64);
            let timestamp = start.instant() + start_timestamp.duration_since(start) + elapsed;

            self.samples_out += filtered.samples();

            if self
                .output
                .send((filtered, Timestamp::Instant(timestamp)))
                .is_err()
            {
                return Err(());
            }

            filtered = ffmpeg::frame::Audio::empty();
        }

        self.last_tick = Some(now);

        Ok(())
    }

    pub fn builder(output: Sender<(ffmpeg::frame::Audio, Timestamp)>) -> AudioMixerBuilder {
        AudioMixerBuilder::new(output)
    }
}

impl PipelineSourceTask for AudioMixerBuilder {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        let start = Timestamps::now();

        let this = std::mem::replace(self, AudioMixerBuilder::new(self.output.clone()));

        let mut mixer = this.build().map_err(|e| format!("BuildMixer: {e}"))?;

        let _ = ready_signal.send(Ok(()));

        loop {
            if control_signal
                .last()
                .map(|v| matches!(v, crate::pipeline::control::Control::Shutdown))
                .unwrap_or(false)
            {
                break;
            }

            mixer
                .tick(start, Timestamp::Instant(Instant::now()))
                .map_err(|()| format!("Audio mixer tick failed"))?;

            std::thread::sleep(Duration::from_millis(5));
        }

        Ok(())
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
