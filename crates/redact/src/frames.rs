use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use cap_video_decode::FFmpegDecoder;
use ffmpeg::{
    format::Pixel,
    frame::Video,
    software::scaling::{Context as Scaler, Flags},
};

use crate::image::{GrayImage, Rect, RgbImage};

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
    gray: GrayScale,
    last_pts: f64,
    /// The video stream's length from its first frame, if the file says.
    pub duration: Option<f64>,
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
        let duration = video_duration(path);
        let gray = GrayScale::new(width, height);
        let (track_width, track_height) = (gray.track_width, gray.track_height);
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
            gray,
            last_pts: -1.0,
            duration,
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
        self.gray.gray(frame)
    }
}

/// Scales frames to the tracking size as gray, the picture every frame is
/// compared and tracked on.
pub struct GrayScale {
    track_width: u32,
    track_height: u32,
    scaler: Option<(Pixel, Scaler)>,
    frame: Video,
}

impl GrayScale {
    /// For frames of `width` x `height`: at most [`TRACK_WIDTH`] wide, same
    /// aspect.
    pub fn new(width: u32, height: u32) -> Self {
        let track_width = TRACK_WIDTH.min(width);
        let track_height =
            ((height as f64 * track_width as f64 / width as f64).round() as u32).max(1);
        Self {
            track_width,
            track_height,
            scaler: None,
            frame: Video::empty(),
        }
    }

    pub fn track_width(&self) -> u32 {
        self.track_width
    }

    pub fn gray(&mut self, frame: &Video) -> anyhow::Result<GrayImage> {
        let format = frame.format();
        if self
            .scaler
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
            self.scaler = Some((format, scaler));
        }
        let (_, scaler) = self.scaler.as_mut().unwrap();
        scaler.run(frame, &mut self.frame).context("gray scale")?;
        let (w, h) = (self.track_width as usize, self.track_height as usize);
        let stride = self.frame.stride(0);
        let data = self.frame.data(0);
        let mut out = GrayImage::new(self.track_width, self.track_height);
        for y in 0..h {
            out.data[y * w..(y + 1) * w].copy_from_slice(&data[y * stride..y * stride + w]);
        }
        Ok(out)
    }
}

/// Converts decoded frames to full-resolution luma and RGB, apart from the
/// decoder so frames can be decoded on another thread.
pub struct Convert {
    rgb_scaler: Option<(Pixel, Scaler)>,
    luma_scaler: Option<(Pixel, Scaler)>,
    luma_frame: Video,
    rgb_frame: Video,
}

impl Default for Convert {
    fn default() -> Self {
        Self {
            rgb_scaler: None,
            luma_scaler: None,
            luma_frame: Video::empty(),
            rgb_frame: Video::empty(),
        }
    }
}

impl Convert {
    /// Full-resolution luma: the frame's Y plane when it has one, otherwise
    /// a conversion.
    pub fn luma(&mut self, frame: &Video) -> anyhow::Result<GrayImage> {
        let (w, h) = (frame.width() as usize, frame.height() as usize);
        let format = frame.format();
        let mut out = GrayImage::new(frame.width(), frame.height());
        if matches!(
            format,
            Pixel::NV12 | Pixel::YUV420P | Pixel::YUVJ420P | Pixel::YUV444P | Pixel::GRAY8
        ) {
            let stride = frame.stride(0);
            let data = frame.data(0);
            for y in 0..h {
                out.data[y * w..(y + 1) * w].copy_from_slice(&data[y * stride..y * stride + w]);
            }
            return Ok(out);
        }
        if self
            .luma_scaler
            .as_ref()
            .is_none_or(|(cached, _)| *cached != format)
        {
            let scaler = Scaler::get(
                format,
                frame.width(),
                frame.height(),
                Pixel::GRAY8,
                frame.width(),
                frame.height(),
                Flags::POINT,
            )
            .context("luma scaler")?;
            self.luma_scaler = Some((format, scaler));
        }
        let (_, scaler) = self.luma_scaler.as_mut().unwrap();
        scaler
            .run(frame, &mut self.luma_frame)
            .context("luma convert")?;
        let stride = self.luma_frame.stride(0);
        let data = self.luma_frame.data(0);
        for y in 0..h {
            out.data[y * w..(y + 1) * w].copy_from_slice(&data[y * stride..y * stride + w]);
        }
        Ok(out)
    }

    /// RGB of the pixels inside `regions` only, the rest left black, when
    /// the frame is 4:2:0 YUV (what the decoders here produce); the whole
    /// frame otherwise. The boolean says whether only the regions were filled.
    pub fn rgb_regions(
        &mut self,
        frame: &Video,
        regions: &[Rect],
    ) -> anyhow::Result<(RgbImage, bool)> {
        if !partial_supported(frame) {
            return Ok((self.rgb(frame)?, false));
        }
        let mut out = RgbImage::new(frame.width(), frame.height());
        fill_rgb(frame, &mut out, regions);
        Ok((out, true))
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

fn partial_supported(frame: &Video) -> bool {
    matches!(frame.format(), Pixel::NV12 | Pixel::YUV420P)
}

/// Converts the pixels of `frame` inside `regions` into `image` (BT.601
/// limited range, nearest chroma: what the full-frame scaler does). Does
/// nothing for formats [`FrameSource::rgb_regions`] converts whole.
pub fn fill_rgb(frame: &Video, image: &mut RgbImage, regions: &[Rect]) {
    if !partial_supported(frame) {
        return;
    }
    let nv12 = frame.format() == Pixel::NV12;
    let (width, height) = (frame.width() as usize, frame.height() as usize);
    let (y_stride, y_plane) = (frame.stride(0), frame.data(0));
    let (u_stride, u_plane) = (frame.stride(1), frame.data(1));
    let (v_stride, v_plane) = if nv12 {
        (0, &[][..])
    } else {
        (frame.stride(2), frame.data(2))
    };
    let mut spans = Vec::new();
    for region in regions {
        let r = region.clamp_to(frame.width(), frame.height());
        let (x0, y0) = (r.x.floor().max(0.0) as usize, r.y.floor().max(0.0) as usize);
        let x1 = (r.right().ceil() as usize).min(width);
        let y1 = (r.bottom().ceil() as usize).min(height);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        for y in y0..y1 {
            // Only the parts of the row no earlier region converted.
            spans.clear();
            spans.extend(
                image
                    .filled
                    .iter()
                    .filter(|f| f[1] <= y && y < f[3] && f[0] < x1 && f[2] > x0)
                    .map(|f| (f[0], f[2])),
            );
            spans.sort_unstable();
            let luma = &y_plane[y * y_stride..y * y_stride + width];
            let out = &mut image.data[y * width * 3..(y + 1) * width * 3];
            let mut x = x0;
            for &(a, b) in spans.iter().chain(std::iter::once(&(x1, x1))) {
                let end = a.min(x1);
                if end > x {
                    if nv12 {
                        let chroma = &u_plane[(y / 2) * u_stride..];
                        for x in x..end {
                            let index = (x / 2) * 2;
                            out[x * 3..x * 3 + 3].copy_from_slice(&yuv_to_rgb(
                                luma[x],
                                chroma[index],
                                chroma[index + 1],
                            ));
                        }
                    } else {
                        let u_row = &u_plane[(y / 2) * u_stride..];
                        let v_row = &v_plane[(y / 2) * v_stride..];
                        for x in x..end {
                            out[x * 3..x * 3 + 3].copy_from_slice(&yuv_to_rgb(
                                luma[x],
                                u_row[x / 2],
                                v_row[x / 2],
                            ));
                        }
                    }
                }
                x = x.max(b);
                if x >= x1 {
                    break;
                }
            }
        }
        image.filled.push([x0, y0, x1, y1]);
    }
}

fn yuv_to_rgb(y: u8, u: u8, v: u8) -> [u8; 3] {
    let c = 298 * (i32::from(y) - 16);
    let d = i32::from(u) - 128;
    let e = i32::from(v) - 128;
    let clamp = |value: i32| ((value + 128) >> 8).clamp(0, 255) as u8;
    [
        clamp(c + 409 * e),
        clamp(c - 100 * d - 208 * e),
        clamp(c + 516 * d),
    ]
}

/// The video stream's length as the file reports it (the stream's own
/// duration, else the container's).
pub fn video_duration(path: &Path) -> Option<f64> {
    ffmpeg::init().ok();
    let input = ffmpeg::format::input(path).ok()?;
    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    let base = f64::from(stream.time_base());
    if stream.duration() > 0 && base > 0.0 {
        return Some(stream.duration() as f64 * base);
    }
    (input.duration() > 0).then(|| input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE))
}

/// How many frames the video stream holds: the stream's own count, else its
/// packets counted without decoding.
pub fn video_frame_count(path: &Path) -> Option<u64> {
    ffmpeg::init().ok();
    let mut input = ffmpeg::format::input(path).ok()?;
    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    if stream.frames() > 0 {
        return u64::try_from(stream.frames()).ok();
    }
    let index = stream.index();
    Some(
        input
            .packets()
            .filter(|(stream, _)| stream.index() == index)
            .count() as u64,
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sws_rgb(frame: &Video) -> Video {
        let mut scaler = Scaler::get(
            frame.format(),
            frame.width(),
            frame.height(),
            Pixel::RGB24,
            frame.width(),
            frame.height(),
            Flags::POINT,
        )
        .unwrap();
        let mut out = Video::empty();
        scaler.run(frame, &mut out).unwrap();
        out
    }

    #[test]
    fn overlapping_regions_fill_like_one_pass() {
        ffmpeg::init().ok();
        for format in [Pixel::NV12, Pixel::YUV420P] {
            let (w, h) = (64u32, 40u32);
            let mut frame = Video::new(format, w, h);
            let mut seed = 3u32;
            for plane in 0..frame.planes() {
                for value in frame.data_mut(plane) {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    *value = (seed >> 16) as u8;
                }
            }
            let regions = [
                Rect::new(3.5, 2.2, 30.0, 20.0),
                Rect::new(10.0, 5.0, 40.7, 9.0),
                Rect::new(0.0, 15.0, 64.0, 4.0),
                Rect::new(12.0, 6.0, 5.0, 5.0),
                Rect::new(50.0, 30.0, 30.0, 30.0),
            ];
            let mut together = RgbImage::new(w, h);
            fill_rgb(&frame, &mut together, &regions);
            let mut stepwise = RgbImage::new(w, h);
            for region in &regions {
                fill_rgb(&frame, &mut stepwise, std::slice::from_ref(region));
            }
            assert_eq!(together.data, stepwise.data);
            let mut whole = RgbImage::new(w, h);
            fill_rgb(
                &frame,
                &mut whole,
                &[Rect::new(0.0, 0.0, w as f32, h as f32)],
            );
            for (i, (t, full)) in together.data.iter().zip(&whole.data).enumerate() {
                let (x, y) = ((i / 3) % w as usize, (i / 3) / w as usize);
                let inside = regions.iter().any(|r| {
                    let r = r.clamp_to(w, h);
                    x >= r.x.floor() as usize
                        && x < r.right().ceil() as usize
                        && y >= r.y.floor() as usize
                        && y < r.bottom().ceil() as usize
                });
                assert_eq!(*t, if inside { *full } else { 0 }, "{format:?} {x},{y}");
            }
        }
    }

    #[test]
    fn region_conversion_matches_the_scaler() {
        ffmpeg::init().ok();
        for format in [Pixel::NV12, Pixel::YUV420P] {
            let (w, h) = (96u32, 48u32);
            let mut frame = Video::new(format, w, h);
            let mut seed = 11u32;
            for plane in 0..frame.planes() {
                for value in frame.data_mut(plane) {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    *value = (seed >> 16) as u8;
                }
            }
            let expected = sws_rgb(&frame);
            let mut image = RgbImage::new(w, h);
            fill_rgb(
                &frame,
                &mut image,
                &[Rect::new(0.0, 0.0, w as f32, h as f32)],
            );
            let stride = expected.stride(0);
            let mut worst = 0u8;
            for y in 0..h as usize {
                for x in 0..(w as usize * 3) {
                    let a = expected.data(0)[y * stride + x];
                    let b = image.data[y * w as usize * 3 + x];
                    worst = worst.max(a.abs_diff(b));
                }
            }
            assert!(worst <= 3, "{format:?} differs by {worst}");
        }
    }
}
