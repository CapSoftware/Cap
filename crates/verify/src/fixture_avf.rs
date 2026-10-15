//! macOS: writes a track through the product's AVFoundation encoder
//! (`cap-enc-avfoundation`, AVAssetWriter + VideoToolbox), the encoder Studio
//! recordings use on macOS, fed NV12 IOSurface buffers with exact times.

use std::{path::Path, time::Duration};

use anyhow::{anyhow, bail};
use cap_enc_avfoundation::{MP4Encoder, QueueFrameError};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cidre::{arc, cf, cm, cv};

use crate::video_code::{self, FrameMarker};

pub fn pixel_buffer(
    width: usize,
    height: usize,
    rgba: &[u8],
) -> anyhow::Result<arc::R<cv::PixelBuf>> {
    let io_surface_properties = cf::Dictionary::new();
    let keys: [&cf::Type; 1] = [cv::pixel_buffer::keys::io_surf_props().as_ref()];
    let values: [&cf::Type; 1] = [io_surface_properties.as_ref()];
    let attrs = cf::Dictionary::with_keys_values(&keys, &values)
        .ok_or_else(|| anyhow!("pixel buffer attributes"))?;
    let mut buf = cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
        .map_err(|e| anyhow!("pixel buffer: {e:?}"))?;
    unsafe {
        buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()
            .map_err(|e| anyhow!("lock: {e:?}"))?;
        let y_stride = buf.plane_bytes_per_row(0);
        let uv_stride = buf.plane_bytes_per_row(1);
        let y_base = buf.plane_base_address(0).cast_mut();
        let uv_base = buf.plane_base_address(1).cast_mut();
        let ycc = |x: usize, y: usize| {
            let i = (y * width + x) * 4;
            video_code::rgb_to_ycbcr(rgba[i], rgba[i + 1], rgba[i + 2])
        };
        for y in 0..height {
            for x in 0..width {
                let (l, _, _) = ycc(x, y);
                *y_base.add(y * y_stride + x) = (16.0 + l * 219.0 / 255.0).round() as u8;
            }
        }
        for y in 0..height / 2 {
            for x in 0..width / 2 {
                let (_, cb, cr) = ycc(x * 2, y * 2);
                *uv_base.add(y * uv_stride + x * 2) = (128.0 + cb * 224.0 / 255.0).round() as u8;
                *uv_base.add(y * uv_stride + x * 2 + 1) =
                    (128.0 + cr * 224.0 / 255.0).round() as u8;
            }
        }
        buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
    }
    Ok(buf)
}

pub fn write_video_track(
    path: &Path,
    marker_for: impl Fn(u32) -> FrameMarker,
    width: u32,
    height: u32,
    fps: u32,
    times: &[(u32, f64)],
) -> anyhow::Result<()> {
    let info = VideoInfo::from_raw(RawVideoFormat::Nv12, width, height, fps);
    let mut encoder =
        MP4Encoder::init(path.to_path_buf(), info, None, None).map_err(|e| anyhow!("{e}"))?;
    let mut last = Duration::ZERO;
    for &(slot, pts) in times {
        let rgba = video_code::marker_rgba(marker_for(slot), width as usize, height as usize);
        let buf = pixel_buffer(width as usize, height as usize, &rgba)?;
        let format_desc = cm::VideoFormatDesc::with_image_buf(&buf)
            .map_err(|e| anyhow!("format description: {e:?}"))?;
        let timing = cm::SampleTimingInfo {
            duration: cm::Time::new(1_000_000 / i64::from(fps), 1_000_000),
            pts: cm::Time::new((pts * 1e6).round() as i64, 1_000_000),
            dts: cm::Time::invalid(),
        };
        let sample = cm::SampleBuf::with_image_buf(
            &buf,
            true,
            None,
            std::ptr::null(),
            &format_desc,
            &timing,
        )
        .map_err(|e| anyhow!("sample buffer: {e:?}"))?;
        let timestamp = Duration::from_secs_f64(pts);
        let mut queued = false;
        for _ in 0..20_000 {
            match encoder.queue_video_frame(sample.clone(), timestamp) {
                Ok(()) => {
                    queued = true;
                    break;
                }
                Err(QueueFrameError::NotReadyForMore) => {
                    std::thread::sleep(Duration::from_micros(250));
                }
                Err(e) => bail!("queue frame at {pts}: {e}"),
            }
        }
        if !queued {
            bail!("encoder never became ready at {pts}");
        }
        last = timestamp;
    }
    encoder
        .finish(Some(last + Duration::from_secs_f64(1.0 / f64::from(fps))))
        .map_err(|e| anyhow!("finish: {e}"))?;
    Ok(())
}
