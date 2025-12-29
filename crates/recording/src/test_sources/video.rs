use crate::output_pipeline::{FFmpegVideoFrame, SetupCtx, VideoSource};
use cap_media_info::{Pixel, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
use ffmpeg::util::rational::Rational as FFRational;
use futures::{FutureExt, channel::mpsc};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

use super::{TestPattern, VideoTestConfig};

pub struct TestPatternVideoSource {
    info: VideoInfo,
    stop_flag: Arc<AtomicBool>,
}

pub struct TestPatternVideoSourceConfig {
    pub video_config: VideoTestConfig,
    pub duration: Duration,
    pub timestamps: Timestamps,
    pub cancel_token: CancellationToken,
}

impl VideoSource for TestPatternVideoSource {
    type Config = TestPatternVideoSourceConfig;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self> {
        let video_config = config.video_config;
        let info = VideoInfo {
            pixel_format: video_config.pixel_format,
            width: video_config.width,
            height: video_config.height,
            time_base: FFRational(1, 1_000_000),
            frame_rate: FFRational(video_config.frame_rate as i32, 1),
        };

        let pattern = video_config.pattern;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let cancel_token = config.cancel_token;

        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(video_config.frame_rate));
        let total_frames =
            (config.duration.as_secs_f64() * f64::from(video_config.frame_rate)) as u64;

        ctx.tasks().spawn("synthetic-video-generator", {
            let stop_flag = stop_flag.clone();
            let cancel_token = cancel_token.clone();
            let timestamps = config.timestamps;
            let mut video_tx = video_tx;

            async move {
                let mut frame_number = 0u64;
                let start_instant = timestamps.instant();

                loop {
                    if stop_flag.load(Ordering::Relaxed) || cancel_token.is_cancelled() {
                        break;
                    }

                    if frame_number >= total_frames {
                        break;
                    }

                    let target_time = start_instant + frame_duration * frame_number as u32;
                    let now = std::time::Instant::now();
                    if target_time > now {
                        tokio::time::sleep(target_time - now).await;
                    }

                    let frame = generate_video_frame(&info, pattern, frame_number);

                    let timestamp =
                        Timestamp::Instant(start_instant + frame_duration * frame_number as u32);

                    let ffmpeg_frame = FFmpegVideoFrame {
                        inner: frame,
                        timestamp,
                    };

                    if video_tx.try_send(ffmpeg_frame).is_err() {
                        if stop_flag.load(Ordering::Relaxed) || cancel_token.is_cancelled() {
                            break;
                        }
                        tracing::warn!("Video frame channel full, frame {} dropped", frame_number);
                    }

                    frame_number += 1;
                }

                tracing::info!(
                    "Synthetic video generator finished after {} frames",
                    frame_number
                );
                Ok(())
            }
        });

        Ok(Self { info, stop_flag })
    }

    fn video_info(&self) -> VideoInfo {
        self.info
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.stop_flag.store(true, Ordering::Relaxed);
        async { Ok(()) }.boxed()
    }
}

fn generate_video_frame(
    info: &VideoInfo,
    pattern: TestPattern,
    frame_number: u64,
) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(info.pixel_format, info.width, info.height);
    frame.set_pts(Some((frame_number * 33333) as i64));

    match pattern {
        TestPattern::SmpteColorBars => {
            fill_smpte_bars(&mut frame, info);
        }
        TestPattern::ColorGradient => {
            fill_color_gradient(&mut frame, info, frame_number);
        }
        TestPattern::FrameCounter => {
            fill_frame_counter(&mut frame, info, frame_number);
        }
        TestPattern::TimestampOverlay => {
            fill_timestamp_overlay(&mut frame, info, frame_number);
        }
        TestPattern::Checkerboard => {
            fill_checkerboard(&mut frame, info, frame_number);
        }
        TestPattern::SolidColor { r, g, b } => {
            fill_solid_color(&mut frame, info, r, g, b);
        }
        TestPattern::Random => {
            fill_random(&mut frame, info, frame_number);
        }
    }

    frame
}

fn fill_smpte_bars(frame: &mut ffmpeg::frame::Video, info: &VideoInfo) {
    let colors_rgb: [(u8, u8, u8); 8] = [
        (192, 192, 192),
        (192, 192, 0),
        (0, 192, 192),
        (0, 192, 0),
        (192, 0, 192),
        (192, 0, 0),
        (0, 0, 192),
        (0, 0, 0),
    ];

    let width = info.width as usize;
    let height = info.height as usize;
    let bar_width = width / 8;

    match info.pixel_format {
        Pixel::BGRA | Pixel::RGBA => {
            let stride = frame.stride(0);
            let is_bgra = info.pixel_format == Pixel::BGRA;
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let bar_idx = (x / bar_width).min(7);
                    let (r, g, b) = colors_rgb[bar_idx];
                    let offset = y * stride + x * 4;

                    if offset + 3 < data.len() {
                        if is_bgra {
                            data[offset] = b;
                            data[offset + 1] = g;
                            data[offset + 2] = r;
                            data[offset + 3] = 255;
                        } else {
                            data[offset] = r;
                            data[offset + 1] = g;
                            data[offset + 2] = b;
                            data[offset + 3] = 255;
                        }
                    }
                }
            }
        }
        Pixel::NV12 => {
            let y_stride = frame.stride(0);
            let uv_stride = frame.stride(1);

            {
                let y_data = frame.data_mut(0);
                for y in 0..height {
                    for x in 0..width {
                        let bar_idx = (x / bar_width).min(7);
                        let (r, g, b) = colors_rgb[bar_idx];
                        let y_val = rgb_to_y(r, g, b);

                        let y_offset = y * y_stride + x;
                        if y_offset < y_data.len() {
                            y_data[y_offset] = y_val;
                        }
                    }
                }
            }

            {
                let uv_data = frame.data_mut(1);
                for y in (0..height).step_by(2) {
                    for x in (0..width).step_by(2) {
                        let bar_idx = (x / bar_width).min(7);
                        let (r, g, b) = colors_rgb[bar_idx];
                        let (u, v) = rgb_to_uv(r, g, b);

                        let uv_offset = (y / 2) * uv_stride + x;
                        if uv_offset + 1 < uv_data.len() {
                            uv_data[uv_offset] = u;
                            uv_data[uv_offset + 1] = v;
                        }
                    }
                }
            }
        }
        _ => {
            fill_random_fallback(frame, info, 0);
        }
    }
}

fn fill_color_gradient(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, frame_number: u64) {
    let width = info.width as usize;
    let height = info.height as usize;
    let phase = (frame_number % 256) as u8;

    match info.pixel_format {
        Pixel::BGRA | Pixel::RGBA => {
            let stride = frame.stride(0);
            let is_bgra = info.pixel_format == Pixel::BGRA;
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let r = ((x * 255 / width) as u8).wrapping_add(phase);
                    let g = ((y * 255 / height) as u8).wrapping_add(phase);
                    let b = (((x + y) * 255 / (width + height)) as u8).wrapping_add(phase);

                    let offset = y * stride + x * 4;
                    if offset + 3 < data.len() {
                        if is_bgra {
                            data[offset] = b;
                            data[offset + 1] = g;
                            data[offset + 2] = r;
                            data[offset + 3] = 255;
                        } else {
                            data[offset] = r;
                            data[offset + 1] = g;
                            data[offset + 2] = b;
                            data[offset + 3] = 255;
                        }
                    }
                }
            }
        }
        Pixel::NV12 => {
            fill_nv12_gradient(frame, info, phase);
        }
        _ => {
            fill_random_fallback(frame, info, frame_number);
        }
    }
}

fn fill_frame_counter(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, frame_number: u64) {
    let width = info.width as usize;
    let height = info.height as usize;

    let frame_bytes = frame_number.to_le_bytes();

    match info.pixel_format {
        Pixel::BGRA | Pixel::RGBA => {
            let stride = frame.stride(0);
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let intensity = if y < 64 && x < 256 {
                        let byte_idx = x / 32;
                        let bit_idx = (x % 32) / 4;
                        if byte_idx < 8 {
                            let byte = frame_bytes[byte_idx];
                            if (byte >> bit_idx) & 1 == 1 { 255 } else { 0 }
                        } else {
                            128
                        }
                    } else {
                        ((frame_number % 256) as u8).wrapping_add(((x ^ y) & 0xFF) as u8)
                    };

                    let offset = y * stride + x * 4;
                    if offset + 3 < data.len() {
                        data[offset] = intensity;
                        data[offset + 1] = intensity;
                        data[offset + 2] = intensity;
                        data[offset + 3] = 255;
                    }
                }
            }
        }
        Pixel::NV12 => {
            fill_nv12_frame_counter(frame, info, frame_number, &frame_bytes);
        }
        _ => {
            fill_random_fallback(frame, info, frame_number);
        }
    }
}

fn fill_timestamp_overlay(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, frame_number: u64) {
    fill_frame_counter(frame, info, frame_number);
}

fn fill_checkerboard(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, frame_number: u64) {
    let width = info.width as usize;
    let height = info.height as usize;
    let check_size = 32;
    let offset = (frame_number % (check_size as u64 * 2)) as usize;

    match info.pixel_format {
        Pixel::BGRA | Pixel::RGBA => {
            let stride = frame.stride(0);
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let check_x = (x + offset) / check_size;
                    let check_y = y / check_size;
                    let is_white = (check_x + check_y) % 2 == 0;
                    let val = if is_white { 255 } else { 0 };

                    let pixel_offset = y * stride + x * 4;
                    if pixel_offset + 3 < data.len() {
                        data[pixel_offset] = val;
                        data[pixel_offset + 1] = val;
                        data[pixel_offset + 2] = val;
                        data[pixel_offset + 3] = 255;
                    }
                }
            }
        }
        Pixel::NV12 => {
            fill_nv12_checkerboard(frame, info, check_size, offset);
        }
        _ => {
            fill_random_fallback(frame, info, frame_number);
        }
    }
}

fn fill_solid_color(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, r: u8, g: u8, b: u8) {
    let width = info.width as usize;
    let height = info.height as usize;

    match info.pixel_format {
        Pixel::BGRA => {
            let stride = frame.stride(0);
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let offset = y * stride + x * 4;
                    if offset + 3 < data.len() {
                        data[offset] = b;
                        data[offset + 1] = g;
                        data[offset + 2] = r;
                        data[offset + 3] = 255;
                    }
                }
            }
        }
        Pixel::RGBA => {
            let stride = frame.stride(0);
            let data = frame.data_mut(0);

            for y in 0..height {
                for x in 0..width {
                    let offset = y * stride + x * 4;
                    if offset + 3 < data.len() {
                        data[offset] = r;
                        data[offset + 1] = g;
                        data[offset + 2] = b;
                        data[offset + 3] = 255;
                    }
                }
            }
        }
        Pixel::NV12 => {
            let y_val = rgb_to_y(r, g, b);
            let (u_val, v_val) = rgb_to_uv(r, g, b);

            let y_stride = frame.stride(0);
            let uv_stride = frame.stride(1);

            {
                let data = frame.data_mut(0);
                for y in 0..height {
                    for x in 0..width {
                        let offset = y * y_stride + x;
                        if offset < data.len() {
                            data[offset] = y_val;
                        }
                    }
                }
            }

            {
                let uv_data = frame.data_mut(1);
                for y in 0..(height / 2) {
                    for x in 0..(width / 2) {
                        let offset = y * uv_stride + x * 2;
                        if offset + 1 < uv_data.len() {
                            uv_data[offset] = u_val;
                            uv_data[offset + 1] = v_val;
                        }
                    }
                }
            }
        }
        _ => {
            fill_random_fallback(frame, info, 0);
        }
    }
}

fn fill_random(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, frame_number: u64) {
    fill_random_fallback(frame, info, frame_number);
}

fn fill_random_fallback(frame: &mut ffmpeg::frame::Video, _info: &VideoInfo, frame_number: u64) {
    for plane_idx in 0..frame.planes() {
        let data = frame.data_mut(plane_idx);
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = ((i
                .wrapping_mul(17)
                .wrapping_add(plane_idx * 31)
                .wrapping_add(frame_number as usize))
                % 256) as u8;
        }
    }
}

fn fill_nv12_gradient(frame: &mut ffmpeg::frame::Video, info: &VideoInfo, phase: u8) {
    let width = info.width as usize;
    let height = info.height as usize;

    let y_stride = frame.stride(0);
    let uv_stride = frame.stride(1);

    {
        let y_data = frame.data_mut(0);
        for y in 0..height {
            for x in 0..width {
                let val = (((x * 255 / width) + (y * 255 / height)) / 2) as u8;
                let y_offset = y * y_stride + x;
                if y_offset < y_data.len() {
                    y_data[y_offset] = val.wrapping_add(phase);
                }
            }
        }
    }

    {
        let uv_data = frame.data_mut(1);
        for y in 0..(height / 2) {
            for x in 0..(width / 2) {
                let uv_offset = y * uv_stride + x * 2;
                if uv_offset + 1 < uv_data.len() {
                    uv_data[uv_offset] = 128;
                    uv_data[uv_offset + 1] = 128;
                }
            }
        }
    }
}

fn fill_nv12_frame_counter(
    frame: &mut ffmpeg::frame::Video,
    info: &VideoInfo,
    frame_number: u64,
    frame_bytes: &[u8; 8],
) {
    let width = info.width as usize;
    let height = info.height as usize;

    let y_stride = frame.stride(0);
    let uv_stride = frame.stride(1);

    {
        let y_data = frame.data_mut(0);
        for y in 0..height {
            for x in 0..width {
                let intensity = if y < 64 && x < 256 {
                    let byte_idx = x / 32;
                    let bit_idx = (x % 32) / 4;
                    if byte_idx < 8 {
                        let byte = frame_bytes[byte_idx];
                        if (byte >> bit_idx) & 1 == 1 { 235 } else { 16 }
                    } else {
                        128
                    }
                } else {
                    ((frame_number % 220) as u8).wrapping_add(16)
                };

                let y_offset = y * y_stride + x;
                if y_offset < y_data.len() {
                    y_data[y_offset] = intensity;
                }
            }
        }
    }

    {
        let uv_data = frame.data_mut(1);
        for y in 0..(height / 2) {
            for x in 0..(width / 2) {
                let uv_offset = y * uv_stride + x * 2;
                if uv_offset + 1 < uv_data.len() {
                    uv_data[uv_offset] = 128;
                    uv_data[uv_offset + 1] = 128;
                }
            }
        }
    }
}

fn fill_nv12_checkerboard(
    frame: &mut ffmpeg::frame::Video,
    info: &VideoInfo,
    check_size: usize,
    offset: usize,
) {
    let width = info.width as usize;
    let height = info.height as usize;

    let y_stride = frame.stride(0);
    let uv_stride = frame.stride(1);

    {
        let y_data = frame.data_mut(0);
        for y in 0..height {
            for x in 0..width {
                let check_x = (x + offset) / check_size;
                let check_y = y / check_size;
                let is_white = (check_x + check_y) % 2 == 0;
                let val = if is_white { 235 } else { 16 };

                let y_offset = y * y_stride + x;
                if y_offset < y_data.len() {
                    y_data[y_offset] = val;
                }
            }
        }
    }

    {
        let uv_data = frame.data_mut(1);
        for y in 0..(height / 2) {
            for x in 0..(width / 2) {
                let uv_offset = y * uv_stride + x * 2;
                if uv_offset + 1 < uv_data.len() {
                    uv_data[uv_offset] = 128;
                    uv_data[uv_offset + 1] = 128;
                }
            }
        }
    }
}

fn rgb_to_y(r: u8, g: u8, b: u8) -> u8 {
    let y = 16.0 + (65.481 * f64::from(r) + 128.553 * f64::from(g) + 24.966 * f64::from(b)) / 255.0;
    y.clamp(16.0, 235.0) as u8
}

fn rgb_to_uv(r: u8, g: u8, b: u8) -> (u8, u8) {
    let u = 128.0 + (-37.797 * f64::from(r) - 74.203 * f64::from(g) + 112.0 * f64::from(b)) / 255.0;
    let v = 128.0 + (112.0 * f64::from(r) - 93.786 * f64::from(g) - 18.214 * f64::from(b)) / 255.0;
    (u.clamp(16.0, 240.0) as u8, v.clamp(16.0, 240.0) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rgb_to_yuv_black() {
        let y = rgb_to_y(0, 0, 0);
        let (u, v) = rgb_to_uv(0, 0, 0);
        assert_eq!(y, 16);
        assert_eq!(u, 128);
        assert_eq!(v, 128);
    }

    #[test]
    fn test_rgb_to_yuv_white() {
        let y = rgb_to_y(255, 255, 255);
        assert_eq!(y, 235);
    }

    #[test]
    fn test_video_info_creation() {
        let config = VideoTestConfig::fhd_1080p();
        let info = VideoInfo {
            pixel_format: config.pixel_format,
            width: config.width,
            height: config.height,
            time_base: FFRational(1, 1_000_000),
            frame_rate: FFRational(config.frame_rate as i32, 1),
        };

        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert_eq!(info.pixel_format, Pixel::NV12);
    }
}
