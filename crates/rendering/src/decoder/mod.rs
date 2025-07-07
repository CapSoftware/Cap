use ::ffmpeg::Rational;
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
};
use tokio::sync::oneshot;

#[cfg(target_os = "macos")]
mod avassetreader;
mod ffmpeg;

pub type DecodedFrame = Arc<Vec<u8>>;

pub const FRAME_CACHE_SIZE: usize = 100;

pub enum VideoDecoderMessage {
    GetFrame(f32, oneshot::Sender<DecodedFrame>),
}

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    tx: mpsc::Sender<VideoDecoderMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(VideoDecoderMessage::GetFrame(time, tx)).ok()?;
        rx.await.ok()
    }
}

pub async fn spawn_decoder(
    name: &'static str,
    path: PathBuf,
    fps: u32,
    _offset: f64,
) -> Result<AsyncVideoDecoderHandle, String> {
    let (tx, rx) = mpsc::channel();
    let (ready_tx, ready_rx) = oneshot::channel();

    #[cfg(target_os = "macos")]
    {
        avassetreader::AVAssetReaderDecoder::spawn(name, path, fps, rx, ready_tx);
    }
    #[cfg(not(target_os = "macos"))]
    {
        ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx)?;
    }

    ready_rx.await.map_err(|_| "Decoder spawn failed")??;

    Ok(AsyncVideoDecoderHandle { tx })
}

pub fn pts_to_frame(pts: i64, time_base: Rational, fps: u32) -> u32 {
    let time_in_seconds =
        pts as f64 * time_base.numerator() as f64 / time_base.denominator() as f64;
    (time_in_seconds * fps as f64).round() as u32
}
