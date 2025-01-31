use std::{
    cell::LazyCell,
    collections::BTreeMap,
    path::PathBuf,
    sync::{mpsc, Arc},
};

use cidre::{
    arc::R,
    av, cm,
    cv::{self, pixel_buffer::LockFlags},
    ns,
};
use ffmpeg::{codec, format, frame, Rational};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use super::{pts_to_frame, DecodedFrame, VideoDecoderMessage, FRAME_CACHE_SIZE};

#[derive(Clone)]
enum CachedFrame {
    Raw(R<cv::ImageBuf>),
    Processed(Arc<Vec<u8>>),
}

impl CachedFrame {
    fn process(&mut self) -> Arc<Vec<u8>> {
        match self {
            CachedFrame::Raw(image_buf) => {
                let format = pixel_format_to_pixel(image_buf.pixel_format());

                let data = if matches!(format, format::Pixel::RGBA) {
                    let _lock = image_buf.base_address_lock(LockFlags::READ_ONLY).unwrap();

                    let bytes_per_row = image_buf.plane_bytes_per_row(0);
                    let width = image_buf.width() as usize;
                    let height = image_buf.height();

                    let slice = unsafe {
                        std::slice::from_raw_parts::<'static, _>(
                            image_buf.plane_base_address(0),
                            bytes_per_row * height,
                        )
                    };

                    let mut bytes = Vec::with_capacity(width * height * 4);

                    let row_length = width * 4;

                    for i in 0..height {
                        bytes.as_mut_slice()[i * row_length..((i + 1) * row_length)]
                            .copy_from_slice(
                                &slice[i * bytes_per_row..(i * bytes_per_row + row_length)],
                            )
                    }

                    bytes
                } else {
                    let mut ffmpeg_frame = ffmpeg::frame::Video::new(
                        format,
                        image_buf.width() as u32,
                        image_buf.height() as u32,
                    );

                    match ffmpeg_frame.format() {
                        format::Pixel::NV12 => {
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
                                            &slice[i * bytes_per_row
                                                ..(i * bytes_per_row + row_length)],
                                        )
                                }
                            }
                        }
                        format::Pixel::YUV420P => {
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
                                            &slice[i * bytes_per_row
                                                ..(i * bytes_per_row + row_length)],
                                        )
                                }
                            }
                        }
                        format => todo!("implement {:?}", format),
                    }

                    let mut converter = ffmpeg::software::converter(
                        (ffmpeg_frame.width(), ffmpeg_frame.height()),
                        ffmpeg_frame.format(),
                        format::Pixel::RGBA,
                    )
                    .unwrap();

                    let mut rgb_frame = frame::Video::empty();
                    converter.run(&ffmpeg_frame, &mut rgb_frame).unwrap();

                    let slice = rgb_frame.data(0);
                    let width = rgb_frame.width();
                    let height = rgb_frame.height();
                    let bytes_per_row = rgb_frame.stride(0);
                    let row_length = width * 4;

                    let mut bytes = vec![0; (width * height * 4) as usize];

                    // TODO: allow for decoded frames to have stride, handle stride in shaders
                    for i in 0..height as usize {
                        bytes.as_mut_slice()[i * row_length as usize..(i + 1) * row_length as usize]
                            .copy_from_slice(
                                &slice
                                    [(i * bytes_per_row)..i * bytes_per_row + row_length as usize],
                            )
                    }

                    bytes
                };

                let data = Arc::new(data);

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
        ready_tx: oneshot::Sender<Result<(), String>>,
    ) {
        let handle = tokio::runtime::Handle::current();

        let handle = std::thread::spawn(move || {
            let init = || {
                let (pixel_format, width, height) = {
                    let input = ffmpeg::format::input(&path).unwrap();

                    let input_stream = input
                        .streams()
                        .best(ffmpeg::media::Type::Video)
                        .ok_or("Could not find a video stream")
                        .unwrap();

                    let decoder_codec = super::ffmpeg::find_decoder(
                        &input,
                        &input_stream,
                        input_stream.parameters().id(),
                    )
                    .unwrap();

                    let mut context = codec::context::Context::new_with_codec(decoder_codec);
                    context.set_parameters(input_stream.parameters()).unwrap();

                    let decoder = context.decoder().video().unwrap();
                    (
                        pixel_to_pixel_format(decoder.format()),
                        decoder.width(),
                        decoder.height(),
                    )
                };

                let asset = av::UrlAsset::with_url(
                    &ns::Url::with_fs_path_str(path.to_str().unwrap(), false),
                    None,
                )
                .ok_or_else(|| format!("UrlAsset::with_url{{{path:?}}}"))?;

                Ok((
                    get_reader_track_output(&asset, 0.0, &handle, pixel_format)?,
                    width,
                    height,
                    asset,
                    pixel_format,
                ))
            };

            let (mut track_output, width, height, asset, pixel_format) = match init() {
                Ok(v) => {
                    ready_tx.send(Ok(())).ok();
                    v
                }
                Err(e) => {
                    ready_tx.send(Err(e)).ok();
                    return;
                }
            };

            // let black_frame = LazyCell::new(|| Arc::new(vec![0; (width * height * 4) as usize]));

            let mut cache = BTreeMap::<u32, CachedFrame>::new();

            let mut last_active_frame = None::<u32>;

            let mut last_decoded_frame = None::<(u32, CachedFrame)>;
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
                            track_output = get_reader_track_output(
                                &asset,
                                requested_time,
                                &handle,
                                pixel_format,
                            )
                            .unwrap();
                            last_decoded_frame = None;
                        }

                        last_active_frame = Some(requested_frame);

                        let mut exit = false;

                        while let Some((current_frame, mut cache_frame)) = track_output
                            .next_sample_buf()
                            .unwrap()
                            .and_then(|sample_buf| {
                                let current_frame = pts_to_frame(
                                    sample_buf.pts().value,
                                    Rational::new(1, sample_buf.pts().scale),
                                    fps,
                                );

                                let image_buf = sample_buf.image_buf()?;

                                Some((current_frame, CachedFrame::Raw(image_buf.retained())))
                            })
                        {
                            // Handles frame skips. requested_frame == last_decoded_frame should be handled by the frame cache.
                            if let Some((last_decoded_frame, sender)) = last_decoded_frame
                                .as_mut()
                                .filter(|(last_decoded_frame_i, _)| {
                                    requested_frame > *last_decoded_frame_i
                                        && requested_frame < current_frame
                                })
                                .and_then(|l| Some((l, sender.take()?)))
                            {
                                let (frame_number, frame) = last_decoded_frame;

                                let data = frame.process();
                                last_sent_frame = Some((*frame_number, data.clone()));
                                sender.send(data).ok();
                            }

                            last_decoded_frame = Some((current_frame, cache_frame.clone()));

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
        // this is intentional, it works and is faster /shrug
        format::Pixel::YUV420P => cv::PixelFormat::_420V,
        format::Pixel::RGBA => cv::PixelFormat::_32_RGBA,
        _ => todo!(),
    }
}

fn pixel_format_to_pixel(format: cv::PixelFormat) -> format::Pixel {
    match format {
        cv::PixelFormat::_420V => format::Pixel::NV12,
        cv::PixelFormat::_32_RGBA => format::Pixel::RGBA,
        _ => todo!(),
    }
}

fn get_reader_track_output(
    asset: &av::UrlAsset,
    time: f32,
    handle: &TokioHandle,
    pixel_format: cv::PixelFormat,
) -> Result<R<av::AssetReaderTrackOutput>, String> {
    let mut reader =
        av::AssetReader::with_asset(&asset).map_err(|e| format!("AssetReader::with_asset: {e}"))?;

    let time_range = cm::TimeRange {
        start: cm::Time::with_secs(time as f64, 100),
        duration: asset.duration(),
    };

    reader.set_time_range(time_range);

    let tracks = handle
        .block_on(asset.load_tracks_with_media_type(av::MediaType::video()))
        .map_err(|e| format!("asset.load_tracks_with_media_type: {e}"))?;

    let track = tracks.get(0).map_err(|e| e.to_string())?;

    let mut reader_track_output = av::AssetReaderTrackOutput::with_track(
        &track,
        Some(&ns::Dictionary::with_keys_values(
            &[cv::pixel_buffer::keys::pixel_format().as_ns()],
            &[pixel_format.to_cf_number().as_ns().as_id_ref()],
        )),
    )
    .map_err(|e| format!("asset.reader_track_output{{{pixel_format:?}}}): {e}"))?;

    reader_track_output.set_always_copies_sample_data(false);

    reader
        .add_output(&reader_track_output)
        .map_err(|e| format!("reader.add_output: {e}"))?;

    reader
        .start_reading()
        .map_err(|e| format!("reader.start_reading: {e}"))?;

    Ok(reader_track_output)
}
