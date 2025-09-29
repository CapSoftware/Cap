use crate::output_pipeline::{Muxer, VideoFrame};
use cap_enc_ffmpeg::*;
use cap_timestamp::Timestamp;

#[derive(Clone)]
pub struct FFmpegVideoFrame {
    pub inner: ffmpeg::frame::Video,
    pub timestamp: Timestamp,
}

impl VideoFrame for FFmpegVideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

pub struct FFmpegMuxer {
    output: ffmpeg::format::context::Output,
    video_encoder: H264Encoder,
}

impl Muxer for FFmpegMuxer {
    type VideoFrame = FFmpegVideoFrame;
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: std::path::PathBuf,
        video_config: cap_media_info::VideoInfo,
        audio_config: Option<cap_media_info::AudioInfo>,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let mut output = ffmpeg::format::output(&output_path)?;

        let video_encoder = H264Encoder::builder("camera", video_config).build(&mut output)?;

        output.write_header()?;

        Ok(Self {
            output,
            video_encoder,
        })
    }

    fn send_audio_frame(
        &mut self,
        frame: ffmpeg::frame::Audio,
        timestamp: std::time::Duration,
    ) -> anyhow::Result<()> {
        todo!()
    }

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: std::time::Duration,
    ) -> anyhow::Result<()> {
        self.video_encoder
            .queue_frame(frame.inner, timestamp, &mut self.output);
        Ok(())
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        self.video_encoder.finish(&mut self.output);

        self.output.write_trailer()?;

        Ok(())
    }
}
