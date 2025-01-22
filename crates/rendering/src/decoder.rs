use std::{
    cell::LazyCell,
    collections::BTreeMap,
    path::PathBuf,
    sync::{mpsc, Arc},
};

use cidre::cv::pixel_buffer::LockFlags;
use ffmpeg::{
    codec::{self, Capabilities},
    format, frame, rescale, software, Codec, Rational, Rescale,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use ffmpeg_sys_next::{avcodec_find_decoder, AVHWDeviceType};

pub type DecodedFrame = Arc<Vec<u8>>;

pub enum VideoDecoderMessage {
    GetFrame(f32, tokio::sync::oneshot::Sender<DecodedFrame>),
}

fn pts_to_frame(pts: i64, time_base: Rational, fps: u32) -> u32 {
    (fps as f64 * ((pts as f64 * time_base.numerator() as f64) / (time_base.denominator() as f64)))
        .round() as u32
}

const FRAME_CACHE_SIZE: usize = 100;

#[derive(Clone)]
struct CachedFrame {
    data: CachedFrameData,
}

impl CachedFrame {
    fn process(&mut self, decoder: &codec::decoder::Video) -> Arc<Vec<u8>> {
        match &mut self.data {
            CachedFrameData::Raw(frame) => {
                let rgb_frame = if frame.format() != format::Pixel::RGBA {
                    // Reinitialize the scaler with the new input format
                    let mut scaler = software::converter(
                        (decoder.width(), decoder.height()),
                        frame.format(),
                        format::Pixel::RGBA,
                    )
                    .unwrap();

                    let mut rgb_frame = frame::Video::empty();
                    scaler.run(&frame, &mut rgb_frame).unwrap();
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

#[derive(Clone)]
pub struct AsyncVideoDecoderHandle {
    sender: mpsc::Sender<VideoDecoderMessage>,
}

impl AsyncVideoDecoderHandle {
    pub async fn get_frame(&self, time: f32) -> Option<DecodedFrame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .send(VideoDecoderMessage::GetFrame(time, tx))
            .unwrap();
        rx.await.ok()
    }
}

pub enum GetFrameError {
    Failed,
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

pub enum Decoder {
    Ffmpeg(FfmpegDecoder),
    #[cfg(target_os = "macos")]
    AVAssetReader(AVAssetReaderDecoder),
}

impl Decoder {
    pub fn spawn(name: &'static str, path: PathBuf, fps: u32) -> AsyncVideoDecoderHandle {
        let (tx, rx) = mpsc::channel();

        let handle = AsyncVideoDecoderHandle { sender: tx };

        #[cfg(target_os = "macos")]
        {
            AVAssetReaderDecoder::spawn(name, path, fps, rx);
        }

        #[cfg(not(target_os = "macos"))]
        {
            FfmpegDecoder::spawn(name, path, fps, rx);
        }

        handle
    }
}

struct FfmpegDecoder;

impl FfmpegDecoder {
    fn spawn(name: &'static str, path: PathBuf, fps: u32, rx: mpsc::Receiver<VideoDecoderMessage>) {
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
                #[cfg(target_os = "windows")]
                {
                    decoder
                        .try_use_hw_device(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA, Pixel::NV12)
                        .ok()
                }

                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                None
            };

            use ffmpeg::format::Pixel;

            let mut temp_frame = ffmpeg::frame::Video::empty();

            // let mut packets = input.packets().peekable();

            let width = decoder.width();
            let height = decoder.height();
            let black_frame = LazyCell::new((|| Arc::new(vec![0; (width * height * 4) as usize])));

            let mut cache = BTreeMap::<u32, CachedFrame>::new();
            // active frame is a frame that triggered decode.
            // frames that are within render_more_margin of this frame won't trigger decode.
            let mut last_active_frame = None::<u32>;

            let mut last_decoded_frame = None::<u32>;
            let mut last_sent_frame = None::<(u32, DecodedFrame)>;

            let mut peekable_requests = PeekableReceiver { rx, peeked: None };

            let mut packets = input.packets().peekable();

            while let Ok(r) = peekable_requests.recv() {
                match r {
                    VideoDecoderMessage::GetFrame(requested_time, sender) => {
                        let requested_frame = (requested_time * fps as f32).floor() as u32;
                        // sender.send(black_frame.clone()).ok();
                        // continue;

                        let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                            let data = cached.process(&decoder);

                            sender.send(data.clone()).ok();
                            last_sent_frame = Some((requested_frame, data));
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

                            decoder.flush();
                            input.seek(position, ..position).unwrap();
                            last_decoded_frame = None;

                            packets = input.packets().peekable();
                        }

                        last_active_frame = Some(requested_frame);

                        loop {
                            if peekable_requests.peek().is_some() {
                                break;
                            }
                            let Some((stream, packet)) = packets.next() else {
                                // handles the case where the cache doesn't contain a frame so we fallback to the previously sent one
                                if let Some(last_sent_frame) = &last_sent_frame {
                                    if last_sent_frame.0 < requested_frame {
                                        sender.take().map(|s| s.send(last_sent_frame.1.clone()));
                                    }
                                }

                                sender.take().map(|s| s.send(black_frame.clone()));
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
                                        fps,
                                    );

                                    // Handles frame skips. requested_frame == last_decoded_frame should be handled by the frame cache.
                                    if let Some((last_decoded_frame, sender)) = last_decoded_frame
                                        .filter(|last_decoded_frame| {
                                            requested_frame > *last_decoded_frame
                                                && requested_frame < current_frame
                                        })
                                        .and_then(|l| Some((l, sender.take()?)))
                                    {
                                        let data = cache
                                            .get_mut(&last_decoded_frame)
                                            .map(|f| f.process(&decoder))
                                            .unwrap_or_else(|| black_frame.clone());

                                        last_sent_frame = Some((last_decoded_frame, data.clone()));
                                        sender.send(data).ok();
                                    }

                                    last_decoded_frame = Some(current_frame);

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
                                                let data = cache_frame.process(&decoder);
                                                last_sent_frame =
                                                    Some((current_frame, data.clone()));
                                                sender.send(data).ok();

                                                break;
                                            }
                                        }

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

                                        cache.insert(current_frame, cache_frame);
                                    }

                                    exit = exit || exceeds_cache_bounds;
                                }

                                if exit {
                                    break;
                                }
                            }
                        }

                        if let Some((sender, last_sent_frame)) =
                            sender.take().zip(last_sent_frame.clone())
                        {
                            sender.send(last_sent_frame.1).ok();
                        }
                    }
                }
            }
        });
    }
}

use tokio::runtime::Handle as TokioHandle;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cidre::{arc::R, av, cm, cv, ns};
    use format::context::input::PacketIter;

    #[derive(Clone)]
    enum CachedFrame {
        Raw(R<cv::ImageBuf>),
        Processed(Arc<Vec<u8>>),
    }

    impl CachedFrame {
        fn process(&mut self) -> Arc<Vec<u8>> {
            match self {
                CachedFrame::Raw(image_buf) => {
                    let mut ffmpeg_frame = ffmpeg::frame::Video::new(
                        format::Pixel::NV12,
                        image_buf.width() as u32,
                        image_buf.height() as u32,
                    );

                    {
                        let _lock = image_buf.base_address_lock(LockFlags::READ_ONLY).unwrap();

                        for plane_i in 0..image_buf.plane_count() {
                            let bytes_per_row = image_buf.plane_bytes_per_row(plane_i);
                            let height = image_buf.plane_height(plane_i);

                            let ffmpeg_stride = ffmpeg_frame.stride(plane_i);
                            let row_length = bytes_per_row.min(ffmpeg_stride);

                            let slice = unsafe {
                                std::slice::from_raw_parts::<'static, _>(
                                    image_buf.plane_base_address(plane_i),
                                    bytes_per_row * height,
                                )
                            };

                            for i in 0..height {
                                ffmpeg_frame.data_mut(plane_i)
                                    [i * ffmpeg_stride..(i * ffmpeg_stride + row_length)]
                                    .copy_from_slice(
                                        &slice[i * bytes_per_row..(i * bytes_per_row + row_length)],
                                    )
                            }
                        }
                    }

                    let mut converter = ffmpeg::software::converter(
                        (ffmpeg_frame.width(), ffmpeg_frame.height()),
                        ffmpeg_frame.format(),
                        format::Pixel::RGBA,
                    )
                    .unwrap();

                    let mut rgb_frame = frame::Video::empty();
                    converter.run(&ffmpeg_frame, &mut rgb_frame).unwrap();

                    let data = Arc::new(rgb_frame.data(0).to_vec());

                    *self = Self::Processed(data.clone());

                    data
                }
                CachedFrame::Processed(data) => data.clone(),
            }
        }
    }

    pub struct AVAssetReaderDecoder;

    impl AVAssetReaderDecoder {
        pub fn spawn(
            name: &'static str,
            path: PathBuf,
            fps: u32,
            rx: mpsc::Receiver<VideoDecoderMessage>,
        ) {
            let handle = tokio::runtime::Handle::current();

            std::thread::spawn(move || {
                let pixel_format = {
                    let input = ffmpeg::format::input(&path).unwrap();

                    let input_stream = input
                        .streams()
                        .best(ffmpeg::media::Type::Video)
                        .ok_or("Could not find a video stream")
                        .unwrap();

                    let decoder_codec =
                        ff_find_decoder(&input, &input_stream, input_stream.parameters().id())
                            .unwrap();

                    let mut context = codec::context::Context::new_with_codec(decoder_codec);
                    context.set_parameters(input_stream.parameters()).unwrap();

                    pixel_to_pixel_format(context.decoder().video().unwrap().format())
                };

                dbg!(pixel_format);

                let asset = av::UrlAsset::with_url(
                    &ns::Url::with_fs_path_str(path.to_str().unwrap(), false),
                    None,
                )
                .unwrap();

                fn get_reader_track_output(
                    asset: &av::UrlAsset,
                    time: f32,
                    handle: &TokioHandle,
                    pixel_format: cv::PixelFormat,
                ) -> R<av::AssetReaderTrackOutput> {
                    let mut reader = av::AssetReader::with_asset(&asset).unwrap();

                    let time_range = cm::TimeRange {
                        start: cm::Time::with_secs(time as f64, 100),
                        duration: asset.duration(),
                    };

                    reader.set_time_range(time_range);

                    let tracks = handle
                        .block_on(asset.load_tracks_with_media_type(av::MediaType::video()))
                        .unwrap();

                    let track = tracks.get(0).unwrap();

                    let mut reader_track_output = av::AssetReaderTrackOutput::with_track(
                        &track,
                        Some(&ns::Dictionary::with_keys_values(
                            &[cv::pixel_buffer::keys::pixel_format().as_ns()],
                            &[pixel_format.to_cf_number().as_ns().as_id_ref()],
                        )),
                    )
                    .unwrap();

                    reader_track_output.set_always_copies_sample_data(false);

                    reader.add_output(&reader_track_output).unwrap();

                    reader.start_reading().ok();

                    reader_track_output
                }

                let mut track_output = get_reader_track_output(&asset, 0.0, &handle, pixel_format);

                let mut cache = BTreeMap::<u32, CachedFrame>::new();

                let mut last_active_frame = None::<u32>;

                let mut last_decoded_frame = None::<u32>;
                let mut last_sent_frame = None::<(u32, DecodedFrame)>;

                while let Ok(r) = rx.recv() {
                    match r {
                        VideoDecoderMessage::GetFrame(requested_time, sender) => {
                            let requested_frame = (requested_time * fps as f32).floor() as u32;

                            let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                                let data = cached.process();

                                sender.send(data.clone()).ok();
                                last_sent_frame = Some((requested_frame, data));
                                continue;
                            } else {
                                Some(sender)
                            };

                            let cache_min =
                                requested_frame.saturating_sub(FRAME_CACHE_SIZE as u32 / 2);
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
                                track_output = get_reader_track_output(
                                    &asset,
                                    requested_time,
                                    &handle,
                                    pixel_format,
                                );
                                last_decoded_frame = None;
                            }

                            last_active_frame = Some(requested_frame);

                            fn get_next_rgba_frame(
                                name: &'static str,
                                track_output: &mut R<av::AssetReaderTrackOutput>,
                                fps: u32,
                            ) -> Option<(u32, CachedFrame)> {
                                let sample_buf = track_output.next_sample_buf().unwrap()?;

                                let current_frame = pts_to_frame(
                                    sample_buf.pts().value,
                                    Rational::new(1, sample_buf.pts().scale),
                                    fps,
                                );

                                let image_buf = sample_buf.image_buf()?;

                                Some((current_frame, CachedFrame::Raw(image_buf.retained())))
                            }

                            let mut exit = false;

                            while let Some((current_frame, mut cache_frame)) =
                                get_next_rgba_frame(name, &mut track_output, fps)
                            {
                                last_decoded_frame = Some(current_frame);

                                let exceeds_cache_bounds = current_frame > cache_max;
                                let too_small_for_cache_bounds = current_frame < cache_min;

                                if !too_small_for_cache_bounds {
                                    if current_frame == requested_frame {
                                        if let Some(sender) = sender.take() {
                                            let data = cache_frame.process();
                                            last_sent_frame = Some((current_frame, data.clone()));
                                            sender.send(data).ok();

                                            break;
                                        }
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

                                    cache.insert(current_frame, cache_frame.clone());
                                }

                                if current_frame > requested_frame && sender.is_some() {
                                    if let Some((sender, last_sent_frame)) = last_sent_frame
                                        .as_ref()
                                        .and_then(|l| Some((sender.take()?, l)))
                                    {
                                        sender.send(last_sent_frame.1.clone()).ok();
                                    } else if let Some(sender) = sender.take() {
                                        sender.send(cache_frame.process()).ok();
                                    }
                                }

                                exit = exit || exceeds_cache_bounds;

                                if exit {
                                    break;
                                }
                            }

                            if let Some((sender, last_sent_frame)) =
                                sender.take().zip(last_sent_frame.as_ref())
                            {
                                sender.send(last_sent_frame.1.clone()).ok();
                            }
                        }
                    }
                }

                println!("Decoder thread ended");
            });
        }
    }

    fn pixel_to_pixel_format(pixel: format::Pixel) -> cv::PixelFormat {
        match pixel {
            format::Pixel::NV12 => cv::PixelFormat::_420V,
            format::Pixel::YUV420P => cv::PixelFormat::_420_YP_CB_CR_8_PLANAR_FULL_RANGE,
            format::Pixel::RGBA => cv::PixelFormat::_32_RGBA,
            _ => todo!(),
        }
    }

    fn pixel_format_to_pixel(format: cv::PixelFormat) -> format::Pixel {
        match format {
            cv::PixelFormat::_420V => format::Pixel::NV12,
            cv::PixelFormat::_420_YP_CB_CR_8_PLANAR_FULL_RANGE => format::Pixel::YUV420P,
            cv::PixelFormat::_32_RGBA => format::Pixel::RGBA,
            _ => todo!(),
        }
    }
}

#[cfg(target_os = "macos")]
use macos::*;
