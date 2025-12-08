use crate::output_pipeline::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoFrame, VideoMuxer};
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

#[cfg(target_os = "macos")]
use crate::sources::screen_capture;

#[cfg(target_os = "macos")]
use cap_enc_avfoundation::SegmentedMP4Encoder;

#[cfg(target_os = "macos")]
use cap_timestamp::Timestamp;

#[cfg(target_os = "macos")]
pub struct FragmentedAVFoundationMp4Muxer {
    inner: SegmentedMP4Encoder,
    pause_flag: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
pub struct FragmentedAVFoundationMp4MuxerConfig {
    pub output_height: Option<u32>,
    pub segment_duration: Duration,
}

#[cfg(target_os = "macos")]
impl Default for FragmentedAVFoundationMp4MuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            segment_duration: Duration::from_secs(3),
        }
    }
}

#[cfg(target_os = "macos")]
impl FragmentedAVFoundationMp4Muxer {
    const MAX_QUEUE_RETRIES: u32 = 500;
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
pub struct FragmentedNativeCameraFrame {
    pub sample_buf: cidre::arc::R<cidre::cm::SampleBuf>,
    pub timestamp: Timestamp,
}

#[cfg(target_os = "macos")]
unsafe impl Send for FragmentedNativeCameraFrame {}
#[cfg(target_os = "macos")]
unsafe impl Sync for FragmentedNativeCameraFrame {}

#[cfg(target_os = "macos")]
impl VideoFrame for FragmentedNativeCameraFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

#[cfg(target_os = "macos")]
impl Muxer for FragmentedAVFoundationMp4Muxer {
    type Config = FragmentedAVFoundationMp4MuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        let video_config =
            video_config.ok_or_else(|| anyhow!("Invariant: No video source provided"))?;

        Ok(Self {
            inner: SegmentedMP4Encoder::init(
                output_path,
                video_config,
                audio_config,
                config.output_height,
                config.segment_duration,
            )
            .map_err(|e| anyhow!("{e}"))?,
            pause_flag,
        })
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(self.inner.finish(Some(timestamp)).map(Ok)?)
    }
}

#[cfg(target_os = "macos")]
impl VideoMuxer for FragmentedAVFoundationMp4Muxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if self.pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
            self.inner.pause();
        } else {
            self.inner.resume();
        }

        let mut retry_count = 0;
        loop {
            match self
                .inner
                .queue_video_frame(frame.sample_buf.clone(), timestamp)
            {
                Ok(()) => break,
                Err(cap_enc_avfoundation::QueueFrameError::NotReadyForMore) => {
                    retry_count += 1;
                    if retry_count >= Self::MAX_QUEUE_RETRIES {
                        return Err(anyhow!(
                            "send_video_frame/timeout after {} retries",
                            Self::MAX_QUEUE_RETRIES
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_video_frame/{e}")),
            }
        }

        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl AudioMuxer for FragmentedAVFoundationMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        loop {
            match self.inner.queue_audio_frame(&frame.inner, timestamp) {
                Ok(()) => break,
                Err(cap_enc_avfoundation::QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_audio_frame/{e}")),
            }
        }

        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub struct FragmentedAVFoundationCameraMuxer {
    inner: SegmentedMP4Encoder,
    pause_flag: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
pub struct FragmentedAVFoundationCameraMuxerConfig {
    pub output_height: Option<u32>,
    pub segment_duration: Duration,
}

#[cfg(target_os = "macos")]
impl Default for FragmentedAVFoundationCameraMuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            segment_duration: Duration::from_secs(3),
        }
    }
}

#[cfg(target_os = "macos")]
impl FragmentedAVFoundationCameraMuxer {
    const MAX_QUEUE_RETRIES: u32 = 500;
}

#[cfg(target_os = "macos")]
impl Muxer for FragmentedAVFoundationCameraMuxer {
    type Config = FragmentedAVFoundationCameraMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self> {
        let video_config =
            video_config.ok_or_else(|| anyhow!("Invariant: No video source provided"))?;

        Ok(Self {
            inner: SegmentedMP4Encoder::init(
                output_path,
                video_config,
                audio_config,
                config.output_height,
                config.segment_duration,
            )
            .map_err(|e| anyhow!("{e}"))?,
            pause_flag,
        })
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(self.inner.finish(Some(timestamp)).map(Ok)?)
    }
}

#[cfg(target_os = "macos")]
impl VideoMuxer for FragmentedAVFoundationCameraMuxer {
    type VideoFrame = crate::output_pipeline::NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        if self.pause_flag.load(std::sync::atomic::Ordering::Relaxed) {
            self.inner.pause();
        } else {
            self.inner.resume();
        }

        let mut retry_count = 0;
        loop {
            match self
                .inner
                .queue_video_frame(frame.sample_buf.clone(), timestamp)
            {
                Ok(()) => break,
                Err(cap_enc_avfoundation::QueueFrameError::NotReadyForMore) => {
                    retry_count += 1;
                    if retry_count >= Self::MAX_QUEUE_RETRIES {
                        return Err(anyhow!(
                            "send_video_frame/timeout after {} retries",
                            Self::MAX_QUEUE_RETRIES
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_video_frame/{e}")),
            }
        }

        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl AudioMuxer for FragmentedAVFoundationCameraMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        loop {
            match self.inner.queue_audio_frame(&frame.inner, timestamp) {
                Ok(()) => break,
                Err(cap_enc_avfoundation::QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_audio_frame/{e}")),
            }
        }

        Ok(())
    }
}
