use std::{path::PathBuf, time::Duration};

use crate::{CameraInfo, CapturedFrame, Format, FormatInfo, StartCapturingError};

#[derive(Debug, Clone)]
pub struct LinuxNativeFormat {
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
}

pub type NativeFormat = LinuxNativeFormat;

#[derive(Debug)]
pub struct LinuxCapturedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub type NativeCapturedFrame = LinuxCapturedFrame;

pub struct LinuxCaptureHandle {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

pub type NativeCaptureHandle = LinuxCaptureHandle;

impl LinuxCaptureHandle {
    pub fn stop_capturing(mut self) -> Result<(), String> {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "Failed to join capture thread".to_string())?;
        }
        Ok(())
    }
}

impl Drop for LinuxCaptureHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub fn list_cameras_impl() -> impl Iterator<Item = CameraInfo> {
    let mut cameras = Vec::new();

    for i in 0..16 {
        let path = PathBuf::from(format!("/dev/video{i}"));
        if path.exists() {
            let device_id = format!("/dev/video{i}");
            let display_name = format!("Camera {i} (/dev/video{i})");
            cameras.push(CameraInfo {
                device_id,
                model_id: None,
                display_name,
            });
        }
    }

    cameras.into_iter()
}

impl CameraInfo {
    pub fn formats_impl(&self) -> Option<Vec<Format>> {
        Some(vec![
            Format {
                native: LinuxNativeFormat {
                    pixel_format: "yuyv422".to_string(),
                    width: 640,
                    height: 480,
                    frame_rate: 30.0,
                },
                info: FormatInfo {
                    width: 640,
                    height: 480,
                    frame_rate: 30.0,
                },
            },
            Format {
                native: LinuxNativeFormat {
                    pixel_format: "yuyv422".to_string(),
                    width: 1280,
                    height: 720,
                    frame_rate: 30.0,
                },
                info: FormatInfo {
                    width: 1280,
                    height: 720,
                    frame_rate: 30.0,
                },
            },
            Format {
                native: LinuxNativeFormat {
                    pixel_format: "yuyv422".to_string(),
                    width: 1920,
                    height: 1080,
                    frame_rate: 30.0,
                },
                info: FormatInfo {
                    width: 1920,
                    height: 1080,
                    frame_rate: 30.0,
                },
            },
        ])
    }
}

pub fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: Box<dyn FnMut(CapturedFrame) + Send + 'static>,
) -> Result<LinuxCaptureHandle, StartCapturingError> {
    let device_path = camera.device_id.clone();
    let width = format.info.width;
    let height = format.info.height;
    let fps = format.info.frame_rate;

    let (stop_tx, stop_rx) = std::sync::mpsc::channel();

    let thread = std::thread::spawn(move || {
        let frame_duration = Duration::from_secs_f32(1.0 / fps);
        let mut frame_count = 0u64;

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            let data = vec![0u8; (width * height * 3) as usize];
            let timestamp = Duration::from_secs_f64(frame_count as f64 / fps as f64);
            frame_count += 1;

            callback(CapturedFrame {
                native: LinuxCapturedFrame {
                    data,
                    width,
                    height,
                },
                timestamp,
            });

            std::thread::sleep(frame_duration);
        }

        let _ = device_path;
    });

    Ok(LinuxCaptureHandle {
        stop_tx: Some(stop_tx),
        thread: Some(thread),
    })
}
