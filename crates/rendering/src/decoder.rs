use std::{
    cell::Cell,
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    ptr::{null, null_mut},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

use ffmpeg::{
    codec,
    format::{self, context::input::PacketIter, Pixel},
    frame::{self, Video},
    rescale, Codec, Packet, Rational, Rescale, Stream,
};
use ffmpeg_sys_next::{
    av_buffer_ref, av_buffer_unref, av_hwdevice_ctx_create, av_hwframe_transfer_data,
    avcodec_find_decoder, avcodec_get_hw_config, AVBufferRef, AVCodecContext, AVHWDeviceType,
    AVPixelFormat, AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX,
};

const FRAME_CACHE_SIZE: usize = 50;
const MAX_CACHE_MEMORY: usize = 1024 * 1024 * 1024; // 1 GB max cache size
const CACHE_CLEANUP_INTERVAL: Duration = Duration::from_secs(60); // Clean up every 60 seconds

pub type DecodedFrame = Arc<Vec<u8>>;

enum VideoDecoderMessage {
    GetFrame(u32, tokio::sync::oneshot::Sender<Option<DecodedFrame>>),
}

#[derive(Clone)]
struct CachedFrame {
    frame_number: u32,
    frame: DecodedFrame,
    last_accessed: Instant,
}

fn ts_to_frame(ts: i64, time_base: Rational, frame_rate: Rational) -> u32 {
    ((ts * time_base.numerator() as i64 * frame_rate.numerator() as i64)
        / (time_base.denominator() as i64 * frame_rate.denominator() as i64)) as u32
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

            let hw_device: Option<HwDevice> = {
                #[cfg(target_os = "macos")]
                {
                    context
                        .try_use_hw_device(
                            AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
                            Pixel::NV12,
                        )
                        .ok()
                }

                #[cfg(not(target_os = "macos"))]
                None
            };

            let input_stream_index = input_stream.index();
            let time_base = input_stream.time_base();
            let frame_rate = input_stream.rate();

            let mut decoder = context.decoder().video().unwrap();

            let mut scaler_input_format = hw_device
                .as_ref()
                .map(|d| d.pix_fmt)
                .unwrap_or(decoder.format());

            let mut scaler = ffmpeg::software::scaling::context::Context::get(
                scaler_input_format,
                decoder.width(),
                decoder.height(),
                Pixel::RGBA,
                decoder.width(),
                decoder.height(),
                ffmpeg::software::scaling::flag::Flags::BILINEAR,
            )
            .unwrap();

            let mut temp_frame = ffmpeg::frame::Video::empty();
            let mut cache = VecDeque::new();
            let mut cache_size = 0;
            let mut last_cleanup = Instant::now();
            let mut last_decoded_frame = None::<u32>;

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };
            let mut packets = input.packets();

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(frame_number, sender) => {
                        let mut frame_to_send: Option<DecodedFrame> = None;

                        if let Some(index) = cache.iter().position(|f: &CachedFrame| f.frame_number == frame_number) {
                            let mut cached = cache.remove(index).unwrap();
                            cached.last_accessed = Instant::now();
                            cache.push_front(cached.clone());
                            frame_to_send = Some(cached.frame.clone());
                        } else {
                            if frame_number <= 0
                                || last_decoded_frame
                                    .map(|f| frame_number < f || frame_number - f > FRAME_CACHE_SIZE as u32)
                                    .unwrap_or(true)
                            {
                                let timestamp_us = ((frame_number as f32 / frame_rate.numerator() as f32)
                                    * 1_000_000.0) as i64;
                                let position = timestamp_us.rescale((1, 1_000_000), rescale::TIME_BASE);

                                decoder.flush();
                                input.seek(position, ..position).unwrap();
                                cache.clear();
                                cache_size = 0;
                                last_decoded_frame = None;
                                packets = input.packets();
                            }

                            'packet_loop: loop {
                                if peekable_requests.peek().is_some() {
                                    break;
                                }
                                let Some((stream, packet)) = packets.next() else {
                                    break;
                                };

                                if stream.index() == input_stream_index {
                                    decoder.send_packet(&packet).ok();

                                    while decoder.receive_frame(&mut temp_frame).is_ok() {
                                        let current_frame = ts_to_frame(
                                            temp_frame.pts().unwrap(),
                                            time_base,
                                            frame_rate,
                                        );
                                        last_decoded_frame = Some(current_frame);

                                        let hw_frame = hw_device.as_ref().and_then(|d| d.get_hwframe(&temp_frame));
                                        let frame = hw_frame.as_ref().unwrap_or(&temp_frame);

                                        if frame.format() != scaler_input_format {
                                            scaler_input_format = frame.format();
                                            scaler = ffmpeg::software::scaling::context::Context::get(
                                                scaler_input_format,
                                                decoder.width(),
                                                decoder.height(),
                                                Pixel::RGBA,
                                                decoder.width(),
                                                decoder.height(),
                                                ffmpeg::software::scaling::flag::Flags::BILINEAR,
                                            )
                                            .unwrap();
                                        }

                                        let mut rgb_frame = frame::Video::empty();
                                        scaler.run(frame, &mut rgb_frame).unwrap();

                                        let width = rgb_frame.width() as usize;
                                        let height = rgb_frame.height() as usize;
                                        let stride = rgb_frame.stride(0);
                                        let data = rgb_frame.data(0);

                                        let mut frame_buffer = Vec::with_capacity(width * height * 4);
                                        for line_data in data.chunks_exact(stride) {
                                            frame_buffer.extend_from_slice(&line_data[0..width * 4]);
                                        }

                                        let frame_size = frame_buffer.len();
                                        let new_frame = Arc::new(frame_buffer);

                                        if current_frame == frame_number && frame_to_send.is_none() {
                                            frame_to_send = Some(new_frame.clone());
                                        }

                                        cache.push_front(CachedFrame {
                                            frame_number: current_frame,
                                            frame: new_frame,
                                            last_accessed: Instant::now(),
                                        });
                                        cache_size += frame_size;

                                        Self::cleanup_cache(&mut cache, &mut cache_size);

                                        if frame_to_send.is_some() {
                                            break 'packet_loop;
                                        }
                                    }
                                }
                            }
                        }

                        // Send the frame outside of all loops
                        sender.send(frame_to_send).ok();

                        if last_cleanup.elapsed() > CACHE_CLEANUP_INTERVAL {
                            Self::aggressive_cleanup(&mut cache, &mut cache_size);
                            last_cleanup = Instant::now();
                        }
                    }
                }
            }
        });

        AsyncVideoDecoderHandle { sender: tx }
    }

    fn cleanup_cache(cache: &mut VecDeque<CachedFrame>, cache_size: &mut usize) {
        while *cache_size > MAX_CACHE_MEMORY || cache.len() > FRAME_CACHE_SIZE {
            if let Some(old_frame) = cache.pop_back() {
                *cache_size -= old_frame.frame.len();
            } else {
                break;
            }
        }
    }

    fn aggressive_cleanup(cache: &mut VecDeque<CachedFrame>, cache_size: &mut usize) {
        let now = Instant::now();
        cache.retain(|frame| {
            let keep = now.duration_since(frame.last_accessed) < Duration::from_secs(300); // 5 minutes
            if !keep {
                *cache_size -= frame.frame.len();
            }
            keep
        });
    }
}

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, frame_number: u32) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(frame_number, tx))
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

thread_local! {
    static HW_PIX_FMT: Cell<AVPixelFormat> = const { Cell::new(AVPixelFormat::AV_PIX_FMT_NONE) };
}

unsafe extern "C" fn get_format(
    _: *mut AVCodecContext,
    pix_fmts: *const AVPixelFormat,
) -> AVPixelFormat {
    let mut fmt = pix_fmts;

    loop {
        if *fmt == AVPixelFormat::AV_PIX_FMT_NONE {
            break;
        }

        if *fmt == HW_PIX_FMT.get() {
            return *fmt;
        }

        fmt = fmt.offset(1);
    }

    AVPixelFormat::AV_PIX_FMT_NONE
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

struct HwDevice {
    pub device_type: AVHWDeviceType,
    pub pix_fmt: Pixel,
    ctx: *mut AVBufferRef,
}

impl HwDevice {
    pub fn get_hwframe(&self, src: &Video) -> Option<Video> {
        unsafe {
            if src.format() == HW_PIX_FMT.get().into() {
                let mut sw_frame = frame::Video::empty();

                if av_hwframe_transfer_data(sw_frame.as_mut_ptr(), src.as_ptr(), 0) >= 0 {
                    return Some(sw_frame);
                };
            }
        }

        None
    }
}

impl Drop for HwDevice {
    fn drop(&mut self) {
        unsafe {
            av_buffer_unref(&mut self.ctx);
        }
    }
}

trait CodecContextExt {
    fn try_use_hw_device(
        &mut self,
        device_type: AVHWDeviceType,
        pix_fmt: Pixel,
    ) -> Result<HwDevice, &'static str>;
}

impl CodecContextExt for codec::context::Context {
    fn try_use_hw_device(
        &mut self,
        device_type: AVHWDeviceType,
        pix_fmt: Pixel,
    ) -> Result<HwDevice, &'static str> {
        let codec = self.codec().ok_or("no codec")?;

        unsafe {
            let mut i = 0;
            loop {
                let config = avcodec_get_hw_config(codec.as_ptr(), i);
                if config.is_null() {
                    return Err("no hw config");
                }

                if (*config).methods & (AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX as i32) == 1
                    && (*config).device_type == AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX
                {
                    HW_PIX_FMT.set((*config).pix_fmt);
                    break;
                }

                i += 1;
            }

            let context = self.as_mut_ptr();

            (*context).get_format = Some(get_format);

            let mut hw_device_ctx = null_mut();

            if av_hwdevice_ctx_create(&mut hw_device_ctx, device_type, null(), null_mut(), 0) < 0 {
                return Err("failed to create hw device context");
            }

            (*context).hw_device_ctx = av_buffer_ref(hw_device_ctx);

            Ok(HwDevice {
                device_type,
                ctx: hw_device_ctx,
                pix_fmt,
            })
        }
    }
}