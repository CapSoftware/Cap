use std::time::Duration;

use flume::{Receiver, Sender};
use tracing::warn;

use crate::{
    data::{AudioInfo, FFAudio},
    pipeline::{
        control::PipelineControlSignal,
        task::{PipelineSinkTask, PipelineSourceTask},
        RawNanoseconds, RealTimeClock,
    },
};

pub struct AudioMixer {
    sources: Vec<AudioMixerSource>,
    output: Sender<FFAudio>,
}

impl AudioMixer {
    pub fn new(output: Sender<FFAudio>) -> Self {
        Self {
            sources: Vec::new(),
            output,
        }
    }

    pub fn sink(&mut self, info: AudioInfo) -> AudioMixerSink {
        let (tx, rx) = flume::bounded(32);

        self.sources.push(AudioMixerSource { rx, info });

        AudioMixerSink { tx }
    }

    pub fn add_source(&mut self, info: AudioInfo, rx: Receiver<FFAudio>) {
        self.sources.push(AudioMixerSource { rx, info })
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48000,
            2,
        )
        .unwrap()
    }

    pub fn run(&mut self, mut get_is_stopped: impl FnMut() -> bool, on_ready: impl FnOnce() -> ()) {
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

                filter_graph
                    .add(
                        &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
                        &format!("src{i}"),
                        &args,
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();

        let mut amix = filter_graph
            .add(
                &ffmpeg::filter::find("amix").expect("Failed to find amix filter"),
                "amix",
                &format!(
                    "inputs={}:duration=first:dropout_transition=0",
                    abuffers.len()
                ),
            )
            .unwrap();

        let mut aformat = filter_graph
            .add(
                &ffmpeg::filter::find("aformat").expect("Failed to find aformat filter"),
                "aformat",
                "sample_fmts=flt:sample_rates=48000:channel_layouts=stereo",
            )
            .expect("Failed to add aformat filter");

        let mut abuffersink = filter_graph
            .add(
                &ffmpeg::filter::find("abuffersink").expect("Failed to find abuffersink filter"),
                "sink",
                "",
            )
            .expect("Failed to add abuffersink filter");

        for (i, abuffer) in abuffers.iter_mut().enumerate() {
            abuffer.link(0, &mut amix, i as u32);
        }

        amix.link(0, &mut aformat, 0);
        aformat.link(0, &mut abuffersink, 0);

        filter_graph
            .validate()
            .expect("Failed to validate filter graph");

        on_ready();

        let mut filtered = ffmpeg::frame::Audio::empty();
        loop {
            if get_is_stopped() {
                return;
            }

            for (i, source) in self.sources.iter().enumerate() {
                loop {
                    let value = match source.rx.try_recv() {
                        Ok(v) => v,
                        Err(flume::TryRecvError::Disconnected) => return,
                        Err(flume::TryRecvError::Empty) => break,
                    };

                    abuffers[i].source().add(&value).unwrap();
                }
            }

            while abuffersink.sink().frame(&mut filtered).is_ok() {
                if self.output.send(dbg!(filtered)).is_err() {
                    warn!("Mixer unable to send output");
                    return;
                }
                filtered = ffmpeg::frame::Audio::empty()
            }

            std::thread::sleep(Duration::from_millis(2))
        }
    }
}

pub struct AudioMixerSink {
    pub tx: flume::Sender<FFAudio>,
}

pub struct AudioMixerSource {
    rx: flume::Receiver<FFAudio>,
    info: AudioInfo,
}

impl PipelineSinkTask<FFAudio> for AudioMixerSink {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<FFAudio>,
    ) {
        let _ = ready_signal.send(Ok(()));

        while let Ok(input) = input.recv() {
            let _ = self.tx.send(input);
        }
    }

    fn finish(&mut self) {}
}

impl PipelineSourceTask for AudioMixer {
    type Output = FFAudio;
    type Clock = RealTimeClock<RawNanoseconds>;

    fn run(
        &mut self,
        clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) {
        self.run(
            || {
                control_signal
                    .last()
                    .map(|v| matches!(v, crate::pipeline::control::Control::Shutdown))
                    .unwrap_or(false)
            },
            || {
                let _ = ready_signal.send(Ok(()));
            },
        )
    }
}
