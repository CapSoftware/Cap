use crate::{
    data::{FFAudio, FFVideo, RawVideoFormat},
    pipeline::task::PipelineSinkTask,
    MediaError,
};
use ffmpeg::format::{self};
use std::path::PathBuf;

use super::{H264Encoder, OpusEncoder};

pub struct MP4File {
    tag: &'static str,
    output: format::context::Output,
    video: H264Encoder,
    audio: Option<OpusEncoder>,
}

impl MP4File {
    pub fn init(
        tag: &'static str,
        mut output: PathBuf,
        video: impl FnOnce(&mut format::context::Output) -> Result<H264Encoder, MediaError>,
        audio: impl FnOnce(&mut format::context::Output) -> Option<Result<OpusEncoder, MediaError>>,
    ) -> Result<Self, MediaError> {
        output.set_extension("mp4");
        let mut output = format::output(&output)?;

        let video = video(&mut output)?;
        let audio = audio(&mut output).transpose()?;

        // make sure this happens after adding all encoders!
        output.write_header()?;

        Ok(Self {
            tag,
            output,
            video,
            audio,
        })
    }

    pub fn video_format() -> RawVideoFormat {
        RawVideoFormat::YUYV420
    }

    pub fn queue_video_frame(&mut self, frame: FFVideo) {
        self.video.queue_frame(frame, &mut self.output);
    }

    pub fn queue_audio_frame(&mut self, frame: FFAudio) {
        let Some(audio) = &mut self.audio else {
            return;
        };

        audio.queue_frame(frame, &mut self.output);
    }

    pub fn finish(&mut self) {
        println!("MP4Encoder: Finishing encoding");

        self.video.finish(&mut self.output);

        if let Some(audio) = &mut self.audio {
            println!("MP4Encoder: Flushing audio encoder");
            audio.finish(&mut self.output);
        }

        println!("MP4Encoder: Writing trailer");
        self.output.write_trailer().unwrap();
    }
}

pub struct MP4Input {
    pub video: FFVideo,
    pub audio: Option<FFAudio>,
}

unsafe impl Send for H264Encoder {}

impl PipelineSinkTask<MP4Input> for MP4File {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<MP4Input>,
    ) {
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_video_frame(frame.video);
            if let Some(audio) = frame.audio {
                self.queue_audio_frame(audio);
            }
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}

impl PipelineSinkTask<FFVideo> for MP4File {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<FFVideo>,
    ) {
        assert!(self.audio.is_none());

        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_video_frame(frame);
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}
