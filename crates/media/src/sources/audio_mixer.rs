use crate::data::{AudioInfo, FFAudio};
use crate::pipeline::task::PipelineSinkTask;
use crate::pipeline::{task::PipelineSourceTask, RawNanoseconds, RealTimeClock};

pub struct AudioMixer {
    sources: Vec<AudioMixerSource>,
}

impl AudioMixer {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
        }
    }

    pub fn sink(&mut self, info: AudioInfo) -> AudioMixerSink {
        let (tx, rx) = flume::bounded(32);

        self.sources.push(AudioMixerSource { rx, info });

        AudioMixerSink { tx }
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }
}

pub struct AudioMixerSink {
    tx: flume::Sender<FFAudio>,
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
        control_signal: crate::pipeline::control::PipelineControlSignal,
        output: flume::Sender<Self::Output>,
    ) {
        let _ = ready_signal.send(Ok(()));

        let mut filter_graph = ffmpeg::filter::Graph::new();

        let info = &self.sources[0].info;
        let args = format!(
            "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
            info.time_base,
            info.rate(),
            info.sample_format.name(),
            info.channel_layout().bits()
        );

        let abuffer = filter_graph
            .add(
                &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
                "src1",
                &args,
            )
            .unwrap();

        let rx = &self.sources[0].rx;
        while let Ok(input) = rx.recv() {
            let _ = output.send(input);
        }
    }
}
