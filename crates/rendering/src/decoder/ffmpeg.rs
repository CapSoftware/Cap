#![allow(dead_code)]

#[cfg(any(target_os = "macos", target_os = "windows"))]
use ffmpeg::sys::AVHWDeviceType;
use ffmpeg::{format, frame};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    env,
    path::PathBuf,
    rc::Rc,
    sync::OnceLock,
    sync::{mpsc, Arc},
};
use tokio::sync::oneshot;
use tracing::info;

use crate::{DecodedFrame, PixelFormat};
#[cfg(target_os = "windows")]
use cap_video_decode::FrameTextures;

use super::{
    frame_converter::FrameConverter, pts_to_frame, DecoderInitResult, DecoderType,
    VideoDecoderMessage, FRAME_CACHE_SIZE,
};

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
            PixelFormat::Rgba => {
                DecodedFrame::new_with_arc(Arc::clone(&self.data), self.width, self.height)
            }
            PixelFormat::Nv12 => DecodedFrame::new_nv12_with_arc(
                Arc::clone(&self.data),
                self.width,
                self.height,
                self.y_stride,
                self.uv_stride,
            ),
            PixelFormat::Yuv420p => DecodedFrame::new_yuv420p_with_arc(
                Arc::clone(&self.data),
                self.width,
                self.height,
                self.y_stride,
                self.uv_stride,
            ),
        }
    }
}

#[derive(Clone)]
struct OutputFrame {
    number: u32,
    frame: DecodedFrame,
}

struct PendingRequest {
    time: f32,
    frame: u32,
    reply: oneshot::Sender<DecodedFrame>,
    additional_replies: Vec<oneshot::Sender<DecodedFrame>>,
    order: u64,
}

#[derive(Clone, Copy)]
struct ScrubSupersessionConfig {
    min_requests: usize,
    min_span_frames: u32,
    min_pixels: u64,
    disabled: bool,
    latest_first_disabled: bool,
    latest_first_min_requests: usize,
    latest_first_min_span_frames: u32,
}

static SCRUB_SUPERSESSION_CONFIG: OnceLock<ScrubSupersessionConfig> = OnceLock::new();

fn parse_usize_env(key: &str) -> Option<usize> {
    env::var(key).ok()?.parse::<usize>().ok()
}

fn parse_u32_env(key: &str) -> Option<u32> {
    env::var(key).ok()?.parse::<u32>().ok()
}

fn parse_u64_env(key: &str) -> Option<u64> {
    env::var(key).ok()?.parse::<u64>().ok()
}

fn parse_bool_env(key: &str) -> bool {
    env::var(key)
        .ok()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn scrub_supersession_config() -> ScrubSupersessionConfig {
    *SCRUB_SUPERSESSION_CONFIG.get_or_init(|| {
        let min_requests = parse_usize_env("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS")
            .filter(|value| *value > 0)
            .unwrap_or(7);
        let min_span_frames = parse_u32_env("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES")
            .filter(|value| *value > 0)
            .unwrap_or(20);
        let min_pixels = parse_u64_env("CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS")
            .filter(|value| *value > 0)
            .unwrap_or(2_000_000);
        let disabled = parse_bool_env("CAP_FFMPEG_SCRUB_SUPERSEDE_DISABLED");
        let latest_first_disabled = parse_bool_env("CAP_FFMPEG_SCRUB_LATEST_FIRST_DISABLED");
        let latest_first_min_requests =
            parse_usize_env("CAP_FFMPEG_SCRUB_LATEST_FIRST_MIN_REQUESTS")
                .filter(|value| *value > 1)
                .unwrap_or(2);
        let latest_first_min_span_frames =
            parse_u32_env("CAP_FFMPEG_SCRUB_LATEST_FIRST_MIN_SPAN_FRAMES")
                .filter(|value| *value > 0)
                .unwrap_or(min_span_frames);

        ScrubSupersessionConfig {
            min_requests,
            min_span_frames,
            min_pixels,
            disabled,
            latest_first_disabled,
            latest_first_min_requests,
            latest_first_min_span_frames,
        }
    })
}

fn send_to_replies(
    name: &str,
    frame_number: u32,
    frame: &DecodedFrame,
    replies: Vec<oneshot::Sender<DecodedFrame>>,
) {
    for reply in replies {
        if reply.send(frame.clone()).is_err() {
            log::warn!("FFmpeg '{name}': Failed to send frame {frame_number}: receiver dropped");
        }
    }
}

fn maybe_supersede_scrub_burst(pending_requests: &mut Vec<PendingRequest>, enabled: bool) {
    let config = scrub_supersession_config();

    if !enabled || pending_requests.len() < config.min_requests {
        return;
    }

    let min_frame = pending_requests
        .iter()
        .map(|request| request.frame)
        .min()
        .unwrap_or(0);
    let max_frame = pending_requests
        .iter()
        .map(|request| request.frame)
        .max()
        .unwrap_or(0);

    if max_frame.saturating_sub(min_frame) <= config.min_span_frames {
        return;
    }

    let Some(latest_index) = pending_requests
        .iter()
        .enumerate()
        .max_by_key(|(_, request)| request.order)
        .map(|(index, _)| index)
    else {
        return;
    };

    let mut collapsed = pending_requests.swap_remove(latest_index);
    for request in pending_requests.drain(..) {
        collapsed.additional_replies.push(request.reply);
        collapsed
            .additional_replies
            .extend(request.additional_replies);
    }
    pending_requests.push(collapsed);
}

fn should_prioritize_latest_request(
    pending_requests: &[PendingRequest],
    enabled: bool,
    config: ScrubSupersessionConfig,
) -> bool {
    if !enabled || config.latest_first_disabled {
        return false;
    }
    if pending_requests.len() < config.latest_first_min_requests {
        return false;
    }

    let min_frame = pending_requests
        .iter()
        .map(|request| request.frame)
        .min()
        .unwrap_or(0);
    let max_frame = pending_requests
        .iter()
        .map(|request| request.frame)
        .max()
        .unwrap_or(0);

    max_frame.saturating_sub(min_frame) > config.latest_first_min_span_frames
}

fn order_pending_requests_for_seek(
    pending_requests: &mut Vec<PendingRequest>,
    enable_scrub_supersession: bool,
) {
    let config = scrub_supersession_config();

    if !should_prioritize_latest_request(pending_requests, enable_scrub_supersession, config) {
        pending_requests.sort_by_key(|request| request.frame);
        return;
    }

    let Some(latest_order) = pending_requests.iter().map(|request| request.order).max() else {
        return;
    };

    pending_requests.sort_by(|left, right| {
        let left_is_latest = left.order == latest_order;
        let right_is_latest = right.order == latest_order;
        match (left_is_latest, right_is_latest) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.frame.cmp(&right.frame),
        }
    });
}

fn extract_yuv_planes(frame: &frame::Video) -> Option<(Vec<u8>, PixelFormat, u32, u32)> {
    let height = frame.height();

    match frame.format() {
        format::Pixel::YUV420P => {
            let y_stride = frame.stride(0) as u32;
            let u_stride = frame.stride(1) as u32;
            let v_stride = frame.stride(2) as u32;

            let y_size = (y_stride * height) as usize;
            let uv_height = height / 2;
            let u_size = (u_stride * uv_height) as usize;
            let v_size = (v_stride * uv_height) as usize;

            let mut data = Vec::with_capacity(y_size + u_size + v_size);
            data.extend_from_slice(&frame.data(0)[..y_size]);
            data.extend_from_slice(&frame.data(1)[..u_size]);
            data.extend_from_slice(&frame.data(2)[..v_size]);

            Some((data, PixelFormat::Yuv420p, y_stride, u_stride))
        }
        format::Pixel::NV12 => {
            let y_stride = frame.stride(0) as u32;
            let uv_stride = frame.stride(1) as u32;

            let y_size = (y_stride * height) as usize;
            let uv_size = (uv_stride * (height / 2)) as usize;

            let mut data = Vec::with_capacity(y_size + uv_size);
            data.extend_from_slice(&frame.data(0)[..y_size]);
            data.extend_from_slice(&frame.data(1)[..uv_size]);

            Some((data, PixelFormat::Nv12, y_stride, uv_stride))
        }
        _ => None,
    }
}

impl CachedFrame {
    fn process_cpu(&mut self, converter: &mut FrameConverter) -> ProcessedFrame {
        match self {
            Self::Raw { frame, number } => {
                let data = if let Some((yuv_data, pixel_format, y_stride, uv_stride)) =
                    extract_yuv_planes(frame)
                {
                    ProcessedFrame {
                        data: Arc::new(yuv_data),
                        number: *number,
                        width: frame.width(),
                        height: frame.height(),
                        format: pixel_format,
                        y_stride,
                        uv_stride,
                    }
                } else {
                    let frame_buffer = converter.convert(frame);
                    ProcessedFrame {
                        data: Arc::new(frame_buffer),
                        number: *number,
                        width: frame.width(),
                        height: frame.height(),
                        format: PixelFormat::Rgba,
                        y_stride: frame.width() * 4,
                        uv_stride: 0,
                    }
                };

                *self = Self::Processed(data.clone());

                data
            }
            Self::Processed(data) => data.clone(),
            #[cfg(target_os = "windows")]
            Self::Gpu { .. } => unreachable!(),
        }
    }

    fn produce(&mut self, converter: &mut FrameConverter) -> OutputFrame {
        match self {
            #[cfg(target_os = "windows")]
            Self::Gpu { frame, number, .. } => OutputFrame {
                number: *number,
                frame: frame.clone(),
            },
            Self::Raw { .. } => {
                let data = self.process_cpu(converter);
                OutputFrame {
                    number: data.number,
                    frame: data.to_decoded_frame(),
                }
            }
            Self::Processed(data) => OutputFrame {
                number: data.number,
                frame: data.clone().to_decoded_frame(),
            },
        }
    }
}

#[derive(Clone)]
enum CachedFrame {
    Raw {
        frame: frame::Video,
        number: u32,
    },
    Processed(ProcessedFrame),
    #[cfg(target_os = "windows")]
    Gpu {
        frame: DecodedFrame,
        number: u32,
        textures: Arc<FrameTextures>,
    },
}

pub struct FfmpegDecoder;

impl FfmpegDecoder {
    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
    ) -> Result<(), String> {
        Self::spawn_with_hw_config(name, path, fps, rx, ready_tx, true)
    }

    pub fn spawn_with_hw_config(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
        use_hw_acceleration: bool,
    ) -> Result<(), String> {
        let (continue_tx, continue_rx) = mpsc::channel::<Result<(u32, u32, bool), String>>();

        std::thread::spawn(move || {
            let hw_device_type = if use_hw_acceleration {
                #[cfg(target_os = "windows")]
                {
                    Some(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA)
                }
                #[cfg(target_os = "macos")]
                {
                    Some(AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX)
                }
                #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                {
                    None
                }
            } else {
                None
            };
            let mut this = match cap_video_decode::FFmpegDecoder::new(path.clone(), hw_device_type)
            {
                Err(e) => {
                    let _ = continue_tx.send(Err(e));
                    return;
                }
                Ok(v) => {
                    let is_hw = v.is_hardware_accelerated();
                    let width = v.decoder().width();
                    let height = v.decoder().height();
                    info!(
                        "FFmpeg decoder created for '{}': {}x{}, hw_accel={}",
                        name, width, height, is_hw
                    );
                    let _ = continue_tx.send(Ok((width, height, is_hw)));
                    v
                }
            };

            let time_base = this.decoder().time_base();
            let start_time = this.start_time();
            let video_width = this.decoder().width();
            let video_height = this.decoder().height();
            let is_hw = this.is_hardware_accelerated();

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            let mut last_active_frame = None::<u32>;

            let last_sent_frame = Rc::new(RefCell::new(None::<OutputFrame>));
            let first_ever_frame = Rc::new(RefCell::new(None::<OutputFrame>));

            let mut frames = this.frames();
            let mut converter = FrameConverter::new();

            let first_frame_result = (&mut frames).flatten().next();

            if first_frame_result.is_none() && is_hw {
                let mut sw_this = match cap_video_decode::FFmpegDecoder::new(path.clone(), None) {
                    Err(e) => {
                        let _ = continue_tx.send(Err(format!("Software fallback failed: {e}")));
                        return;
                    }
                    Ok(v) => v,
                };

                let sw_time_base = sw_this.decoder().time_base();
                let sw_start_time = sw_this.start_time();

                let mut sw_cache = BTreeMap::<u32, CachedFrame>::new();
                let mut sw_last_active_frame = None::<u32>;
                let sw_last_sent_frame = Rc::new(RefCell::new(None::<OutputFrame>));
                let sw_first_ever_frame = Rc::new(RefCell::new(None::<OutputFrame>));
                let mut sw_frames = sw_this.frames();
                let mut sw_converter = FrameConverter::new();

                if let Some(frame) = (&mut sw_frames).flatten().next() {
                    let current_frame =
                        pts_to_frame(frame.pts().unwrap_or(0) - sw_start_time, sw_time_base, fps);
                    let mut cache_frame = CachedFrame::Raw {
                        frame,
                        number: current_frame,
                    };
                    let output = cache_frame.produce(&mut sw_converter);
                    sw_cache.insert(current_frame, cache_frame);
                    *sw_first_ever_frame.borrow_mut() = Some(output.clone());
                    *sw_last_sent_frame.borrow_mut() = Some(output);
                }

                let sw_decoder_type = DecoderType::FFmpegSoftware;
                let sw_init_result = DecoderInitResult {
                    width: video_width,
                    height: video_height,
                    decoder_type: sw_decoder_type,
                };
                let _ = ready_tx.send(Ok(sw_init_result));
                let supersession_config = scrub_supersession_config();
                let enable_scrub_supersession = !supersession_config.disabled
                    && (video_width as u64) * (video_height as u64)
                        >= supersession_config.min_pixels;

                while let Ok(r) = rx.recv() {
                    const MAX_FRAME_TOLERANCE: u32 = 2;

                    let mut pending_requests: Vec<PendingRequest> = Vec::with_capacity(8);
                    let mut request_order = 0u64;
                    let mut push_request =
                        |requested_time: f32, reply: oneshot::Sender<DecodedFrame>| {
                            if reply.is_closed() {
                                return;
                            }

                            let requested_time = requested_time.max(0.0);
                            let requested_frame = (requested_time * fps as f32).floor() as u32;
                            let current_order = request_order;
                            request_order = request_order.saturating_add(1);

                            if let Some(existing) = pending_requests
                                .iter_mut()
                                .find(|r| r.frame == requested_frame)
                            {
                                existing.additional_replies.push(reply);
                                existing.order = current_order;
                            } else {
                                pending_requests.push(PendingRequest {
                                    time: requested_time,
                                    frame: requested_frame,
                                    reply,
                                    additional_replies: Vec::new(),
                                    order: current_order,
                                });
                            }
                        };

                    match r {
                        VideoDecoderMessage::GetFrame(requested_time, reply) => {
                            push_request(requested_time, reply);
                        }
                    }

                    while let Ok(msg) = rx.try_recv() {
                        match msg {
                            VideoDecoderMessage::GetFrame(requested_time, reply) => {
                                push_request(requested_time, reply);
                            }
                        }
                    }

                    maybe_supersede_scrub_burst(&mut pending_requests, enable_scrub_supersession);
                    order_pending_requests_for_seek(
                        &mut pending_requests,
                        enable_scrub_supersession,
                    );

                    for PendingRequest {
                        time: requested_time,
                        frame: requested_frame,
                        reply,
                        additional_replies,
                        ..
                    } in pending_requests
                    {
                        let mut replies = Vec::with_capacity(1 + additional_replies.len());
                        if !reply.is_closed() {
                            replies.push(reply);
                        }
                        replies.extend(additional_replies.into_iter().filter(|r| !r.is_closed()));

                        if replies.is_empty() {
                            continue;
                        }

                        let last_sent_number =
                            sw_last_sent_frame.borrow().as_ref().map(|f| f.number);
                        let is_backward_seek = last_sent_number
                            .map(|last| requested_frame < last)
                            .unwrap_or(false);

                        if let Some(cached) = sw_cache.get_mut(&requested_frame) {
                            let data = cached.produce(&mut sw_converter);
                            send_to_replies(name, requested_frame, &data.frame, replies);
                            *sw_last_sent_frame.borrow_mut() = Some(data);
                            continue;
                        }

                        if is_backward_seek {
                            let best_cached_frame = sw_cache
                                .range(..=requested_frame)
                                .next_back()
                                .filter(|(k, _)| {
                                    requested_frame.saturating_sub(**k) <= MAX_FRAME_TOLERANCE
                                })
                                .map(|(k, _)| *k);

                            if let Some(frame_num) = best_cached_frame
                                && let Some(cached) = sw_cache.get_mut(&frame_num)
                            {
                                let data = cached.produce(&mut sw_converter);
                                *sw_last_sent_frame.borrow_mut() = Some(data.clone());
                                send_to_replies(name, requested_frame, &data.frame, replies);
                                continue;
                            }

                            if requested_frame <= MAX_FRAME_TOLERANCE
                                && let Some(first_frame) = sw_first_ever_frame.borrow().clone()
                            {
                                *sw_last_sent_frame.borrow_mut() = Some(first_frame.clone());
                                send_to_replies(name, requested_frame, &first_frame.frame, replies);
                                continue;
                            }

                            let _ = sw_this.reset(requested_time);
                            sw_frames = sw_this.frames();
                            *sw_last_sent_frame.borrow_mut() = None;
                            sw_cache.clear();
                        }

                        if replies.iter().all(|reply| reply.is_closed()) {
                            continue;
                        }

                        let reply_cell = Rc::new(RefCell::new(Some(replies)));
                        let reply_for_respond = reply_cell.clone();

                        let mut respond = {
                            let last_sent_frame = sw_last_sent_frame.clone();
                            Some(move |data: OutputFrame| {
                                let frame_number = data.number;
                                *last_sent_frame.borrow_mut() = Some(data.clone());
                                if let Some(replies) = reply_for_respond.borrow_mut().take() {
                                    send_to_replies(name, frame_number, &data.frame, replies);
                                }
                            })
                        };

                        let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                        let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                        let is_far_forward = sw_last_sent_frame.borrow().as_ref().map_or_else(
                            || {
                                if sw_first_ever_frame.borrow().is_some() {
                                    let first_frame_num = sw_first_ever_frame
                                        .borrow()
                                        .as_ref()
                                        .map(|f| f.number)
                                        .unwrap_or(0);
                                    requested_frame.saturating_sub(first_frame_num)
                                        > FRAME_CACHE_SIZE as u32
                                } else {
                                    requested_frame != 0
                                }
                            },
                            |last| {
                                requested_frame.saturating_sub(last.number)
                                    > FRAME_CACHE_SIZE as u32
                            },
                        );

                        if is_far_forward {
                            let _ = sw_this.reset(requested_time);
                            sw_frames = sw_this.frames();
                            *sw_last_sent_frame.borrow_mut() = None;
                            sw_cache.clear();
                        }

                        let mut exit = false;

                        for frame in &mut sw_frames {
                            if reply_cell
                                .borrow()
                                .as_ref()
                                .is_none_or(|replies| replies.iter().all(|reply| reply.is_closed()))
                            {
                                respond.take();
                                break;
                            }

                            let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                                continue;
                            };

                            let Some(pts) = frame.pts() else {
                                continue;
                            };
                            let current_frame =
                                pts_to_frame(pts - sw_start_time, sw_time_base, fps);

                            let mut cache_frame = CachedFrame::Raw {
                                frame,
                                number: current_frame,
                            };

                            if sw_first_ever_frame.borrow().is_none() {
                                let output = cache_frame.produce(&mut sw_converter);
                                *sw_first_ever_frame.borrow_mut() = Some(output);
                            }

                            if let Some(most_recent_prev_frame) =
                                sw_cache.iter_mut().rev().find(|v| {
                                    *v.0 <= requested_frame
                                        && requested_frame.saturating_sub(*v.0)
                                            <= MAX_FRAME_TOLERANCE
                                })
                                && let Some(respond) = respond.take()
                            {
                                let output = most_recent_prev_frame.1.produce(&mut sw_converter);
                                *sw_last_sent_frame.borrow_mut() = Some(output.clone());
                                (respond)(output);
                            }

                            let exceeds_cache_bounds = current_frame > cache_max;
                            let too_small_for_cache_bounds = current_frame < cache_min;

                            let cache_frame = if !too_small_for_cache_bounds {
                                cache_frame.produce(&mut sw_converter);

                                if current_frame == requested_frame
                                    && let Some(respond) = respond.take()
                                {
                                    let output = cache_frame.produce(&mut sw_converter);
                                    (respond)(output);
                                    break;
                                }

                                if sw_cache.len() >= FRAME_CACHE_SIZE {
                                    if let Some(last_active_frame) = &sw_last_active_frame {
                                        let frame = if requested_frame > *last_active_frame {
                                            *sw_cache.keys().next().unwrap()
                                        } else if requested_frame < *last_active_frame {
                                            *sw_cache.keys().next_back().unwrap()
                                        } else {
                                            let min = *sw_cache.keys().min().unwrap();
                                            let max = *sw_cache.keys().max().unwrap();
                                            if current_frame > max {
                                                min
                                            } else {
                                                max
                                            }
                                        };
                                        sw_cache.remove(&frame);
                                    } else {
                                        sw_cache.clear()
                                    }
                                }

                                sw_cache.insert(current_frame, cache_frame);
                                sw_cache.get_mut(&current_frame).unwrap()
                            } else {
                                &mut cache_frame
                            };

                            if current_frame > requested_frame && respond.is_some() {
                                let last_sent_frame_clone = sw_last_sent_frame.borrow().clone();

                                if let Some((respond, last_frame)) = last_sent_frame_clone
                                    .filter(|l| {
                                        requested_frame.saturating_sub(l.number)
                                            <= MAX_FRAME_TOLERANCE
                                    })
                                    .and_then(|l| Some((respond.take()?, l)))
                                {
                                    (respond)(last_frame);
                                } else if let Some(respond) = respond.take() {
                                    let output = cache_frame.produce(&mut sw_converter);
                                    *sw_last_sent_frame.borrow_mut() = Some(output.clone());
                                    (respond)(output);
                                }
                            }

                            exit = exit || exceeds_cache_bounds;

                            if exit {
                                break;
                            }
                        }

                        sw_last_active_frame = Some(requested_frame);

                        if let Some(respond) = respond.take() {
                            let best_cached = sw_cache
                                .range(..=requested_frame)
                                .next_back()
                                .filter(|(k, _)| {
                                    requested_frame.saturating_sub(**k) <= MAX_FRAME_TOLERANCE
                                })
                                .map(|(_, v)| v);

                            if let Some(cached) = best_cached {
                                let output = cached.clone().produce(&mut sw_converter);
                                *sw_last_sent_frame.borrow_mut() = Some(output.clone());
                                (respond)(output);
                            } else {
                                let last_frame_clone = sw_last_sent_frame.borrow().clone();
                                let first_frame_clone = sw_first_ever_frame.borrow().clone();
                                if let Some(last_frame) = last_frame_clone {
                                    (respond)(last_frame);
                                } else if let Some(first_frame) = first_frame_clone {
                                    (respond)(first_frame);
                                } else {
                                    let black_frame_data =
                                        vec![0u8; (video_width * video_height * 4) as usize];
                                    let black_frame = OutputFrame {
                                        number: requested_frame,
                                        frame: DecodedFrame::new_with_arc(
                                            Arc::new(black_frame_data),
                                            video_width,
                                            video_height,
                                        ),
                                    };
                                    (respond)(black_frame);
                                }
                            }
                        }
                    }
                }

                return;
            }

            if let Some(frame) = first_frame_result {
                let current_frame =
                    pts_to_frame(frame.pts().unwrap_or(0) - start_time, time_base, fps);
                let mut cache_frame = CachedFrame::Raw {
                    frame,
                    number: current_frame,
                };
                let output = cache_frame.produce(&mut converter);

                cache.insert(current_frame, cache_frame);
                *first_ever_frame.borrow_mut() = Some(output.clone());
                *last_sent_frame.borrow_mut() = Some(output);
                info!(
                    "FFmpeg decoder '{}': pre-decoded first frame {} ({}x{})",
                    name, current_frame, video_width, video_height
                );
            }

            let decoder_type = if is_hw {
                DecoderType::FFmpegHardware
            } else {
                DecoderType::FFmpegSoftware
            };
            let init_result = DecoderInitResult {
                width: video_width,
                height: video_height,
                decoder_type,
            };
            let _ = ready_tx.send(Ok(init_result));
            let supersession_config = scrub_supersession_config();
            let enable_scrub_supersession = !supersession_config.disabled
                && (video_width as u64) * (video_height as u64) >= supersession_config.min_pixels;

            while let Ok(r) = rx.recv() {
                const MAX_FRAME_TOLERANCE: u32 = 2;

                let mut pending_requests: Vec<PendingRequest> = Vec::with_capacity(8);
                let mut request_order = 0u64;
                let mut push_request =
                    |requested_time: f32, reply: oneshot::Sender<DecodedFrame>| {
                        if reply.is_closed() {
                            return;
                        }

                        let requested_time = requested_time.max(0.0);
                        let requested_frame = (requested_time * fps as f32).floor() as u32;
                        let current_order = request_order;
                        request_order = request_order.saturating_add(1);

                        if let Some(existing) = pending_requests
                            .iter_mut()
                            .find(|r| r.frame == requested_frame)
                        {
                            existing.additional_replies.push(reply);
                            existing.order = current_order;
                        } else {
                            pending_requests.push(PendingRequest {
                                time: requested_time,
                                frame: requested_frame,
                                reply,
                                additional_replies: Vec::new(),
                                order: current_order,
                            });
                        }
                    };

                match r {
                    VideoDecoderMessage::GetFrame(requested_time, reply) => {
                        push_request(requested_time, reply);
                    }
                }

                while let Ok(msg) = rx.try_recv() {
                    match msg {
                        VideoDecoderMessage::GetFrame(requested_time, reply) => {
                            push_request(requested_time, reply);
                        }
                    }
                }

                maybe_supersede_scrub_burst(&mut pending_requests, enable_scrub_supersession);
                order_pending_requests_for_seek(&mut pending_requests, enable_scrub_supersession);

                for PendingRequest {
                    time: requested_time,
                    frame: requested_frame,
                    reply,
                    additional_replies,
                    ..
                } in pending_requests
                {
                    let mut replies = Vec::with_capacity(1 + additional_replies.len());
                    if !reply.is_closed() {
                        replies.push(reply);
                    }
                    replies.extend(additional_replies.into_iter().filter(|r| !r.is_closed()));

                    if replies.is_empty() {
                        continue;
                    }

                    let last_sent_number = last_sent_frame.borrow().as_ref().map(|f| f.number);
                    let is_backward_seek = last_sent_number
                        .map(|last| requested_frame < last)
                        .unwrap_or(false);

                    if let Some(cached) = cache.get_mut(&requested_frame) {
                        let data = cached.produce(&mut converter);

                        send_to_replies(name, requested_frame, &data.frame, replies);
                        *last_sent_frame.borrow_mut() = Some(data);
                        continue;
                    }

                    if is_backward_seek {
                        let best_cached_frame = cache
                            .range(..=requested_frame)
                            .next_back()
                            .filter(|(k, _)| {
                                requested_frame.saturating_sub(**k) <= MAX_FRAME_TOLERANCE
                            })
                            .map(|(k, _)| *k);

                        if let Some(frame_num) = best_cached_frame
                            && let Some(cached) = cache.get_mut(&frame_num)
                        {
                            let data = cached.produce(&mut converter);
                            *last_sent_frame.borrow_mut() = Some(data.clone());
                            send_to_replies(name, requested_frame, &data.frame, replies);
                            continue;
                        }

                        if requested_frame <= MAX_FRAME_TOLERANCE
                            && let Some(first_frame) = first_ever_frame.borrow().clone()
                        {
                            *last_sent_frame.borrow_mut() = Some(first_frame.clone());
                            send_to_replies(name, requested_frame, &first_frame.frame, replies);
                            continue;
                        }

                        let _ = this.reset(requested_time);
                        frames = this.frames();
                        *last_sent_frame.borrow_mut() = None;
                        cache.clear();
                    }

                    if replies.iter().all(|reply| reply.is_closed()) {
                        continue;
                    }

                    let reply_cell = Rc::new(RefCell::new(Some(replies)));
                    let reply_for_respond = reply_cell.clone();

                    let mut respond = {
                        let last_sent_frame = last_sent_frame.clone();
                        Some(move |data: OutputFrame| {
                            let frame_number = data.number;
                            *last_sent_frame.borrow_mut() = Some(data.clone());
                            if let Some(replies) = reply_for_respond.borrow_mut().take() {
                                send_to_replies(name, frame_number, &data.frame, replies);
                            }
                        })
                    };

                    let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                    let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                    let is_far_forward = last_sent_frame.borrow().as_ref().map_or_else(
                        || {
                            if first_ever_frame.borrow().is_some() {
                                let first_frame_num = first_ever_frame
                                    .borrow()
                                    .as_ref()
                                    .map(|f| f.number)
                                    .unwrap_or(0);
                                requested_frame.saturating_sub(first_frame_num)
                                    > FRAME_CACHE_SIZE as u32
                            } else {
                                requested_frame != 0
                            }
                        },
                        |last| {
                            requested_frame.saturating_sub(last.number) > FRAME_CACHE_SIZE as u32
                        },
                    );

                    if is_far_forward {
                        let _ = this.reset(requested_time);
                        frames = this.frames();
                        *last_sent_frame.borrow_mut() = None;
                        cache.clear();
                    }

                    let mut exit = false;

                    for frame in &mut frames {
                        if reply_cell
                            .borrow()
                            .as_ref()
                            .is_none_or(|replies| replies.iter().all(|reply| reply.is_closed()))
                        {
                            respond.take();
                            break;
                        }

                        let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                            continue;
                        };

                        let Some(pts) = frame.pts() else {
                            continue;
                        };
                        let current_frame = pts_to_frame(pts - start_time, time_base, fps);

                        let mut cache_frame = CachedFrame::Raw {
                            frame,
                            number: current_frame,
                        };

                        if first_ever_frame.borrow().is_none() {
                            let output = cache_frame.produce(&mut converter);
                            *first_ever_frame.borrow_mut() = Some(output);
                        }

                        if let Some(most_recent_prev_frame) = cache.iter_mut().rev().find(|v| {
                            *v.0 <= requested_frame
                                && requested_frame.saturating_sub(*v.0) <= MAX_FRAME_TOLERANCE
                        }) && let Some(respond) = respond.take()
                        {
                            let output = most_recent_prev_frame.1.produce(&mut converter);
                            *last_sent_frame.borrow_mut() = Some(output.clone());
                            (respond)(output);
                        }

                        let exceeds_cache_bounds = current_frame > cache_max;
                        let too_small_for_cache_bounds = current_frame < cache_min;

                        let cache_frame = if !too_small_for_cache_bounds {
                            cache_frame.produce(&mut converter);

                            if current_frame == requested_frame
                                && let Some(respond) = respond.take()
                            {
                                let output = cache_frame.produce(&mut converter);
                                (respond)(output);

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

                                        if current_frame > max {
                                            min
                                        } else {
                                            max
                                        }
                                    };

                                    cache.remove(&frame);
                                } else {
                                    cache.clear()
                                }
                            }

                            cache.insert(current_frame, cache_frame);
                            cache.get_mut(&current_frame).unwrap()
                        } else {
                            &mut cache_frame
                        };

                        if current_frame > requested_frame && respond.is_some() {
                            let last_sent_frame_clone = last_sent_frame.borrow().clone();

                            if let Some((respond, last_frame)) = last_sent_frame_clone
                                .filter(|l| {
                                    requested_frame.saturating_sub(l.number) <= MAX_FRAME_TOLERANCE
                                })
                                .and_then(|l| Some((respond.take()?, l)))
                            {
                                (respond)(last_frame);
                            } else if let Some(respond) = respond.take() {
                                let output = cache_frame.produce(&mut converter);
                                *last_sent_frame.borrow_mut() = Some(output.clone());
                                (respond)(output);
                            }
                        }

                        exit = exit || exceeds_cache_bounds;

                        if exit {
                            break;
                        }
                    }

                    last_active_frame = Some(requested_frame);

                    if let Some(respond) = respond.take() {
                        let best_cached = cache
                            .range(..=requested_frame)
                            .next_back()
                            .filter(|(k, _)| {
                                requested_frame.saturating_sub(**k) <= MAX_FRAME_TOLERANCE
                            })
                            .map(|(_, v)| v);

                        if let Some(cached) = best_cached {
                            let output = cached.clone().produce(&mut converter);
                            *last_sent_frame.borrow_mut() = Some(output.clone());
                            (respond)(output);
                        } else {
                            let last_frame_clone = last_sent_frame.borrow().clone();
                            let first_frame_clone = first_ever_frame.borrow().clone();
                            if let Some(last_frame) = last_frame_clone {
                                (respond)(last_frame);
                            } else if let Some(first_frame) = first_frame_clone {
                                (respond)(first_frame);
                            } else {
                                let black_frame_data =
                                    vec![0u8; (video_width * video_height * 4) as usize];
                                let black_frame = OutputFrame {
                                    number: requested_frame,
                                    frame: DecodedFrame::new_with_arc(
                                        Arc::new(black_frame_data),
                                        video_width,
                                        video_height,
                                    ),
                                };
                                (respond)(black_frame);
                            }
                        }
                    }
                }
            }
        });

        continue_rx.recv().map_err(|e| e.to_string())?.map(|_| ())
    }
}

// pub fn find_decoder(
//     s: &format::context::Input,
//     st: &format::stream::Stream,
//     codec_id: codec::Id,
// ) -> Option<Codec> {
//     unsafe {
//         use ffmpeg::media::Type;
//         let codec = match st.parameters().medium() {
//             Type::Video => Some((*s.as_ptr()).video_codec),
//             Type::Audio => Some((*s.as_ptr()).audio_codec),
//             Type::Subtitle => Some((*s.as_ptr()).subtitle_codec),
//             _ => None,
//         };

//         if let Some(codec) = codec {
//             if !codec.is_null() {
//                 return Some(Codec::wrap(codec));
//             }
//         }

//         let found = avcodec_find_decoder(codec_id.into());

//         if found.is_null() {
//             return None;
//         }
//         Some(Codec::wrap(found))
//     }
// }

// struct PeekableReceiver<T> {
//     rx: mpsc::Receiver<T>,
//     peeked: Option<T>,
// }

// impl<T> PeekableReceiver<T> {
//     fn peek(&mut self) -> Option<&T> {
//         if self.peeked.is_some() {
//             self.peeked.as_ref()
//         } else {
//             match self.rx.try_recv() {
//                 Ok(value) => {
//                     self.peeked = Some(value);
//                     self.peeked.as_ref()
//                 }
//                 Err(_) => None,
//             }
//         }
//     }

//     fn recv(&mut self) -> Result<T, mpsc::RecvError> {
//         if let Some(value) = self.peeked.take() {
//             Ok(value)
//         } else {
//             self.rx.recv()
//         }
//     }
// }

#[cfg(test)]
mod tests {
    use super::{
        order_pending_requests_for_seek, should_prioritize_latest_request, PendingRequest,
        ScrubSupersessionConfig,
    };
    use tokio::sync::oneshot;

    fn pending_request(frame: u32, order: u64) -> PendingRequest {
        let (reply, _) = oneshot::channel();
        PendingRequest {
            time: 0.0,
            frame,
            reply,
            additional_replies: Vec::new(),
            order,
        }
    }

    #[test]
    fn prioritizes_latest_request_when_span_exceeds_threshold() {
        let requests = vec![
            pending_request(200, 0),
            pending_request(4000, 1),
            pending_request(2500, 2),
        ];
        let should_prioritize = should_prioritize_latest_request(
            &requests,
            true,
            ScrubSupersessionConfig {
                min_requests: 7,
                min_span_frames: 20,
                min_pixels: 2_000_000,
                disabled: false,
                latest_first_disabled: false,
                latest_first_min_requests: 2,
                latest_first_min_span_frames: 20,
            },
        );
        assert!(should_prioritize);
    }

    #[test]
    fn does_not_prioritize_when_latest_first_is_disabled() {
        let requests = vec![
            pending_request(200, 0),
            pending_request(4000, 1),
            pending_request(2500, 2),
        ];
        let should_prioritize = should_prioritize_latest_request(
            &requests,
            true,
            ScrubSupersessionConfig {
                min_requests: 7,
                min_span_frames: 20,
                min_pixels: 2_000_000,
                disabled: false,
                latest_first_disabled: true,
                latest_first_min_requests: 2,
                latest_first_min_span_frames: 20,
            },
        );
        assert!(!should_prioritize);
    }

    #[test]
    fn does_not_prioritize_when_request_count_below_latest_first_threshold() {
        let requests = vec![pending_request(200, 0), pending_request(4000, 1)];
        let should_prioritize = should_prioritize_latest_request(
            &requests,
            true,
            ScrubSupersessionConfig {
                min_requests: 7,
                min_span_frames: 20,
                min_pixels: 2_000_000,
                disabled: false,
                latest_first_disabled: false,
                latest_first_min_requests: 3,
                latest_first_min_span_frames: 20,
            },
        );
        assert!(!should_prioritize);
    }

    #[test]
    fn keeps_frame_order_when_prioritization_disabled() {
        let mut requests = vec![
            pending_request(500, 1),
            pending_request(100, 2),
            pending_request(300, 3),
        ];
        order_pending_requests_for_seek(&mut requests, false);
        let ordered_frames = requests
            .iter()
            .map(|request| request.frame)
            .collect::<Vec<_>>();
        assert_eq!(ordered_frames, vec![100, 300, 500]);
    }

    #[test]
    fn places_latest_request_first_when_prioritizing() {
        let mut requests = vec![
            pending_request(120, 0),
            pending_request(4096, 1),
            pending_request(2800, 2),
            pending_request(40, 3),
        ];
        order_pending_requests_for_seek(&mut requests, true);
        let ordered_frames = requests
            .iter()
            .map(|request| request.frame)
            .collect::<Vec<_>>();
        assert_eq!(ordered_frames[0], 40);
    }
}
