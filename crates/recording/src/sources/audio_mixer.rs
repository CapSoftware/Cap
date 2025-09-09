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
    rx: Receiver<(ffmpeg::frame::Audio, Timestamp)>,
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
            rx,
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
        })
    }
}

pub struct AudioMixer {
    sources: Vec<MixerSource>,
    samples_out: usize,
    output: Sender<(ffmpeg::frame::Audio, Timestamp)>,
    last_tick: Option<Instant>,
    // sample_timestamps: VecDeque<(usize, Timestamp)>,
    abuffers: Vec<ffmpeg::filter::Context>,
    abuffersink: ffmpeg::filter::Context,
    _filter_graph: ffmpeg::filter::Graph,
    _amix: ffmpeg::filter::Context,
    _aformat: ffmpeg::filter::Context,
}

impl AudioMixer {
    pub const INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::F32(cap_media_info::Type::Packed),
        48_000,
        2,
    );
    pub const BUFFER_TIMEOUT: Duration = Duration::from_millis(10);

    fn buffer_sources(&mut self, start: Timestamps) {
        for source in &mut self.sources {
            let rate = source.info.rate();

            while let Ok((frame, timestamp)) = source.rx.try_recv() {
                // if gap between incoming and last, insert silence
                if let Some((buffer_last_timestamp, buffer_last_duration)) = source.buffer_last {
                    let timestamp_elapsed = timestamp.duration_since(start);
                    let buffer_last_elapsed = buffer_last_timestamp.duration_since(start);

                    if timestamp_elapsed > buffer_last_elapsed {
                        let elapsed_since_last_frame = timestamp_elapsed - buffer_last_elapsed;

                        if elapsed_since_last_frame < buffer_last_duration
                            && buffer_last_duration - elapsed_since_last_frame
                                >= Duration::from_millis(1)
                        {
                            let gap = (buffer_last_timestamp.duration_since(start)
                                + buffer_last_duration)
                                - timestamp.duration_since(start);

                            debug!("Gap between last buffer frame, inserting {gap:?} of silence");

                            let silence_samples_needed = (gap.as_secs_f64()) * rate as f64;
                            let silence_samples_count = silence_samples_needed.ceil() as usize;

                            let mut frame = ffmpeg::frame::Audio::new(
                                source.info.sample_format,
                                silence_samples_count,
                                source.info.channel_layout(),
                            );

                            frame.set_rate(source.info.rate() as u32);

                            source.buffer_last = Some((
                                &buffer_last_timestamp + gap,
                                Duration::from_secs_f64(silence_samples_count as f64 / rate as f64),
                            ));
                            source.buffer.push_back((frame, buffer_last_timestamp));
                        }
                    }
                } else {
                    let gap = timestamp.duration_since(start);

                    if !gap.is_zero() {
                        debug!("Gap from beginning of stream, inserting {gap:?} of silence");

                        // TODO: refactor to be one while loop

                        let gap_samples = gap.as_millis() as usize * rate as usize / 1000;
                        let chunk_size = rate as usize / 200;

                        let chunks = gap_samples as f64 / chunk_size as f64;

                        let chunk_duration =
                            Duration::from_secs_f64(chunk_size as f64 / rate as f64);
                        for i in 0..chunks.floor() as usize {
                            let mut frame = ffmpeg::frame::Audio::new(
                                source.info.sample_format,
                                chunk_size,
                                source.info.channel_layout(),
                            );

                            for i in 0..frame.planes() {
                                frame.data_mut(i).fill(0);
                            }

                            frame.set_rate(rate as u32);

                            let timestamp =
                                Timestamp::Instant(start.instant() + chunk_duration * i as u32);
                            source.buffer_last = Some((timestamp, chunk_duration));
                            source.buffer.push_back((frame, timestamp));
                        }

                        let leftover_chunk_size = (chunks.fract() * chunk_size as f64) as usize;

                        let mut frame = ffmpeg::frame::Audio::new(
                            source.info.sample_format,
                            leftover_chunk_size,
                            source.info.channel_layout(),
                        );

                        for i in 0..frame.planes() {
                            frame.data_mut(i).fill(0);
                        }

                        frame.set_rate(rate as u32);

                        let duration =
                            Duration::from_secs_f64(leftover_chunk_size as f64 / rate as f64);
                        let timestamp = Timestamp::Instant(
                            start.instant() + chunk_duration * chunks.floor() as u32 + duration,
                        );
                        source.buffer_last = Some((timestamp, duration));
                        source.buffer.push_back((frame, timestamp));
                    }
                }

                // dbg!(frame.samples());
                source.buffer_last = Some((
                    timestamp,
                    Duration::from_secs_f64(frame.samples() as f64 / frame.rate() as f64),
                ));
                source.buffer.push_back((frame, timestamp));
            }
        }
    }

    fn tick(&mut self, start: Timestamps, now: Instant) -> Result<(), ()> {
        self.buffer_sources(start);

        for (i, source) in self.sources.iter_mut().enumerate() {
            for buffer in source.buffer.drain(..) {
                let _ = self.abuffers[i].source().add(&buffer.0);
            }
        }

        let mut filtered = ffmpeg::frame::Audio::empty();
        while self.abuffersink.sink().frame(&mut filtered).is_ok() {
            let elapsed = Duration::from_secs_f64(self.samples_out as f64 / filtered.rate() as f64);
            let timestamp = start.instant() + elapsed;

            self.samples_out += filtered.samples();

            // dbg!(filtered.samples(), timestamp);

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

    pub fn run(&mut self) {
        let start = Timestamps::now();

        while let Ok(()) = self.tick(start, Instant::now()) {
            std::thread::sleep(Duration::from_millis(5));
        }
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
                .tick(start, Instant::now())
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
        let start = Timestamps::now();

        let (tx1, rx) = flume::bounded(4);
        mixer.add_source(SOURCE_INFO, rx);

        let (tx2, rx) = flume::bounded(4);
        mixer.add_source(SOURCE_INFO, rx);

        let mut mixer = mixer.build().unwrap();

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
            start.instant() + Duration::from_secs_f64(4.0 / SAMPLE_RATE as f64),
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

            mixer.buffer_sources(start);

            assert_eq!(mixer.sources[0].buffer.len(), 1);
            assert!(mixer.sources[0].rx.is_empty());
        }

        #[test]
        fn frame_gap() {
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

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .unwrap();

            mixer.buffer_sources(start);

            let source = &mixer.sources[0];

            assert_eq!(source.buffer.len(), 3);
            assert!(source.rx.is_empty());

            assert_eq!(source.buffer[1].1.duration_since(start), ONE_SECOND / 2);
            assert_eq!(
                source.buffer[1].0.samples(),
                SOURCE_INFO.rate() as usize / 2
            );
        }

        #[test]
        fn start_gap() {
            let (output_tx, _) = flume::bounded(4);
            let mut mixer = AudioMixerBuilder::new(output_tx);
            let start = Timestamps::now();

            let (tx, rx) = flume::bounded(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build().unwrap();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND / 2),
            ))
            .unwrap();

            mixer.buffer_sources(start);

            let source = &mixer.sources[0];

            assert_eq!(source.buffer.len(), 2);
            assert!(source.rx.is_empty());

            assert_eq!(source.buffer[0].1.duration_since(start), Duration::ZERO);
            assert_eq!(
                source.buffer[0].0.samples(),
                SOURCE_INFO.rate() as usize / 2
            );
        }

        #[test]
        fn after_draining() {
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

            mixer.buffer_sources(start);

            mixer.sources[0].buffer.clear();

            tx.send((
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .unwrap();

            mixer.buffer_sources(start);

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
