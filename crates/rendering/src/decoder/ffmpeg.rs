use ffmpeg::{format, frame, software, sys::AVHWDeviceType};
use log::debug;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
};
use tokio::sync::oneshot;

use super::{FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: Arc<Vec<u8>>,
}

impl CachedFrame {
    fn process(&mut self, width: u32, height: u32) -> ProcessedFrame {
        match self {
            Self::Raw { frame, number } => {
                let rgb_frame = if frame.format() != format::Pixel::RGBA {
                    // Reinitialize the scaler with the new input format
                    let mut scaler =
                        software::converter((width, height), frame.format(), format::Pixel::RGBA)
                            .unwrap();

                    let mut rgb_frame = frame::Video::empty();
                    scaler.run(frame, &mut rgb_frame).unwrap();
                    rgb_frame
                } else {
                    std::mem::replace(frame, frame::Video::empty())
                };

                let width = rgb_frame.width() as usize;
                let height = rgb_frame.height() as usize;
                let stride = rgb_frame.stride(0);
                let data = rgb_frame.data(0);

                let expected_size = width * height * 4;

                let mut frame_buffer = Vec::with_capacity(expected_size);

                // account for stride > width
                for line_data in data.chunks_exact(stride) {
                    frame_buffer.extend_from_slice(&line_data[0..width * 4]);
                }

                let data = ProcessedFrame {
                    data: Arc::new(frame_buffer),
                    number: *number,
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
        let mut this = cap_video_decode::FFmpegDecoder::new(
            path,
            Some(if cfg!(target_os = "macos") {
                AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
            } else {
                AVHWDeviceType::AV_HWDEVICE_TYPE_D3D12VA
            }),
        )?;

        let time_base = this.decoder().time_base();
        let start_time = this.start_time();
        let width = this.decoder().width();
        let height = this.decoder().height();

        std::thread::spawn(move || {
            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            #[allow(unused)]
            let mut last_active_frame = None::<u32>;

            let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

            let mut frames = this.frames();

            let _ = ready_tx.send(Ok(()));

            while let Ok(r) = rx.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        let requested_frame = (requested_time * fps as f32).floor() as u32;
                        // sender.send(black_frame.clone()).ok();
                        // continue;

                        let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                            let data = cached.process(width, height);

                            sender.send(data.data.clone()).ok();
                            *last_sent_frame.borrow_mut() = Some(data);
                            continue;
                        } else {
                            let last_sent_frame = last_sent_frame.clone();
                            Some(move |data: ProcessedFrame| {
                                *last_sent_frame.borrow_mut() = Some(data.clone());
                                let _ = sender.send(data.data);
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
                                    // seek forward for big jumps. this threshold is arbitrary but should be derived from i-frames in future
                                    || requested_frame - last.number > FRAME_CACHE_SIZE as u32
                                })
                                .unwrap_or(true)
                        {
                            debug!("seeking to {requested_frame}");

                            let _ = this.reset(requested_time);
                            frames = this.frames();
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
                                (sender)(most_recent_prev_frame.1.process(width, height));
                            }

                            let exceeds_cache_bounds = current_frame > cache_max;
                            let too_small_for_cache_bounds = current_frame < cache_min;

                            let cache_frame = if !too_small_for_cache_bounds {
                                if current_frame == requested_frame
                                    && let Some(sender) = sender.take()
                                {
                                    let data = cache_frame.process(width, height);
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

                                    (sender)(cache_frame.process(width, height));
                                }
                            }

                            exit = exit || exceeds_cache_bounds;

                            if exit {
                                break;
                            }
                        }

                        // not inlining this is important so that last_sent_frame is dropped before the sender is invoked
                        let last_sent_frame = last_sent_frame.borrow().clone();
                        if let Some((sender, last_sent_frame)) = sender.take().zip(last_sent_frame)
                        {
                            // info!(
                            //     "sending hail mary frame {} for {requested_frame}",
                            //     last_sent_frame.0
                            // );

                            (sender)(last_sent_frame);
                        }
                    }
                }
            }
        });

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
