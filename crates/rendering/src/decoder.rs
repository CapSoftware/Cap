use std::{
    collections::{HashMap, VecDeque},
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
use ffmpeg_hw_device::CodecContextExt;
use ffmpeg_sys_next::{
    av_buffer_unref, av_hwdevice_ctx_alloc, av_hwdevice_ctx_init, av_hwframe_transfer_data,
    avcodec_find_decoder, AVHWDeviceType,
};
use log;

// Trait for hardware frame operations
trait HwFrameExt {
    fn has_hw_context(&self) -> bool;
    fn transfer_to_cpu(&self, output: &mut frame::Video) -> Result<(), ffmpeg::Error>;
}

impl HwFrameExt for frame::Video {
    fn has_hw_context(&self) -> bool {
        unsafe { (*self.as_ptr()).hw_frames_ctx.is_null() == false }
    }

    fn transfer_to_cpu(&self, output: &mut frame::Video) -> Result<(), ffmpeg::Error> {
        let ret = unsafe { av_hwframe_transfer_data(output.as_mut_ptr(), self.as_ptr(), 0) };
        if ret < 0 {
            Err(ffmpeg::Error::from(ret))
        } else {
            Ok(())
        }
    }
}

pub type DecodedFrame = Arc<Vec<u8>>;

enum VideoDecoderMessage {
    GetFrame(u32, tokio::sync::oneshot::Sender<Option<Arc<Vec<u8>>>>),
}

fn pts_to_frame(pts: i64, time_base: Rational) -> u32 {
    (FPS as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

const FRAME_CACHE_SIZE: usize = 100;
const FPS: u32 = 30;

pub struct FrameCache {
    capacity: usize,
    frames: HashMap<u32, CachedFrame>,
    usage_order: VecDeque<u32>,
}

impl FrameCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            frames: HashMap::new(),
            usage_order: VecDeque::new(),
        }
    }

    pub fn get(&mut self, key: u32) -> Option<&mut CachedFrame> {
        if self.frames.contains_key(&key) {
            self.refresh_usage(key);
            return self.frames.get_mut(&key);
        }
        None
    }

    pub fn insert(&mut self, key: u32, cached_frame: CachedFrame) {
        if self.frames.contains_key(&key) {
            self.frames.insert(key, cached_frame);
            self.refresh_usage(key);
        } else {
            if self.frames.len() >= self.capacity {
                if let Some(oldest) = self.usage_order.pop_front() {
                    self.frames.remove(&oldest);
                }
            }
            self.frames.insert(key, cached_frame);
            self.usage_order.push_back(key);
        }
    }

    fn refresh_usage(&mut self, key: u32) {
        if let Some(pos) = self.usage_order.iter().position(|x| *x == key) {
            self.usage_order.remove(pos);
        }
        self.usage_order.push_back(key);
    }
}

#[derive(Clone)]
struct CachedFrame {
    data: CachedFrameData,
}

impl CachedFrame {
    fn process(
        &mut self,
        scaler_input_format: &mut format::Pixel,
        scaler_ctx: &mut ScalerContext,
        decoder: &codec::decoder::Video,
    ) -> Arc<Vec<u8>> {
        match &mut self.data {
            CachedFrameData::Processed(data) => {
                // Already have RGBA data, return it immediately
                return data.clone();
            }
            CachedFrameData::Raw(frame) => {
                let width = frame.width();
                let height = frame.height();

                // Check if dimensions changed and update scalers if needed
                scaler_ctx.check_dimensions(width, height);

                // Handle hardware frames by transferring to CPU memory if needed
                let frame = if frame.has_hw_context() {
                    let mut sw_frame = frame::Video::new(format::Pixel::YUV420P, width, height);
                    if let Err(e) = frame.transfer_to_cpu(&mut sw_frame) {
                        log::error!("Failed to transfer hardware frame to CPU: {:?}", e);
                        panic!("Failed to transfer hardware frame to CPU memory");
                    }
                    sw_frame
                } else {
                    frame.clone()
                };

                // Now handle software format conversion if needed
                let frame = if frame.format() != format::Pixel::YUV420P {
                    log::debug!(
                        "Converting from {:?} to YUV420P as intermediate format",
                        frame.format()
                    );

                    let mut yuv_frame = frame::Video::new(format::Pixel::YUV420P, width, height);
                    scaler_ctx.ensure_yuv_scaler(frame.format());

                    if let Some(yuv_scaler) = &mut scaler_ctx.yuv_scaler {
                        if let Err(e) = yuv_scaler.run(&frame, &mut yuv_frame) {
                            log::error!(
                                "Failed to convert to YUV420P: {:?} (from format: {:?})",
                                e,
                                frame.format()
                            );
                            panic!("Failed to convert to intermediate format");
                        }
                    }
                    yuv_frame
                } else {
                    frame
                };

                *scaler_input_format = format::Pixel::YUV420P;

                // Create output frame
                let mut rgb_frame = frame::Video::new(format::Pixel::RGBA, width, height);

                // Convert to RGBA with retry on failure
                let mut conversion_successful = false;
                for _ in 0..3 {
                    match scaler_ctx.rgba_scaler.run(&frame, &mut rgb_frame) {
                        Ok(_) => {
                            conversion_successful = true;
                            break;
                        }
                        Err(e) => {
                            log::warn!(
                                "Failed to convert to RGBA, retrying with new scaler: {:?}",
                                e
                            );
                            scaler_ctx.rgba_scaler = create_scaler(
                                format::Pixel::YUV420P,
                                width,
                                height,
                                format::Pixel::RGBA,
                            );
                        }
                    }
                }

                if !conversion_successful {
                    panic!("Failed to convert frame to RGBA after multiple attempts");
                }

                // Convert to bytes and store in Arc<Vec<u8>>
                let size = (width as usize) * (height as usize) * 4;
                let mut rgb_data = Vec::with_capacity(size);
                rgb_data.extend_from_slice(rgb_frame.data(0));
                let rgb_data = Arc::new(rgb_data);

                // Store the processed RGBA data for future use
                self.data = CachedFrameData::Processed(rgb_data.clone());

                rgb_data
            }
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
            let _frame_rate = input_stream.rate();

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

            // Try to enable hardware acceleration on macOS
            #[cfg(target_os = "macos")]
            {
                // First try NV12 as it's commonly supported by VideoToolbox
                let formats = [format::Pixel::NV12, format::Pixel::YUV420P];

                for &fmt in &formats {
                    unsafe {
                        let mut hw_device_ptr =
                            av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX);
                        if !hw_device_ptr.is_null() && av_hwdevice_ctx_init(hw_device_ptr) >= 0 {
                            (*decoder.as_mut_ptr()).hw_device_ctx = hw_device_ptr;
                            (*decoder.as_mut_ptr()).sw_pix_fmt = fmt.into();
                            (*decoder.as_mut_ptr()).get_format = Some(get_hw_format);
                            log::info!("Successfully enabled VideoToolbox hardware acceleration with format {:?}", fmt);
                            break;
                        }
                        if !hw_device_ptr.is_null() {
                            av_buffer_unref(&mut hw_device_ptr);
                        }
                    }
                }
            }

            use ffmpeg::format::Pixel;
            use ffmpeg::software::scaling::{context::Context, flag::Flags};

            // Set initial scaler format based on hardware acceleration
            let mut scaler_input_format = format::Pixel::YUV420P;
            let mut scaler_ctx = ScalerContext::new(decoder.width(), decoder.height());

            let mut temp_frame = ffmpeg::frame::Video::empty();
            let mut frame_cache = FrameCache::new(FRAME_CACHE_SIZE);
            let mut last_sent_frame = None::<(u32, DecodedFrame)>;
            let mut reached_end = false;

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };
            let mut packets = input.packets();

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_frame, sender) => {
                        if reached_end {
                            if let Some((_, last_frame)) = &last_sent_frame {
                                sender.send(Some(last_frame.clone())).ok();
                                continue;
                            }
                        }

                        if let Some(cached) = frame_cache.get(requested_frame) {
                            let data =
                                cached.process(&mut scaler_input_format, &mut scaler_ctx, &decoder);
                            sender.send(Some(data.clone())).ok();
                            last_sent_frame = Some((requested_frame, data));
                            continue;
                        }

                        let mut sender = Some(sender);

                        'packet_loop: while let Some((stream, packet)) = packets.next() {
                            if stream.index() != input_stream_index {
                                continue;
                            }

                            decoder.send_packet(&packet).unwrap();

                            while decoder.receive_frame(&mut temp_frame).is_ok() {
                                let frame_number =
                                    pts_to_frame(temp_frame.pts().unwrap(), time_base);
                                let cached_frame = CachedFrame {
                                    data: CachedFrameData::Raw(temp_frame.clone()),
                                };

                                frame_cache.insert(frame_number, cached_frame);

                                if frame_number == requested_frame {
                                    if let Some(cached) = frame_cache.get(requested_frame) {
                                        let data = cached.process(
                                            &mut scaler_input_format,
                                            &mut scaler_ctx,
                                            &decoder,
                                        );
                                        if let Some(s) = sender.take() {
                                            s.send(Some(data.clone())).ok();
                                        }
                                        last_sent_frame = Some((requested_frame, data));
                                        break 'packet_loop;
                                    }
                                }
                            }
                        }

                        if sender.is_some() {
                            reached_end = true;
                            if let Some(s) = sender.take() {
                                if let Some((_, last_frame)) = &last_sent_frame {
                                    s.send(Some(last_frame.clone())).ok();
                                } else {
                                    s.send(None).ok();
                                }
                            }
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

fn create_scaler(
    input_format: format::Pixel,
    width: u32,
    height: u32,
    output_format: format::Pixel,
) -> scaling::Context {
    // Try different input/output format combinations in order of preference
    let format_combinations = [
        (input_format, output_format),
        (format::Pixel::YUV420P, output_format),
        (format::Pixel::YUV420P, format::Pixel::RGBA),
        (format::Pixel::YUV420P, format::Pixel::RGB24),
        (format::Pixel::YUV420P, format::Pixel::BGR24),
    ];

    // Try different scaling flags in order of quality/performance
    let scaling_flags = [
        scaling::Flags::BILINEAR,
        scaling::Flags::BICUBIC,
        scaling::Flags::POINT,
        scaling::Flags::FAST_BILINEAR,
        scaling::Flags::AREA,
    ];

    for (in_fmt, out_fmt) in format_combinations.iter() {
        for flags in scaling_flags.iter() {
            match scaling::Context::get(*in_fmt, width, height, *out_fmt, width, height, *flags) {
                Ok(context) => {
                    log::info!(
                        "Created scaler: {:?} -> {:?} with flags {:?}",
                        in_fmt,
                        out_fmt,
                        flags
                    );
                    return context;
                }
                Err(e) => {
                    log::debug!(
                        "Failed to create scaler: {:?} -> {:?} with flags {:?}: {:?}",
                        in_fmt,
                        out_fmt,
                        flags,
                        e
                    );
                    continue;
                }
            }
        }
    }

    // Last resort: try with absolute minimal settings
    match scaling::Context::get(
        format::Pixel::YUV420P,
        width,
        height,
        format::Pixel::RGB24,
        width,
        height,
        scaling::Flags::POINT,
    ) {
        Ok(context) => {
            log::warn!("Using fallback RGB24 scaler with minimal settings");
            context
        }
        Err(e) => {
            log::error!("All scaler creation attempts failed. Last error: {:?}", e);
            panic!("Could not create scaler with any configuration");
        }
    }
}

unsafe extern "C" fn get_hw_format(
    ctx: *mut ffmpeg_sys_next::AVCodecContext,
    _pix_fmts: *const ffmpeg_sys_next::AVPixelFormat,
) -> ffmpeg_sys_next::AVPixelFormat {
    (*ctx).sw_pix_fmt
}

struct ScalerContext {
    yuv_scaler: Option<scaling::Context>,
    rgba_scaler: scaling::Context,
    width: u32,
    height: u32,
}

impl ScalerContext {
    fn new(width: u32, height: u32) -> Self {
        let rgba_scaler = create_scaler(format::Pixel::YUV420P, width, height, format::Pixel::RGBA);

        Self {
            yuv_scaler: None,
            rgba_scaler,
            width,
            height,
        }
    }

    fn ensure_yuv_scaler(&mut self, input_format: format::Pixel) {
        if input_format != format::Pixel::YUV420P {
            self.yuv_scaler = Some(create_scaler(
                input_format,
                self.width,
                self.height,
                format::Pixel::YUV420P,
            ));
        }
    }

    fn check_dimensions(&mut self, width: u32, height: u32) -> bool {
        if width != self.width || height != self.height {
            self.width = width;
            self.height = height;
            self.rgba_scaler =
                create_scaler(format::Pixel::YUV420P, width, height, format::Pixel::RGBA);
            self.yuv_scaler = None;
            true
        } else {
            false
        }
    }
}
