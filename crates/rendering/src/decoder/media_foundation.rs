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
            frame_decode_times: [Duration::ZERO; 32],
            frame_decode_index: 0,
            slow_frame_count: 0,
        }
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

        self.consecutive_errors < MAX_CONSECUTIVE_ERRORS
            && self.consecutive_texture_read_failures < MAX_CONSECUTIVE_TEXTURE_FAILURES
            && self.last_successful_decode.elapsed() < MAX_TIME_SINCE_SUCCESS
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
        let (continue_tx, continue_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut decoder = match cap_video_decode::MediaFoundationDecoder::new(&path) {
                Err(e) => {
                    let _ = continue_tx.send(Err(e));
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
                        let _ = continue_tx.send(Err(format!(
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
                    let _ = continue_tx.send(Ok((width, height)));
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

            while let Ok(r) = rx.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        if sender.is_closed() {
                            continue;
                        }

                        if !health.is_healthy() {
                            warn!(
                                name = name,
                                consecutive_errors = health.consecutive_errors,
                                texture_failures = health.consecutive_texture_read_failures,
                                total_decoded = health.total_frames_decoded,
                                "MediaFoundation decoder unhealthy, performance may degrade"
                            );
                        }

                        let requested_frame = (requested_time * fps as f32).floor() as u32;

                        if let Some(cached) = cache.get(&requested_frame) {
                            let _ = sender.send(cached.to_decoded_frame());
                            continue;
                        }

                        let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                        let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                        let needs_seek = last_decoded_frame
                            .map(|last| {
                                requested_frame < last
                                    || requested_frame.saturating_sub(last)
                                        > FRAME_CACHE_SIZE as u32
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

                        let mut sender = Some(sender);
                        let mut last_valid_frame: Option<CachedFrame> = None;

                        loop {
                            let decode_start = Instant::now();
                            match decoder.read_sample() {
                                Ok(Some(mf_frame)) => {
                                    let decode_time = decode_start.elapsed();
                                    let frame_number = pts_100ns_to_frame(mf_frame.pts, fps);

                                    let nv12_data = match decoder.read_texture_to_cpu(
                                        &mf_frame.texture,
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
                                    };

                                    let cached = CachedFrame {
                                        number: frame_number,
                                        _texture: mf_frame.texture,
                                        _shared_handle: mf_frame.shared_handle,
                                        _y_handle: mf_frame.y_handle,
                                        _uv_handle: mf_frame.uv_handle,
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
                                            last_valid_frame
                                                .as_ref()
                                                .or_else(|| cache.get(&frame_number))
                                        };

                                        if let Some(frame) = frame_to_send
                                            && let Some(s) = sender.take()
                                        {
                                            let _ = s.send(frame.to_decoded_frame());
                                        }
                                        break;
                                    }

                                    if frame_number > cache_max {
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
                            if let Some(frame) = last_valid_frame
                                .or_else(|| cache.values().max_by_key(|f| f.number).cloned())
                            {
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
                    }
                }
            }
        });

        continue_rx.recv().map_err(|e| e.to_string())?.map(|_| ())
    }
}

fn frame_to_100ns(frame: u32, fps: u32) -> i64 {
    ((frame as i64) * 10_000_000) / (fps as i64)
}

fn pts_100ns_to_frame(pts_100ns: i64, fps: u32) -> u32 {
    ((pts_100ns * fps as i64) / 10_000_000) as u32
}
