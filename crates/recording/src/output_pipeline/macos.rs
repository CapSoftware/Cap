use crate::{
    output_pipeline::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer},
    sources::screen_capture,
};
use anyhow::anyhow;
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::Duration,
};

#[derive(Clone)]
pub struct AVFoundationMp4Muxer(
    Arc<Mutex<cap_enc_avfoundation::MP4Encoder>>,
    Arc<AtomicBool>,
);

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

    fn finish(&mut self) -> anyhow::Result<()> {
        self.0.lock().map_err(|e| anyhow!("{e}"))?.finish();
        Ok(())
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

        mp4.queue_video_frame(&frame.sample_buf, timestamp)
            .map_err(|e| anyhow!("QueueVideoFrame/{e}"))
    }
}

impl AudioMuxer for AVFoundationMp4Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()> {
        self.0
            .lock()
            .map_err(|e| anyhow!("{e}"))?
            .queue_audio_frame(frame.inner, timestamp)
            .map_err(|e| anyhow!("{e}"))
    }
}
