use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{mpsc, Arc},
};

use cap_project::TargetFPS;
use ffmpeg::{
    codec,
    format::{self},
    frame, rescale, Codec, Rational, Rescale,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use ffmpeg_sys_next::{avcodec_find_decoder, AVHWDeviceType};

pub type DecodedFrame = Arc<Vec<u8>>;

enum VideoDecoderMessage {
    GetFrame(u32, tokio::sync::oneshot::Sender<Option<Arc<Vec<u8>>>>),
}

fn pts_to_frame(fps: f64, pts: i64, time_base: Rational) -> u32 {
    (fps * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64))).round()
        as u32
}

const FRAME_CACHE_SIZE: usize = 50;
// TODO: Allow dynamic FPS values by either passing it into `spawn`
// or changing `get_frame` to take the requested time instead of frame number,
// so that the lookup can be done by PTS instead of frame number.
// const FPS: u32 = 30;

pub struct AsyncVideoDecoder;

impl AsyncVideoDecoder {
    pub fn spawn(path: PathBuf) -> AsyncVideoDecoderHandle {
        let (tx, rx) = mpsc::channel();

        std::thread::spawn(move || {
            let mut input = ffmpeg::format::input(&path).unwrap();

            let input_stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or("Could not find a video stream")
                .unwrap();

            let decoder_codec =
                ff_find_decoder(&input, &input_stream, input_stream.parameters().id()).unwrap();

            let mut context = codec::context::Context::new_with_codec(decoder_codec);
            context.set_parameters(input_stream.parameters()).unwrap();

            let input_stream_index = input_stream.index();
            let time_base = input_stream.time_base();
            let frame_rate = input_stream.rate();
            let fps = TargetFPS::round(frame_rate.into());

            // Create a decoder for the video stream
            let mut decoder = context.decoder().video().unwrap();

            let hw_device: Option<HwDevice> = {
                #[cfg(target_os = "macos")]
                {
                    decoder
                        .try_use_hw_device(
                            AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
                            Pixel::NV12,
                        )
                        .ok()
                }

                #[cfg(not(target_os = "macos"))]
                None
            };

            use ffmpeg::format::Pixel;
            use ffmpeg::software::scaling::{context::Context, flag::Flags};

            let mut scaler_input_format = hw_device
                .as_ref()
                .map(|d| d.pix_fmt)
                .unwrap_or(decoder.format());

            let mut scaler = Context::get(
                scaler_input_format,
                decoder.width(),
                decoder.height(),
                Pixel::RGBA,
                decoder.width(),
                decoder.height(),
                Flags::BILINEAR,
            )
            .unwrap();

            let mut temp_frame = ffmpeg::frame::Video::empty();

            let mut cache = BTreeMap::<u32, Arc<Vec<u8>>>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            let mut last_active_frame = None::<u32>;

            let mut last_decoded_frame = None::<u32>;
            let mut last_sent_frame = None::<(u32, DecodedFrame)>;

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };

            let mut packets = input.packets();

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_frame, sender) => {
                        let mut sender = if let Some(cached) = cache.get(&requested_frame) {
                            sender.send(Some(cached.clone())).ok();
                            last_sent_frame = Some((requested_frame, cached.clone()));
                            continue;
                        } else {
                            Some(sender)
                        };

                        let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                        let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                        if requested_frame <= 0
                            || last_sent_frame
                                .as_ref()
                                .map(|last| {
                                    requested_frame < last.0 ||
                                    // seek forward for big jumps. this threshold is arbitrary but should be derived from i-frames in future
                                    requested_frame - last.0 > FRAME_CACHE_SIZE as u32
                                })
                                .unwrap_or(true)
                        {
                            let timestamp_us =
                                ((requested_frame as f32 / frame_rate.numerator() as f32)
                                    * 1_000_000.0) as i64;
                            let position = timestamp_us.rescale((1, 1_000_000), rescale::TIME_BASE);

                            println!("seeking to {position} for frame {requested_frame}");

                            decoder.flush();
                            input.seek(position, ..position).unwrap();
                            cache.clear();
                            last_decoded_frame = None;
                            last_sent_frame = None;

                            packets = input.packets();
                        }

                        // handle when requested_frame == last_decoded_frame or last_decoded_frame > requested_frame.
                        // the latter can occur when there are skips in frame numbers.
                        // in future we should alleviate this by using time + pts values instead of frame numbers.
                        if let Some((_, last_sent_frame)) = last_decoded_frame
                            .zip(last_sent_frame.as_ref())
                            .filter(|(last_decoded_frame, last_sent_frame)| {
                                last_sent_frame.0 < requested_frame
                                    && requested_frame < *last_decoded_frame
                            })
                        {
                            if let Some(sender) = sender.take() {
                                sender.send(Some(last_sent_frame.1.clone())).ok();
                                continue;
                            }
                        }

                        last_active_frame = Some(requested_frame);

                        loop {
                            if peekable_requests.peek().is_some() {
                                break;
                            }
                            let Some((stream, packet)) = packets.next() else {
                                sender.take().map(|s| s.send(None));
                                break;
                            };

                            if stream.index() == input_stream_index {
                                let start_offset = stream.start_time();

                                decoder.send_packet(&packet).ok(); // decode failures are ok, we just fail to return a frame

                                let mut exit = false;

                                while decoder.receive_frame(&mut temp_frame).is_ok() {
                                    let current_frame = pts_to_frame(
                                        fps as f64,
                                        temp_frame.pts().unwrap() - start_offset,
                                        time_base,
                                    );

                                    last_decoded_frame = Some(current_frame);

                                    // we repeat the similar section as above to do the check per-frame instead of just per-request
                                    if let Some((_, last_sent_frame)) = last_decoded_frame
                                        .zip(last_sent_frame.as_ref())
                                        .filter(|(last_decoded_frame, last_sent_frame)| {
                                            last_sent_frame.0 <= requested_frame
                                                && requested_frame < *last_decoded_frame
                                        })
                                    {
                                        if let Some(sender) = sender.take() {
                                            sender.send(Some(last_sent_frame.1.clone())).ok();
                                        }
                                    }

                                    let exceeds_cache_bounds = current_frame > cache_max;
                                    let too_small_for_cache_bounds = current_frame < cache_min;

                                    let hw_frame =
                                        hw_device.as_ref().and_then(|d| d.get_hwframe(&temp_frame));

                                    let frame = hw_frame.as_ref().unwrap_or(&temp_frame);

                                    if frame.format() != scaler_input_format {
                                        // Reinitialize the scaler with the new input format
                                        scaler_input_format = frame.format();
                                        scaler = Context::get(
                                            scaler_input_format,
                                            decoder.width(),
                                            decoder.height(),
                                            Pixel::RGBA,
                                            decoder.width(),
                                            decoder.height(),
                                            Flags::BILINEAR,
                                        )
                                        .unwrap();
                                    }

                                    let mut rgb_frame = frame::Video::empty();
                                    scaler.run(frame, &mut rgb_frame).unwrap();

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

                                    let frame = Arc::new(frame_buffer);

                                    if current_frame == requested_frame {
                                        if let Some(sender) = sender.take() {
                                            last_sent_frame = Some((current_frame, frame.clone()));
                                            sender.send(Some(frame.clone())).ok();

                                            break;
                                        }
                                    }

                                    if !too_small_for_cache_bounds {
                                        if cache.len() >= FRAME_CACHE_SIZE {
                                            if let Some(last_active_frame) = &last_active_frame {
                                                let frame = if requested_frame > *last_active_frame
                                                {
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

                                        cache.insert(current_frame, frame);
                                    }

                                    exit = exit || exceeds_cache_bounds;
                                }

                                if exit {
                                    break;
                                }
                            }
                        }

                        if let Some(s) = sender.take() {
                            let _ = s.send(None);
                        }
                    }
                }
            }
        });

        AsyncVideoDecoderHandle { sender: tx }
    }
}

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: u32) -> Option<Arc<Vec<u8>>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(time, tx))
            .unwrap();
        rx.await.ok().flatten()
    }
}

struct PeekableReceiver<T> {
    rx: mpsc::Receiver<T>,
    peeked: Option<T>,
}

impl<T> PeekableReceiver<T> {
    fn peek(&mut self) -> Option<&T> {
        if self.peeked.is_some() {
            self.peeked.as_ref()
        } else {
            match self.rx.try_recv() {
                Ok(value) => {
                    self.peeked = Some(value);
                    self.peeked.as_ref()
                }
                Err(_) => None,
            }
        }
    }

    fn try_recv(&mut self) -> Result<T, mpsc::TryRecvError> {
        println!("try_recv");
        if let Some(value) = self.peeked.take() {
            Ok(value)
        } else {
            self.rx.try_recv()
        }
    }

    fn recv(&mut self) -> Result<T, mpsc::RecvError> {
        if let Some(value) = self.peeked.take() {
            Ok(value)
        } else {
            self.rx.recv()
        }
    }
}

fn ff_find_decoder(
    s: &format::context::Input,
    st: &format::stream::Stream,
    codec_id: codec::Id,
) -> Option<Codec> {
    unsafe {
        use ffmpeg::media::Type;
        let codec = match st.parameters().medium() {
            Type::Video => Some((*s.as_ptr()).video_codec),
            Type::Audio => Some((*s.as_ptr()).audio_codec),
            Type::Subtitle => Some((*s.as_ptr()).subtitle_codec),
            _ => None,
        };

        if let Some(codec) = codec {
            if !codec.is_null() {
                return Some(Codec::wrap(codec));
            }
        }

        let found = avcodec_find_decoder(codec_id.into());

        if found.is_null() {
            return None;
        }
        Some(Codec::wrap(found))
    }
}
