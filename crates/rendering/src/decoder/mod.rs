use ::ffmpeg::Rational;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
};

#[cfg(target_os = "macos")]
mod avassetreader;
mod ffmpeg;

pub type DecodedFrame = Arc<Vec<u8>>;

pub enum VideoDecoderMessage {
    GetFrame(f32, tokio::sync::oneshot::Sender<DecodedFrame>),
}

pub fn pts_to_frame(pts: i64, time_base: Rational, fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

pub const FRAME_CACHE_SIZE: usize = 100;

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(time, tx))
            .unwrap();
        rx.await.ok()
    }
}

pub fn spawn_decoder(name: &'static str, path: PathBuf, fps: u32) -> AsyncVideoDecoderHandle {
    let (tx, rx) = mpsc::channel();

    let handle = AsyncVideoDecoderHandle { sender: tx };

    #[cfg(target_os = "macos")]
    {
        avassetreader::AVAssetReaderDecoder::spawn(name, path, fps, rx);
    }

    #[cfg(not(target_os = "macos"))]
    {
        FfmpegDecoder::spawn(name, path, fps, rx);
    }

    handle
}
