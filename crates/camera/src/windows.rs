use std::time::Duration;

use cap_camera_windows::*;
use ffmpeg::format::Pixel;

use crate::*;

pub(super) fn list_cameras_impl() -> Vec<CameraInfo> {
    let devices = cap_camera_windows::list_devices().unwrap_or_default();

    devices.into_iter().filter_map(|d| {
        Some(CameraInfo {
            model_id: ModelID::from_windows(&d)?,
            display_name: d.name().to_string_lossy().to_string(),
        })
    })
}

impl ModelID {
    pub(super) fn formats_impl(&self) -> Option<Vec<Format>> {
        let devices = cap_camera_windows::get_devices().ok()?;

        let device = devices
            .iter()
            .find(|d| ModelID::from_windows(d).as_ref() == Some(self))?;

        let mut ret = vec![];

        for format in device.formats() {
            ret.push(Format {
                native: format.inner,
                info: FormatInfo {
                    width: format.width(),
                    height: format.height(),
                    frame_rate: format.frame_rate(),
                },
            })
        }
    }

    fn from_windows(device: &VideoDeviceInfo) -> Option<Self> {
        let model_id: String = device.model_id()?;

        let vid = &model_id[0..4];
        let pid = &model_id[5..9];

        Some(Self {
            vid: vid.to_string(),
            pid: pid.to_string(),
        })
    }
}

pub type NativeFormat = VideoFormat;

pub struct NativeCapturedFrame(Frame);

pub(super) fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: impl FnMut(CapturedFrame) + 'static,
) -> Result<WindowsRecordingHandle, StartCaptureError> {
    let devices = cap_camera_windows::get_devices().ok()?;
    let mut device = devices
        .into_iter()
        .find(|d| ModelID::from_windows(d).as_ref() == Some(camera.model_id()))
        .ok_or(StartCaptureError::DeviceNotFound)?;

    std::thread::spawn(|| {
        for frame in device.start_capturing(&format.native).unwrap() {
            let Ok(frame) = frame else {
                return;
            };

            callback(frame);

            std::thread::sleep(Duration::from_millis(10));
        }
    });
}

impl Deref for NativeCapturedFrame {
    type Target = Frame;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl NativeCapturedFrame {
    pub fn to_ffmpeg(&self) -> Result<ffmpeg::frame::Video, ToFfmpegError> {
        let width = self.width;
        let height = self.height;

        Ok(match self.pixel_format {
            PixelFormat::YUV420P => {
                let mut ff_frame = FFVideo::new(Pixel::YUV420P, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                let src_row = &self.bytes;

                for y in 0..height {
                    let row_width = width;
                    let src_row = &src_row[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(1);

                for y in 0..height / 2 {
                    let row_width = width / 2;
                    let src_row = &src_row[width * height + y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                let stride = ff_frame.stride(2);

                for y in 0..height / 2 {
                    let row_width = width / 2;
                    let src_row = &src_row[width * height + width * height / 4 + y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(2)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::NV12 => {
                let mut ff_frame = FFVideo::new(Pixel::NV12, width as u32, height as u32);

                let stride = ff_frame.stride(0);
                for y in 0..height {
                    let src_row = &self.bytes[y * width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..width].copy_from_slice(&src_row[0..width]);
                }

                let stride = ff_frame.stride(1);
                let src_row = &self.bytes[width * height..];

                for y in 0..height / 2 {
                    let row_width = width;
                    let src_row = &src_row[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(1)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::ARGB => {
                let mut ff_frame = FFVideo::new(Pixel::ARGB, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &self.bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::RGB24 => {
                let mut ff_frame = FFVideo::new(Pixel::RGB24, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &self.bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::RGB32 => {
                let mut ff_frame = FFVideo::new(Pixel::RGB32, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 4;
                    let src_row = &self.bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::YUYV422 => {
                let mut ff_frame = FFVideo::new(Pixel::YUYV422, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &self.bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
            PixelFormat::UYVY422 => {
                let mut ff_frame = FFVideo::new(Pixel::UYVY422, width as u32, height as u32);

                let stride = ff_frame.stride(0);

                for y in 0..height {
                    let row_width = width * 2;
                    let src_row = &self.bytes[y * row_width..];
                    let dest_row = &mut ff_frame.data_mut(0)[y * stride..];

                    dest_row[0..row_width].copy_from_slice(&src_row[0..row_width]);
                }

                ff_frame
            }
        })
    }
}

pub struct WindowsRecordingHandle {
    handle: std::thread::JoinHandle<()>,
}

impl WindowsRecordingHandle {
    pub fn stop_capturing(mut self) {
        self.handle
    }
}

#[derive(thiserror::Error, Debug)]
pub enum ToFfmpegError {}
