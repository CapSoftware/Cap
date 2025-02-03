use screencapturekit::{output::CMSampleBuffer, stream::output_type::SCStreamOutputType};

use crate::pipeline::task::PipelineSinkTask;

use super::{ACCAVAsetWriterEncoder, H264AVAssetWriterEncoder};

pub struct SplitAVAssetWriterEncoder {
    pub video: H264AVAssetWriterEncoder,
    pub audio: Option<ACCAVAsetWriterEncoder>,
}

type Input = (CMSampleBuffer, SCStreamOutputType);
impl PipelineSinkTask<Input> for SplitAVAssetWriterEncoder {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<Input>,
    ) {
        ready_signal.send(Ok(())).ok();

        while let Ok((sample_buffer, typ)) = input.recv() {
            match typ {
                SCStreamOutputType::Screen => {
                    self.video.queue_sample_buffer(sample_buffer);
                }
                SCStreamOutputType::Audio => {
                    if let Some(audio) = &mut self.audio {
                        audio.queue_sample_buffer(sample_buffer);
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
