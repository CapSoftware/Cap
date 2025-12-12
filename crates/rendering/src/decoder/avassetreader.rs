use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
    time::Instant,
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::{DecodedFrame, PixelFormat};

use super::frame_converter::copy_rgba_plane;
use super::{FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    format: PixelFormat,
    y_stride: u32,
    uv_stride: u32,
}

impl ProcessedFrame {
    fn to_decoded_frame(&self) -> DecodedFrame {
        match self.format {
            PixelFormat::Rgba => DecodedFrame::new((*self.data).clone(), self.width, self.height),
            PixelFormat::Nv12 => DecodedFrame::new_nv12(
                (*self.data).clone(),
                self.width,
                self.height,
                self.y_stride,
                self.uv_stride,
            ),
            PixelFormat::Yuv420p => DecodedFrame::new_yuv420p(
                (*self.data).clone(),
                self.width,
                self.height,
                self.y_stride,
                self.uv_stride,
            ),
        }
    }
}

#[derive(Clone)]
struct CachedFrame(ProcessedFrame);

struct ImageBufProcessor;

impl ImageBufProcessor {
    fn new() -> Self {
        Self
    }

    fn extract_raw(&self, image_buf: &mut R<cv::ImageBuf>) -> (Vec<u8>, PixelFormat, u32, u32) {
        let pixel_format =
            cap_video_decode::avassetreader::pixel_format_to_pixel(image_buf.pixel_format());

        unsafe {
            image_buf
                .lock_base_addr(LockFlags::READ_ONLY)
                .result()
                .unwrap();
        }

        let result = match pixel_format {
            format::Pixel::RGBA => {
                let bytes_per_row = image_buf.plane_bytes_per_row(0);
                let width = image_buf.width();
                let height = image_buf.height();

                let slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        bytes_per_row * height,
                    )
                };

                let bytes = copy_rgba_plane(slice, bytes_per_row, width, height);
                (bytes, PixelFormat::Rgba, width as u32 * 4, 0)
            }
            format::Pixel::NV12 => {
                let width = image_buf.width();
                let height = image_buf.height();
                let y_stride = image_buf.plane_bytes_per_row(0);
                let uv_stride = image_buf.plane_bytes_per_row(1);
                let y_height = image_buf.plane_height(0);
                let uv_height = image_buf.plane_height(1);

                let y_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        y_stride * y_height,
                    )
                };

                let uv_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(1),
                        uv_stride * uv_height,
                    )
                };

                let mut data = Vec::with_capacity(width * height + width * height / 2);
                for row in 0..y_height {
                    let start = row * y_stride;
                    let end = start + width;
                    data.extend_from_slice(&y_slice[start..end]);
                }
                for row in 0..uv_height {
                    let start = row * uv_stride;
                    let end = start + width;
                    data.extend_from_slice(&uv_slice[start..end]);
                }

                (data, PixelFormat::Nv12, width as u32, width as u32)
            }
            format::Pixel::YUV420P => {
                let width = image_buf.width();
                let height = image_buf.height();
                let y_stride = image_buf.plane_bytes_per_row(0);
                let u_stride = image_buf.plane_bytes_per_row(1);
                let v_stride = image_buf.plane_bytes_per_row(2);
                let y_height = image_buf.plane_height(0);
                let uv_height = image_buf.plane_height(1);

                let y_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        y_stride * y_height,
                    )
                };

                let u_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(1),
                        u_stride * uv_height,
                    )
                };

                let v_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(2),
                        v_stride * uv_height,
                    )
                };

                let half_width = width / 2;
                let mut data = Vec::with_capacity(width * height + half_width * uv_height * 2);

                for row in 0..y_height {
                    let start = row * y_stride;
                    let end = start + width;
                    data.extend_from_slice(&y_slice[start..end]);
                }
                for row in 0..uv_height {
                    let start = row * u_stride;
                    let end = start + half_width;
                    data.extend_from_slice(&u_slice[start..end]);
                }
                for row in 0..uv_height {
                    let start = row * v_stride;
                    let end = start + half_width;
                    data.extend_from_slice(&v_slice[start..end]);
                }

                (data, PixelFormat::Yuv420p, width as u32, half_width as u32)
            }
            _ => {
                let width = image_buf.width();
                let height = image_buf.height();
                let black_frame = vec![0u8; width * height * 4];
                (black_frame, PixelFormat::Rgba, width as u32 * 4, 0)
            }
        };

        unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

        result
    }
}

impl CachedFrame {
    fn new(processor: &ImageBufProcessor, mut image_buf: R<cv::ImageBuf>, number: u32) -> Self {
        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;
        let (data, format, y_stride, uv_stride) = processor.extract_raw(&mut image_buf);

        let frame = ProcessedFrame {
            number,
            data: Arc::new(data),
            width,
            height,
            format,
            y_stride,
            uv_stride,
        };
        Self(frame)
    }

    fn data(&self) -> &ProcessedFrame {
        &self.0
    }
}

pub struct AVAssetReaderDecoder {
    inner: cap_video_decode::AVAssetReaderDecoder,
    is_done: bool,
}

impl AVAssetReaderDecoder {
    fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        Ok(Self {
            inner: cap_video_decode::AVAssetReaderDecoder::new(path, tokio_handle)?,
            is_done: false,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        let _ = self.inner.reset(requested_time);
    }

    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
    ) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || Self::run(name, path, fps, rx, ready_tx, handle));
    }

    fn run(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
        tokio_handle: tokio::runtime::Handle,
    ) {
        let mut this = match AVAssetReaderDecoder::new(path, tokio_handle) {
            Ok(v) => {
                ready_tx.send(Ok(())).ok();
                v
            }
            Err(e) => {
                ready_tx.send(Err(e)).ok();
                return;
            }
        };

        let video_width = this.inner.width();
        let video_height = this.inner.height();

        let mut cache = BTreeMap::<u32, CachedFrame>::new();

        #[allow(unused)]
        let mut last_active_frame = None::<u32>;
        let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

        let mut frames = this.inner.frames();
        let mut processor = ImageBufProcessor::new();

        let mut _cache_hits = 0u64;
        let mut _cache_misses = 0u64;
        let mut _total_requests = 0u64;
        let _total_decode_time_us = 0u64;
        let mut _total_reset_count = 0u64;
        let mut _total_reset_time_us = 0u64;
        let last_metrics_log = Rc::new(RefCell::new(Instant::now()));

        while let Ok(r) = rx.recv() {
            match r {
                VideoDecoderMessage::GetFrame(mut requested_time, mut sender) => {
                    if sender.is_closed() {
                        continue;
                    }

                    let request_start = Instant::now();
                    _total_requests += 1;
                    let requested_frame = (requested_time * fps as f32).floor() as u32;

                    const BACKWARD_SEEK_TOLERANCE: u32 = 120;
                    let cache_frame_min_early = cache.keys().next().copied();
                    let cache_frame_max_early = cache.keys().next_back().copied();

                    if let (Some(c_min), Some(_c_max)) =
                        (cache_frame_min_early, cache_frame_max_early)
                    {
                        let is_backward_within_tolerance = requested_frame < c_min
                            && requested_frame + BACKWARD_SEEK_TOLERANCE >= c_min;
                        if is_backward_within_tolerance {
                            if let Some(closest_frame) = cache.get(&c_min) {
                                let data = closest_frame.data().clone();
                                let _ = sender.send(data.to_decoded_frame());
                                *last_sent_frame.borrow_mut() = Some(data);
                                continue;
                            }
                        }
                    }

                    let mut sender = if let Some(cached) = cache.get(&requested_frame) {
                        _cache_hits += 1;
                        let data = cached.data().clone();
                        let total_time = request_start.elapsed();

                        tracing::debug!(
                            decoder = name,
                            frame = requested_frame,
                            cache_hit = true,
                            total_time_us = total_time.as_micros() as u64,
                            cache_size = cache.len(),
                            "[PERF:DECODER] cache hit"
                        );

                        let _ = sender.send(data.to_decoded_frame());
                        *last_sent_frame.borrow_mut() = Some(data);
                        continue;
                    } else {
                        _cache_misses += 1;
                        let last_sent_frame = last_sent_frame.clone();
                        let request_start_clone = request_start;
                        let last_metrics_log_clone = last_metrics_log.clone();
                        let decoder_name = name;
                        Some(move |data: ProcessedFrame| {
                            let total_time = request_start_clone.elapsed();
                            tracing::debug!(
                                decoder = decoder_name,
                                frame = data.number,
                                cache_hit = false,
                                total_time_us = total_time.as_micros() as u64,
                                "[PERF:DECODER] cache miss - frame decoded"
                            );
                            *last_sent_frame.borrow_mut() = Some(data.clone());
                            let _ = sender.send(data.to_decoded_frame());

                            let mut last_log = last_metrics_log_clone.borrow_mut();
                            if last_log.elapsed().as_secs() >= 2 {
                                *last_log = Instant::now();
                            }
                        })
                    };

                    let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                    let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                    let cache_frame_min = cache.keys().next().copied();
                    let cache_frame_max = cache.keys().next_back().copied();

                    let needs_reset =
                        if let (Some(c_min), Some(c_max)) = (cache_frame_min, cache_frame_max) {
                            let is_backward_seek_beyond_tolerance =
                                requested_frame + BACKWARD_SEEK_TOLERANCE < c_min;
                            let is_forward_seek_beyond_cache =
                                requested_frame > c_max + FRAME_CACHE_SIZE as u32 / 4;
                            is_backward_seek_beyond_tolerance || is_forward_seek_beyond_cache
                        } else {
                            true
                        };

                    if needs_reset {
                        let reset_start = Instant::now();
                        _total_reset_count += 1;

                        this.reset(requested_time);
                        frames = this.inner.frames();
                        *last_sent_frame.borrow_mut() = None;

                        let old_cache_size = cache.len();
                        let retained = cache
                            .keys()
                            .filter(|&&f| f >= cache_min && f <= cache_max)
                            .count();
                        cache.retain(|&f, _| f >= cache_min && f <= cache_max);
                        let cleared = old_cache_size - retained;

                        let reset_time = reset_start.elapsed();
                        _total_reset_time_us += reset_time.as_micros() as u64;

                        tracing::info!(
                            decoder = name,
                            requested_frame = requested_frame,
                            requested_time = requested_time,
                            reset_time_ms = reset_time.as_millis() as u64,
                            cleared_cache_entries = cleared,
                            retained_cache_entries = retained,
                            total_resets = _total_reset_count,
                            "[PERF:DECODER] decoder reset/seek"
                        );

                        // #region agent log
                        use std::io::Write;
                        if let Ok(mut file) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open("/Users/macbookuser/Documents/GitHub/cap/.cursor/debug.log")
                        {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64;
                            writeln!(
                                file,
                                r#"{{"location":"avassetreader.rs:decoder_reset","message":"decoder performed reset/seek","data":{{"decoder":"{}","requested_frame":{},"reset_time_ms":{},"cleared_cache":{},"retained_cache":{},"total_resets":{}}},"timestamp":{},"sessionId":"debug-session","hypothesisId":"D"}}"#,
                                name, requested_frame, reset_time.as_millis() as u64, cleared, retained, _total_reset_count, ts
                            )
                            .ok();
                        }
                        // #endregion
                    }

                    last_active_frame = Some(requested_frame);

                    let mut exit = false;

                    for frame in &mut frames {
                        let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                            continue;
                        };

                        let current_frame = pts_to_frame(
                            frame.pts().value,
                            Rational::new(1, frame.pts().scale),
                            fps,
                        );

                        let Some(frame) = frame.image_buf() else {
                            continue;
                        };

                        let cache_frame =
                            CachedFrame::new(&mut processor, frame.retained(), current_frame);

                        this.is_done = false;

                        if let Some(most_recent_prev_frame) =
                            cache.iter().rev().find(|v| *v.0 < requested_frame)
                            && let Some(sender) = sender.take()
                        {
                            (sender)(most_recent_prev_frame.1.data().clone());
                        }

                        let exceeds_cache_bounds = current_frame > cache_max;
                        let too_small_for_cache_bounds = current_frame < cache_min;

                        if !too_small_for_cache_bounds {
                            if cache.len() >= FRAME_CACHE_SIZE {
                                if let Some(last_active_frame) = &last_active_frame {
                                    let frame = if requested_frame > *last_active_frame {
                                        *cache.keys().next().unwrap()
                                    } else if requested_frame < *last_active_frame {
                                        *cache.keys().next_back().unwrap()
                                    } else {
                                        let min = *cache.keys().min().unwrap();
                                        let max = *cache.keys().max().unwrap();

                                        if current_frame > max { min } else { max }
                                    };

                                    cache.remove(&frame);
                                } else {
                                    cache.clear()
                                }
                            }

                            cache.insert(current_frame, cache_frame.clone());

                            if current_frame == requested_frame
                                && let Some(sender) = sender.take()
                            {
                                (sender)(cache_frame.data().clone());
                                break;
                            }
                        }

                        if current_frame > requested_frame && sender.is_some() {
                            // not inlining this is important so that last_sent_frame is dropped before the sender is invoked
                            let last_sent_frame = last_sent_frame.borrow().clone();

                            if let Some((sender, last_sent_frame)) =
                                last_sent_frame.and_then(|l| Some((sender.take()?, l)))
                            {
                                // info!(
                                //     "sending previous frame {} for {requested_frame}",
                                //     last_sent_frame.0
                                // );

                                (sender)(last_sent_frame);
                            } else if let Some(sender) = sender.take() {
                                (sender)(cache_frame.data().clone());
                            }
                        }

                        exit = exit || exceeds_cache_bounds;

                        if exit {
                            break;
                        }
                    }

                    this.is_done = true;

                    let last_sent_frame = last_sent_frame.borrow().clone();
                    if let Some(sender) = sender.take() {
                        if let Some(last_sent_frame) = last_sent_frame {
                            (sender)(last_sent_frame);
                        } else {
                            tracing::debug!(
                                "No frames available for request {requested_frame}, sending black frame"
                            );
                            let black_frame_data =
                                vec![0u8; (video_width * video_height * 4) as usize];
                            let black_frame = ProcessedFrame {
                                number: requested_frame,
                                data: Arc::new(black_frame_data),
                                width: video_width,
                                height: video_height,
                                format: PixelFormat::Rgba,
                                y_stride: video_width * 4,
                                uv_stride: 0,
                            };
                            (sender)(black_frame);
                        }
                    }
                }
            }
        }
    }
}
