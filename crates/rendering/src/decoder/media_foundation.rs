#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use tracing::{info, warn};
use windows::Win32::{Foundation::HANDLE, Graphics::Direct3D11::ID3D11Texture2D};

use super::{DecodedFrame, DecoderInitResult, DecoderType, FRAME_CACHE_SIZE, VideoDecoderMessage};

struct DecoderHealthMonitor {
    consecutive_errors: u32,
    consecutive_texture_read_failures: u32,
    total_frames_decoded: u64,
    total_errors: u64,
    last_successful_decode: Instant,
    last_request_time: Instant,
    last_unhealthy_warning: Option<Instant>,
    frame_decode_times: [Duration; 32],
    frame_decode_index: usize,
    slow_frame_count: u32,
}

impl DecoderHealthMonitor {
    fn new() -> Self {
        Self {
            consecutive_errors: 0,
            consecutive_texture_read_failures: 0,
            total_frames_decoded: 0,
            total_errors: 0,
            last_successful_decode: Instant::now(),
            last_request_time: Instant::now(),
            last_unhealthy_warning: None,
            frame_decode_times: [Duration::ZERO; 32],
            frame_decode_index: 0,
            slow_frame_count: 0,
        }
    }

    fn record_request(&mut self) {
        self.last_request_time = Instant::now();
    }

    fn record_success(&mut self, decode_time: Duration) {
        self.consecutive_errors = 0;
        self.consecutive_texture_read_failures = 0;
        self.total_frames_decoded += 1;
        self.last_successful_decode = Instant::now();

        self.frame_decode_times[self.frame_decode_index] = decode_time;
        self.frame_decode_index = (self.frame_decode_index + 1) % 32;

        const SLOW_FRAME_THRESHOLD: Duration = Duration::from_millis(100);
        if decode_time > SLOW_FRAME_THRESHOLD {
            self.slow_frame_count += 1;
        }
    }

    fn record_error(&mut self) {
        self.consecutive_errors += 1;
        self.total_errors += 1;
    }

    fn record_texture_read_failure(&mut self) {
        self.consecutive_texture_read_failures += 1;
    }

    fn is_healthy(&self) -> bool {
        const MAX_CONSECUTIVE_ERRORS: u32 = 10;
        const MAX_CONSECUTIVE_TEXTURE_FAILURES: u32 = 5;
        const MAX_TIME_SINCE_SUCCESS: Duration = Duration::from_secs(5);

        if self.consecutive_errors >= MAX_CONSECUTIVE_ERRORS
            || self.consecutive_texture_read_failures >= MAX_CONSECUTIVE_TEXTURE_FAILURES
        {
            return false;
        }

        let idle_duration = self.last_request_time.elapsed();
        if idle_duration > Duration::from_secs(2) {
            return true;
        }

        self.last_successful_decode.elapsed() < MAX_TIME_SINCE_SUCCESS
    }

    fn should_warn_unhealthy(&mut self) -> bool {
        if self.is_healthy() {
            return false;
        }

        let should_warn = self
            .last_unhealthy_warning
            .is_none_or(|last| last.elapsed() > Duration::from_secs(5));

        if should_warn {
            self.last_unhealthy_warning = Some(Instant::now());
        }

        should_warn
    }

    #[allow(dead_code)]
    fn average_decode_time(&self) -> Duration {
        let sum: Duration = self.frame_decode_times.iter().sum();
        sum / 32
    }

    #[allow(dead_code)]
    fn get_health_summary(&self) -> (u64, u64, u32) {
        (
            self.total_frames_decoded,
            self.total_errors,
            self.slow_frame_count,
        )
    }
}

#[derive(Clone)]
struct CachedFrame {
    number: u32,
    _texture: ID3D11Texture2D,
    _shared_handle: Option<HANDLE>,
    _y_handle: Option<HANDLE>,
    _uv_handle: Option<HANDLE>,
    nv12_data: Option<Arc<cap_video_decode::NV12Data>>,
    width: u32,
    height: u32,
}

impl CachedFrame {
    fn to_decoded_frame(&self) -> DecodedFrame {
        let null_ptr = std::ptr::null_mut();
        let y_handle = self._y_handle.filter(|h| h.0 != null_ptr);
        let uv_handle = self._uv_handle.filter(|h| h.0 != null_ptr);
        if let (Some(y_handle), Some(uv_handle)) = (y_handle, uv_handle) {
            return DecodedFrame::new_nv12_with_d3d11_texture_and_yuv_handles(
                self.width,
                self.height,
                self._texture.clone(),
                self._shared_handle,
                Some(y_handle),
                Some(uv_handle),
            );
        }

        if let Some(nv12_data) = &self.nv12_data {
            DecodedFrame::new_nv12(
                nv12_data.data.clone(),
                self.width,
                self.height,
                nv12_data.y_stride,
                nv12_data.uv_stride,
            )
        } else {
            warn!(
                "CachedFrame has no CPU data, creating black frame (D3D11 zero-copy not implemented)"
            );
            let black_data = vec![0u8; (self.width * self.height * 3 / 2) as usize];
            DecodedFrame::new_nv12(black_data, self.width, self.height, self.width, self.width)
        }
    }
}

pub struct MFDecoder;

impl MFDecoder {
    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
    ) -> Result<(), String> {
        std::thread::spawn(move || {
            let mut decoder = match cap_video_decode::MediaFoundationDecoder::new(&path) {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
                Ok(v) => {
                    let width = v.width();
                    let height = v.height();
                    let caps = v.capabilities();

                    let exceeds_hw_limits = width > caps.max_width || height > caps.max_height;

                    if exceeds_hw_limits {
                        warn!(
                            "Video '{}' dimensions {}x{} exceed hardware decoder limits ({}x{})",
                            name, width, height, caps.max_width, caps.max_height
                        );
                        let _ = ready_tx.send(Err(format!(
                            "Video dimensions {}x{} exceed hardware decoder limits {}x{}",
                            width, height, caps.max_width, caps.max_height
                        )));
                        return;
                    }

                    info!(
                        "MediaFoundation decoder created for '{}': {}x{} @ {:?}fps (hw max: {}x{})",
                        name,
                        width,
                        height,
                        v.frame_rate(),
                        caps.max_width,
                        caps.max_height
                    );
                    v
                }
            };

            let video_width = decoder.width();
            let video_height = decoder.height();

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            let mut last_decoded_frame: Option<u32> = None;
            let mut health = DecoderHealthMonitor::new();

            let init_result = DecoderInitResult {
                width: video_width,
                height: video_height,
                decoder_type: DecoderType::MediaFoundation,
            };
            let _ = ready_tx.send(Ok(init_result));

            struct PendingRequest {
                frame: u32,
                time: f32,
                sender: oneshot::Sender<DecodedFrame>,
            }

            while let Ok(r) = rx.recv() {
                let mut pending_requests: Vec<PendingRequest> = Vec::with_capacity(8);

                let mut push_request =
                    |requested_time: f32, sender: oneshot::Sender<DecodedFrame>| {
                        if sender.is_closed() {
                            return;
                        }
                        let frame = (requested_time * fps as f32).floor() as u32;
                        pending_requests.push(PendingRequest {
                            frame,
                            time: requested_time,
                            sender,
                        });
                    };

                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        push_request(requested_time, sender);
                    }
                }

                while let Ok(msg) = rx.try_recv() {
                    match msg {
                        VideoDecoderMessage::GetFrame(requested_time, sender) => {
                            push_request(requested_time, sender);
                        }
                    }
                }

                let mut unfulfilled = Vec::with_capacity(pending_requests.len());
                for req in pending_requests.drain(..) {
                    let cached = cache.get(&req.frame).or_else(|| {
                        cache
                            .range(..=req.frame)
                            .next_back()
                            .filter(|(k, _)| req.frame - *k <= 2)
                            .map(|(_, f)| f)
                    });
                    if let Some(frame) = cached {
                        let _ = req.sender.send(frame.to_decoded_frame());
                    } else if !req.sender.is_closed() {
                        unfulfilled.push(req);
                    }
                }
                pending_requests = unfulfilled;

                if pending_requests.is_empty() {
                    continue;
                }

                pending_requests.sort_by_key(|r| r.frame);

                let target_request = pending_requests.pop().unwrap();
                let deferred_requests = pending_requests;

                let requested_frame = target_request.frame;
                let mut sender = Some(target_request.sender);

                health.record_request();

                if health.should_warn_unhealthy() {
                    warn!(
                        name = name,
                        consecutive_errors = health.consecutive_errors,
                        texture_failures = health.consecutive_texture_read_failures,
                        total_decoded = health.total_frames_decoded,
                        "MediaFoundation decoder unhealthy, performance may degrade"
                    );
                }

                let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                let needs_seek = last_decoded_frame
                    .map(|last| {
                        if requested_frame <= last {
                            last - requested_frame > FRAME_CACHE_SIZE as u32 / 2
                        } else {
                            requested_frame - last > FRAME_CACHE_SIZE as u32
                        }
                    })
                    .unwrap_or(true);

                if needs_seek {
                    let time_100ns = frame_to_100ns(requested_frame, fps);
                    if let Err(e) = decoder.seek(time_100ns) {
                        warn!("MediaFoundation seek failed: {e}");
                    }
                    cache.clear();
                    last_decoded_frame = None;
                }

                let mut last_valid_frame: Option<CachedFrame> = None;

                let pixel_count = (video_width as u64) * (video_height as u64);
                let readahead_frames = if pixel_count > 4_000_000 {
                    8u32
                } else if pixel_count > 2_000_000 {
                    15u32
                } else {
                    30u32
                };
                let max_batch_duration = if pixel_count > 4_000_000 {
                    Duration::from_millis(200)
                } else if pixel_count > 2_000_000 {
                    Duration::from_millis(400)
                } else {
                    Duration::from_millis(800)
                };
                let batch_start = Instant::now();

                loop {
                    if sender.as_ref().is_some_and(|s| s.is_closed()) {
                        sender.take();
                        break;
                    }

                    if sender.is_none() && batch_start.elapsed() > max_batch_duration {
                        break;
                    }

                    let decode_start = Instant::now();
                    match decoder.read_sample() {
                        Ok(Some(mf_frame)) => {
                            let decode_time = decode_start.elapsed();
                            let frame_number = pts_100ns_to_frame(mf_frame.pts, fps);

                            let has_valid_zero_copy_handles = {
                                let null_ptr = std::ptr::null_mut();
                                mf_frame.textures.y.handle.0 != null_ptr
                                    && mf_frame.textures.uv.handle.0 != null_ptr
                            };

                            let nv12_data = if has_valid_zero_copy_handles {
                                health.record_success(decode_time);
                                None
                            } else {
                                match decoder.read_texture_to_cpu(
                                    &mf_frame.textures.nv12.texture,
                                    mf_frame.width,
                                    mf_frame.height,
                                ) {
                                    Ok(data) => {
                                        health.record_success(decode_time);
                                        Some(Arc::new(data))
                                    }
                                    Err(e) => {
                                        health.record_texture_read_failure();
                                        warn!(
                                            "Failed to read texture to CPU for frame {frame_number}: {e}"
                                        );
                                        None
                                    }
                                }
                            };

                            let cached = CachedFrame {
                                number: frame_number,
                                _texture: mf_frame.textures.nv12.texture.clone(),
                                _shared_handle: Some(mf_frame.textures.nv12.handle),
                                _y_handle: Some(mf_frame.textures.y.handle),
                                _uv_handle: Some(mf_frame.textures.uv.handle),
                                nv12_data,
                                width: mf_frame.width,
                                height: mf_frame.height,
                            };

                            last_decoded_frame = Some(frame_number);

                            if frame_number >= cache_min && frame_number <= cache_max {
                                if cache.len() >= FRAME_CACHE_SIZE {
                                    let key_to_remove = if frame_number > requested_frame {
                                        *cache.keys().next().unwrap()
                                    } else {
                                        *cache.keys().next_back().unwrap()
                                    };
                                    cache.remove(&key_to_remove);
                                }
                                cache.insert(frame_number, cached.clone());
                            }

                            if frame_number <= requested_frame {
                                last_valid_frame = Some(cached);
                            }

                            if frame_number >= requested_frame {
                                let frame_to_send = if frame_number == requested_frame {
                                    cache.get(&requested_frame)
                                } else {
                                    last_valid_frame.as_ref().or_else(|| {
                                        cache
                                            .range(..=requested_frame)
                                            .next_back()
                                            .map(|(_, f)| f)
                                            .or_else(|| cache.get(&frame_number))
                                    })
                                };

                                if let Some(frame) = frame_to_send
                                    && let Some(s) = sender.take()
                                {
                                    let _ = s.send(frame.to_decoded_frame());
                                }
                            }

                            let readahead_target = requested_frame + readahead_frames;
                            if frame_number >= readahead_target || frame_number > cache_max {
                                break;
                            }
                        }
                        Ok(None) => {
                            break;
                        }
                        Err(e) => {
                            health.record_error();
                            warn!(
                                consecutive_errors = health.consecutive_errors,
                                "MediaFoundation read_sample error: {e}"
                            );
                            break;
                        }
                    }
                }

                if let Some(s) = sender.take() {
                    let fallback = last_valid_frame.as_ref().cloned().or_else(|| {
                        cache
                            .range(..=requested_frame)
                            .next_back()
                            .or_else(|| cache.range(requested_frame..).next())
                            .map(|(_, f)| f.clone())
                    });
                    if let Some(frame) = fallback {
                        let _ = s.send(frame.to_decoded_frame());
                    } else {
                        let black_frame = DecodedFrame::new(
                            vec![0u8; (video_width * video_height * 4) as usize],
                            video_width,
                            video_height,
                        );
                        let _ = s.send(black_frame);
                    }
                }

                for req in deferred_requests {
                    if req.sender.is_closed() {
                        continue;
                    }
                    let frame_to_send = cache
                        .get(&req.frame)
                        .or_else(|| cache.range(..=req.frame).next_back().map(|(_, f)| f))
                        .or(last_valid_frame.as_ref());
                    if let Some(frame) = frame_to_send {
                        let _ = req.sender.send(frame.to_decoded_frame());
                    } else {
                        let black_frame = DecodedFrame::new(
                            vec![0u8; (video_width * video_height * 4) as usize],
                            video_width,
                            video_height,
                        );
                        let _ = req.sender.send(black_frame);
                    }
                }
            }
        });

        Ok(())
    }
}

fn frame_to_100ns(frame: u32, fps: u32) -> i64 {
    ((frame as i64) * 10_000_000) / (fps as i64)
}

fn pts_100ns_to_frame(pts_100ns: i64, fps: u32) -> u32 {
    ((pts_100ns * fps as i64) / 10_000_000) as u32
}
