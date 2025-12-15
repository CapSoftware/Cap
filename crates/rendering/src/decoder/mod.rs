use ::ffmpeg::Rational;
use std::{
    path::PathBuf,
    sync::{Arc, mpsc},
};
use tokio::sync::oneshot;
use tracing::debug;

#[cfg(target_os = "macos")]
mod avassetreader;
mod ffmpeg;
mod frame_converter;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    Rgba,
    Nv12,
    Yuv420p,
}

#[derive(Clone, Debug)]
pub struct DecodedFrame {
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    format: PixelFormat,
    y_stride: u32,
    uv_stride: u32,
}

impl DecodedFrame {
    pub fn new(data: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            data: Arc::new(data),
            width,
            height,
            format: PixelFormat::Rgba,
            y_stride: width * 4,
            uv_stride: 0,
        }
    }

    pub fn new_nv12(data: Vec<u8>, width: u32, height: u32, y_stride: u32, uv_stride: u32) -> Self {
        Self {
            data: Arc::new(data),
            width,
            height,
            format: PixelFormat::Nv12,
            y_stride,
            uv_stride,
        }
    }

    pub fn new_yuv420p(
        data: Vec<u8>,
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Self {
        Self {
            data: Arc::new(data),
            width,
            height,
            format: PixelFormat::Yuv420p,
            y_stride,
            uv_stride,
        }
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn format(&self) -> PixelFormat {
        self.format
    }

    pub fn y_plane(&self) -> Option<&[u8]> {
        match self.format {
            PixelFormat::Nv12 | PixelFormat::Yuv420p => {
                let y_size = self
                    .y_stride
                    .checked_mul(self.height)
                    .and_then(|v| usize::try_from(v).ok())?;
                self.data.get(..y_size)
            }
            PixelFormat::Rgba => None,
        }
    }

    pub fn uv_plane(&self) -> Option<&[u8]> {
        match self.format {
            PixelFormat::Nv12 => {
                let y_size = self
                    .y_stride
                    .checked_mul(self.height)
                    .and_then(|v| usize::try_from(v).ok())?;
                self.data.get(y_size..)
            }
            PixelFormat::Yuv420p | PixelFormat::Rgba => None,
        }
    }

    pub fn u_plane(&self) -> Option<&[u8]> {
        match self.format {
            PixelFormat::Yuv420p => {
                let y_size = self
                    .y_stride
                    .checked_mul(self.height)
                    .and_then(|v| usize::try_from(v).ok())?;
                let u_size = self
                    .uv_stride
                    .checked_mul(self.height / 2)
                    .and_then(|v| usize::try_from(v).ok())?;
                let u_end = y_size.checked_add(u_size)?;
                self.data.get(y_size..u_end)
            }
            _ => None,
        }
    }

    pub fn v_plane(&self) -> Option<&[u8]> {
        match self.format {
            PixelFormat::Yuv420p => {
                let y_size = self
                    .y_stride
                    .checked_mul(self.height)
                    .and_then(|v| usize::try_from(v).ok())?;
                let u_size = self
                    .uv_stride
                    .checked_mul(self.height / 2)
                    .and_then(|v| usize::try_from(v).ok())?;
                let v_start = y_size.checked_add(u_size)?;
                self.data.get(v_start..)
            }
            _ => None,
        }
    }

    pub fn y_stride(&self) -> u32 {
        self.y_stride
    }

    pub fn uv_stride(&self) -> u32 {
        self.uv_stride
    }
}

pub enum VideoDecoderMessage {
    GetFrame(f32, tokio::sync::oneshot::Sender<DecodedFrame>),
}

pub fn pts_to_frame(pts: i64, time_base: Rational, fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

pub const FRAME_CACHE_SIZE: usize = 750;

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
    offset: f64,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let adjusted_time = self.get_time(time);

        if self
            .sender
            .send(VideoDecoderMessage::GetFrame(adjusted_time, tx))
            .is_err()
        {
            debug!("Decoder channel closed, receiver dropped");
            return None;
        }

        let start = std::time::Instant::now();
        let result = rx.await;
        let wait_ms = start.elapsed().as_millis() as u64;

        let success = result.is_ok();
        let cancelled = result.is_err();
        if cancelled || wait_ms > 50 {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            debug!(
                time = time,
                wait_ms = wait_ms,
                success = success,
                cancelled = cancelled,
                timestamp = timestamp,
                session_id = "debug-session",
                hypothesis_id = "A",
                "get_frame completed"
            );
        }

        result.ok()
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
) -> Result<AsyncVideoDecoderHandle, String> {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
    let (tx, rx) = mpsc::channel();

    let handle = AsyncVideoDecoderHandle { sender: tx, offset };

    let path_display = path.display().to_string();

    if cfg!(target_os = "macos") {
        #[cfg(target_os = "macos")]
        avassetreader::AVAssetReaderDecoder::spawn(name, path, fps, rx, ready_tx);
    } else {
        ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx)
            .map_err(|e| format!("'{name}' decoder / {e}"))?;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(30), ready_rx).await {
        Ok(result) => result
            .map_err(|e| format!("'{name}' decoder channel closed: {e}"))?
            .map(|()| handle),
        Err(_) => Err(format!(
            "'{name}' decoder timed out after 30s initializing: {path_display}"
        )),
    }
}
