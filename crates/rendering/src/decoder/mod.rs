use ::ffmpeg::Rational;
use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, mpsc},
    time::Duration,
};
use tokio::sync::oneshot;
use tracing::info;

#[cfg(target_os = "macos")]
mod avassetreader;
mod ffmpeg;
mod frame_converter;
#[cfg(target_os = "windows")]
mod media_foundation;
#[cfg(target_os = "macos")]
pub mod multi_position;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecoderType {
    #[cfg(target_os = "macos")]
    AVAssetReader,
    #[cfg(target_os = "windows")]
    MediaFoundation,
    FFmpegHardware,
    FFmpegSoftware,
}

impl DecoderType {
    pub fn is_hardware_accelerated(&self) -> bool {
        match self {
            #[cfg(target_os = "macos")]
            DecoderType::AVAssetReader => true,
            #[cfg(target_os = "windows")]
            DecoderType::MediaFoundation => true,
            DecoderType::FFmpegHardware => true,
            DecoderType::FFmpegSoftware => false,
        }
    }
}

impl fmt::Display for DecoderType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(target_os = "macos")]
            DecoderType::AVAssetReader => write!(f, "AVAssetReader (hardware)"),
            #[cfg(target_os = "windows")]
            DecoderType::MediaFoundation => write!(f, "MediaFoundation (hardware)"),
            DecoderType::FFmpegHardware => write!(f, "FFmpeg (hardware)"),
            DecoderType::FFmpegSoftware => write!(f, "FFmpeg (software)"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecoderStatus {
    pub decoder_type: DecoderType,
    pub video_width: u32,
    pub video_height: u32,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DecoderInitResult {
    pub width: u32,
    pub height: u32,
    pub decoder_type: DecoderType,
}

#[cfg(target_os = "windows")]
use windows::Win32::{Foundation::HANDLE, Graphics::Direct3D11::ID3D11Texture2D};

#[cfg(target_os = "windows")]
pub struct SendableD3D11Texture {
    texture: ID3D11Texture2D,
    shared_handle: Option<HANDLE>,
    y_handle: Option<HANDLE>,
    uv_handle: Option<HANDLE>,
}

#[cfg(target_os = "windows")]
unsafe impl Send for SendableD3D11Texture {}
#[cfg(target_os = "windows")]
unsafe impl Sync for SendableD3D11Texture {}

#[cfg(target_os = "windows")]
impl SendableD3D11Texture {
    pub fn new(texture: ID3D11Texture2D) -> Self {
        Self {
            texture,
            shared_handle: None,
            y_handle: None,
            uv_handle: None,
        }
    }

    pub fn new_with_handle(texture: ID3D11Texture2D, shared_handle: Option<HANDLE>) -> Self {
        Self {
            texture,
            shared_handle,
            y_handle: None,
            uv_handle: None,
        }
    }

    pub fn new_with_yuv_handles(
        texture: ID3D11Texture2D,
        shared_handle: Option<HANDLE>,
        y_handle: Option<HANDLE>,
        uv_handle: Option<HANDLE>,
    ) -> Self {
        Self {
            texture,
            shared_handle,
            y_handle,
            uv_handle,
        }
    }

    pub fn inner(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    pub fn shared_handle(&self) -> Option<HANDLE> {
        self.shared_handle
    }

    pub fn y_handle(&self) -> Option<HANDLE> {
        self.y_handle
    }

    pub fn uv_handle(&self) -> Option<HANDLE> {
        self.uv_handle
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelFormat {
    Rgba,
    Nv12,
    Yuv420p,
}

#[derive(Clone)]
pub struct DecodedFrame {
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    format: PixelFormat,
    y_stride: u32,
    uv_stride: u32,
    #[cfg(target_os = "windows")]
    d3d11_texture_backing: Option<Arc<SendableD3D11Texture>>,
}

impl fmt::Debug for DecodedFrame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecodedFrame")
            .field("data_len", &self.data.len())
            .field("width", &self.width)
            .field("height", &self.height)
            .field("format", &self.format)
            .field("y_stride", &self.y_stride)
            .field("uv_stride", &self.uv_stride)
            .finish()
    }
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
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
        }
    }

    pub fn new_with_arc(data: Arc<Vec<u8>>, width: u32, height: u32) -> Self {
        Self {
            data,
            width,
            height,
            format: PixelFormat::Rgba,
            y_stride: width * 4,
            uv_stride: 0,
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
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
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
        }
    }

    pub fn new_nv12_with_arc(
        data: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Self {
        Self {
            data,
            width,
            height,
            format: PixelFormat::Nv12,
            y_stride,
            uv_stride,
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
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
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
        }
    }

    pub fn new_yuv420p_with_arc(
        data: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
    ) -> Self {
        Self {
            data,
            width,
            height,
            format: PixelFormat::Yuv420p,
            y_stride,
            uv_stride,
            #[cfg(target_os = "windows")]
            d3d11_texture_backing: None,
        }
    }

    #[cfg(target_os = "windows")]
    pub fn new_nv12_with_d3d11_texture(width: u32, height: u32, texture: ID3D11Texture2D) -> Self {
        Self {
            data: Arc::new(Vec::new()),
            width,
            height,
            format: PixelFormat::Nv12,
            y_stride: width,
            uv_stride: width,
            d3d11_texture_backing: Some(Arc::new(SendableD3D11Texture::new(texture))),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn new_nv12_with_d3d11_texture_and_handle(
        width: u32,
        height: u32,
        texture: ID3D11Texture2D,
        shared_handle: Option<HANDLE>,
    ) -> Self {
        Self {
            data: Arc::new(Vec::new()),
            width,
            height,
            format: PixelFormat::Nv12,
            y_stride: width,
            uv_stride: width,
            d3d11_texture_backing: Some(Arc::new(SendableD3D11Texture::new_with_handle(
                texture,
                shared_handle,
            ))),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn new_nv12_with_d3d11_texture_and_yuv_handles(
        width: u32,
        height: u32,
        texture: ID3D11Texture2D,
        shared_handle: Option<HANDLE>,
        y_handle: Option<HANDLE>,
        uv_handle: Option<HANDLE>,
    ) -> Self {
        Self {
            data: Arc::new(Vec::new()),
            width,
            height,
            format: PixelFormat::Nv12,
            y_stride: width,
            uv_stride: width,
            d3d11_texture_backing: Some(Arc::new(SendableD3D11Texture::new_with_yuv_handles(
                texture,
                shared_handle,
                y_handle,
                uv_handle,
            ))),
        }
    }

    #[cfg(target_os = "windows")]
    #[allow(clippy::redundant_closure)]
    pub fn d3d11_texture_backing(&self) -> Option<&ID3D11Texture2D> {
        self.d3d11_texture_backing.as_ref().map(|b| b.inner())
    }

    #[cfg(target_os = "windows")]
    pub fn d3d11_shared_handle(&self) -> Option<HANDLE> {
        self.d3d11_texture_backing
            .as_ref()
            .and_then(|b| b.shared_handle())
    }

    #[cfg(target_os = "windows")]
    pub fn d3d11_y_handle(&self) -> Option<HANDLE> {
        self.d3d11_texture_backing
            .as_ref()
            .and_then(|b| b.y_handle())
    }

    #[cfg(target_os = "windows")]
    pub fn d3d11_uv_handle(&self) -> Option<HANDLE> {
        self.d3d11_texture_backing
            .as_ref()
            .and_then(|b| b.uv_handle())
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

pub const FRAME_CACHE_SIZE: usize = 90;

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
    offset: f64,
    status: DecoderStatus,
}

impl AsyncVideoDecoderHandle {
    const NORMAL_TIMEOUT_MS: u64 = 2000;
    const INITIAL_SEEK_TIMEOUT_MS: u64 = 10000;

    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        self.get_frame_with_timeout(time, Self::NORMAL_TIMEOUT_MS)
            .await
    }

    pub async fn get_frame_initial(&self, time: f32) -> Option<DecodedFrame> {
        self.get_frame_with_timeout(time, Self::INITIAL_SEEK_TIMEOUT_MS)
            .await
    }

    async fn get_frame_with_timeout(&self, time: f32, timeout_ms: u64) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let adjusted_time = self.get_time(time);

        if self
            .sender
            .send(VideoDecoderMessage::GetFrame(adjusted_time, tx))
            .is_err()
        {
            return None;
        }

        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
            Ok(result) => result.ok(),
            Err(_) => {
                tracing::warn!(
                    time = adjusted_time,
                    timeout_ms = timeout_ms,
                    "Frame decode request timed out"
                );
                None
            }
        }
    }

    pub fn get_time(&self, time: f32) -> f32 {
        time + self.offset as f32
    }

    pub fn decoder_status(&self) -> &DecoderStatus {
        &self.status
    }

    pub fn decoder_type(&self) -> DecoderType {
        self.status.decoder_type
    }

    pub fn is_hardware_accelerated(&self) -> bool {
        self.status.decoder_type.is_hardware_accelerated()
    }

    pub fn video_dimensions(&self) -> (u32, u32) {
        (self.status.video_width, self.status.video_height)
    }

    pub fn fallback_reason(&self) -> Option<&str> {
        self.status.fallback_reason.as_deref()
    }
}

#[cfg(target_os = "macos")]
async fn spawn_ffmpeg_decoder(
    name: &'static str,
    path: PathBuf,
    fps: u32,
    offset: f64,
    timeout_duration: Duration,
    path_display: &str,
) -> Result<AsyncVideoDecoderHandle, String> {
    let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
    let (tx, rx) = mpsc::channel();

    ffmpeg::FfmpegDecoder::spawn_with_hw_config(name, path, fps, rx, ready_tx, true)
        .map_err(|e| format!("'{name}' FFmpeg decoder / {e}"))?;

    match tokio::time::timeout(timeout_duration, ready_rx).await {
        Ok(Ok(Ok(init_result))) => {
            info!(
                "Video '{}' using {} decoder ({}x{})",
                name, init_result.decoder_type, init_result.width, init_result.height
            );
            let status = DecoderStatus {
                decoder_type: init_result.decoder_type,
                video_width: init_result.width,
                video_height: init_result.height,
                fallback_reason: None,
            };
            Ok(AsyncVideoDecoderHandle {
                sender: tx,
                offset,
                status,
            })
        }
        Ok(Ok(Err(e))) => Err(format!(
            "'{name}' FFmpeg decoder initialization failed: {e}"
        )),
        Ok(Err(e)) => Err(format!("'{name}' FFmpeg decoder channel closed: {e}")),
        Err(_) => Err(format!(
            "'{name}' FFmpeg decoder timed out after 30s initializing: {path_display}"
        )),
    }
}

pub async fn spawn_decoder(
    name: &'static str,
    path: PathBuf,
    fps: u32,
    offset: f64,
    force_ffmpeg: bool,
) -> Result<AsyncVideoDecoderHandle, String> {
    let path_display = path.display().to_string();
    let timeout_duration = Duration::from_secs(30);

    #[cfg(target_os = "macos")]
    {
        if force_ffmpeg {
            info!(
                "Video '{}' using FFmpeg decoder (forced via experimental setting)",
                name
            );
            return spawn_ffmpeg_decoder(name, path, fps, offset, timeout_duration, &path_display)
                .await;
        }

        let avasset_result = {
            let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
            let (tx, rx) = mpsc::channel();

            avassetreader::AVAssetReaderDecoder::spawn(name, path.clone(), fps, rx, ready_tx);

            match tokio::time::timeout(timeout_duration, ready_rx).await {
                Ok(Ok(Ok(init_result))) => {
                    info!(
                        "Video '{}' using {} decoder ({}x{})",
                        name, init_result.decoder_type, init_result.width, init_result.height
                    );
                    let status = DecoderStatus {
                        decoder_type: init_result.decoder_type,
                        video_width: init_result.width,
                        video_height: init_result.height,
                        fallback_reason: None,
                    };
                    Ok(AsyncVideoDecoderHandle {
                        sender: tx,
                        offset,
                        status,
                    })
                }
                Ok(Ok(Err(e))) => Err(format!("AVAssetReader initialization failed: {e}")),
                Ok(Err(e)) => Err(format!("AVAssetReader channel closed: {e}")),
                Err(_) => Err(format!(
                    "AVAssetReader timed out after 30s initializing: {path_display}"
                )),
            }
        };

        match avasset_result {
            Ok(handle) => Ok(handle),
            Err(avasset_error) => {
                tracing::warn!(
                    name = name,
                    error = %avasset_error,
                    "AVAssetReader failed, falling back to FFmpeg decoder"
                );

                let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
                let (tx, rx) = mpsc::channel();

                if let Err(e) = ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx) {
                    return Err(format!(
                        "'{name}' decoder failed - AVAssetReader: {avasset_error}, FFmpeg: {e}"
                    ));
                }

                match tokio::time::timeout(timeout_duration, ready_rx).await {
                    Ok(Ok(Ok(init_result))) => {
                        info!(
                            "Video '{}' using {} decoder ({}x{}) after AVAssetReader failure",
                            name, init_result.decoder_type, init_result.width, init_result.height
                        );
                        let status = DecoderStatus {
                            decoder_type: init_result.decoder_type,
                            video_width: init_result.width,
                            video_height: init_result.height,
                            fallback_reason: Some(avasset_error),
                        };
                        Ok(AsyncVideoDecoderHandle {
                            sender: tx,
                            offset,
                            status,
                        })
                    }
                    Ok(Ok(Err(e))) => Err(format!(
                        "'{name}' decoder failed - AVAssetReader: {avasset_error}, FFmpeg: {e}"
                    )),
                    Ok(Err(e)) => Err(format!(
                        "'{name}' decoder failed - AVAssetReader: {avasset_error}, FFmpeg channel: {e}"
                    )),
                    Err(_) => Err(format!(
                        "'{name}' decoder failed - AVAssetReader: {avasset_error}, FFmpeg timed out"
                    )),
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if force_ffmpeg {
            info!(
                "Video '{}' using FFmpeg decoder (forced via experimental setting)",
                name
            );
            let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
            let (tx, rx) = mpsc::channel();

            ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx)
                .map_err(|e| format!("'{name}' FFmpeg decoder / {e}"))?;

            return match tokio::time::timeout(timeout_duration, ready_rx).await {
                Ok(Ok(Ok(init_result))) => {
                    info!(
                        "Video '{}' using {} decoder ({}x{})",
                        name, init_result.decoder_type, init_result.width, init_result.height
                    );
                    let status = DecoderStatus {
                        decoder_type: init_result.decoder_type,
                        video_width: init_result.width,
                        video_height: init_result.height,
                        fallback_reason: None,
                    };
                    Ok(AsyncVideoDecoderHandle {
                        sender: tx,
                        offset,
                        status,
                    })
                }
                Ok(Ok(Err(e))) => Err(format!(
                    "'{name}' FFmpeg decoder initialization failed: {e}"
                )),
                Ok(Err(e)) => Err(format!("'{name}' FFmpeg decoder channel closed: {e}")),
                Err(_) => Err(format!(
                    "'{name}' FFmpeg decoder timed out after 30s initializing: {path_display}"
                )),
            };
        }

        let mf_result = {
            let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
            let (tx, rx) = mpsc::channel();

            match media_foundation::MFDecoder::spawn(name, path.clone(), fps, rx, ready_tx) {
                Ok(()) => match tokio::time::timeout(timeout_duration, ready_rx).await {
                    Ok(Ok(Ok(init_result))) => {
                        info!(
                            "Video '{}' using {} decoder ({}x{})",
                            name, init_result.decoder_type, init_result.width, init_result.height
                        );
                        let status = DecoderStatus {
                            decoder_type: init_result.decoder_type,
                            video_width: init_result.width,
                            video_height: init_result.height,
                            fallback_reason: None,
                        };
                        Ok(AsyncVideoDecoderHandle {
                            sender: tx,
                            offset,
                            status,
                        })
                    }
                    Ok(Ok(Err(e))) => Err(format!(
                        "'{name}' MediaFoundation initialization failed: {e} ({path_display})"
                    )),
                    Ok(Err(e)) => Err(format!(
                        "'{name}' MediaFoundation channel closed: {e} ({path_display})"
                    )),
                    Err(_) => Err(format!(
                        "'{name}' MediaFoundation timed out after 30s initializing: {path_display}"
                    )),
                },
                Err(e) => Err(format!(
                    "'{name}' MediaFoundation spawn failed: {e} ({path_display})"
                )),
            }
        };

        match mf_result {
            Ok(handle) => Ok(handle),
            Err(mf_error) => {
                tracing::warn!(
                    name = name,
                    error = %mf_error,
                    "MediaFoundation failed, falling back to FFmpeg decoder"
                );

                let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
                let (tx, rx) = mpsc::channel();

                if let Err(e) = ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx) {
                    return Err(format!(
                        "'{name}' decoder failed - MediaFoundation: {mf_error}, FFmpeg: {e}"
                    ));
                }

                match tokio::time::timeout(timeout_duration, ready_rx).await {
                    Ok(Ok(Ok(init_result))) => {
                        info!(
                            "Video '{}' using {} decoder ({}x{}) after MediaFoundation failure",
                            name, init_result.decoder_type, init_result.width, init_result.height
                        );
                        let status = DecoderStatus {
                            decoder_type: init_result.decoder_type,
                            video_width: init_result.width,
                            video_height: init_result.height,
                            fallback_reason: Some(mf_error),
                        };
                        Ok(AsyncVideoDecoderHandle {
                            sender: tx,
                            offset,
                            status,
                        })
                    }
                    Ok(Ok(Err(e))) => Err(format!(
                        "'{name}' decoder failed - MediaFoundation: {mf_error}, FFmpeg: {e}"
                    )),
                    Ok(Err(e)) => Err(format!(
                        "'{name}' decoder failed - MediaFoundation: {mf_error}, FFmpeg channel: {e}"
                    )),
                    Err(_) => Err(format!(
                        "'{name}' decoder failed - MediaFoundation: {mf_error}, FFmpeg timed out"
                    )),
                }
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = force_ffmpeg;
        let (ready_tx, ready_rx) = oneshot::channel::<Result<DecoderInitResult, String>>();
        let (tx, rx) = mpsc::channel();

        ffmpeg::FfmpegDecoder::spawn(name, path, fps, rx, ready_tx)
            .map_err(|e| format!("'{name}' decoder / {e}"))?;

        match tokio::time::timeout(timeout_duration, ready_rx).await {
            Ok(Ok(Ok(init_result))) => {
                info!(
                    "Video '{}' using {} decoder ({}x{})",
                    name, init_result.decoder_type, init_result.width, init_result.height
                );
                let status = DecoderStatus {
                    decoder_type: init_result.decoder_type,
                    video_width: init_result.width,
                    video_height: init_result.height,
                    fallback_reason: None,
                };
                Ok(AsyncVideoDecoderHandle {
                    sender: tx,
                    offset,
                    status,
                })
            }
            Ok(Ok(Err(e))) => Err(format!("'{name}' decoder initialization failed: {e}")),
            Ok(Err(e)) => Err(format!("'{name}' decoder channel closed: {e}")),
            Err(_) => Err(format!(
                "'{name}' decoder timed out after 30s initializing: {path_display}"
            )),
        }
    }
}
