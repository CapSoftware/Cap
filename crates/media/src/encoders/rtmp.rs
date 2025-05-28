use crate::{
    data::{FFAudio, FFVideo, RawVideoFormat},
    pipeline::task::PipelineSinkTask,
    MediaError,
};
use ffmpeg::format::{self};
use std::{sync::{Arc, Mutex}};

use super::{audio::AudioEncoder, H264Encoder};

pub struct RtmpStream {
    tag: &'static str,
    output: format::context::Output,
    video: H264Encoder,
    audio: Option<Box<dyn AudioEncoder + Send>>,
    is_finished: bool,
}

impl RtmpStream {
    pub fn init(
        tag: &'static str,
        url: String,
        video: impl FnOnce(&mut format::context::Output) -> Result<H264Encoder, MediaError>,
        audio: impl FnOnce(&mut format::context::Output) -> Option<Result<Box<dyn AudioEncoder + Send>, MediaError>>,
    ) -> Result<Self, MediaError> {
        let mut output = format::output_as(&url, "flv")?;
        let video = video(&mut output)?;
        let audio = audio(&mut output).transpose()?;
        output.write_header()?;
        Ok(Self { tag, output, video, audio, is_finished: false })
    }

    pub fn video_format() -> RawVideoFormat { RawVideoFormat::YUYV420 }

    pub fn queue_video_frame(&mut self, frame: FFVideo) {
        if self.is_finished { return; }
        self.video.queue_frame(frame, &mut self.output);
    }

    pub fn queue_audio_frame(&mut self, frame: FFAudio) {
        if self.is_finished { return; }
        if let Some(audio) = &mut self.audio { audio.queue_frame(frame, &mut self.output); }
    }

    pub fn finish(&mut self) {
        if self.is_finished { return; }
        self.is_finished = true;
        self.video.finish(&mut self.output);
        if let Some(audio) = &mut self.audio { audio.finish(&mut self.output); }
        let _ = self.output.write_trailer();
    }
}

pub struct RtmpInput {
    pub video: FFVideo,
    pub audio: Option<FFAudio>,
}

unsafe impl Send for H264Encoder {}

impl PipelineSinkTask<RtmpInput> for RtmpStream {
    fn run(&mut self, ready: crate::pipeline::task::PipelineReadySignal, rx: &flume::Receiver<RtmpInput>) {
        let _ = ready.send(Ok(()));
        while let Ok(frame) = rx.recv() {
            self.queue_video_frame(frame.video);
            if let Some(audio) = frame.audio { self.queue_audio_frame(audio); }
        }
    }

    fn finish(&mut self) { self.finish(); }
}

impl PipelineSinkTask<FFAudio> for Arc<Mutex<RtmpStream>> {
    fn run(&mut self, ready: crate::pipeline::task::PipelineReadySignal, rx: &flume::Receiver<FFAudio>) {
        let _ = ready.send(Ok(()));
        while let Ok(frame) = rx.recv() {
            if let Ok(mut s) = self.lock() { s.queue_audio_frame(frame); }
        }
    }

    fn finish(&mut self) { if let Ok(mut s) = self.lock() { s.finish(); } }
}

impl PipelineSinkTask<FFVideo> for Arc<Mutex<RtmpStream>> {
    fn run(&mut self, ready: crate::pipeline::task::PipelineReadySignal, rx: &flume::Receiver<FFVideo>) {
        let _ = ready.send(Ok(()));
        while let Ok(frame) = rx.recv() {
            if let Ok(mut s) = self.lock() { s.queue_video_frame(frame); }
        }
    }

    fn finish(&mut self) { if let Ok(mut s) = self.lock() { s.finish(); } }
}
