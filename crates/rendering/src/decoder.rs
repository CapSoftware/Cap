use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
};

use ffmpeg::{
    codec::{self, Capabilities},
    format::{self},
    frame, rescale,
    software::{self, scaling},
    Codec, Rational, Rescale,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use ffmpeg_sys_next::{avcodec_find_decoder, AVHWDeviceType};

pub type DecodedFrame = Arc<Vec<u8>>;

enum VideoDecoderMessage {
    GetFrame(u32, tokio::sync::oneshot::Sender<Option<Arc<Vec<u8>>>>),
}

fn pts_to_frame(pts: i64, time_base: Rational) -> u32 {
    (FPS as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

const FRAME_CACHE_SIZE: usize = 50;
// TODO: Allow dynamic FPS values by either passing it into `spawn`
// or changing `get_frame` to take the requested time instead of frame number,
// so that the lookup can be done by PTS instead of frame number.
const FPS: u32 = 30;

#[derive(Clone)]
struct CachedFrame {
    data: CachedFrameData,
}

impl CachedFrame {
    fn process(
        &mut self,
        scaler_input_format: &mut format::Pixel,
        scaler: &mut scaling::Context,
        decoder: &codec::decoder::Video,
    ) -> Arc<Vec<u8>> {
        match &mut self.data {
            CachedFrameData::Raw(frame) => {
                if frame.format() != *scaler_input_format {
                    // Reinitialize the scaler with the new input format
                    *scaler_input_format = frame.format();
                    *scaler = software::scaling::Context::get(
                        *scaler_input_format,
                        decoder.width(),
                        decoder.height(),
                        format::Pixel::RGBA,
                        decoder.width(),
                        decoder.height(),
                        software::scaling::Flags::BILINEAR,
                    )
                    .unwrap();
                }

                let mut rgb_frame = frame::Video::empty();
                scaler.run(&frame, &mut rgb_frame).unwrap();

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

                let data = Arc::new(frame_buffer);

                self.data = CachedFrameData::Processed(data.clone());

                data
            }
            CachedFrameData::Processed(data) => data.clone(),
        }
    }
}

#[derive(Clone)]
enum CachedFrameData {
    Raw(frame::Video),
    Processed(Arc<Vec<u8>>),
}

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

            // Create a decoder for the video stream
            let mut decoder = context.decoder().video().unwrap();

            {
                use codec::threading::{Config, Type};

                let capabilities = decoder_codec.capabilities();

                if capabilities.intersects(Capabilities::FRAME_THREADS) {
                    decoder.set_threading(Config::kind(Type::Frame));
                } else if capabilities.intersects(Capabilities::SLICE_THREADS) {
                    decoder.set_threading(Config::kind(Type::Slice));
                } else {
                    decoder.set_threading(Config::count(1));
                }
            }

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

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            let mut last_active_frame = None::<u32>;

            let mut last_decoded_frame = None::<u32>;
            let mut last_sent_frame = None::<(u32, DecodedFrame)>;
            let mut reached_end = false;

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };

            let mut packets = input.packets();

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_frame, sender) => {
                        // If we've already reached the end and have a last frame, return it
                        if reached_end {
                            if let Some((_, last_frame)) = &last_sent_frame {
                                sender.send(Some(last_frame.clone())).ok();
                                continue;
                            }
                        }

                        let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                            let data =
                                cached.process(&mut scaler_input_format, &mut scaler, &decoder);

                            sender.send(Some(data.clone())).ok();
                            last_sent_frame = Some((requested_frame, data));
                            continue;
                        } else {
                            Some(sender)
                        };

                        let cache_min = requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
                        let cache_max = requested_frame + FRAME_CACHE_SIZE as u32 / 2;

                        if cache.len() >= FRAME_CACHE_SIZE {
                            // When cache is full, remove old frames that are far from the requested frame
                            let frames_to_remove: Vec<_> = cache
                                .keys()
                                .filter(|&&k| {
                                    // Keep frames within a window of the requested frame
                                    let distance = if k <= requested_frame {
                                        requested_frame - k
                                    } else {
                                        k - requested_frame
                                    };
                                    // Remove frames that are more than half the cache size away
                                    distance > FRAME_CACHE_SIZE as u32 / 2
                                })
                                .copied()
                                .collect();

                            for frame in frames_to_remove {
                                println!(
                                    "Removing old frame {} from cache (requested_frame: {})",
                                    frame, requested_frame
                                );
                                cache.remove(&frame);
                            }

                            // If we still need to remove frames, remove the ones furthest from the requested frame
                            if cache.len() >= FRAME_CACHE_SIZE {
                                let frame_to_remove = cache
                                    .keys()
                                    .max_by_key(|&&k| {
                                        if k <= requested_frame {
                                            requested_frame - k
                                        } else {
                                            k - requested_frame
                                        }
                                    })
                                    .copied()
                                    .unwrap();
                                println!(
                                    "Removing distant frame {} from cache (requested_frame: {})",
                                    frame_to_remove, requested_frame
                                );
                                cache.remove(&frame_to_remove);
                            }
                        }

                        // Only seek if we're going backwards or if we're jumping more than half the cache size
                        // AND we don't have the frame in cache already
                        // AND we haven't reached the end of the video
                        if !reached_end
                            && !cache.contains_key(&requested_frame)
                            && (requested_frame <= 0
                                || last_sent_frame
                                    .as_ref()
                                    .map(|last| {
                                        let backwards = requested_frame < last.0;
                                        let big_jump = requested_frame > last.0
                                            && requested_frame.saturating_sub(last.0)
                                                > FRAME_CACHE_SIZE as u32 / 2;
                                        backwards || big_jump
                                    })
                                    .unwrap_or(true))
                        {
                            let timestamp_us =
                                ((requested_frame as f32 / frame_rate.numerator() as f32)
                                    * 1_000_000.0) as i64;
                            let position = timestamp_us.rescale((1, 1_000_000), rescale::TIME_BASE);

                            decoder.flush();
                            // Drop the old packets iterator to release the mutable borrow
                            drop(packets);
                            let seek_result = input.seek(position, ..position);
                            // Create new packets iterator regardless of seek result
                            packets = input.packets();

                            match seek_result {
                                Ok(_) => {
                                    cache.clear();
                                    last_decoded_frame = None;
                                }
                                Err(_) => {
                                    // If seek fails, we've likely reached the end
                                    reached_end = true;
                                    if let Some((_, last_frame)) = &last_sent_frame {
                                        sender.take().map(|s| s.send(Some(last_frame.clone())));
                                    }
                                    continue;
                                }
                            }
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
                                sender
                                    .take()
                                    .map(|s| s.send(last_sent_frame.clone().map(|f| f.1)));
                                break;
                            };

                            if stream.index() == input_stream_index {
                                let start_offset = stream.start_time();

                                decoder.send_packet(&packet).ok(); // decode failures are ok, we just fail to return a frame

                                let mut exit = false;

                                while decoder.receive_frame(&mut temp_frame).is_ok() {
                                    let current_frame = pts_to_frame(
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

                                    let frame = hw_frame.unwrap_or(std::mem::replace(
                                        &mut temp_frame,
                                        frame::Video::empty(),
                                    ));

                                    if !too_small_for_cache_bounds {
                                        let mut cache_frame = CachedFrame {
                                            data: CachedFrameData::Raw(frame),
                                        };

                                        if current_frame == requested_frame {
                                            if let Some(sender) = sender.take() {
                                                let data = cache_frame.process(
                                                    &mut scaler_input_format,
                                                    &mut scaler,
                                                    &decoder,
                                                );
                                                last_sent_frame =
                                                    Some((current_frame, data.clone()));
                                                sender.send(Some(data)).ok();
                                                break;
                                            }
                                        } else if current_frame
                                            > last_sent_frame.as_ref().map(|f| f.0).unwrap_or(0)
                                        {
                                            // Keep last_sent_frame up to date even for frames we're not sending
                                            let data = cache_frame.process(
                                                &mut scaler_input_format,
                                                &mut scaler,
                                                &decoder,
                                            );
                                            last_sent_frame = Some((current_frame, data));
                                        }

                                        if cache.len() >= FRAME_CACHE_SIZE {
                                            // When cache is full, remove old frames that are far from the requested frame
                                            let frames_to_remove: Vec<_> = cache
                                                .keys()
                                                .filter(|&&k| {
                                                    // Keep frames within a window of the requested frame
                                                    let distance = if k <= requested_frame {
                                                        requested_frame - k
                                                    } else {
                                                        k - requested_frame
                                                    };
                                                    // Remove frames that are more than half the cache size away
                                                    distance > FRAME_CACHE_SIZE as u32 / 2
                                                })
                                                .copied()
                                                .collect();

                                            for frame in frames_to_remove {
                                                println!("Removing old frame {} from cache (requested_frame: {})", frame, requested_frame);
                                                cache.remove(&frame);
                                            }

                                            // If we still need to remove frames, remove the ones furthest from the requested frame
                                            if cache.len() >= FRAME_CACHE_SIZE {
                                                let frame_to_remove = cache
                                                    .keys()
                                                    .max_by_key(|&&k| {
                                                        if k <= requested_frame {
                                                            requested_frame - k
                                                        } else {
                                                            k - requested_frame
                                                        }
                                                    })
                                                    .copied()
                                                    .unwrap();
                                                println!("Removing distant frame {} from cache (requested_frame: {})", frame_to_remove, requested_frame);
                                                cache.remove(&frame_to_remove);
                                            }
                                        }

                                        println!(
                                            "Inserting frame {} into cache (size: {})",
                                            current_frame,
                                            cache.len()
                                        );
                                        cache.insert(current_frame, cache_frame);
                                    }

                                    exit = exit || exceeds_cache_bounds;
                                }

                                if exit {
                                    break;
                                }
                            }
                        }

                        if let Some(s) = sender.take() {
                            s.send(None).ok();
                        }
                    }
                }
            }
        });

        AsyncVideoDecoderHandle {
            sender: tx,
            last_valid_frame: Arc::new(Mutex::new(None)),
            reached_end: Arc::new(Mutex::new(false)),
        }
    }
}

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
    last_valid_frame: Arc<Mutex<Option<DecodedFrame>>>,
    reached_end: Arc<Mutex<bool>>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, frame_number: u32) -> Option<DecodedFrame> {
        // If we've already reached the end of the video, just return the last valid frame
        if *self.reached_end.lock().unwrap() {
            return self.last_valid_frame.lock().unwrap().clone();
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(frame_number, tx))
            .ok()?;

        // Wait for response with a timeout
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(frame)) => {
                if let Some(frame) = &frame {
                    // Store this as the last valid frame
                    *self.last_valid_frame.lock().unwrap() = Some(frame.clone());
                } else {
                    // If we got no frame, we've reached the end
                    *self.reached_end.lock().unwrap() = true;
                }
                // If we got no frame but have a last valid frame, return that instead
                frame.or_else(|| self.last_valid_frame.lock().unwrap().clone())
            }
            _ => {
                // On timeout, return last valid frame if we have one
                self.last_valid_frame.lock().unwrap().clone()
            }
        }
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
