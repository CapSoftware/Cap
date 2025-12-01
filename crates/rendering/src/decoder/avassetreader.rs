use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format, frame};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::DecodedFrame;

use super::frame_converter::{FrameConverter, copy_rgba_plane};
use super::{FRAME_CACHE_SIZE, PREFETCH_LOOKAHEAD, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

#[derive(Clone)]
enum CachedFrame {
    Raw {
        image_buf: R<cv::ImageBuf>,
        number: u32,
    },
    Processed(ProcessedFrame),
}

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
    fn process(&mut self, processor: &mut ImageBufProcessor) -> ProcessedFrame {
        match self {
            CachedFrame::Raw { image_buf, number } => {
                let frame_buffer = processor.convert(image_buf);
                let data = ProcessedFrame {
                    number: *number,
                    data: Arc::new(frame_buffer),
                    width: image_buf.width() as u32,
                    height: image_buf.height() as u32,
                };

                *self = Self::Processed(data.clone());

                data
            }
            CachedFrame::Processed(data) => data.clone(),
        }
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
        _name: &'static str,
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

        let mut cache = BTreeMap::<u32, CachedFrame>::new();

        #[allow(unused)]
        let mut last_active_frame = None::<u32>;
        let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

        let mut frames = this.inner.frames();
        let mut processor = ImageBufProcessor::new();

        while let Ok(r) = rx.recv() {
            match r {
                VideoDecoderMessage::PrefetchFrames(start_time_secs, prefetch_fps) => {
                    let start_frame = (start_time_secs * prefetch_fps as f32).floor() as u32;
                    let end_frame = start_frame + PREFETCH_LOOKAHEAD as u32;

                    for frame in &mut frames {
                        let Ok(frame) = frame else { continue };

                        let current_frame = pts_to_frame(
                            frame.pts().value,
                            Rational::new(1, frame.pts().scale),
                            fps,
                        );

                        if let Some(image_buf) = frame.image_buf() {
                            if current_frame >= start_frame
                                && current_frame <= end_frame
                                && !cache.contains_key(&current_frame)
                            {
                                if cache.len() >= FRAME_CACHE_SIZE {
                                    if let Some(&oldest) = cache.keys().next() {
                                        cache.remove(&oldest);
                                    }
                                }
                                cache.insert(
                                    current_frame,
                                    CachedFrame::Raw {
                                        image_buf: image_buf.retained(),
                                        number: current_frame,
                                    },
                                );
                            }
                        }

                        if current_frame >= end_frame {
                            break;
                        }
                    }
                }
                VideoDecoderMessage::GetFrame(requested_time, sender) => {
                    let requested_frame = (requested_time * fps as f32).floor() as u32;

                    let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                        let data = cached.process(&mut processor);

                        let _ = sender.send(DecodedFrame {
                            data: data.data.clone(),
                            width: data.width,
                            height: data.height,
                        });
                        *last_sent_frame.borrow_mut() = Some(data);
                        continue;
                    } else {
                        let last_sent_frame = last_sent_frame.clone();
                        Some(move |data: ProcessedFrame| {
                            *last_sent_frame.borrow_mut() = Some(data.clone());
                            let _ = sender.send(DecodedFrame {
                                data: data.data.clone(),
                                width: data.width,
                                height: data.height,
                            });
                        })
                    };

                    let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                    let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                    if requested_frame == 0
                        || last_sent_frame
                            .borrow()
                            .as_ref()
                            .map(|last| {
                                requested_frame < last.number
                                    || requested_frame - last.number > FRAME_CACHE_SIZE as u32
                            })
                            .unwrap_or(true)
                    {
                        this.reset(requested_time);
                        frames = this.inner.frames();
                        *last_sent_frame.borrow_mut() = None;
                        cache.clear();
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

                        let mut cache_frame = CachedFrame::Raw {
                            image_buf: frame.retained(),
                            number: current_frame,
                        };

                        this.is_done = false;

                        if let Some(most_recent_prev_frame) =
                            cache.iter_mut().rev().find(|v| *v.0 < requested_frame)
                            && let Some(sender) = sender.take()
                        {
                            (sender)(most_recent_prev_frame.1.process(&mut processor));
                        }

                        let exceeds_cache_bounds = current_frame > cache_max;
                        let too_small_for_cache_bounds = current_frame < cache_min;

                        if !too_small_for_cache_bounds {
                            if current_frame == requested_frame
                                && let Some(sender) = sender.take()
                            {
                                let data = cache_frame.process(&mut processor);

                                (sender)(data);

                                break;
                            }

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
                        }

                        if current_frame > requested_frame && sender.is_some() {
                            let last_sent_frame = last_sent_frame.borrow().clone();

                            if let Some((sender, last_sent_frame)) =
                                last_sent_frame.and_then(|l| Some((sender.take()?, l)))
                            {
                                (sender)(last_sent_frame);
                            } else if let Some(sender) = sender.take() {
                                (sender)(cache_frame.process(&mut processor));
                            }
                        }

                        exit = exit || exceeds_cache_bounds;

                        if exit {
                            break;
                        }
                    }

                    this.is_done = true;

                    let last_sent_frame = last_sent_frame.borrow().clone();
                    if let Some((sender, last_sent_frame)) = sender.take().zip(last_sent_frame) {
                        (sender)(last_sent_frame);
                    }
                }
            }
        }
    }
}
