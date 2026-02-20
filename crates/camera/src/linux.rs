use std::{fs, path::PathBuf, time::Duration};

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

fn read_v4l2_device_name(device_path: &str) -> Option<String> {
    let device_num: &str = device_path.strip_prefix("/dev/video")?;
    let name_path = format!("/sys/class/video4linux/video{device_num}/name");
    fs::read_to_string(name_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn is_v4l2_capture_device(device_path: &str) -> bool {
    let device_num = match device_path.strip_prefix("/dev/video") {
        Some(n) => n,
        None => return false,
    };

    let caps_path = format!("/sys/class/video4linux/video{device_num}/device/");
    PathBuf::from(&caps_path).exists()
}

pub fn list_cameras_impl() -> impl Iterator<Item = CameraInfo> {
    let mut cameras = Vec::new();

    for i in 0..64 {
        let device_path = format!("/dev/video{i}");
        if !PathBuf::from(&device_path).exists() {
            continue;
        }

        if !is_v4l2_capture_device(&device_path) {
            continue;
        }

        let display_name = read_v4l2_device_name(&device_path)
            .unwrap_or_else(|| format!("Camera (/dev/video{i})"));

        cameras.push(CameraInfo {
            device_id: device_path,
            model_id: None,
            display_name,
        });
    }

    cameras.into_iter()
}

fn query_v4l2_formats_via_ffmpeg(device_path: &str) -> Option<Vec<Format>> {
    unsafe {
        ffmpeg::ffi::avdevice_register_all();

        let format_name = std::ffi::CString::new("video4linux2").ok()?;
        let input_format = ffmpeg::ffi::av_find_input_format(format_name.as_ptr());
        if input_format.is_null() {
            return None;
        }

        let url = std::ffi::CString::new(device_path).ok()?;
        let mut ps = std::ptr::null_mut();

        let mut opts = std::ptr::null_mut();
        let list_formats_key = std::ffi::CString::new("list_formats").ok()?;
        let list_formats_val = std::ffi::CString::new("all").ok()?;
        ffmpeg::ffi::av_dict_set(
            &mut opts,
            list_formats_key.as_ptr(),
            list_formats_val.as_ptr(),
            0,
        );

        let ret = ffmpeg::ffi::avformat_open_input(&mut ps, url.as_ptr(), input_format, &mut opts);

        if !opts.is_null() {
            ffmpeg::ffi::av_dict_free(&mut opts);
        }

        if ret >= 0 && !ps.is_null() {
            ffmpeg::ffi::avformat_close_input(&mut ps);
        }
    }

    None
}

impl CameraInfo {
    pub fn formats_impl(&self) -> Option<Vec<Format>> {
        if let Some(formats) = query_v4l2_formats_via_ffmpeg(&self.device_id) {
            if !formats.is_empty() {
                return Some(formats);
            }
        }

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

    if !PathBuf::from(&device_path).exists() {
        return Err(StartCapturingError::DeviceNotFound);
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel();

    let thread = std::thread::spawn(move || {
        if let Err(e) = run_v4l2_capture(&device_path, width, height, fps, &stop_rx, &mut callback)
        {
            tracing::warn!("V4L2 capture error: {e}");
        }
    });

    Ok(LinuxCaptureHandle {
        stop_tx: Some(stop_tx),
        thread: Some(thread),
    })
}

fn run_v4l2_capture(
    device_path: &str,
    width: u32,
    height: u32,
    fps: f32,
    stop_rx: &std::sync::mpsc::Receiver<()>,
    callback: &mut Box<dyn FnMut(CapturedFrame) + Send + 'static>,
) -> Result<(), String> {
    unsafe {
        ffmpeg::ffi::avdevice_register_all();
    }

    let format_name = "video4linux2";
    let ictx = unsafe {
        let fmt_cstr = std::ffi::CString::new(format_name).map_err(|e| e.to_string())?;
        let input_format = ffmpeg::ffi::av_find_input_format(fmt_cstr.as_ptr());
        if input_format.is_null() {
            return Err("video4linux2 input format not available".to_string());
        }

        let url_cstr = std::ffi::CString::new(device_path).map_err(|e| e.to_string())?;
        let mut ps = std::ptr::null_mut();
        let mut opts = std::ptr::null_mut();

        let key_vs = std::ffi::CString::new("video_size").unwrap();
        let val_vs = std::ffi::CString::new(format!("{width}x{height}")).unwrap();
        ffmpeg::ffi::av_dict_set(&mut opts, key_vs.as_ptr(), val_vs.as_ptr(), 0);

        let key_fr = std::ffi::CString::new("framerate").unwrap();
        let val_fr = std::ffi::CString::new(format!("{}", fps as u32)).unwrap();
        ffmpeg::ffi::av_dict_set(&mut opts, key_fr.as_ptr(), val_fr.as_ptr(), 0);

        let key_pf = std::ffi::CString::new("input_format").unwrap();
        let val_pf = std::ffi::CString::new("mjpeg").unwrap();
        ffmpeg::ffi::av_dict_set(&mut opts, key_pf.as_ptr(), val_pf.as_ptr(), 0);

        let ret =
            ffmpeg::ffi::avformat_open_input(&mut ps, url_cstr.as_ptr(), input_format, &mut opts);

        if !opts.is_null() {
            ffmpeg::ffi::av_dict_free(&mut opts);
        }

        if ret < 0 {
            return Err(format!(
                "Failed to open V4L2 device {device_path} (error: {ret})"
            ));
        }

        let ret = ffmpeg::ffi::avformat_find_stream_info(ps, std::ptr::null_mut());
        if ret < 0 {
            ffmpeg::ffi::avformat_close_input(&mut ps);
            return Err(format!("Failed to find V4L2 stream info (error: {ret})"));
        }

        ffmpeg::format::context::Input::wrap(ps)
    };

    let mut ictx = ictx;

    let video_stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream from V4L2 device")?;
    let video_stream_index = video_stream.index();

    let codec_params = video_stream.parameters();
    let mut decoder = ffmpeg::codec::Context::from_parameters(codec_params)
        .map_err(|e| format!("Decoder context: {e}"))?
        .decoder()
        .video()
        .map_err(|e| format!("Video decoder: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();
    let mut scaler: Option<ffmpeg::software::scaling::Context> = None;
    let mut frame_count = 0u64;

    for (stream, packet) in ictx.packets() {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        if stream.index() != video_stream_index {
            continue;
        }

        decoder.send_packet(&packet).ok();

        while decoder.receive_frame(&mut frame).is_ok() {
            if stop_rx.try_recv().is_ok() {
                return Ok(());
            }

            let sws = scaler.get_or_insert_with(|| {
                ffmpeg::software::scaling::Context::get(
                    frame.format(),
                    frame.width(),
                    frame.height(),
                    ffmpeg::format::Pixel::RGB24,
                    width,
                    height,
                    ffmpeg::software::scaling::Flags::BILINEAR,
                )
                .expect("Failed to create scaler")
            });

            let mut rgb_frame = ffmpeg::frame::Video::empty();
            sws.run(&frame, &mut rgb_frame).ok();

            let data_slice = rgb_frame.data(0);
            let stride = rgb_frame.stride(0);
            let expected_row_bytes = (width * 3) as usize;
            let mut packed_data = Vec::with_capacity((width * height * 3) as usize);

            for y in 0..height as usize {
                let row_start = y * stride;
                let row_end = row_start + expected_row_bytes;
                if row_end <= data_slice.len() {
                    packed_data.extend_from_slice(&data_slice[row_start..row_end]);
                }
            }

            let timestamp = Duration::from_secs_f64(frame_count as f64 / fps as f64);
            frame_count += 1;

            callback(CapturedFrame {
                native: LinuxCapturedFrame {
                    data: packed_data,
                    width,
                    height,
                },
                timestamp,
            });
        }
    }

    Ok(())
}
