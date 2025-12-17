#![allow(dead_code)]

use ffmpeg::{format, frame, sys::AVHWDeviceType};
use log::debug;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
};
use tokio::sync::oneshot;

use crate::{DecodedFrame, PixelFormat};

use super::{FRAME_CACHE_SIZE, VideoDecoderMessage, frame_converter::FrameConverter, pts_to_frame};

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
    fn process(&mut self, converter: &mut FrameConverter) -> ProcessedFrame {
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
        }
    }
}

#[derive(Clone)]
enum CachedFrame {
    Raw { frame: frame::Video, number: u32 },
    Processed(ProcessedFrame),
}

pub struct FfmpegDecoder;

impl FfmpegDecoder {
    pub fn spawn(
        _name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let (continue_tx, continue_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut this = match cap_video_decode::FFmpegDecoder::new(
                path,
                Some(if cfg!(target_os = "macos") {
                    AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
                } else {
                    AVHWDeviceType::AV_HWDEVICE_TYPE_DXVA2
                }),
            ) {
                Err(e) => {
                    let _ = continue_tx.send(Err(e));
                    return;
                }
                Ok(v) => {
                    let _ = continue_tx.send(Ok(()));
                    v
                }
            };

            let time_base = this.decoder().time_base();
            let start_time = this.start_time();
            let video_width = this.decoder().width();
            let video_height = this.decoder().height();

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            #[allow(unused)]
            let mut last_active_frame = None::<u32>;

            let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

            let mut frames = this.frames();
            let mut converter = FrameConverter::new();

            let _ = ready_tx.send(Ok(()));

            while let Ok(r) = rx.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        if sender.is_closed() {
                            continue;
                        }

                        let requested_frame = (requested_time * fps as f32).floor() as u32;
                        // sender.send(black_frame.clone()).ok();
                        // continue;

                        let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                            let data = cached.process(&mut converter);

                            if sender.send(data.to_decoded_frame()).is_err() {
                                log::warn!(
                                    "Failed to send cached frame {requested_frame}: receiver dropped"
                                );
                            }
                            *last_sent_frame.borrow_mut() = Some(data);
                            continue;
                        } else {
                            let last_sent_frame = last_sent_frame.clone();
                            Some(move |data: ProcessedFrame| {
                                let frame_number = data.number;
                                *last_sent_frame.borrow_mut() = Some(data.clone());
                                if sender.send(data.to_decoded_frame()).is_err() {
                                    log::warn!(
                                        "Failed to send decoded frame {frame_number}: receiver dropped"
                                    );
                                }
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
                            debug!("seeking to {requested_frame}");

                            let _ = this.reset(requested_time);
                            frames = this.frames();
                            *last_sent_frame.borrow_mut() = None;
                            cache.clear();
                        }

                        last_active_frame = Some(requested_frame);

                        let mut exit = false;

                        for frame in &mut frames {
                            let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                                continue;
                            };

                            let current_frame =
                                pts_to_frame(frame.pts().unwrap() - start_time, time_base, fps);

                            let mut cache_frame = CachedFrame::Raw {
                                frame,
                                number: current_frame,
                            };

                            // Handles frame skips.
                            // We use the cache instead of last_sent_frame as newer non-matching frames could have been decoded.
                            if let Some(most_recent_prev_frame) =
                                cache.iter_mut().rev().find(|v| *v.0 < requested_frame)
                                && let Some(sender) = sender.take()
                            {
                                (sender)(most_recent_prev_frame.1.process(&mut converter));
                            }

                            let exceeds_cache_bounds = current_frame > cache_max;
                            let too_small_for_cache_bounds = current_frame < cache_min;

                            let cache_frame = if !too_small_for_cache_bounds {
                                if current_frame == requested_frame
                                    && let Some(sender) = sender.take()
                                {
                                    let data = cache_frame.process(&mut converter);
                                    // info!("sending frame {requested_frame}");

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

                                cache.insert(current_frame, cache_frame);
                                cache.get_mut(&current_frame).unwrap()
                            } else {
                                &mut cache_frame
                            };

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
                                    // info!(
                                    //     "sending forward frame {current_frame} for {requested_frame}",
                                    // );

                                    (sender)(cache_frame.process(&mut converter));
                                }
                            }

                            exit = exit || exceeds_cache_bounds;

                            if exit {
                                break;
                            }
                        }

                        let last_sent_frame = last_sent_frame.borrow().clone();
                        if let Some(sender) = sender.take() {
                            if let Some(last_sent_frame) = last_sent_frame {
                                (sender)(last_sent_frame);
                            } else {
                                debug!(
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
        });

        continue_rx.recv().map_err(|e| e.to_string())??;

        Ok(())
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
