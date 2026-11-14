use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format};
use tokio::{
    runtime::Handle as TokioHandle,
    sync::{OwnedSemaphorePermit, Semaphore, oneshot},
};

use crate::{DecodedFrame, PixelFormat, cpu_yuv::YuvMatrix};

use super::frame_converter::{copy_bgra_to_rgba, copy_rgba_plane};
use super::multi_position::{DecoderPoolManager, MultiPositionDecoderConfig, ScrubDetector};
use super::{
    DecoderInitResult, DecoderType, FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame,
    record_pts_hole,
};

const MAX_RELAXED_FALLBACK_DISTANCE: u32 = 8;
const SCRUB_REUSE_THRESHOLD_SECS: f32 = 0.5;
const DECODER_REQUEST_CLUSTER_GAP_FRAMES: u32 = FRAME_CACHE_SIZE as u32 / 2;
// A frame-count-only limit can retain more than 1 GiB for high-resolution
// recordings. Keep the existing temporal cap, but also bound the raw decoded
// frame data so playback remains viable on memory-constrained devices.
const MAX_FRAME_CACHE_BYTES: usize = 256 * 1024 * 1024;
// Sequential readers never revisit frames behind the newest request, so only
// the newest few are kept: enough for repeated requests and for answering a
// request inside a pts hole with the frame before it. Each retained frame pins
// a decoder-owned IOSurface (about 9 MB for a 3K screen).
const SEQUENTIAL_FRAME_CACHE_SIZE: usize = 8;
// Paused recordings can contain hundreds of screen/camera pairs. AVAssetReader
// starts decoding eagerly, so only requested tracks may hold native readers.
const MAX_ACTIVE_READERS: usize = 16;
// An idle reader keeps its native reader, cache and warm-ahead frames for
// IDLE_READER_RETAIN, so a hover or Play shortly after a pause continues
// from them. It releases them sooner, at the next IDLE_READER_POLL, when every
// reader permit is taken and another track may be waiting for one.
const IDLE_READER_POLL: Duration = Duration::from_millis(250);
const IDLE_READER_RETAIN: Duration = Duration::from_secs(5);
const MAX_CACHED_FRAMES_BELOW_REQUEST: u32 = 10;

fn reader_capacity() -> &'static Arc<Semaphore> {
    static CAPACITY: OnceLock<Arc<Semaphore>> = OnceLock::new();
    CAPACITY.get_or_init(|| Arc::new(Semaphore::new(MAX_ACTIVE_READERS)))
}

#[derive(Default)]
struct RequestDirection {
    highest_frame: Option<u32>,
    moved_backwards: bool,
}

impl RequestDirection {
    fn record_batch(&mut self, first_frame: u32, last_frame: u32) {
        self.moved_backwards |= self
            .highest_frame
            .is_some_and(|highest| first_frame < highest);
        self.highest_frame = self.highest_frame.max(Some(last_frame));
    }

    fn frame_cache_limit(&self, sequential_access: bool) -> usize {
        if sequential_access && !self.moved_backwards {
            SEQUENTIAL_FRAME_CACHE_SIZE
        } else {
            FRAME_CACHE_SIZE
        }
    }
}

fn frame_cache_needs_eviction(
    current_frames: usize,
    current_bytes: usize,
    next_frame_bytes: usize,
    frame_limit: usize,
) -> bool {
    current_frames >= frame_limit
        || current_bytes.saturating_add(next_frame_bytes) > MAX_FRAME_CACHE_BYTES
}

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    frame: DecodedFrame,
}

impl ProcessedFrame {
    fn to_decoded_frame(&self) -> DecodedFrame {
        self.frame.clone()
    }
}

#[derive(Clone)]
struct CachedFrame(ProcessedFrame);

struct ImageBufProcessor {
    matrix: YuvMatrix,
}

impl ImageBufProcessor {
    fn new(matrix: YuvMatrix) -> Self {
        Self { matrix }
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
                let frame = if pixel_format == format::Pixel::NV12 && image_buf.io_surf().is_some()
                {
                    let y_stride = image_buf.plane_bytes_per_row(0) as u32;
                    let uv_stride = image_buf.plane_bytes_per_row(1) as u32;
                    DecodedFrame::new_nv12_with_image_buf(
                        width, height, y_stride, uv_stride, image_buf,
                    )
                } else {
                    let mut image_buf = image_buf;
                    let (data, fmt, y_str, uv_str) = processor.extract_raw(&mut image_buf);
                    let data = Arc::new(data);
                    match fmt {
                        PixelFormat::Nv12 => {
                            DecodedFrame::new_nv12_with_arc(data, width, height, y_str, uv_str)
                        }
                        PixelFormat::Rgba => DecodedFrame::new_with_arc(data, width, height),
                        PixelFormat::Yuv420p => {
                            DecodedFrame::new_yuv420p_with_arc(data, width, height, y_str, uv_str)
                        }
                    }
                };
                Self(ProcessedFrame {
                    number,
                    frame: frame.with_matrix(processor.matrix),
                })
            }
            _ => {
                let black_frame = vec![0u8; (width * height * 4) as usize];
                Self(ProcessedFrame {
                    number,
                    frame: DecodedFrame::new(black_frame, width, height),
                })
            }
        }
    }

    fn byte_len(&self) -> usize {
        self.0.frame.byte_len()
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
    /// First frame of the uninterrupted vend run that ends at `prev_vended`.
    run_start: Option<u32>,
    _permit: OwnedSemaphorePermit,
}

impl DecoderInstance {
    fn new(
        path: PathBuf,
        tokio_handle: TokioHandle,
        start_time: f32,
        keyframe_index: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>>,
        permit: OwnedSemaphorePermit,
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
            run_start: None,
            _permit: permit,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        match self.inner.reset(requested_time) {
            Ok(()) => {
                self.is_done = false;
                self.frames_iter_valid = true;
                self.health.reset_counters();
                self.prev_vended = None;
                self.run_start = None;
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
        self.run_start = None;
        Ok(())
    }

    fn current_position(&self) -> f32 {
        self.inner.current_position_secs()
    }

    fn would_serve_stale_frame(&self, frame: u32, cache: &BTreeMap<u32, CachedFrame>) -> bool {
        reuse_would_serve_stale_frame(
            self.run_start,
            self.prev_vended,
            cache.range(..=frame).next_back().map(|(&cached, _)| cached),
        )
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
    fn new(
        path: PathBuf,
        tokio_handle: TokioHandle,
        keyframe_index: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>>,
        requested_time: f32,
    ) -> Result<Self, String> {
        let fps = keyframe_index
            .as_ref()
            .map(|kf| kf.fps() as u32)
            .unwrap_or(30);
        let duration_secs = keyframe_index
            .as_ref()
            .map(|kf| kf.duration_secs())
            .unwrap_or(0.0);
        let keyframe_index_arc = keyframe_index;

        let config = MultiPositionDecoderConfig {
            path: path.clone(),
            tokio_handle: tokio_handle.clone(),
            keyframe_index: keyframe_index_arc.clone(),
            fps,
            duration_secs,
        };

        let mut pool_manager = DecoderPoolManager::new(config);

        let permit = tokio_handle
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    reader_capacity().clone().acquire_owned(),
                )
                .await
            })
            .map_err(|_| "Timed out waiting for an available video reader".to_string())?
            .map_err(|error| error.to_string())?;

        let primary_instance = DecoderInstance::new(
            path.clone(),
            tokio_handle.clone(),
            requested_time,
            keyframe_index_arc.clone(),
            permit,
        )?;
        pool_manager.update_decoder_position(0, primary_instance.current_position());

        // Linear playback only needs one reader. Additional readers retain
        // AVFoundation state and decoded buffers, so create them only when a
        // non-sequential request would otherwise reposition an active reader.
        let decoders = vec![primary_instance];

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

    fn select_best_decoder(
        &mut self,
        requested_time: f32,
        is_scrubbing: bool,
        must_reset: impl Fn(&DecoderInstance) -> bool,
    ) -> (usize, bool) {
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
        let needs_reset = needs_reset || self.decoders.get(decoder_idx).is_some_and(must_reset);

        let max_decoder_count = self
            .pool_manager
            .optimal_pool_size()
            .min(self.pool_manager.positions().len());
        if should_grow_decoder_pool(is_scrubbing, needs_reset, decoder_count, max_decoder_count) {
            let (path, tokio_handle, keyframe_index) = {
                let config = self.pool_manager.config();
                (
                    config.path.clone(),
                    config.tokio_handle.clone(),
                    config.keyframe_index.clone(),
                )
            };

            let Ok(permit) = reader_capacity().clone().try_acquire_owned() else {
                self.decoders[decoder_idx].reset(requested_time);
                self.pool_manager.update_decoder_position(
                    decoder_idx,
                    self.decoders[decoder_idx].current_position(),
                );
                self.active_decoder_idx = decoder_idx;
                return (decoder_idx, true);
            };
            match DecoderInstance::new(path, tokio_handle, requested_time, keyframe_index, permit) {
                Ok(instance) => {
                    let decoder_idx = self.decoders.len();
                    let position = instance.current_position();
                    self.decoders.push(instance);
                    self.pool_manager
                        .update_decoder_position(decoder_idx, position);
                    self.active_decoder_idx = decoder_idx;
                    tracing::info!(
                        decoder_index = decoder_idx,
                        requested_time = requested_time,
                        decoder_count = self.decoders.len(),
                        "Created decoder instance on demand for non-sequential access"
                    );
                    return (decoder_idx, true);
                }
                Err(error) => {
                    tracing::warn!(
                        requested_time = requested_time,
                        error = %error,
                        "Failed to create decoder on demand; reusing an existing decoder"
                    );
                }
            }
        }

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
        sequential_access: Arc<AtomicBool>,
    ) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || {
            Self::run(name, path, fps, rx, ready_tx, handle, sequential_access)
        });
    }

    fn run(
        _name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
        tokio_handle: tokio::runtime::Handle,
        sequential_access: Arc<AtomicBool>,
    ) {
        let dimensions = (|| {
            #[cfg(test)]
            if let Some((width, height)) = cap_video_decode::scripted::dimensions(&path) {
                return Ok((width, height, YuvMatrix::default()));
            }
            if let Some(dimensions) = crate::project_recordings::header_video_metadata(&path) {
                return Ok(dimensions);
            }
            let input = format::input(&path).map_err(|error| error.to_string())?;
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| "No video stream found".to_string())?;
            let video = ffmpeg::codec::Context::from_parameters(stream.parameters())
                .and_then(|context| context.decoder().video())
                .map_err(|error| error.to_string())?;
            if video.width() == 0 || video.height() == 0 {
                return Err("Invalid video dimensions".to_string());
            }
            Ok((
                video.width(),
                video.height(),
                YuvMatrix::from_color_space(video.color_space()),
            ))
        })();
        let (width, height, matrix) = match dimensions {
            Ok(dimensions) => dimensions,
            Err(error) => {
                let _ = ready_tx.send(Err(error));
                return;
            }
        };
        let mut this = None::<Self>;
        let mut keyframe_index: Option<Arc<cap_video_decode::avassetreader::KeyframeIndex>> = None;

        let init_result = DecoderInitResult {
            width,
            height,
            decoder_type: DecoderType::AVAssetReader,
        };
        ready_tx.send(Ok(init_result)).ok();

        let mut cache = BTreeMap::<u32, CachedFrame>::new();
        let mut cache_bytes = 0usize;
        let mut request_direction = RequestDirection::default();

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

        let processor = ImageBufProcessor::new(matrix);

        struct PendingRequest {
            frame: u32,
            max_fallback_distance: u32,
            sender: oneshot::Sender<DecodedFrame>,
            retried: bool,
        }

        let mut deferred_requests = VecDeque::<PendingRequest>::new();
        let mut idle_since = None::<std::time::Instant>;

        loop {
            let _autorelease_pool = cidre::objc::AutoreleasePoolPage::push();
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
                let received = if this.is_some() {
                    rx.recv_timeout(IDLE_READER_POLL)
                } else {
                    rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                };
                let message = match received {
                    Ok(message) => {
                        idle_since = None;
                        message
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let idle = *idle_since.get_or_insert_with(std::time::Instant::now);
                        if idle.elapsed() < IDLE_READER_RETAIN
                            && reader_capacity().available_permits() > 0
                        {
                            continue;
                        }
                        idle_since = None;
                        cache.clear();
                        cache_bytes = 0;
                        *last_sent_frame.borrow_mut() = None;
                        *first_ever_frame.borrow_mut() = None;
                        gap_hold = None;
                        this = None;
                        continue;
                    }
                };
                match message {
                    VideoDecoderMessage::PreferSequentialAccess => {}
                    VideoDecoderMessage::GetFrame(
                        requested_time,
                        max_fallback_distance,
                        sender,
                    ) => {
                        let frame = super::request_frame(requested_time, fps);
                        if !sender.is_closed() {
                            pending_requests.push(PendingRequest {
                                frame,
                                max_fallback_distance,
                                sender,
                                retried: false,
                            });
                        }
                    }
                }

                while let Ok(message) = rx.try_recv() {
                    match message {
                        VideoDecoderMessage::PreferSequentialAccess => {}
                        VideoDecoderMessage::GetFrame(
                            requested_time,
                            max_fallback_distance,
                            sender,
                        ) => {
                            let frame = super::request_frame(requested_time, fps);
                            if !sender.is_closed() {
                                pending_requests.push(PendingRequest {
                                    frame,
                                    max_fallback_distance,
                                    sender,
                                    retried: false,
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

            if let (Some(first), Some(last)) = (pending_requests.first(), pending_requests.last()) {
                request_direction.record_batch(first.frame, last.frame);
            }

            let is_scrubbing =
                this.as_mut()
                    .zip(pending_requests.first())
                    .is_some_and(|(decoder, request)| {
                        decoder.scrub_detector.record_request(request.frame)
                    });

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

            // A track can start after the recording does. Before its first
            // frame, that frame is the answer; serving it from the cache keeps
            // the reader from stepping ahead on every such request.
            let stream_start_frame = keyframe_index
                .as_ref()
                .and_then(|index| index.keyframes().first())
                .map(|&(_, secs)| (secs * f64::from(fps)).round() as u32);
            if let Some(start) = stream_start_frame
                && let Some(first) = cache.get(&start).map(|cached| cached.data().clone())
            {
                let mut after_start = Vec::with_capacity(pending_requests.len());
                for req in pending_requests.drain(..) {
                    if req.frame < start {
                        *last_sent_frame.borrow_mut() = Some(first.clone());
                        let _ = req.sender.send(first.to_decoded_frame());
                    } else {
                        after_start.push(req);
                    }
                }
                pending_requests = after_start;
            }

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

            if this.is_none() {
                if keyframe_index.is_none() {
                    keyframe_index = cap_video_decode::avassetreader::KeyframeIndex::build(&path)
                        .ok()
                        .map(Arc::new);
                }
                match Self::new(
                    path.clone(),
                    tokio_handle.clone(),
                    keyframe_index.clone(),
                    requested_time,
                ) {
                    Ok(decoder) => this = Some(decoder),
                    Err(error) => {
                        tracing::warn!(%error, "Failed to initialize video reader on demand");
                        continue;
                    }
                }
            }
            pending_requests.retain(|request| !request.sender.is_closed());
            if pending_requests.is_empty() {
                continue;
            }
            let this = this.as_mut().expect("Video reader initialized above");

            // Pool positions are capped to the newest request, so a reader that
            // decoded ahead can look usable for a request it has already passed.
            // It can never vend that frame again, and reading on would answer
            // with a stale or later frame, so it has to seek back first. Before
            // the stream's first frame nothing better exists, so a seek is wasted.
            let retrying = pending_requests.iter().any(|request| request.retried);
            let before_stream_start =
                stream_start_frame.is_some_and(|start| requested_frame < start);
            let (decoder_idx, was_reset) =
                this.select_best_decoder(requested_time, is_scrubbing, |decoder| {
                    retrying
                        || decoder.would_serve_stale_frame(requested_frame, &cache)
                        || (!before_stream_start
                            && reader_passed_request(decoder.prev_vended, requested_frame))
                });

            let cache_min = if was_reset {
                min_requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 * 2)
            } else {
                min_requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2)
            };
            let cache_max = if is_scrubbing {
                max_requested_frame.saturating_add(FRAME_CACHE_SIZE as u32 / 4)
            } else {
                max_requested_frame.saturating_add(FRAME_CACHE_SIZE as u32)
            };

            // The last frame each other pooled reader vended is the answer for a
            // request that lands in the gap after it, and the reader can never
            // vend it again; keep it cached while requests alternate between
            // readers.
            let pinned_frames: Vec<u32> = this
                .decoders
                .iter()
                .enumerate()
                .filter(|&(index, _)| index != decoder_idx)
                .filter_map(|(_, decoder)| decoder.prev_vended)
                .collect();

            if was_reset {
                *last_sent_frame.borrow_mut() = None;
                cache.retain(|f, _| {
                    (*f >= cache_min && *f <= cache_max) || pinned_frames.contains(f)
                });
                cache_bytes = cache
                    .values()
                    .map(CachedFrame::byte_len)
                    .fold(0usize, usize::saturating_add);
            }

            last_active_frame = Some(requested_frame);

            let frame_limit =
                request_direction.frame_cache_limit(sequential_access.load(Ordering::Relaxed));
            let mut exit = false;
            let mut abandoned = false;
            let mut frames_iterated = 0u32;
            let mut last_decoded_position: Option<f32> = None;
            // Newest vended frame below the fallback floor: after a seek the
            // reader re-vends from the keyframe at-or-before the request, and
            // that frame is the true VFR hold for requests inside a pts hole.
            let mut hold_candidate: Option<(u32, R<cv::ImageBuf>)> = None;
            let mut retry_requests = Vec::new();

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

                    let vended_before = decoder.prev_vended;
                    if let Some(prev) = vended_before
                        && current_frame > prev + 1
                    {
                        record_pts_hole(&mut pts_holes, prev, current_frame);
                    }
                    if decoder.prev_vended.is_none() {
                        decoder.run_start = Some(current_frame);
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
                            // A seek decodes from the keyframe before the
                            // request, and scrubbing backwards asks for the
                            // frames just below it next; caching them makes
                            // those requests hits instead of another seek over
                            // the same span. Only the last few are kept: each
                            // pins a buffer of the reader's own pool, and with
                            // dozens outstanding the reader stops vending.
                            if current_frame >= cache_min
                                && current_frame + MAX_CACHED_FRAMES_BELOW_REQUEST
                                    >= minimum_fallback_frame
                            {
                                insert_cached_frame(
                                    &mut cache,
                                    &mut cache_bytes,
                                    current_frame,
                                    CachedFrame::new(&processor, buf.retained(), current_frame),
                                    frame_limit,
                                    requested_frame,
                                    last_active_frame,
                                    |frame| {
                                        Some(frame) == vended_before
                                            || pinned_frames.contains(&frame)
                                    },
                                );
                            }
                        }
                        // Every request in the batch was given up on (a newer
                        // scrub position, a live seek dropping its prefetches):
                        // reading on towards their frames only delays the
                        // request that replaced them.
                        if pending_requests.iter().all(|r| r.sender.is_closed()) {
                            abandoned = true;
                            break;
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
                        insert_cached_frame(
                            &mut cache,
                            &mut cache_bytes,
                            current_frame,
                            cache_frame.clone(),
                            frame_limit,
                            requested_frame,
                            last_active_frame,
                            |frame| Some(frame) == vended_before || pinned_frames.contains(&frame),
                        );

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

                                    // The reader vends every sample in pts order, so the
                                    // frame it vended just before this one is the newest
                                    // at or before the request. When that frame is no
                                    // longer held anywhere, any other answer is stale or
                                    // from the future: retry once from a fresh seek, which
                                    // re-vends and keeps it.
                                    if !req.retried
                                        && answer_misses_previous_vend(
                                            vended_before,
                                            req.frame,
                                            best_before.as_ref().map(|d| d.number),
                                        )
                                    {
                                        retry_requests.push(PendingRequest {
                                            retried: true,
                                            ..req
                                        });
                                        continue;
                                    }

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
                    if pending_requests.iter().all(|r| r.sender.is_closed()) {
                        abandoned = true;
                        break;
                    }
                }

                decoder.is_done = true;

                // A failed reader (a decode error, seen with many decode
                // sessions on a loaded machine) vends nothing more, and the
                // newest cached frame is stale for every request still
                // waiting. Read them again from a fresh reader; when that one
                // fails too, leave them unanswered so the handle switches to
                // software decoding instead of showing an older frame.
                if !pending_requests.is_empty()
                    && let Some(error) = decoder.inner.failure()
                {
                    tracing::warn!(
                        decoder_idx,
                        requested_frame,
                        %error,
                        "Video reader failed; reading the requests again from a fresh reader"
                    );
                    retry_requests.extend(
                        pending_requests
                            .drain(..)
                            .filter(|request| !request.retried)
                            .map(|request| PendingRequest {
                                retried: true,
                                ..request
                            }),
                    );
                }
            }

            if abandoned {
                pending_requests.clear();
            }

            for request in retry_requests.into_iter().rev() {
                deferred_requests.push_front(request);
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

fn reader_passed_request(prev_vended: Option<u32>, requested_frame: u32) -> bool {
    prev_vended.is_some_and(|prev| prev >= requested_frame)
}

// A request the reader steps over is answered by the frame it vended just
// before, the newest one at or before the request. Any other answer is stale.
fn answer_misses_previous_vend(
    vended_before: Option<u32>,
    requested_frame: u32,
    answer: Option<u32>,
) -> bool {
    vended_before
        .filter(|&number| number <= requested_frame)
        .is_some_and(|expected| answer != Some(expected))
}

#[allow(clippy::too_many_arguments)]
fn insert_cached_frame(
    cache: &mut BTreeMap<u32, CachedFrame>,
    cache_bytes: &mut usize,
    number: u32,
    frame: CachedFrame,
    frame_limit: usize,
    requested_frame: u32,
    last_active_frame: Option<u32>,
    is_pinned: impl Fn(u32) -> bool,
) {
    let frame_bytes = frame.byte_len();
    if let Some(replaced) = cache.remove(&number) {
        *cache_bytes = cache_bytes.saturating_sub(replaced.byte_len());
    }
    while !cache.is_empty()
        && frame_cache_needs_eviction(cache.len(), *cache_bytes, frame_bytes, frame_limit)
    {
        if let Some(last_active) = last_active_frame {
            let from_oldest = if requested_frame > last_active {
                true
            } else if requested_frame < last_active {
                false
            } else {
                number > *cache.keys().next_back().unwrap()
            };
            let victim = cache_eviction_victim(cache, from_oldest, &is_pinned);
            if let Some(removed) = victim.and_then(|frame| cache.remove(&frame)) {
                *cache_bytes = cache_bytes.saturating_sub(removed.byte_len());
            }
        } else {
            cache.clear();
            *cache_bytes = 0;
        }
    }
    *cache_bytes = cache_bytes.saturating_add(frame_bytes);
    cache.insert(number, frame);
}

// Drops from the end the cache is trimmed from, skipping pinned frames unless
// every frame is pinned.
fn cache_eviction_victim<V>(
    cache: &BTreeMap<u32, V>,
    from_oldest: bool,
    is_pinned: impl Fn(u32) -> bool,
) -> Option<u32> {
    if from_oldest {
        cache
            .keys()
            .copied()
            .find(|&frame| !is_pinned(frame))
            .or_else(|| cache.keys().next().copied())
    } else {
        cache
            .keys()
            .rev()
            .copied()
            .find(|&frame| !is_pinned(frame))
            .or_else(|| cache.keys().next_back().copied())
    }
}

// Requests the reader has already passed, or that fall in a gap before its
// next frame, are answered with the newest cached frame at or before them.
// That frame is only trustworthy when this reader vended it in its current
// run; an older one comes from an unrelated seek and shows stale content.
// With nothing cached at or before the request, whether the reader has
// passed it or a gap follows its evicted last frame, the only answer left is
// a later frame instead of the one on screen.
fn reuse_would_serve_stale_frame(
    run_start: Option<u32>,
    prev_vended: Option<u32>,
    newest_cached_at_or_before: Option<u32>,
) -> bool {
    let (Some(run_start), Some(_)) = (run_start, prev_vended) else {
        return false;
    };
    newest_cached_at_or_before.is_none_or(|cached| cached < run_start)
}

fn should_grow_decoder_pool(
    is_scrubbing: bool,
    needs_reset: bool,
    decoder_count: usize,
    max_decoder_count: usize,
) -> bool {
    is_scrubbing && needs_reset && decoder_count < max_decoder_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_cache_enforces_frame_and_byte_limits() {
        assert!(!frame_cache_needs_eviction(
            FRAME_CACHE_SIZE - 1,
            MAX_FRAME_CACHE_BYTES - 1,
            1,
            FRAME_CACHE_SIZE,
        ));
        assert!(frame_cache_needs_eviction(
            FRAME_CACHE_SIZE,
            0,
            1,
            FRAME_CACHE_SIZE
        ));
        assert!(frame_cache_needs_eviction(
            1,
            MAX_FRAME_CACHE_BYTES,
            1,
            FRAME_CACHE_SIZE
        ));
        assert!(frame_cache_needs_eviction(
            1,
            usize::MAX,
            1,
            FRAME_CACHE_SIZE
        ));
    }

    #[test]
    fn sequential_access_bounds_the_cache_until_requests_move_backwards() {
        let mut direction = RequestDirection::default();
        assert_eq!(direction.frame_cache_limit(false), FRAME_CACHE_SIZE);
        assert_eq!(
            direction.frame_cache_limit(true),
            SEQUENTIAL_FRAME_CACHE_SIZE
        );

        for (first, last) in [(0, 0), (1, 3), (3, 3), (4, 9), (40, 41)] {
            direction.record_batch(first, last);
            assert_eq!(
                direction.frame_cache_limit(true),
                SEQUENTIAL_FRAME_CACHE_SIZE
            );
            assert_eq!(direction.frame_cache_limit(false), FRAME_CACHE_SIZE);
        }

        direction.record_batch(38, 38);
        assert_eq!(direction.frame_cache_limit(true), FRAME_CACHE_SIZE);

        for (first, last) in [(42, 42), (43, 50), (90, 120)] {
            direction.record_batch(first, last);
            assert_eq!(direction.frame_cache_limit(true), FRAME_CACHE_SIZE);
        }

        let limit = RequestDirection::default().frame_cache_limit(true);
        assert!(limit >= 2);
        assert!(!frame_cache_needs_eviction(limit - 1, 0, 1, limit));
        assert!(frame_cache_needs_eviction(limit, 0, 1, limit));
        assert!(frame_cache_needs_eviction(
            1,
            MAX_FRAME_CACHE_BYTES,
            1,
            limit
        ));
    }

    #[test]
    fn a_reader_that_vended_the_request_cannot_serve_it_again() {
        assert!(!reader_passed_request(None, 10));
        assert!(!reader_passed_request(Some(9), 10));
        assert!(reader_passed_request(Some(10), 10));
        assert!(reader_passed_request(Some(57), 54));
    }

    #[test]
    fn only_the_frame_vended_before_a_gap_answers_requests_inside_it() {
        assert!(!answer_misses_previous_vend(Some(1054), 1055, Some(1054)));
        assert!(answer_misses_previous_vend(Some(1054), 1055, Some(1052)));
        assert!(answer_misses_previous_vend(Some(751), 752, Some(421)));
        assert!(answer_misses_previous_vend(Some(751), 752, None));
        assert!(!answer_misses_previous_vend(None, 752, Some(421)));
        assert!(!answer_misses_previous_vend(Some(760), 752, Some(751)));
    }

    #[test]
    fn cache_eviction_skips_pinned_frames() {
        let cache: BTreeMap<u32, ()> = [415, 419, 421, 749, 751]
            .into_iter()
            .map(|f| (f, ()))
            .collect();
        assert_eq!(cache_eviction_victim(&cache, true, |_| false), Some(415));
        assert_eq!(cache_eviction_victim(&cache, false, |_| false), Some(751));
        assert_eq!(
            cache_eviction_victim(&cache, false, |f| f == 751),
            Some(749)
        );
        assert_eq!(cache_eviction_victim(&cache, true, |f| f < 420), Some(421));
        assert_eq!(cache_eviction_victim(&cache, true, |_| true), Some(415));
        assert_eq!(
            cache_eviction_victim(&BTreeMap::<u32, ()>::new(), true, |_| false),
            None
        );
    }

    #[test]
    fn reused_readers_never_answer_with_frames_from_an_unrelated_seek() {
        assert!(!reuse_would_serve_stale_frame(None, None, Some(10)));
        assert!(!reuse_would_serve_stale_frame(Some(40), Some(55), Some(48)));
        assert!(!reuse_would_serve_stale_frame(Some(40), Some(55), Some(40)));
        assert!(reuse_would_serve_stale_frame(Some(40), Some(55), Some(39)));
        assert!(reuse_would_serve_stale_frame(Some(40), Some(55), Some(10)));
        assert!(reuse_would_serve_stale_frame(Some(40), Some(48), None));
    }

    #[test]
    fn returning_to_a_passed_hold_after_its_frame_is_evicted_resets_the_reader() {
        let (run_start, held, vended) = (40, 48, 55);
        assert!(!reuse_would_serve_stale_frame(
            Some(run_start),
            Some(vended),
            Some(held)
        ));
        assert!(reuse_would_serve_stale_frame(
            Some(run_start),
            Some(vended),
            None
        ));
    }

    #[test]
    fn decoder_pool_grows_only_for_unserved_non_sequential_access() {
        assert!(should_grow_decoder_pool(true, true, 1, 5));
        assert!(!should_grow_decoder_pool(false, true, 1, 5));
        assert!(!should_grow_decoder_pool(true, false, 1, 5));
        assert!(!should_grow_decoder_pool(true, true, 5, 5));
        assert!(!should_grow_decoder_pool(true, true, 1, 1));
    }

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
