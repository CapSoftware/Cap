use ::ffmpeg::Rational;
use std::{
    path::PathBuf,
    sync::{Arc, mpsc},
};
use tokio::sync::oneshot;

#[cfg(target_os = "macos")]
mod avassetreader;
#[cfg(windows)]
mod ffmpeg;

pub type DecodedFrame = wgpu::Texture;

pub enum VideoDecoderMessage {
    GetFrame(f32, tokio::sync::oneshot::Sender<wgpu::Texture>),
}

pub fn pts_to_frame(pts: i64, time_base: Rational, fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

pub const FRAME_CACHE_SIZE: usize = 100;

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
    offset: f64,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(self.get_time(time), tx))
            .unwrap();
        rx.await.ok()
    }

    pub fn get_time(&self, time: f32) -> f32 {
        time + self.offset as f32
    }
}

pub async fn spawn_decoder(
    name: &'static str,
    path: PathBuf,
    fps: u32,
    offset: f64,
    device: wgpu::Device,
) -> Result<AsyncVideoDecoderHandle, String> {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
    let (tx, rx) = mpsc::channel();

    let handle = AsyncVideoDecoderHandle { sender: tx, offset };

    if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        avassetreader::AVAssetReaderDecoder::spawn(name, path, fps, rx, ready_tx, device);
    } else if cfg!(windows) {
        #[cfg(windows)]
        ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx)
            .map_err(|e| format!("'{name}' decoder / {e}"))?;
    } else {
        unreachable!()
    }

    ready_rx.await.map_err(|e| e.to_string())?.map(|()| handle)
}
