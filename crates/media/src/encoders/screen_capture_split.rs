use crate::{
    pipeline::task::{PipelineSinkTask, PipelineSourceTask},
    sources::{self, MacOSRawCaptureOutput},
};

use super::{H264AVAssetWriterEncoder, OggFile};

pub struct ScreenCaptureSplitEncoder {
    pub video: H264AVAssetWriterEncoder,
    pub audio: Option<OggFile>,
}

type Input = <sources::ScreenCaptureSource<sources::MacOSRawCapture> as PipelineSourceTask>::Output;
impl PipelineSinkTask<Input> for ScreenCaptureSplitEncoder {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<Input>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok(input) = input.recv() {
            match input {
                MacOSRawCaptureOutput::Video(sample_buffer) => {
                    self.video.queue_sample_buffer(sample_buffer);
                }
                MacOSRawCaptureOutput::Audio(frame) => {
                    if let Some(audio) = &mut self.audio {
                        audio.queue_frame(frame);
                    }
                }
            }
        }
    }

    fn finish(&mut self) {
        self.video.finish();
        if let Some(audio) = &mut self.audio {
            audio.finish();
        }
    }
}
