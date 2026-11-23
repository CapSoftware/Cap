use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use cap_video_decode::FFmpegDecoder;
use ffmpeg::{
    format::Pixel,
    frame::Video,
    software::scaling::{Context as Scaler, Flags},
};

use crate::image::{GrayImage, RgbImage};

/// Width of the luma copy every frame is reduced to for change detection
/// and tracking.
pub const TRACK_WIDTH: u32 = 960;

pub struct FrameSource {
    decoder: FFmpegDecoder,
    time_base: f64,
    start: i64,
    pub width: u32,
    pub height: u32,
    pub track_width: u32,
    pub track_height: u32,
    gray_scaler: Option<(Pixel, Scaler)>,
    rgb_scaler: Option<(Pixel, Scaler)>,
    gray_frame: Video,
    rgb_frame: Video,
    last_pts: f64,
}

pub struct Frame {
    pub time: f64,
    pub video: Video,
}

fn hardware_device() -> Option<ffmpeg::sys::AVHWDeviceType> {
    if std::env::var_os("CAP_REDACT_SOFTWARE_DECODE").is_some() {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        Some(ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX)
    }
    #[cfg(target_os = "windows")]
    {
        Some(ffmpeg::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

impl FrameSource {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        ffmpeg::init().ok();
        let decoder = FFmpegDecoder::new(path.to_path_buf(), hardware_device())
            .map_err(|error| anyhow!("open {}: {error}", path.display()))?;
        let video = decoder.decoder();
        let width = video.width();
        let height = video.height();
        anyhow::ensure!(width > 0 && height > 0, "video has no size");
        let time_base = f64::from(video.time_base());
        let start = decoder.start_time();
        let track_width = TRACK_WIDTH.min(width);
        let track_height =
            ((height as f64 * track_width as f64 / width as f64).round() as u32).max(1);
        Ok(Self {
            decoder,
            time_base: if time_base > 0.0 {
                time_base
            } else {
                1.0 / 90_000.0
            },
            start: if start == ffmpeg::ffi::AV_NOPTS_VALUE {
                0
            } else {
                start
            },
            width,
            height,
            track_width,
            track_height,
            gray_scaler: None,
            rgb_scaler: None,
            gray_frame: Video::empty(),
            rgb_frame: Video::empty(),
            last_pts: -1.0,
        })
    }

    pub fn is_hardware_accelerated(&self) -> bool {
        self.decoder.is_hardware_accelerated()
    }

    /// Calls `visit` with every frame in order until it returns false.
    pub fn for_each(
        &mut self,
        mut visit: impl FnMut(&mut Self, Frame) -> anyhow::Result<bool>,
    ) -> anyhow::Result<()> {
        let time_base = self.time_base;
        let start = self.start;
        loop {
            let next = self.decoder.frames().next();
            let Some(frame) = next else { break };
            let video = frame.map_err(|error| anyhow!("decode: {error}"))?;
            let pts = video.pts().or_else(|| video.timestamp()).unwrap_or(0);
            let mut time = (pts - start) as f64 * time_base;
            if time <= self.last_pts {
                time = self.last_pts + 1e-4;
            }
            self.last_pts = time;
            if !visit(self, Frame { time, video })? {
                break;
            }
        }
        Ok(())
    }

    pub fn gray(&mut self, frame: &Video) -> anyhow::Result<GrayImage> {
        let format = frame.format();
        if self
            .gray_scaler
            .as_ref()
            .is_none_or(|(cached, _)| *cached != format)
        {
            let scaler = Scaler::get(
                format,
                frame.width(),
                frame.height(),
                Pixel::GRAY8,
                self.track_width,
                self.track_height,
                Flags::AREA,
            )
            .context("gray scaler")?;
            self.gray_scaler = Some((format, scaler));
        }
        let (_, scaler) = self.gray_scaler.as_mut().unwrap();
        scaler
            .run(frame, &mut self.gray_frame)
            .context("gray scale")?;
        let (w, h) = (self.track_width as usize, self.track_height as usize);
        let stride = self.gray_frame.stride(0);
        let data = self.gray_frame.data(0);
        let mut out = GrayImage::new(self.track_width, self.track_height);
        for y in 0..h {
            out.data[y * w..(y + 1) * w].copy_from_slice(&data[y * stride..y * stride + w]);
        }
        Ok(out)
    }

    pub fn rgb(&mut self, frame: &Video) -> anyhow::Result<RgbImage> {
        let format = frame.format();
        if self
            .rgb_scaler
            .as_ref()
            .is_none_or(|(cached, _)| *cached != format)
        {
            let scaler = Scaler::get(
                format,
                frame.width(),
                frame.height(),
                Pixel::RGB24,
                frame.width(),
                frame.height(),
                Flags::POINT,
            )
            .context("rgb scaler")?;
            self.rgb_scaler = Some((format, scaler));
        }
        let (_, scaler) = self.rgb_scaler.as_mut().unwrap();
        scaler
            .run(frame, &mut self.rgb_frame)
            .context("rgb convert")?;
        let (w, h) = (frame.width() as usize, frame.height() as usize);
        let stride = self.rgb_frame.stride(0);
        let data = self.rgb_frame.data(0);
        let mut out = RgbImage::new(frame.width(), frame.height());
        for y in 0..h {
            out.data[y * w * 3..(y + 1) * w * 3]
                .copy_from_slice(&data[y * stride..y * stride + w * 3]);
        }
        Ok(out)
    }
}

/// `size-mtime-hash` of the display video: file size (all fragments for a
/// fragmented recording), newest modification time, and a hash of the first
/// frame's luma.
pub fn fingerprint(path: &Path, first_frame: &GrayImage) -> String {
    let (size, modified) = file_stats(path);
    format!("{size}-{modified}-{:016x}", fnv1a(&first_frame.data))
}

pub fn file_stats(path: &Path) -> (u64, u64) {
    let files: Vec<PathBuf> = if path.is_dir() {
        std::fs::read_dir(path)
            .map(|entries| entries.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default()
    } else {
        vec![path.to_path_buf()]
    };
    let mut size = 0;
    let mut modified = 0;
    for file in files {
        if let Ok(meta) = std::fs::metadata(&file) {
            size += meta.len();
            let secs = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            modified = modified.max(secs);
        }
    }
    (size, modified)
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
