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
use ffmpeg::{Rational, format, frame};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::DecodedFrame;

use super::frame_converter::{FrameConverter, copy_rgba_plane};
use super::{FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct CachedFrame(ProcessedFrame);

struct ImageBufProcessor {
    converter: FrameConverter,
    scratch_frame: frame::Video,
    scratch_spec: Option<(format::Pixel, u32, u32)>,
}

impl ImageBufProcessor {
    fn new() -> Self {
        Self {
            converter: FrameConverter::new(),
            scratch_frame: frame::Video::empty(),
            scratch_spec: None,
        }
    }

    fn convert(&mut self, image_buf: &mut R<cv::ImageBuf>) -> Vec<u8> {
        let format =
            cap_video_decode::avassetreader::pixel_format_to_pixel(image_buf.pixel_format());

        if matches!(format, format::Pixel::RGBA) {
            return self.copy_rgba(image_buf);
        }

        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;
        self.ensure_scratch(format, width, height);

        unsafe {
            image_buf
                .lock_base_addr(LockFlags::READ_ONLY)
                .result()
                .unwrap();
        }

        self.copy_planes(image_buf);

        unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

        self.converter.convert(&mut self.scratch_frame)
    }

    fn ensure_scratch(&mut self, format: format::Pixel, width: u32, height: u32) {
        let needs_new =
            self.scratch_spec
                .is_none_or(|(current_format, current_width, current_height)| {
                    current_format != format || current_width != width || current_height != height
                });

        if needs_new {
            self.scratch_frame = frame::Video::new(format, width, height);
            self.scratch_spec = Some((format, width, height));
        }
    }

    fn copy_rgba(&mut self, image_buf: &mut R<cv::ImageBuf>) -> Vec<u8> {
        unsafe {
            image_buf
                .lock_base_addr(LockFlags::READ_ONLY)
                .result()
                .unwrap();
        }

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

        unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

        bytes
    }

    fn copy_planes(&mut self, image_buf: &mut R<cv::ImageBuf>) {
        match self.scratch_frame.format() {
            format::Pixel::NV12 | format::Pixel::YUV420P => {
                let scratch = &mut self.scratch_frame;
                for plane_i in 0..image_buf.plane_count() {
                    let bytes_per_row = image_buf.plane_bytes_per_row(plane_i);
                    let height = image_buf.plane_height(plane_i);

                    let ffmpeg_stride = scratch.stride(plane_i);
                    let row_length = bytes_per_row.min(ffmpeg_stride);

                    let slice = unsafe {
                        std::slice::from_raw_parts::<'static, _>(
                            image_buf.plane_base_address(plane_i),
                            bytes_per_row * height,
                        )
                    };

                    for i in 0..height {
                        scratch.data_mut(plane_i)
                            [i * ffmpeg_stride..(i * ffmpeg_stride + row_length)]
                            .copy_from_slice(
                                &slice[i * bytes_per_row..(i * bytes_per_row + row_length)],
                            );
                    }
                }
            }
            format => todo!("implement {:?}", format),
        }
    }
}

impl CachedFrame {
    fn new(processor: &mut ImageBufProcessor, mut image_buf: R<cv::ImageBuf>, number: u32) -> Self {
        let frame_buffer = processor.convert(&mut image_buf);
        let data = ProcessedFrame {
            number,
            data: Arc::new(frame_buffer),
            width: image_buf.width() as u32,
            height: image_buf.height() as u32,
        };
        Self(data)
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

        let mut cache_hits = 0u64;
        let mut cache_misses = 0u64;
        let mut total_requests = 0u64;
        let mut total_decode_time_us = 0u64;
        let mut total_reset_count = 0u64;
        let mut total_reset_time_us = 0u64;
        let last_metrics_log = Rc::new(RefCell::new(Instant::now()));

        while let Ok(r) = rx.recv() {
            match r {
                VideoDecoderMessage::GetFrame(requested_time, sender) => {
                    let request_start = Instant::now();
                    total_requests += 1;
                    let requested_frame = (requested_time * fps as f32).floor() as u32;

                    let mut sender = if let Some(cached) = cache.get(&requested_frame) {
                        cache_hits += 1;
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

                        let _ = sender.send(DecodedFrame {
                            data: data.data.clone(),
                            width: data.width,
                            height: data.height,
                        });
                        *last_sent_frame.borrow_mut() = Some(data);
                        continue;
                    } else {
                        cache_misses += 1;
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
                            let _ = sender.send(DecodedFrame {
                                data: data.data.clone(),
                                width: data.width,
                                height: data.height,
                            });

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
                            let is_backward_seek_beyond_cache = requested_frame < c_min;
                            let is_forward_seek_beyond_cache =
                                requested_frame > c_max + FRAME_CACHE_SIZE as u32 / 4;
                            is_backward_seek_beyond_cache || is_forward_seek_beyond_cache
                        } else {
                            true
                        };

                    if needs_reset {
                        let reset_start = Instant::now();
                        total_reset_count += 1;
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
                        total_reset_time_us += reset_time.as_micros() as u64;

                        tracing::info!(
                            decoder = name,
                            requested_frame = requested_frame,
                            requested_time = requested_time,
                            reset_time_ms = reset_time.as_millis() as u64,
                            cleared_cache_entries = cleared,
                            retained_cache_entries = retained,
                            total_resets = total_reset_count,
                            "[PERF:DECODER] decoder reset/seek"
                        );
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
                            };
                            (sender)(black_frame);
                        }
                    }
                }
            }
        }
    }
}
