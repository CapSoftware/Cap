use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
};

use tracing::debug;

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::{DecodedFrame, PixelFormat};

use super::frame_converter::{copy_bgra_to_rgba, copy_rgba_plane};
use super::multi_position::{DecoderPoolManager, MultiPositionDecoderConfig, ScrubDetector};
use super::{DecoderInitResult, DecoderType, FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

struct SendableImageBuf(R<cv::ImageBuf>);
unsafe impl Send for SendableImageBuf {}
unsafe impl Sync for SendableImageBuf {}

impl Clone for SendableImageBuf {
    fn clone(&self) -> Self {
        Self(self.0.retained())
    }
}

#[derive(Clone)]
struct FrameData {
    data: Arc<Vec<u8>>,
    y_stride: u32,
    uv_stride: u32,
    image_buf: Option<Arc<SendableImageBuf>>,
}

#[derive(Clone)]
struct ProcessedFrame {
    _number: u32,
    width: u32,
    height: u32,
    format: PixelFormat,
    frame_data: FrameData,
}

impl ProcessedFrame {
    fn to_decoded_frame(&self) -> DecodedFrame {
        let FrameData {
            data,
            y_stride,
            uv_stride,
            image_buf,
        } = &self.frame_data;

        match self.format {
            PixelFormat::Rgba => {
                DecodedFrame::new_with_arc(Arc::clone(data), self.width, self.height)
            }
            PixelFormat::Nv12 => {
                if let Some(img_buf) = image_buf {
                    DecodedFrame::new_nv12_zero_copy(
                        self.width,
                        self.height,
                        *y_stride,
                        *uv_stride,
                        img_buf.0.retained(),
                    )
                } else {
                    DecodedFrame::new_nv12_with_arc(
                        Arc::clone(data),
                        self.width,
                        self.height,
                        *y_stride,
                        *uv_stride,
                    )
                }
            }
            PixelFormat::Yuv420p => DecodedFrame::new_yuv420p_with_arc(
                Arc::clone(data),
                self.width,
                self.height,
                *y_stride,
                *uv_stride,
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
            format::Pixel::BGRA => {
                let bytes_per_row = image_buf.plane_bytes_per_row(0);
                let width = image_buf.width();
                let height = image_buf.height();

                let slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        bytes_per_row * height,
                    )
                };

                let bytes = copy_bgra_to_rgba(slice, bytes_per_row, width, height);
                (bytes, PixelFormat::Rgba, width as u32 * 4, 0)
            }
            format::Pixel::NV12 => {
                let y_stride = image_buf.plane_bytes_per_row(0);
                let uv_stride = image_buf.plane_bytes_per_row(1);
                let y_height = image_buf.plane_height(0);
                let uv_height = image_buf.plane_height(1);

                let y_size = y_stride * y_height;
                let uv_size = uv_stride * uv_height;

                let y_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        y_size,
                    )
                };

                let uv_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(1),
                        uv_size,
                    )
                };

                let mut data = Vec::with_capacity(y_size + uv_size);
                data.extend_from_slice(y_slice);
                data.extend_from_slice(uv_slice);

                (data, PixelFormat::Nv12, y_stride as u32, uv_stride as u32)
            }
            format::Pixel::YUV420P => {
                let y_stride = image_buf.plane_bytes_per_row(0);
                let u_stride = image_buf.plane_bytes_per_row(1);
                let v_stride = image_buf.plane_bytes_per_row(2);
                let y_height = image_buf.plane_height(0);
                let uv_height = image_buf.plane_height(1);

                let y_size = y_stride * y_height;
                let u_size = u_stride * uv_height;
                let v_size = v_stride * uv_height;

                let y_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(0),
                        y_size,
                    )
                };

                let u_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(1),
                        u_size,
                    )
                };

                let v_slice = unsafe {
                    std::slice::from_raw_parts::<'static, _>(
                        image_buf.plane_base_address(2),
                        v_size,
                    )
                };

                let mut data = Vec::with_capacity(y_size + u_size + v_size);
                data.extend_from_slice(y_slice);
                data.extend_from_slice(u_slice);
                data.extend_from_slice(v_slice);

                (data, PixelFormat::Yuv420p, y_stride as u32, u_stride as u32)
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
    fn new(_processor: &ImageBufProcessor, image_buf: R<cv::ImageBuf>, number: u32) -> Self {
        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;

        let pixel_format =
            cap_video_decode::avassetreader::pixel_format_to_pixel(image_buf.pixel_format());

        let (format, y_stride, uv_stride, stored_image_buf) = match pixel_format {
            format::Pixel::NV12 => {
                let y_stride = image_buf.plane_bytes_per_row(0) as u32;
                let uv_stride = image_buf.plane_bytes_per_row(1) as u32;
                (
                    PixelFormat::Nv12,
                    y_stride,
                    uv_stride,
                    Some(Arc::new(SendableImageBuf(image_buf))),
                )
            }
            format::Pixel::RGBA | format::Pixel::BGRA | format::Pixel::YUV420P => {
                let mut img = image_buf;
                let (data, fmt, y_str, uv_str) = _processor.extract_raw(&mut img);
                return Self(ProcessedFrame {
                    _number: number,
                    width,
                    height,
                    format: fmt,
                    frame_data: FrameData {
                        data: Arc::new(data),
                        y_stride: y_str,
                        uv_stride: uv_str,
                        image_buf: None,
                    },
                });
            }
            _ => {
                let black_frame = vec![0u8; (width * height * 4) as usize];
                return Self(ProcessedFrame {
                    _number: number,
                    width,
                    height,
                    format: PixelFormat::Rgba,
                    frame_data: FrameData {
                        data: Arc::new(black_frame),
                        y_stride: width * 4,
                        uv_stride: 0,
                        image_buf: None,
                    },
                });
            }
        };

        let frame = ProcessedFrame {
            _number: number,
            width,
            height,
            format,
            frame_data: FrameData {
                data: Arc::new(Vec::new()),
                y_stride,
                uv_stride,
                image_buf: stored_image_buf,
            },
        };
        Self(frame)
    }

    fn data(&self) -> &ProcessedFrame {
        &self.0
    }
}

struct DecoderInstance {
    inner: cap_video_decode::AVAssetReaderDecoder,
    is_done: bool,
    frames_iter_valid: bool,
}

impl DecoderInstance {
    fn new(
        path: PathBuf,
        tokio_handle: TokioHandle,
        start_time: f32,
        keyframe_index: Option<cap_video_decode::avassetreader::KeyframeIndex>,
    ) -> Result<Self, String> {
        Ok(Self {
            inner: cap_video_decode::AVAssetReaderDecoder::new_with_keyframe_index(
                path,
                tokio_handle,
                start_time,
                keyframe_index,
            )?,
            is_done: false,
            frames_iter_valid: true,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        let _ = self.inner.reset(requested_time);
        self.is_done = false;
        self.frames_iter_valid = true;
    }

    fn current_position(&self) -> f32 {
        self.inner.current_position_secs()
    }
}

pub struct AVAssetReaderDecoder {
    decoders: Vec<DecoderInstance>,
    pool_manager: DecoderPoolManager,
    active_decoder_idx: usize,
    scrub_detector: ScrubDetector,
}

impl AVAssetReaderDecoder {
    fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        let mut primary_decoder =
            cap_video_decode::AVAssetReaderDecoder::new(path.clone(), tokio_handle.clone())?;

        let keyframe_index = primary_decoder.take_keyframe_index();
        let keyframe_index_arc: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>> = None;

        let fps = keyframe_index
            .as_ref()
            .map(|kf| kf.fps() as u32)
            .unwrap_or(30);
        let duration_secs = keyframe_index
            .as_ref()
            .map(|kf| kf.duration_secs())
            .unwrap_or(0.0);

        let config = MultiPositionDecoderConfig {
            path: path.clone(),
            tokio_handle: tokio_handle.clone(),
            keyframe_index: keyframe_index_arc,
            fps,
            duration_secs,
        };

        let pool_manager = DecoderPoolManager::new(config);

        let primary_instance = DecoderInstance {
            inner: primary_decoder,
            is_done: false,
            frames_iter_valid: true,
        };

        let mut decoders = vec![primary_instance];

        let initial_positions = pool_manager.positions();
        for pos in initial_positions.iter().skip(1) {
            let start_time = pos.position_secs;
            match DecoderInstance::new(path.clone(), tokio_handle.clone(), start_time, None) {
                Ok(instance) => {
                    decoders.push(instance);
                    tracing::info!(
                        position_secs = start_time,
                        decoder_index = decoders.len() - 1,
                        "Created additional decoder instance for multi-position pool"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        position_secs = start_time,
                        error = %e,
                        "Failed to create additional decoder instance, continuing with fewer decoders"
                    );
                }
            }
        }

        tracing::info!(
            decoder_count = decoders.len(),
            fps = fps,
            duration_secs = duration_secs,
            "Initialized multi-position decoder pool"
        );

        Ok(Self {
            decoders,
            pool_manager,
            active_decoder_idx: 0,
            scrub_detector: ScrubDetector::new(),
        })
    }

    fn select_best_decoder(&mut self, requested_time: f32) -> (usize, bool) {
        let (best_id, _distance, needs_reset) =
            self.pool_manager.find_best_decoder_for_time(requested_time);

        let decoder_idx = best_id.min(self.decoders.len().saturating_sub(1));

        if needs_reset && decoder_idx < self.decoders.len() {
            self.decoders[decoder_idx].reset(requested_time);
            self.pool_manager
                .update_decoder_position(best_id, self.decoders[decoder_idx].current_position());
        }

        self.active_decoder_idx = decoder_idx;
        (decoder_idx, needs_reset)
    }

    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
    ) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || Self::run(name, path, fps, rx, ready_tx, handle));
    }

    fn run(
        _name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
        tokio_handle: tokio::runtime::Handle,
    ) {
        let mut this = match AVAssetReaderDecoder::new(path, tokio_handle) {
            Ok(v) => v,
            Err(e) => {
                ready_tx.send(Err(e)).ok();
                return;
            }
        };

        let video_width = this.decoders[0].inner.width();
        let video_height = this.decoders[0].inner.height();

        let init_result = DecoderInitResult {
            width: video_width,
            height: video_height,
            decoder_type: DecoderType::AVAssetReader,
        };
        ready_tx.send(Ok(init_result)).ok();

        let mut cache = BTreeMap::<u32, CachedFrame>::new();

        #[allow(unused)]
        let mut last_active_frame = None::<u32>;
        let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));
        let first_ever_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

        let processor = ImageBufProcessor::new();

        struct PendingRequest {
            frame: u32,
            sender: oneshot::Sender<DecodedFrame>,
        }

        while let Ok(r) = rx.recv() {
            let mut pending_requests: Vec<PendingRequest> = Vec::with_capacity(8);

            match r {
                VideoDecoderMessage::GetFrame(requested_time, sender) => {
                    let frame = (requested_time * fps as f32).floor() as u32;
                    if !sender.is_closed() {
                        pending_requests.push(PendingRequest { frame, sender });
                    }
                }
            }

            while let Ok(msg) = rx.try_recv() {
                match msg {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        let frame = (requested_time * fps as f32).floor() as u32;
                        if !sender.is_closed() {
                            pending_requests.push(PendingRequest { frame, sender });
                        }
                    }
                }
            }

            pending_requests.sort_by_key(|r| r.frame);

            let is_scrubbing = if let Some(first_req) = pending_requests.first() {
                this.scrub_detector.record_request(first_req.frame)
            } else {
                false
            };

            let mut i = 0;
            while i < pending_requests.len() {
                let request = &pending_requests[i];
                if let Some(cached) = cache.get(&request.frame) {
                    let data = cached.data().clone();
                    let req = pending_requests.remove(i);
                    let _ = req.sender.send(data.to_decoded_frame());
                    *last_sent_frame.borrow_mut() = Some(data);
                } else {
                    i += 1;
                }
            }

            if pending_requests.is_empty() {
                continue;
            }

            let min_requested_frame = pending_requests.iter().map(|r| r.frame).min().unwrap();
            let max_requested_frame = pending_requests.iter().map(|r| r.frame).max().unwrap();
            let requested_frame = min_requested_frame;
            let requested_time = requested_frame as f32 / fps as f32;

            let (decoder_idx, was_reset) = this.select_best_decoder(requested_time);

            let cache_min = min_requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
            let cache_max = if is_scrubbing {
                max_requested_frame + FRAME_CACHE_SIZE as u32 / 4
            } else {
                max_requested_frame + FRAME_CACHE_SIZE as u32 / 2
            };

            if was_reset {
                *last_sent_frame.borrow_mut() = None;
                cache.retain(|&f, _| f >= cache_min && f <= cache_max);
            }

            last_active_frame = Some(requested_frame);

            let mut exit = false;
            let mut frames_iterated = 0u32;
            let mut last_decoded_position: Option<f32> = None;

            {
                let decoder = &mut this.decoders[decoder_idx];
                let mut frames = decoder.inner.frames();

                for frame in &mut frames {
                    let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                        continue;
                    };
                    frames_iterated += 1;

                    let current_frame =
                        pts_to_frame(frame.pts().value, Rational::new(1, frame.pts().scale), fps);

                    let position_secs = current_frame as f32 / fps as f32;
                    last_decoded_position = Some(position_secs);

                    let Some(frame) = frame.image_buf() else {
                        continue;
                    };

                    let cache_frame = CachedFrame::new(&processor, frame.retained(), current_frame);

                    if first_ever_frame.borrow().is_none() {
                        *first_ever_frame.borrow_mut() = Some(cache_frame.data().clone());
                    }

                    decoder.is_done = false;

                    let exceeds_cache_bounds = current_frame > cache_max;
                    let too_small_for_cache_bounds = current_frame < cache_min;

                    if !too_small_for_cache_bounds {
                        if cache.len() >= FRAME_CACHE_SIZE {
                            if let Some(last_active) = &last_active_frame {
                                let frame_to_remove = if requested_frame > *last_active {
                                    *cache.keys().next().unwrap()
                                } else if requested_frame < *last_active {
                                    *cache.keys().next_back().unwrap()
                                } else {
                                    let min = *cache.keys().min().unwrap();
                                    let max = *cache.keys().max().unwrap();
                                    if current_frame > max { min } else { max }
                                };
                                cache.remove(&frame_to_remove);
                            } else {
                                cache.clear()
                            }
                        }

                        cache.insert(current_frame, cache_frame.clone());

                        let mut remaining_requests = Vec::with_capacity(pending_requests.len());
                        for req in pending_requests.drain(..) {
                            if req.frame == current_frame {
                                let data = cache_frame.data().clone();
                                *last_sent_frame.borrow_mut() = Some(data.clone());
                                let _ = req.sender.send(data.to_decoded_frame());
                            } else if req.frame < current_frame {
                                if let Some(cached) = cache.get(&req.frame) {
                                    let data = cached.data().clone();
                                    *last_sent_frame.borrow_mut() = Some(data.clone());
                                    let _ = req.sender.send(data.to_decoded_frame());
                                } else if is_scrubbing {
                                    let data = cache_frame.data().clone();
                                    *last_sent_frame.borrow_mut() = Some(data.clone());
                                    let _ = req.sender.send(data.to_decoded_frame());
                                }
                            } else {
                                remaining_requests.push(req);
                            }
                        }
                        pending_requests = remaining_requests;
                    }

                    *last_sent_frame.borrow_mut() = Some(cache_frame.data().clone());

                    exit = exit || exceeds_cache_bounds;

                    if is_scrubbing && frames_iterated > 3 {
                        break;
                    }

                    if pending_requests.is_empty() || exit {
                        break;
                    }
                }

                decoder.is_done = true;
            }

            if let Some(pos) = last_decoded_position {
                this.pool_manager.update_decoder_position(decoder_idx, pos);
            }

            for req in pending_requests.drain(..) {
                if let Some(cached) = cache.get(&req.frame) {
                    let data = cached.data().clone();
                    let _ = req.sender.send(data.to_decoded_frame());
                } else if let Some(last) = last_sent_frame.borrow().clone() {
                    if req.sender.send(last.to_decoded_frame()).is_err() {}
                } else if let Some(first) = first_ever_frame.borrow().clone() {
                    if req.sender.send(first.to_decoded_frame()).is_err() {}
                } else {
                    debug!(
                        decoder = _name,
                        requested_frame = req.frame,
                        "No frame available to send - request dropped"
                    );
                }
            }
        }
    }
}
