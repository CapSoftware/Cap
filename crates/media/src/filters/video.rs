use ffmpeg::{filter, format::pixel::Pixel};

use crate::{
    data::{FFVideo, VideoInfo},
    pipeline::task::PipelinePipeTask,
    MediaError,
};
use flume::Sender;

pub struct VideoFilter {
    tag: &'static str,
    filter_graph: filter::Graph,
}

impl VideoFilter {
    pub fn init(tag: &'static str, config: VideoInfo, spec: &str) -> Result<Self, MediaError> {
        let mut filter_graph = filter::Graph::new();

        let input_args = format!(
            "pix_fmt={}:width={}:height={}:time_base={}/{}",
            config.pixel_format_int(),
            config.width,
            config.height,
            config.time_base.numerator(),
            config.time_base.denominator()
        );
        filter_graph.add(&filter::find("buffer").unwrap(), "in", &input_args)?;
        filter_graph.add(&filter::find("buffersink").unwrap(), "out", "")?;

        let mut input = filter_graph.get("in").unwrap();
        input.set_pixel_format(config.pixel_format);

        let mut output = filter_graph.get("out").unwrap();
        output.set_pixel_format(Pixel::YUV420P);

        filter_graph.output("in", 0)?.input("out", 0)?.parse(spec)?;
        filter_graph.validate()?;

        Ok(Self { filter_graph, tag })
    }

    fn queue_frame(&mut self, frame: FFVideo) {
        self.filter_graph
            .get("in")
            .unwrap()
            .source()
            .add(&frame)
            .unwrap();
    }

    fn process_frame(&mut self, output: &Sender<FFVideo>) {
        let mut filtered_frame = FFVideo::empty();

        // TODO: Handle errors that are not EGAIN/"needs more data"
        while self
            .filter_graph
            .get("out")
            .unwrap()
            .sink()
            .frame(&mut filtered_frame)
            .is_ok()
        {
            output.send(filtered_frame).unwrap();
            filtered_frame = FFVideo::empty();
        }
    }

    fn finish(&mut self, output: &Sender<FFVideo>) {
        self.filter_graph
            .get("in")
            .unwrap()
            .source()
            .flush()
            .unwrap();

        self.process_frame(output);
    }
}

impl PipelinePipeTask for VideoFilter {
    type Input = FFVideo;
    type Output = FFVideo;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: flume::Receiver<Self::Input>,
        output: Sender<Self::Output>,
    ) {
        tracing::info!("Starting {} video filtering thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(raw_frame) = input.recv() {
            self.queue_frame(raw_frame);
            self.process_frame(&output);
        }

        tracing::info!(
            "Received last raw {} frame. Finishing up filtering.",
            self.tag
        );
        self.finish(&output);

        tracing::info!("Shutting down {} video filtering thread", self.tag);
    }
}
