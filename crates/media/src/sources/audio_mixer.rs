use crate::data::{AudioInfo, FFAudio};
use crate::pipeline::task::PipelineSinkTask;
use crate::pipeline::{task::PipelineSourceTask, RawNanoseconds, RealTimeClock};

pub struct AudioMixer {
    sources: Vec<AudioMixerSource>,
}

impl AudioMixer {
    pub fn new() -> Self {
        Self {
            sources: vec![],
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

    pub fn info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48000,
            2,
        )
        .unwrap()
    }

    pub fn run(
        &mut self,
        on_ready: impl FnOnce() -> (),
        mut on_output: impl FnMut(ffmpeg::frame::Audio),
    ) {
        fn init(
            sources: &[AudioMixerSource],
        ) -> (
            ffmpeg::filter::Graph,
            Vec<ffmpeg::filter::Context>,
            ffmpeg::filter::Context,
        ) {
            let mut filter_graph = ffmpeg::filter::Graph::new();

            let mut abuffers = sources
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
                            &ffmpeg::filter::find("abuffer")
                                .expect("Failed to find abuffer filter"),
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
                    &ffmpeg::filter::find("abuffersink")
                        .expect("Failed to find abuffersink filter"),
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

            (filter_graph, abuffers, abuffersink)
        }

        let (_, mut abuffers, mut abuffersink) = init(&self.sources);
        on_ready();

        let mut filtered = ffmpeg::frame::Audio::empty();
        loop {
            let (value, i, _) = futures::executor::block_on(futures::future::select_all(
                self.sources.iter().map(|r| r.rx.recv_async()),
            ));

            let Ok(input) = value else {
                break;
            };

            abuffers[i].source().add(&input).unwrap();

            while abuffersink.sink().frame(&mut filtered).is_ok() {
                on_output(filtered);
                filtered = ffmpeg::frame::Audio::empty()
            }
        }
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

        let _ = ready_signal.send(Ok(()));

        let mut filtered = ffmpeg::frame::Audio::empty();

        loop {
            let (value, i, _) = futures::executor::block_on(futures::future::select_all(
                self.sources.iter().map(|r| r.rx.recv_async()),
            ));

            let Ok(input) = value else {
                break;
            };

            abuffers[i].source().add(&input).unwrap();

            while abuffersink.sink().frame(&mut filtered).is_ok() {
                let _ = output.send(filtered);
                filtered = ffmpeg::frame::Audio::empty()
            }
        }
    }
}
