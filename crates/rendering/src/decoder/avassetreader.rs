use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::{DecodedFrame, PixelFormat};

use super::frame_converter::{copy_bgra_to_rgba, copy_rgba_plane};
use super::multi_position::{DecoderPoolManager, MultiPositionDecoderConfig, ScrubDetector};
use super::{
    DecoderInitResult, DecoderType, FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame,
    record_pts_hole,
};

const MAX_RELAXED_FALLBACK_DISTANCE: u32 = 8;
const SCRUB_REUSE_THRESHOLD_SECS: f32 = 0.5;
const DECODER_REQUEST_CLUSTER_GAP_FRAMES: u32 = FRAME_CACHE_SIZE as u32 / 2;

#[derive(Clone)]
struct FrameData {
    data: Arc<Vec<u8>>,
    y_stride: u32,
    uv_stride: u32,
}

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
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
        } = &self.frame_data;

        match self.format {
            PixelFormat::Rgba => {
                DecodedFrame::new_with_arc(Arc::clone(data), self.width, self.height)
            }
            PixelFormat::Nv12 => DecodedFrame::new_nv12_with_arc(
                Arc::clone(data),
                self.width,
                self.height,
                *y_stride,
                *uv_stride,
            ),
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
    fn new(processor: &ImageBufProcessor, image_buf: R<cv::ImageBuf>, number: u32) -> Self {
        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;

        let pixel_format =
            cap_video_decode::avassetreader::pixel_format_to_pixel(image_buf.pixel_format());

        match pixel_format {
            format::Pixel::NV12
            | format::Pixel::RGBA
            | format::Pixel::BGRA
            | format::Pixel::YUV420P => {
                let mut img = image_buf;
                let (data, fmt, y_str, uv_str) = processor.extract_raw(&mut img);
                Self(ProcessedFrame {
                    number,
                    width,
                    height,
                    format: fmt,
                    frame_data: FrameData {
                        data: Arc::new(data),
                        y_stride: y_str,
                        uv_stride: uv_str,
                    },
                })
            }
            _ => {
                let black_frame = vec![0u8; (width * height * 4) as usize];
                Self(ProcessedFrame {
                    number,
                    width,
                    height,
                    format: PixelFormat::Rgba,
                    frame_data: FrameData {
                        data: Arc::new(black_frame),
                        y_stride: width * 4,
                        uv_stride: 0,
                    },
                })
            }
        }
    }

    fn data(&self) -> &ProcessedFrame {
        &self.0
    }
}

struct DecoderHealth {
    consecutive_empty_iterations: u32,
    consecutive_errors: u32,
    total_frames_decoded: u64,
    last_successful_decode: std::time::Instant,
    reached_eof: bool,
    last_successful_frame: Option<u32>,
}

impl DecoderHealth {
    const MAX_CONSECUTIVE_EMPTY: u32 = 5;
    const MAX_CONSECUTIVE_ERRORS: u32 = 10;
    const STALE_THRESHOLD_SECS: u64 = 10;
    const EOF_TOLERANCE_EMPTY: u32 = 15;

    fn new() -> Self {
        Self {
            consecutive_empty_iterations: 0,
            consecutive_errors: 0,
            total_frames_decoded: 0,
            last_successful_decode: std::time::Instant::now(),
            reached_eof: false,
            last_successful_frame: None,
        }
    }

    fn record_success(&mut self, frames_count: u32, last_frame: u32) {
        self.consecutive_empty_iterations = 0;
        self.consecutive_errors = 0;
        self.total_frames_decoded += frames_count as u64;
        self.last_successful_decode = std::time::Instant::now();
        self.reached_eof = false;
        self.last_successful_frame = Some(last_frame);
    }

    fn record_empty_iteration(&mut self) {
        self.consecutive_empty_iterations += 1;
    }

    fn record_error(&mut self) {
        self.consecutive_errors += 1;
    }

    fn mark_eof(&mut self) {
        self.reached_eof = true;
    }

    fn is_at_eof(&self) -> bool {
        self.reached_eof
    }

    fn needs_recreation(&self, requested_frame: u32, total_frames_estimate: u32) -> bool {
        if self.reached_eof {
            return self.consecutive_empty_iterations >= Self::EOF_TOLERANCE_EMPTY;
        }

        let near_end = if total_frames_estimate > 0 {
            let remaining = total_frames_estimate.saturating_sub(requested_frame);
            remaining < 60
        } else {
            false
        };

        if near_end {
            return self.consecutive_empty_iterations >= Self::EOF_TOLERANCE_EMPTY
                || self.consecutive_errors >= Self::MAX_CONSECUTIVE_ERRORS;
        }

        self.consecutive_empty_iterations >= Self::MAX_CONSECUTIVE_EMPTY
            || self.consecutive_errors >= Self::MAX_CONSECUTIVE_ERRORS
            || (self.total_frames_decoded > 0
                && self.last_successful_decode.elapsed().as_secs() > Self::STALE_THRESHOLD_SECS)
    }

    fn reset_counters(&mut self) {
        self.consecutive_empty_iterations = 0;
        self.consecutive_errors = 0;
        self.last_successful_decode = std::time::Instant::now();
        self.reached_eof = false;
    }
}

struct DecoderInstance {
    inner: cap_video_decode::AVAssetReaderDecoder,
    is_done: bool,
    frames_iter_valid: bool,
    health: DecoderHealth,
    path: PathBuf,
    tokio_handle: TokioHandle,
    keyframe_index: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>>,
    /// Previous frame number this instance vended, for pts-hole discovery.
    /// Lives on the instance because the reader vends in pts order between
    /// resets, but request batches may be served by different pool decoders.
    prev_vended: Option<u32>,
}

impl DecoderInstance {
    fn new(
        path: PathBuf,
        tokio_handle: TokioHandle,
        start_time: f32,
        keyframe_index: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>>,
    ) -> Result<Self, String> {
        Ok(Self {
            inner: cap_video_decode::AVAssetReaderDecoder::new_with_keyframe_index(
                path.clone(),
                tokio_handle.clone(),
                start_time,
                keyframe_index.clone(),
            )?,
            is_done: false,
            frames_iter_valid: true,
            health: DecoderHealth::new(),
            path,
            tokio_handle,
            keyframe_index,
            prev_vended: None,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        match self.inner.reset(requested_time) {
            Ok(()) => {
                self.is_done = false;
                self.frames_iter_valid = true;
                self.health.reset_counters();
                self.prev_vended = None;
            }
            Err(e) => {
                tracing::error!(
                    requested_time = requested_time,
                    error = %e,
                    "Failed to reset decoder, marking as invalid"
                );
                self.is_done = true;
                self.frames_iter_valid = false;
                self.health.record_error();
            }
        }
    }

    fn recreate(&mut self, start_time: f32) -> Result<(), String> {
        tracing::info!(
            start_time = start_time,
            consecutive_empty = self.health.consecutive_empty_iterations,
            consecutive_errors = self.health.consecutive_errors,
            "Recreating decoder instance due to poor health"
        );

        self.inner = cap_video_decode::AVAssetReaderDecoder::new_with_keyframe_index(
            self.path.clone(),
            self.tokio_handle.clone(),
            start_time,
            self.keyframe_index.clone(),
        )?;
        self.is_done = false;
        self.frames_iter_valid = true;
        self.health = DecoderHealth::new();
        self.prev_vended = None;
        Ok(())
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
    total_frames_estimate: u32,
}

impl AVAssetReaderDecoder {
    fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        let keyframe_index = cap_video_decode::avassetreader::KeyframeIndex::build(&path).ok();
        let fps = keyframe_index
            .as_ref()
            .map(|kf| kf.fps() as u32)
            .unwrap_or(30);
        let duration_secs = keyframe_index
            .as_ref()
            .map(|kf| kf.duration_secs())
            .unwrap_or(0.0);
        let keyframe_index_arc = keyframe_index.map(Arc::new);

        let config = MultiPositionDecoderConfig {
            path: path.clone(),
            tokio_handle: tokio_handle.clone(),
            keyframe_index: keyframe_index_arc.clone(),
            fps,
            duration_secs,
        };

        let pool_manager = DecoderPoolManager::new(config);

        let primary_instance = DecoderInstance::new(
            path.clone(),
            tokio_handle.clone(),
            0.0,
            keyframe_index_arc.clone(),
        )?;

        let mut decoders = vec![primary_instance];

        let initial_positions = pool_manager.positions();
        for pos in initial_positions.iter().skip(1) {
            let start_time = pos.position_secs;
            match DecoderInstance::new(
                path.clone(),
                tokio_handle.clone(),
                start_time,
                keyframe_index_arc.clone(),
            ) {
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

        let total_frames_estimate = (duration_secs * fps as f64).ceil() as u32;

        tracing::info!(
            decoder_count = decoders.len(),
            optimal_pool_size = pool_manager.optimal_pool_size(),
            reposition_threshold = pool_manager.reposition_threshold(),
            fps = fps,
            duration_secs = duration_secs,
            total_frames_estimate = total_frames_estimate,
            "Initialized multi-position decoder pool"
        );

        Ok(Self {
            decoders,
            pool_manager,
            active_decoder_idx: 0,
            scrub_detector: ScrubDetector::new(),
            total_frames_estimate,
        })
    }

    fn select_best_decoder(&mut self, requested_time: f32, is_scrubbing: bool) -> (usize, bool) {
        let decoder_count = self.decoders.len();
        let (best_id, _distance, needs_reset) = if is_scrubbing {
            self.pool_manager
                .find_best_decoder_for_time_with_reuse_threshold(
                    requested_time,
                    decoder_count,
                    SCRUB_REUSE_THRESHOLD_SECS,
                )
        } else {
            self.pool_manager
                .find_best_decoder_for_time(requested_time, decoder_count)
        };

        let decoder_idx = best_id.min(decoder_count.saturating_sub(1));

        if needs_reset && decoder_idx < self.decoders.len() {
            self.decoders[decoder_idx].reset(requested_time);
            self.pool_manager.update_decoder_position(
                decoder_idx,
                self.decoders[decoder_idx].current_position(),
            );
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
        // pts holes (start frame -> first frame after the hole) discovered
        // from decode-order jumps. These are facts about the file — decoders
        // vend samples in pts order, so a jump between consecutive vends can
        // only mean no samples exist in between — and therefore survive
        // resets and cache eviction.
        let mut pts_holes = BTreeMap::<u32, u32>::new();
        // Content of the most recently served VFR hold, kept across request
        // batches so a hole keeps rendering its true frame even after the
        // pre-hole frame leaves the cache.
        let mut gap_hold: Option<ProcessedFrame> = None;

        let processor = ImageBufProcessor::new();

        struct PendingRequest {
            frame: u32,
            max_fallback_distance: u32,
            sender: oneshot::Sender<DecodedFrame>,
        }

        let mut deferred_requests = VecDeque::<PendingRequest>::new();

        loop {
            let mut pending_requests: Vec<PendingRequest> = Vec::with_capacity(8);
            let processing_deferred = !deferred_requests.is_empty();

            if let Some(request) = deferred_requests.pop_front() {
                if request.sender.is_closed() {
                    continue;
                }
                let mut last_frame = request.frame;
                pending_requests.push(request);
                while deferred_requests.front().is_some_and(|next| {
                    next.frame.saturating_sub(last_frame) <= DECODER_REQUEST_CLUSTER_GAP_FRAMES
                }) {
                    if let Some(request) = deferred_requests.pop_front() {
                        if request.sender.is_closed() {
                            continue;
                        }
                        last_frame = request.frame;
                        pending_requests.push(request);
                    }
                }
            } else {
                let Ok(message) = rx.recv() else {
                    break;
                };
                match message {
                    VideoDecoderMessage::GetFrame(
                        requested_time,
                        max_fallback_distance,
                        sender,
                    ) => {
                        let frame = (requested_time * fps as f32).floor() as u32;
                        if !sender.is_closed() {
                            pending_requests.push(PendingRequest {
                                frame,
                                max_fallback_distance,
                                sender,
                            });
                        }
                    }
                }

                while let Ok(message) = rx.try_recv() {
                    match message {
                        VideoDecoderMessage::GetFrame(
                            requested_time,
                            max_fallback_distance,
                            sender,
                        ) => {
                            let frame = (requested_time * fps as f32).floor() as u32;
                            if !sender.is_closed() {
                                pending_requests.push(PendingRequest {
                                    frame,
                                    max_fallback_distance,
                                    sender,
                                });
                            }
                        }
                    }
                }
            }

            pending_requests.sort_by_key(|r| r.frame);

            if !processing_deferred
                && let Some(split_index) = pending_requests
                    .windows(2)
                    .position(|requests| {
                        requests[1].frame.saturating_sub(requests[0].frame)
                            > DECODER_REQUEST_CLUSTER_GAP_FRAMES
                    })
                    .map(|index| index + 1)
            {
                deferred_requests.extend(pending_requests.drain(split_index..));
            }

            let is_scrubbing = if let Some(first_req) = pending_requests.first() {
                this.scrub_detector.record_request(first_req.frame)
            } else {
                false
            };

            let mut unfulfilled = Vec::with_capacity(pending_requests.len());
            let mut last_sent_data = None;
            for request in pending_requests.drain(..) {
                if let Some(cached) = cache.get(&request.frame) {
                    let data = cached.data().clone();
                    let _ = request.sender.send(data.to_decoded_frame());
                    last_sent_data = Some(data);
                } else {
                    unfulfilled.push(request);
                }
            }
            if let Some(data) = last_sent_data {
                *last_sent_frame.borrow_mut() = Some(data);
            }
            pending_requests = unfulfilled;

            // Requests inside a KNOWN pts hole are answered with the hole's
            // start frame — the true VFR hold (the frame simply stayed on
            // screen) — without touching the decoder. This keeps the
            // post-hole frames cached and the reader parked, however long the
            // hole runs; decoding ahead here would evict the very frames the
            // requests are marching towards. Only recorded holes qualify: a
            // bare "some cached frame lies beyond the request" test would
            // also match disjoint cache islands left by seeks, and serving
            // stale content there would freeze playback on old frames.
            let mut still_unfulfilled = Vec::with_capacity(pending_requests.len());
            for req in pending_requests.drain(..) {
                let hole_start = pts_holes
                    .range(..=req.frame)
                    .next_back()
                    .filter(|&(_, &end)| req.frame < end)
                    .map(|(&start, _)| start);
                let Some(hole_start) = hole_start else {
                    still_unfulfilled.push(req);
                    continue;
                };
                let data = cache
                    .get(&hole_start)
                    .map(|c| c.data().clone())
                    .or_else(|| gap_hold.clone().filter(|h| h.number == hole_start));
                if let Some(data) = data {
                    gap_hold = Some(data.clone());
                    *last_sent_frame.borrow_mut() = Some(data.clone());
                    let _ = req.sender.send(data.to_decoded_frame());
                } else {
                    still_unfulfilled.push(req);
                }
            }
            pending_requests = still_unfulfilled;

            if pending_requests.is_empty() {
                continue;
            }

            let min_requested_frame = pending_requests.iter().map(|r| r.frame).min().unwrap();
            let max_requested_frame = pending_requests.iter().map(|r| r.frame).max().unwrap();
            let requested_frame = min_requested_frame;
            let requested_time = requested_frame as f32 / fps as f32;
            let minimum_fallback_frame = pending_requests
                .iter()
                .map(|r| r.frame.saturating_sub(r.max_fallback_distance))
                .min()
                .unwrap_or(requested_frame);

            let (decoder_idx, was_reset) = this.select_best_decoder(requested_time, is_scrubbing);

            let cache_min = if was_reset {
                min_requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 * 2)
            } else {
                min_requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2)
            };
            let cache_max = if is_scrubbing {
                max_requested_frame + FRAME_CACHE_SIZE as u32 / 4
            } else {
                max_requested_frame + FRAME_CACHE_SIZE as u32
            };

            if was_reset {
                *last_sent_frame.borrow_mut() = None;
                cache.retain(|&f, _| f >= cache_min && f <= cache_max);
            }

            last_active_frame = Some(requested_frame);

            let mut exit = false;
            let mut frames_iterated = 0u32;
            let mut last_decoded_position: Option<f32> = None;
            // Newest vended frame below the fallback floor: after a seek the
            // reader re-vends from the keyframe at-or-before the request, and
            // that frame is the true VFR hold for requests inside a pts hole.
            let mut hold_candidate: Option<(u32, R<cv::ImageBuf>)> = None;

            {
                let decoder = &mut this.decoders[decoder_idx];
                let mut frames = decoder.inner.frames();

                for frame in &mut frames {
                    let frame = match frame {
                        Ok(f) => f,
                        Err(e) => {
                            tracing::error!(
                                decoder_idx = decoder_idx,
                                frames_iterated = frames_iterated,
                                error = %e,
                                "Failed to read frame, skipping"
                            );
                            // A skipped frame breaks the vend continuity that
                            // hole discovery relies on; a jump across it is
                            // not evidence of a hole.
                            decoder.prev_vended = None;
                            continue;
                        }
                    };
                    frames_iterated += 1;

                    let current_frame =
                        pts_to_frame(frame.pts().value, Rational::new(1, frame.pts().scale), fps);

                    if let Some(prev) = decoder.prev_vended
                        && current_frame > prev + 1
                    {
                        record_pts_hole(&mut pts_holes, prev, current_frame);
                    }
                    decoder.prev_vended = Some(current_frame);

                    let position_secs = current_frame as f32 / fps as f32;
                    last_decoded_position = Some(position_secs);
                    decoder.is_done = false;

                    if current_frame < minimum_fallback_frame {
                        // Keep a handle to it instead of discarding it: if the
                        // requests land inside a pts hole this is the only
                        // at-or-before content the reader will ever vend.
                        if let Some(buf) = frame.image_buf() {
                            hold_candidate = Some((current_frame, buf.retained()));
                        }
                        continue;
                    }

                    let Some(frame) = frame.image_buf() else {
                        tracing::debug!(
                            current_frame = current_frame,
                            "Frame has no image buffer, skipping"
                        );
                        continue;
                    };

                    let cache_frame = CachedFrame::new(&processor, frame.retained(), current_frame);

                    if first_ever_frame.borrow().is_none() {
                        *first_ever_frame.borrow_mut() = Some(cache_frame.data().clone());
                    }

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
                                } else {
                                    // Always answer. Prefer the newest frame at-or-before
                                    // the request — from the cache, the hold candidate the
                                    // seek re-vended, or the persistent gap hold — as the
                                    // true VFR hold content (a pts gap means the frame
                                    // stayed on screen). A later frame is the last resort;
                                    // leaving the request unanswered would wedge the render
                                    // loop.
                                    let cached_before = cache
                                        .range(..=req.frame)
                                        .next_back()
                                        .map(|(_, c)| c.data().clone());
                                    let hold_before = gap_hold.clone().filter(|h| {
                                        pts_holes.get(&h.number).is_some_and(|&end| {
                                            h.number <= req.frame && req.frame < end
                                        })
                                    });
                                    let candidate_before = hold_candidate
                                        .as_ref()
                                        .filter(|(n, _)| *n <= req.frame)
                                        .map(|(n, buf)| {
                                            CachedFrame::new(&processor, buf.retained(), *n)
                                                .data()
                                                .clone()
                                        });
                                    let best_before =
                                        [cached_before, hold_before, candidate_before]
                                            .into_iter()
                                            .flatten()
                                            .max_by_key(|d| d.number);

                                    if let Some(data) = best_before {
                                        gap_hold = Some(data.clone());
                                        *last_sent_frame.borrow_mut() = Some(data.clone());
                                        let _ = req.sender.send(data.to_decoded_frame());
                                    } else if let Some((&frame_num, cached)) =
                                        cache.range(req.frame..).next()
                                    {
                                        tracing::debug!(
                                            req_frame = req.frame,
                                            nearest_frame = frame_num,
                                            "serving forward frame across pts gap"
                                        );
                                        let _ = req.sender.send(cached.data().to_decoded_frame());
                                    } else {
                                        tracing::warn!(
                                            req_frame = req.frame,
                                            current_frame,
                                            "dropping overshot request: cache empty"
                                        );
                                    }
                                }
                            } else {
                                remaining_requests.push(req);
                            }
                        }
                        pending_requests = remaining_requests;
                    }

                    *last_sent_frame.borrow_mut() = Some(cache_frame.data().clone());

                    exit = exit || exceeds_cache_bounds;

                    if pending_requests.is_empty() || exit {
                        break;
                    }
                }

                decoder.is_done = true;
            }

            let last_frame_in_cache = cache.keys().max().copied().unwrap_or(0);
            if frames_iterated > 0 {
                this.decoders[decoder_idx]
                    .health
                    .record_success(frames_iterated, last_frame_in_cache);
            } else if !pending_requests.is_empty() {
                this.decoders[decoder_idx].health.record_empty_iteration();

                let near_end = this.total_frames_estimate > 0
                    && requested_frame > this.total_frames_estimate.saturating_sub(120);

                let at_eof = near_end
                    && this.decoders[decoder_idx]
                        .health
                        .consecutive_empty_iterations
                        >= 3
                    && !cache.is_empty()
                    && cache.keys().max().copied().unwrap_or(0)
                        > requested_frame.saturating_sub(60);

                if at_eof && !this.decoders[decoder_idx].health.is_at_eof() {
                    this.decoders[decoder_idx].health.mark_eof();
                    tracing::info!(
                        decoder_idx = decoder_idx,
                        requested_frame = requested_frame,
                        total_frames = this.total_frames_estimate,
                        cache_max = cache.keys().max().copied().unwrap_or(0),
                        "Decoder reached EOF - will use cached frames for remaining requests"
                    );
                }

                if near_end {
                    tracing::debug!(
                        decoder_idx = decoder_idx,
                        requested_frame = requested_frame,
                        requested_time = requested_time,
                        was_reset = was_reset,
                        cache_size = cache.len(),
                        consecutive_empty = this.decoders[decoder_idx]
                            .health
                            .consecutive_empty_iterations,
                        near_end = near_end,
                        "Decoder reached video tail while using EOF tolerance"
                    );
                } else if !at_eof {
                    tracing::warn!(
                        decoder_idx = decoder_idx,
                        requested_frame = requested_frame,
                        requested_time = requested_time,
                        was_reset = was_reset,
                        cache_size = cache.len(),
                        consecutive_empty = this.decoders[decoder_idx]
                            .health
                            .consecutive_empty_iterations,
                        near_end = near_end,
                        "No frames decoded from video - decoder iterator returned no frames"
                    );
                }

                if this.decoders[decoder_idx]
                    .health
                    .needs_recreation(requested_frame, this.total_frames_estimate)
                {
                    if let Err(e) = this.decoders[decoder_idx].recreate(requested_time) {
                        tracing::error!(
                            decoder_idx = decoder_idx,
                            error = %e,
                            "Failed to recreate unhealthy decoder"
                        );
                    } else {
                        this.pool_manager.update_decoder_position(
                            decoder_idx,
                            this.decoders[decoder_idx].current_position(),
                        );
                    }
                }
            }

            if let Some(last_pos) = last_decoded_position {
                let max_req_time = max_requested_frame as f32 / fps as f32;
                let capped = last_pos.min(max_req_time);
                this.pool_manager
                    .update_decoder_position(decoder_idx, capped);
            }

            let mut unfulfilled_count = 0u32;
            let decoder_returned_no_frames = frames_iterated == 0;
            let decoder_at_eof = this.decoders[decoder_idx].health.is_at_eof();
            let near_video_end = this.total_frames_estimate > 0
                && requested_frame > this.total_frames_estimate.saturating_sub(120);

            for req in pending_requests.drain(..) {
                if let Some(cached) = cache.get(&req.frame) {
                    let data = cached.data().clone();
                    let _ = req.sender.send(data.to_decoded_frame());
                } else {
                    let allow_relaxed_fallback = is_scrubbing
                        || near_video_end
                        || decoder_at_eof
                        || decoder_returned_no_frames;

                    let fallback_distance = if allow_relaxed_fallback {
                        req.max_fallback_distance.max(MAX_RELAXED_FALLBACK_DISTANCE)
                    } else {
                        req.max_fallback_distance
                    };

                    // Always answer with the newest frame at-or-before the request —
                    // from the cache, the hold candidate a seek re-vended, or the
                    // persistent gap hold — as the true VFR hold content. A later frame
                    // is the best remaining answer; dropping the request instead
                    // starves the render loop and wedges gap playback/export.
                    let cached_before = cache
                        .range(..=req.frame)
                        .next_back()
                        .map(|(_, c)| c.data().clone());
                    let hold_before = gap_hold.clone().filter(|h| {
                        pts_holes
                            .get(&h.number)
                            .is_some_and(|&end| h.number <= req.frame && req.frame < end)
                    });
                    let candidate_before = hold_candidate
                        .as_ref()
                        .filter(|(n, _)| *n <= req.frame)
                        .map(|(n, buf)| {
                            CachedFrame::new(&processor, buf.retained(), *n)
                                .data()
                                .clone()
                        });
                    let best_before = [cached_before, hold_before, candidate_before]
                        .into_iter()
                        .flatten()
                        .max_by_key(|d| d.number);

                    if let Some(data) = best_before {
                        gap_hold = Some(data.clone());
                        *last_sent_frame.borrow_mut() = Some(data.clone());
                        let _ = req.sender.send(data.to_decoded_frame());
                    } else if let Some((&frame_num, cached)) = cache.range(req.frame..).next() {
                        if req.frame.abs_diff(frame_num) > fallback_distance {
                            tracing::debug!(
                                req_frame = req.frame,
                                nearest_frame = frame_num,
                                "serving forward frame across pts gap"
                            );
                        }
                        let _ = req.sender.send(cached.data().to_decoded_frame());
                    } else if allow_relaxed_fallback
                        && let Some(ref last) = *last_sent_frame.borrow()
                    {
                        let _ = req.sender.send(last.to_decoded_frame());
                    } else if allow_relaxed_fallback
                        && let Some(ref first) = *first_ever_frame.borrow()
                    {
                        let _ = req.sender.send(first.to_decoded_frame());
                    } else {
                        unfulfilled_count += 1;
                    }
                }
            }

            if unfulfilled_count > 0 {
                tracing::warn!(
                    unfulfilled_count = unfulfilled_count,
                    cache_size = cache.len(),
                    frames_iterated = frames_iterated,
                    "Frame requests could not be fulfilled - frames not in cache or nearby"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decoder_health_new() {
        let health = DecoderHealth::new();
        assert_eq!(health.consecutive_empty_iterations, 0);
        assert_eq!(health.consecutive_errors, 0);
        assert_eq!(health.total_frames_decoded, 0);
        assert!(!health.needs_recreation(0, 100));
    }

    #[test]
    fn test_decoder_health_record_success_resets_counters() {
        let mut health = DecoderHealth::new();
        health.consecutive_empty_iterations = 3;
        health.consecutive_errors = 5;

        health.record_success(10, 9);

        assert_eq!(health.consecutive_empty_iterations, 0);
        assert_eq!(health.consecutive_errors, 0);
        assert_eq!(health.total_frames_decoded, 10);
        assert!(!health.needs_recreation(10, 100));
    }

    #[test]
    fn test_decoder_health_needs_recreation_after_empty_iterations() {
        let mut health = DecoderHealth::new();
        for _ in 0..DecoderHealth::MAX_CONSECUTIVE_EMPTY {
            health.record_empty_iteration();
        }
        assert!(health.needs_recreation(50, 200));
    }

    #[test]
    fn test_decoder_health_needs_recreation_after_errors() {
        let mut health = DecoderHealth::new();
        for _ in 0..DecoderHealth::MAX_CONSECUTIVE_ERRORS {
            health.record_error();
        }
        assert!(health.needs_recreation(50, 100));
    }

    #[test]
    fn test_decoder_health_reset_counters() {
        let mut health = DecoderHealth::new();
        health.consecutive_empty_iterations = 10;
        health.consecutive_errors = 10;

        health.reset_counters();

        assert_eq!(health.consecutive_empty_iterations, 0);
        assert_eq!(health.consecutive_errors, 0);
        assert!(!health.needs_recreation(0, 100));
    }

    #[test]
    fn test_decoder_health_below_threshold_no_recreation() {
        let mut health = DecoderHealth::new();
        for _ in 0..(DecoderHealth::MAX_CONSECUTIVE_EMPTY - 1) {
            health.record_empty_iteration();
        }
        assert!(!health.needs_recreation(50, 100));
    }
}
