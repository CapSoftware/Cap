use crate::config::DisplayInputConfig;
use cap_media_info::VideoInfo;
use cap_recording::output_pipeline::{ChannelVideoSource, ChannelVideoSourceConfig};
use cap_timestamp::Timestamp;
use futures::channel::mpsc;
use std::sync::Arc;
use tokio::sync::broadcast;

pub struct VideoFrame {
    pub data: Vec<u8>,
    pub timestamp: Timestamp,
}

impl cap_recording::output_pipeline::VideoFrame for VideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

pub type PlatformVideoSource = ChannelVideoSource<VideoFrame>;

pub struct PlatformCapturerInner;

impl PlatformCapturerInner {
    pub async fn start(&self) -> anyhow::Result<()> {
        anyhow::bail!("Windows display capture not yet implemented")
    }

    pub async fn stop(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

pub type PlatformCapturer = PlatformCapturerInner;

pub async fn setup_platform_capture(
    _config: &DisplayInputConfig,
    _video_tx: mpsc::Sender<VideoFrame>,
) -> anyhow::Result<(
    PlatformVideoSource,
    super::Capturer,
    broadcast::Receiver<String>,
)> {
    anyhow::bail!("Windows display capture not yet implemented in multi-recorder. Please use macOS or contribute a Windows implementation.")
}
