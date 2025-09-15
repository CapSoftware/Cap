use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, mpsc},
    time::Instant,
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
    mtl,
};
use ffmpeg::{Rational, format, frame};
use metal::{MTLTextureType, foreign_types::ForeignTypeRef};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};
use wgpu::{InstanceFlags, TextureUsages, wgc::api::Metal};

use super::{FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: wgpu::Texture,
}

#[derive(Clone)]
enum CachedFrame {
    Raw {
        image_buf: R<cv::ImageBuf>,
        number: u32,
    },
    Processed(ProcessedFrame),
}

impl CachedFrame {
    fn process(&mut self, device: &wgpu::Device) -> ProcessedFrame {
        match self {
            CachedFrame::Raw { image_buf, number } => {
                let now = Instant::now();
                let texture = {
                    let metal_device = mtl::Device::sys_default().unwrap();

                    let texture_cache =
                        cv::metal::TextureCache::create(None, &metal_device, None).unwrap();

                    let width = image_buf.width();
                    let height = image_buf.height();

                    let texture = texture_cache
                        .texture(
                            image_buf,
                            None,
                            mtl::PixelFormat::Bgra8UNorm,
                            width,
                            height,
                            0,
                        )
                        .unwrap();

                    let size = wgpu::Extent3d {
                        width: width as u32,
                        height: height as u32,
                        depth_or_array_layers: 1,
                    };
                    let format = wgpu::TextureFormat::Bgra8Unorm;

                    unsafe {
                        let texture =
                            <Metal as wgpu::hal::Api>::Device::texture_from_raw(
                                metal::TextureRef::from_ptr(
                                    texture.as_type_ptr() as *const _ as *mut _
                                )
                                .to_owned(),
                                format,
                                MTLTextureType::D2,
                                1,
                                1,
                                wgpu::hal::CopyExtent {
                                    width: width as u32,
                                    height: height as u32,
                                    depth: 1,
                                },
                            );

                        device.create_texture_from_hal::<Metal>(
                            texture,
                            &wgpu::TextureDescriptor {
                                label: None,
                                size,
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING
                                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                                    | wgpu::TextureUsages::COPY_DST,
                                view_formats: &[],
                            },
                        )
                    }
                };

                // let format = cap_video_decode::avassetreader::pixel_format_to_pixel(
                //     image_buf.pixel_format(),
                // );

                // let data = if matches!(format, format::Pixel::RGBA) {
                //     unsafe {
                //         image_buf
                //             .lock_base_addr(LockFlags::READ_ONLY)
                //             .result()
                //             .unwrap()
                //     };

                //     let bytes_per_row = image_buf.plane_bytes_per_row(0);
                //     let width = image_buf.width();
                //     let height = image_buf.height();

                //     let slice = unsafe {
                //         std::slice::from_raw_parts::<'static, _>(
                //             image_buf.plane_base_address(0),
                //             bytes_per_row * height,
                //         )
                //     };

                //     let mut bytes = Vec::with_capacity(width * height * 4);

                //     let row_length = width * 4;

                //     for i in 0..height {
                //         bytes.as_mut_slice()[i * row_length..((i + 1) * row_length)]
                //             .copy_from_slice(
                //                 &slice[i * bytes_per_row..(i * bytes_per_row + row_length)],
                //             )
                //     }

                //     unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

                //     bytes
                // } else {
                //     let mut ffmpeg_frame = ffmpeg::frame::Video::new(
                //         format,
                //         image_buf.width() as u32,
                //         image_buf.height() as u32,
                //     );

                //     unsafe {
                //         image_buf
                //             .lock_base_addr(LockFlags::READ_ONLY)
                //             .result()
                //             .unwrap()
                //     };

                //     match ffmpeg_frame.format() {
                //         format::Pixel::NV12 => {
                //             for plane_i in 0..image_buf.plane_count() {
                //                 let bytes_per_row = image_buf.plane_bytes_per_row(plane_i);
                //                 let height = image_buf.plane_height(plane_i);

                //                 let ffmpeg_stride = ffmpeg_frame.stride(plane_i);
                //                 let row_length = bytes_per_row.min(ffmpeg_stride);

                //                 let slice = unsafe {
                //                     std::slice::from_raw_parts::<'static, _>(
                //                         image_buf.plane_base_address(plane_i),
                //                         bytes_per_row * height,
                //                     )
                //                 };

                //                 for i in 0..height {
                //                     ffmpeg_frame.data_mut(plane_i)
                //                         [i * ffmpeg_stride..(i * ffmpeg_stride + row_length)]
                //                         .copy_from_slice(
                //                             &slice[i * bytes_per_row
                //                                 ..(i * bytes_per_row + row_length)],
                //                         )
                //                 }
                //             }
                //         }
                //         format::Pixel::YUV420P => {
                //             for plane_i in 0..image_buf.plane_count() {
                //                 let bytes_per_row = image_buf.plane_bytes_per_row(plane_i);
                //                 let height = image_buf.plane_height(plane_i);

                //                 let ffmpeg_stride = ffmpeg_frame.stride(plane_i);
                //                 let row_length = bytes_per_row.min(ffmpeg_stride);

                //                 let slice = unsafe {
                //                     std::slice::from_raw_parts::<'static, _>(
                //                         image_buf.plane_base_address(plane_i),
                //                         bytes_per_row * height,
                //                     )
                //                 };

                //                 for i in 0..height {
                //                     ffmpeg_frame.data_mut(plane_i)
                //                         [i * ffmpeg_stride..(i * ffmpeg_stride + row_length)]
                //                         .copy_from_slice(
                //                             &slice[i * bytes_per_row
                //                                 ..(i * bytes_per_row + row_length)],
                //                         )
                //                 }
                //             }
                //         }
                //         format => todo!("implement {:?}", format),
                //     }

                //     unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

                //     let mut converter = ffmpeg::software::converter(
                //         (ffmpeg_frame.width(), ffmpeg_frame.height()),
                //         ffmpeg_frame.format(),
                //         format::Pixel::RGBA,
                //     )
                //     .unwrap();

                //     let mut rgb_frame = frame::Video::empty();
                //     converter.run(&ffmpeg_frame, &mut rgb_frame).unwrap();

                //     let slice = rgb_frame.data(0);
                //     let width = rgb_frame.width();
                //     let height = rgb_frame.height();
                //     let bytes_per_row = rgb_frame.stride(0);
                //     let row_length = width * 4;

                //     let mut bytes = vec![0; (width * height * 4) as usize];

                //     // TODO: allow for decoded frames to have stride, handle stride in shaders
                //     for i in 0..height as usize {
                //         bytes.as_mut_slice()[i * row_length as usize..(i + 1) * row_length as usize]
                //             .copy_from_slice(
                //                 &slice
                //                     [(i * bytes_per_row)..i * bytes_per_row + row_length as usize],
                //             )
                //     }

                //     bytes
                // };

                let data = ProcessedFrame {
                    number: *number,
                    data: texture,
                };

                *self = Self::Processed(data.clone());

                data
            }
            CachedFrame::Processed(data) => data.clone(),
        }
    }
}

pub struct AVAssetReaderDecoder {
    inner: cap_video_decode::AVAssetReaderDecoder,
}

impl AVAssetReaderDecoder {
    fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        Ok(Self {
            inner: cap_video_decode::AVAssetReaderDecoder::new(path, tokio_handle)?,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        let _ = self.inner.reset(requested_time);
    }

    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
        device: wgpu::Device,
    ) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || Self::run(name, path, fps, rx, ready_tx, handle, &device));
    }

    fn run(
        _name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
        tokio_handle: tokio::runtime::Handle,
        device: &wgpu::Device,
    ) {
        let mut this = match AVAssetReaderDecoder::new(path, tokio_handle) {
            Ok(v) => {
                ready_tx.send(Ok(())).ok();
                v
            }
            Err(e) => {
                ready_tx.send(Err(e)).ok();
                return;
            }
        };

        let mut cache = BTreeMap::<u32, CachedFrame>::new();

        #[allow(unused)]
        let mut last_active_frame = None::<u32>;
        let last_sent_frame = Rc::new(RefCell::new(None::<ProcessedFrame>));

        let mut frames = this.inner.frames();

        while let Ok(r) = rx.recv() {
            match r {
                VideoDecoderMessage::GetFrame(requested_time, sender) => {
                    let start = Instant::now();
                    let requested_frame = (requested_time * fps as f32).floor() as u32;

                    let mut exit = Rc::new(Cell::new(false));

                    let mut sender = if let Some(cached) = cache.get_mut(&requested_frame) {
                        let data = cached.process(device);

                        sender.send(data.data.clone()).ok();
                        dbg!(start.elapsed());
                        *last_sent_frame.borrow_mut() = Some(data);
                        continue;
                    } else {
                        let last_sent_frame = last_sent_frame.clone();
                        let exit = exit.clone();
                        Some(move |data: ProcessedFrame| {
                            *last_sent_frame.borrow_mut() = Some(data.clone());
                            exit.set(true);
                            let _ = sender.send(data.data);
                            dbg!(start.elapsed());
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
                        this.reset(requested_time);
                        frames = this.inner.frames();
                    }

                    last_active_frame = Some(requested_frame);

                    let a = Instant::now();
                    let mut i = 0;
                    for frame in &mut frames {
                        i += 1;
                        let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                            continue;
                        };

                        let current_frame = pts_to_frame(
                            frame.pts().value,
                            Rational::new(1, frame.pts().scale),
                            fps,
                        );

                        let Some(frame) = frame.image_buf() else {
                            continue;
                        };

                        let mut cache_frame = CachedFrame::Raw {
                            image_buf: frame.retained(),
                            number: current_frame,
                        };

                        let frame_skip_start = Instant::now();
                        // Handles frame skips.
                        // We use the cache instead of last_sent_frame as newer non-matching frames could have been decoded.
                        if let Some(most_recent_prev_frame) =
                            cache.range_mut(..requested_frame).next_back()
                            // .rev().find(|v| *v.0 < requested_frame)
                            && let Some(sender) = sender.take()
                        {
                            (sender)(most_recent_prev_frame.1.process(device));
                        }
                        dbg!(frame_skip_start.elapsed());

                        let exceeds_cache_bounds = current_frame > cache_max;
                        let too_small_for_cache_bounds = current_frame < cache_min;

                        let cache_start = Instant::now();
                        if !too_small_for_cache_bounds {
                            if current_frame == requested_frame
                                && let Some(sender) = sender.take()
                            {
                                let data = cache_frame.process(device);
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

                            cache.insert(current_frame, cache_frame.clone());
                        }
                        dbg!(cache_start.elapsed());

                        let last_start = Instant::now();
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

                                (sender)(cache_frame.process(device));
                            }
                        }
                        dbg!(last_start.elapsed());

                        if exceeds_cache_bounds {
                            exit.set(true);
                        }

                        if exit.get() {
                            break;
                        }
                    }
                    dbg!(a.elapsed(), i);

                    // not inlining this is important so that last_sent_frame is dropped before the sender is invoked
                    let last_sent_frame = last_sent_frame.borrow().clone();
                    if let Some((sender, last_sent_frame)) = sender.take().zip(last_sent_frame) {
                        // info!(
                        //     "sending hail mary frame {} for {requested_frame}",
                        //     last_sent_frame.0
                        // );

                        (sender)(last_sent_frame);
                    }
                }
            }
        }
    }
}
