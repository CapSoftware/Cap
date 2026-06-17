use crate::{CameraInfo, CapturedFrame, Format, FormatInfo, StartCapturingError};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use v4l::{
    Device, FourCC,
    buffer::Type,
    capability::Flags as CapabilityFlags,
    format::Format as V4lFormat,
    frameinterval::{FrameInterval, FrameIntervalEnum},
    framesize::{FrameSize, FrameSizeEnum},
    io::{mmap::Stream as MmapStream, traits::CaptureStream},
    video::{Capture, capture::Parameters as CaptureParameters},
};

const PREFERRED_FOURCCS: &[([u8; 4], u32)] = &[
    (*b"YUYV", 0),
    (*b"UYVY", 1),
    (*b"NV12", 2),
    (*b"RGB3", 3),
    (*b"BGR3", 4),
    (*b"YU12", 5),
    (*b"YV12", 6),
    (*b"MJPG", 7),
    (*b"JPEG", 8),
];

const PREFERRED_STEPWISE_SIZES: &[(u32, u32)] = &[
    (3840, 2160),
    (2560, 1440),
    (1920, 1080),
    (1280, 720),
    (1024, 768),
    (800, 600),
    (640, 480),
    (320, 240),
];

const PREFERRED_STEPWISE_FPS: &[u32] = &[60, 30, 24, 15];

#[derive(Clone, Debug)]
pub struct NativeFormat {
    pub fourcc: [u8; 4],
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
    pub interval: v4l::Fraction,
}

#[derive(Clone, Copy, Debug)]
pub struct NativeFrameFormat {
    pub fourcc: [u8; 4],
    pub width: u32,
    pub height: u32,
    pub stride: usize,
}

#[derive(Debug)]
pub struct NativeCapturedFrame {
    pub bytes: Vec<u8>,
    pub format: NativeFrameFormat,
}

pub struct NativeCaptureHandle {
    stop_tx: Option<mpsc::SyncSender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl NativeCaptureHandle {
    pub fn stop_capturing(mut self) -> Result<(), String> {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }

        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "Linux camera capture thread panicked".to_string())?;
        }

        Ok(())
    }
}

impl Drop for NativeCaptureHandle {
    fn drop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
    }
}

pub fn list_cameras_impl() -> impl Iterator<Item = CameraInfo> {
    video_device_paths()
        .into_iter()
        .filter_map(|path| {
            let device = Device::with_path(&path).ok()?;
            let caps = device.query_caps().ok()?;
            let is_capture = caps
                .capabilities
                .contains(CapabilityFlags::VIDEO_CAPTURE | CapabilityFlags::STREAMING);

            if !is_capture {
                return None;
            }

            Some(CameraInfo {
                device_id: path.display().to_string(),
                model_id: None,
                display_name: if caps.card.is_empty() {
                    path.display().to_string()
                } else {
                    caps.card
                },
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
}

impl CameraInfo {
    pub fn formats_impl(&self) -> Option<Vec<Format>> {
        let device = open_device(self).ok()?;
        let mut formats = Vec::new();

        for desc in device.enum_formats().ok()? {
            if fourcc_rank(desc.fourcc.repr).is_none() {
                continue;
            }

            for (width, height) in frame_sizes(&device, desc.fourcc) {
                for (frame_rate, interval) in frame_rates(&device, desc.fourcc, width, height) {
                    formats.push(Format {
                        info: FormatInfo {
                            width,
                            height,
                            frame_rate,
                        },
                        native: NativeFormat {
                            fourcc: desc.fourcc.repr,
                            width,
                            height,
                            frame_rate,
                            interval,
                        },
                    });
                }
            }
        }

        formats.sort_by(|a, b| {
            fourcc_rank(a.native.fourcc)
                .unwrap_or(u32::MAX)
                .cmp(&fourcc_rank(b.native.fourcc).unwrap_or(u32::MAX))
                .then((b.width() * b.height()).cmp(&(a.width() * a.height())))
                .then(
                    (b.frame_rate() * 100.0)
                        .round()
                        .total_cmp(&(a.frame_rate() * 100.0).round()),
                )
        });
        formats.dedup_by(|a, b| {
            a.native.fourcc == b.native.fourcc
                && a.width() == b.width()
                && a.height() == b.height()
                && (a.frame_rate() - b.frame_rate()).abs() < 0.01
        });

        Some(formats)
    }
}

pub fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: Box<dyn FnMut(CapturedFrame) + Send>,
) -> Result<NativeCaptureHandle, StartCapturingError> {
    let device = open_device(camera)?;
    let requested = V4lFormat::new(
        format.native().width,
        format.native().height,
        FourCC::new(&format.native().fourcc),
    );
    let active_format = device
        .set_format(&requested)
        .map_err(|e| StartCapturingError::Native(e.to_string()))?;
    let _ = device.set_params(&CaptureParameters::new(format.native().interval));

    let frame_format = NativeFrameFormat {
        fourcc: active_format.fourcc.repr,
        width: active_format.width,
        height: active_format.height,
        stride: active_format.stride as usize,
    };

    let (stop_tx, stop_rx) = mpsc::sync_channel(1);
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let started = Instant::now();

    let thread = thread::spawn(move || {
        let mut stream = match MmapStream::with_buffers(&device, Type::VideoCapture, 4) {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                stream
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match stream.next() {
                Ok((bytes, meta)) => {
                    let used = meta.bytesused as usize;
                    let bytes = bytes.get(..used).unwrap_or(bytes);
                    callback(CapturedFrame {
                        native: NativeCapturedFrame {
                            bytes: bytes.to_vec(),
                            format: frame_format,
                        },
                        timestamp: started.elapsed(),
                    });
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => Ok(NativeCaptureHandle {
            stop_tx: Some(stop_tx),
            thread: Some(thread),
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(StartCapturingError::Native(error))
        }
        Err(error) => Err(StartCapturingError::Native(error.to_string())),
    }
}

fn video_device_paths() -> Vec<PathBuf> {
    let mut paths = fs::read_dir("/dev")
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.strip_prefix("video")
                        .is_some_and(|suffix| suffix.chars().all(|c| c.is_ascii_digit()))
                })
        })
        .collect::<Vec<_>>();

    paths.sort_by_key(|path| video_index(path).unwrap_or(u32::MAX));
    paths
}

fn video_index(path: &Path) -> Option<u32> {
    path.file_name()?
        .to_str()?
        .strip_prefix("video")?
        .parse()
        .ok()
}

fn open_device(camera: &CameraInfo) -> Result<Device, StartCapturingError> {
    Device::with_path(camera.device_id()).map_err(|e| StartCapturingError::Native(e.to_string()))
}

fn fourcc_rank(fourcc: [u8; 4]) -> Option<u32> {
    PREFERRED_FOURCCS
        .iter()
        .find_map(|(candidate, rank)| (*candidate == fourcc).then_some(*rank))
}

fn frame_sizes(device: &Device, fourcc: FourCC) -> Vec<(u32, u32)> {
    let mut sizes = device
        .enum_framesizes(fourcc)
        .unwrap_or_default()
        .into_iter()
        .flat_map(frame_size_candidates)
        .collect::<Vec<_>>();

    sizes.sort_unstable();
    sizes.dedup();
    sizes
}

fn frame_size_candidates(size: FrameSize) -> Vec<(u32, u32)> {
    match size.size {
        FrameSizeEnum::Discrete(discrete) => vec![(discrete.width, discrete.height)],
        FrameSizeEnum::Stepwise(stepwise) => {
            let mut sizes = PREFERRED_STEPWISE_SIZES
                .iter()
                .copied()
                .filter(|(width, height)| {
                    in_stepwise_range(
                        *width,
                        stepwise.min_width,
                        stepwise.max_width,
                        stepwise.step_width,
                    ) && in_stepwise_range(
                        *height,
                        stepwise.min_height,
                        stepwise.max_height,
                        stepwise.step_height,
                    )
                })
                .collect::<Vec<_>>();

            if sizes.is_empty() {
                sizes.push((stepwise.max_width, stepwise.max_height));
            }

            sizes
        }
    }
}

fn in_stepwise_range(value: u32, min: u32, max: u32, step: u32) -> bool {
    value >= min && value <= max && (step == 0 || (value - min).is_multiple_of(step))
}

fn frame_rates(
    device: &Device,
    fourcc: FourCC,
    width: u32,
    height: u32,
) -> Vec<(f32, v4l::Fraction)> {
    let mut rates = device
        .enum_frameintervals(fourcc, width, height)
        .unwrap_or_default()
        .into_iter()
        .flat_map(frame_rate_candidates)
        .collect::<Vec<_>>();

    if rates.is_empty() {
        rates.push((30.0, v4l::Fraction::new(1, 30)));
    }

    rates.sort_by(|a, b| b.0.total_cmp(&a.0));
    rates.dedup_by(|a, b| (a.0 - b.0).abs() < 0.01);
    rates
}

fn frame_rate_candidates(interval: FrameInterval) -> Vec<(f32, v4l::Fraction)> {
    match interval.interval {
        FrameIntervalEnum::Discrete(fraction) => fps_from_fraction(fraction)
            .map(|fps| vec![(fps, fraction)])
            .unwrap_or_default(),
        FrameIntervalEnum::Stepwise(stepwise) => {
            let min_fps = fps_from_fraction(stepwise.max).unwrap_or(0.0);
            let max_fps = fps_from_fraction(stepwise.min).unwrap_or(f32::MAX);

            PREFERRED_STEPWISE_FPS
                .iter()
                .copied()
                .filter(|fps| {
                    let fps = *fps as f32;
                    fps >= min_fps && fps <= max_fps
                })
                .map(|fps| (fps as f32, v4l::Fraction::new(1, fps)))
                .collect()
        }
    }
}

fn fps_from_fraction(fraction: v4l::Fraction) -> Option<f32> {
    (fraction.numerator != 0).then_some(fraction.denominator as f32 / fraction.numerator as f32)
}
