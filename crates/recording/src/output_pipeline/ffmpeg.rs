use crate::{
    TaskPool,
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, VideoFrame, VideoMuxer},
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::{aac::AACEncoder, h264::*, ogg::*, opus::OpusEncoder};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamp;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

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

pub struct Mp4Muxer {
    output: ffmpeg::format::context::Output,
    video_encoder: Option<H264Encoder>,
    audio_encoder: Option<AACEncoder>,
    video_frame_duration: Option<Duration>,
    last_video_ts: Option<Duration>,
}

impl Muxer for Mp4Muxer {
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: std::path::PathBuf,
        video_config: Option<cap_media_info::VideoInfo>,
        audio_config: Option<cap_media_info::AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let mut output = ffmpeg::format::output(&output_path)?;

        let (video_encoder, video_frame_duration) = match video_config {
            Some(config) => {
                let duration = Self::frame_duration(&config);
                let encoder = H264Encoder::builder(config)
                    .build(&mut output)
                    .context("video encoder")?;
                (Some(encoder), Some(duration))
            }
            None => (None, None),
        };

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()
            .context("audio encoder")?;

        output.write_header()?;

        Ok(Self {
            output,
            video_encoder,
            audio_encoder,
            video_frame_duration,
            last_video_ts: None,
        })
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let video_result = self
            .video_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        let audio_result = self
            .audio_encoder
            .as_mut()
            .map(|enc| enc.flush(&mut self.output))
            .unwrap_or(Ok(()));

        self.output.write_trailer().context("write_trailer")?;

        if video_result.is_ok() && audio_result.is_ok() {
            return Ok(Ok(()));
        }

        Ok(Err(anyhow!(
            "Video: {video_result:#?}, Audio: {audio_result:#?}"
        )))
    }
}

impl VideoMuxer for Mp4Muxer {
    type VideoFrame = FFmpegVideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        mut timestamp: Duration,
    ) -> anyhow::Result<()> {
        if let Some(video_encoder) = self.video_encoder.as_mut() {
            if let Some(frame_duration) = self.video_frame_duration {
                if let Some(last_ts) = self.last_video_ts
                    && timestamp <= last_ts
                {
                    timestamp = last_ts + frame_duration;
                }

                self.last_video_ts = Some(timestamp);
            }

            video_encoder.queue_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

impl Mp4Muxer {
    fn frame_duration(info: &VideoInfo) -> Duration {
        let num = info.frame_rate.numerator().max(1);
        let den = info.frame_rate.denominator().max(1);

        let nanos = ((den as u128 * 1_000_000_000u128) / num as u128).max(1);

        Duration::from_nanos(nanos as u64)
    }
}

impl AudioMuxer for Mp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        if let Some(audio_encoder) = self.audio_encoder.as_mut() {
            audio_encoder.send_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
    }
}

pub struct OggMuxer(OggFile);

impl Muxer for OggMuxer {
    type Config = ();

    async fn setup(
        _: Self::Config,
        output_path: PathBuf,
        _: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        _: Arc<AtomicBool>,
        _: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let audio_config =
            audio_config.ok_or_else(|| anyhow!("No audio configuration provided"))?;

        Ok(Self(
            OggFile::init(output_path, |o| OpusEncoder::init(audio_config, o))
                .map_err(|e| anyhow!("Failed to initialize Opus encoder: {e}"))?,
        ))
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.0
            .finish()
            .map_err(Into::into)
            .map(|r| r.map_err(Into::into))
    }
}

impl AudioMuxer for OggMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        Ok(self.0.queue_frame(frame.inner, timestamp)?)
    }
}
