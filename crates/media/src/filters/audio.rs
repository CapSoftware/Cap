use ffmpeg::filter;
use flume::{Receiver, Sender};

use crate::{
    data::{AudioInfo, FFAudio},
    pipeline::task::PipelinePipeTask,
    MediaError,
};

pub struct AudioFilter {
    tag: &'static str,
    filter_graph: filter::Graph,
}

impl AudioFilter {
    pub fn init(tag: &'static str, config: AudioInfo, spec: &str) -> Result<Self, MediaError> {
        let mut filter_graph = filter::Graph::new();

        let input_args = format!(
            "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
            config.time_base,
            config.rate(),
            config.sample_format.name(),
            config.channel_layout().bits()
        );
        filter_graph.add(&filter::find("abuffer").unwrap(), "in", &input_args)?;
        filter_graph.add(&filter::find("abuffersink").unwrap(), "out", "")?;

        filter_graph.output("in", 0)?.input("out", 0)?.parse(spec)?;
        filter_graph.validate()?;

        Ok(Self { filter_graph, tag })
    }

    fn queue_frame(&mut self, frame: FFAudio) {
        self.filter_graph
            .get("in")
            .unwrap()
            .source()
            .add(&frame)
            .unwrap();
    }

    fn process_frame(&mut self, output: &Sender<FFAudio>) {
        let mut filtered_frame = FFAudio::empty();

        while self
            .filter_graph
            .get("out")
            .unwrap()
            .sink()
            .frame(&mut filtered_frame)
            .is_ok()
        {
            output.send(filtered_frame).unwrap();
            filtered_frame = FFAudio::empty();
        }
    }

    fn finish(&mut self, output: &Sender<FFAudio>) {
        self.filter_graph
            .get("in")
            .unwrap()
            .source()
            .flush()
            .unwrap();

        self.process_frame(output);
    }
}

impl PipelinePipeTask for AudioFilter {
    type Input = FFAudio;
    type Output = FFAudio;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: Receiver<Self::Input>,
        output: Sender<Self::Output>,
    ) {
        println!("Starting {} audio filtering thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(raw_frame) = input.recv() {
            self.queue_frame(raw_frame);
            self.process_frame(&output);
        }

        println!(
            "Received last raw {} sample. Finishing up filtering.",
            self.tag
        );
        self.finish(&output);

        println!("Shutting down {} audio filtering thread", self.tag);
    }
}
