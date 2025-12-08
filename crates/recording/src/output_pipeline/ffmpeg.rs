use crate::{
    TaskPool,
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, VideoFrame, VideoMuxer},
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::{
    aac::AACEncoder, fragmented_audio::FragmentedAudioFile, h264::*, ogg::*, opus::OpusEncoder,
    segmented_audio::SegmentedAudioEncoder,
};
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

        let video_encoder = video_config
            .map(|video_config| H264Encoder::builder(video_config).build(&mut output))
            .transpose()
            .context("video encoder")?;

        let audio_encoder = audio_config
            .map(|config| AACEncoder::init(config, &mut output))
            .transpose()
            .context("audio encoder")?;

        output.write_header()?;

        Ok(Self {
            output,
            video_encoder,
            audio_encoder,
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
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if let Some(video_encoder) = self.video_encoder.as_mut() {
            video_encoder.queue_frame(frame.inner, timestamp, &mut self.output)?;
        }

        Ok(())
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

pub struct FragmentedAudioMuxer(FragmentedAudioFile);

impl Muxer for FragmentedAudioMuxer {
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
            FragmentedAudioFile::init(output_path, audio_config)
                .map_err(|e| anyhow!("Failed to initialize fragmented audio encoder: {e}"))?,
        ))
    }

    fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.0
            .finish()
            .map_err(Into::into)
            .map(|r| r.map_err(Into::into))
    }
}

impl AudioMuxer for FragmentedAudioMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        Ok(self.0.queue_frame(frame.inner, timestamp)?)
    }
}

pub struct SegmentedAudioMuxer(SegmentedAudioEncoder);

pub struct SegmentedAudioMuxerConfig {
    pub segment_duration: Duration,
}

impl Default for SegmentedAudioMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
        }
    }
}

impl Muxer for SegmentedAudioMuxer {
    type Config = SegmentedAudioMuxerConfig;

    async fn setup(
        config: Self::Config,
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
            SegmentedAudioEncoder::init(output_path, audio_config, config.segment_duration)
                .map_err(|e| anyhow!("Failed to initialize segmented audio encoder: {e}"))?,
        ))
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.0
            .finish_with_timestamp(timestamp)
            .map_err(Into::into)
            .map(|_| Ok(()))
    }
}

impl AudioMuxer for SegmentedAudioMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        self.0
            .queue_frame(frame.inner, timestamp)
            .map_err(|e| anyhow!("Failed to queue audio frame: {e}"))
    }
}
