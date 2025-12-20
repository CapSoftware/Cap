use crate::{
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoFrame, VideoMuxer},
    sources::screen_capture,
};
use anyhow::anyhow;
use cap_enc_avfoundation::QueueFrameError;
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::Timestamp;
use cidre::arc;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::Duration,
};

#[derive(Clone)]
pub struct NativeCameraFrame {
    pub sample_buf: arc::R<cidre::cm::SampleBuf>,
    pub timestamp: Timestamp,
}

unsafe impl Send for NativeCameraFrame {}
unsafe impl Sync for NativeCameraFrame {}

impl VideoFrame for NativeCameraFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

#[derive(Clone)]
pub struct AVFoundationMp4Muxer(
    Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    Arc<AtomicBool>,
);

impl AVFoundationMp4Muxer {
    const MAX_QUEUE_RETRIES: u32 = 1500;
}

#[derive(Default)]
pub struct AVFoundationMp4MuxerConfig {
    pub output_height: Option<u32>,
}

impl Muxer for AVFoundationMp4Muxer {
    type Config = AVFoundationMp4MuxerConfig;

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

        Ok(Self(
            Arc::new(Mutex::new(
                cap_enc_avfoundation::MP4Encoder::init(
                    output_path,
                    video_config,
                    audio_config,
                    config.output_height,
                )
                .map_err(|e| anyhow!("{e}"))?,
            )),
            pause_flag,
        ))
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(self
            .0
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .finish(Some(timestamp))
            .map(Ok)?)
    }
}

impl VideoMuxer for AVFoundationMp4Muxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("MuxerLock/{e}"))?;

        if self.1.load(std::sync::atomic::Ordering::Relaxed) {
            mp4.pause();
        } else {
            mp4.resume();
        }

        let mut retry_count = 0;
        loop {
            match mp4.queue_video_frame(frame.sample_buf.clone(), timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
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

impl AudioMuxer for AVFoundationMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("{e}"))?;

        loop {
            match mp4.queue_audio_frame(&frame.inner, timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_audio_frame/{e}")),
            }
        }

        Ok(())
    }
}

#[derive(Clone)]
pub struct AVFoundationCameraMuxer(
    Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    Arc<AtomicBool>,
);

impl AVFoundationCameraMuxer {
    const MAX_QUEUE_RETRIES: u32 = 1500;
}

#[derive(Default)]
pub struct AVFoundationCameraMuxerConfig {
    pub output_height: Option<u32>,
}

impl Muxer for AVFoundationCameraMuxer {
    type Config = AVFoundationCameraMuxerConfig;

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

        Ok(Self(
            Arc::new(Mutex::new(
                cap_enc_avfoundation::MP4Encoder::init(
                    output_path,
                    video_config,
                    audio_config,
                    config.output_height,
                )
                .map_err(|e| anyhow!("{e}"))?,
            )),
            pause_flag,
        ))
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        Ok(self
            .0
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .finish(Some(timestamp))
            .map(Ok)?)
    }
}

impl VideoMuxer for AVFoundationCameraMuxer {
    type VideoFrame = NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("MuxerLock/{e}"))?;

        if self.1.load(std::sync::atomic::Ordering::Relaxed) {
            mp4.pause();
        } else {
            mp4.resume();
        }

        let mut retry_count = 0;
        loop {
            match mp4.queue_video_frame(frame.sample_buf.clone(), timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
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

impl AudioMuxer for AVFoundationCameraMuxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        let mut mp4 = self.0.lock().map_err(|e| anyhow!("{e}"))?;

        loop {
            match mp4.queue_audio_frame(&frame.inner, timestamp) {
                Ok(()) => break,
                Err(QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => return Err(anyhow!("send_audio_frame/{e}")),
            }
        }

        Ok(())
    }
}
