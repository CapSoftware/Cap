use cap_gpu_converters::{NV12Input, NV12ToRGBA, UYVYToRGBA};
use ffmpeg::{format::Pixel, software::scaling};
use flume::{Receiver, Sender, TryRecvError, TrySendError};
use nokhwa::{utils::*, Camera};
use std::{
    thread::{self, JoinHandle},
    time::Instant,
};
use tracing::{debug, error, info, trace, warn};

use crate::{
    data::{FFVideo, RawVideoFormat, VideoInfo},
    frame_ws::WSFrame,
    MediaError,
};

type CameraSwitchResult = Result<(CameraInfo, VideoInfo), MediaError>;

enum CameraControl {
    Switch(String, Sender<CameraSwitchResult>),
    AttachConsumer(Sender<RawCameraFrame>),
    Shutdown,
}

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: FFVideo,
    pub captured_at: Instant,
}

pub struct CameraConnection {
    control: Sender<CameraControl>,
}

impl CameraConnection {
    pub fn attach(&self) -> Receiver<RawCameraFrame> {
        let (sender, receiver) = flume::bounded(60);
        self.control
            .send(CameraControl::AttachConsumer(sender))
            .ok();

        receiver
    }
}

pub struct CameraFeed {
    pub camera_info: CameraInfo,
    video_info: VideoInfo,
    control: Sender<CameraControl>,
}

impl CameraFeed {
    pub async fn init(selected_camera: &str) -> Result<CameraFeed, MediaError> {
        trace!("Initializing camera feed for: {}", selected_camera);

        let camera_info = find_camera(selected_camera)?;
        let (control, control_receiver) = flume::bounded(1);

        let video_info = start_capturing(camera_info.clone(), control_receiver).await?;

        dbg!(&video_info);

        let camera_feed = Self {
            camera_info,
            video_info,
            control,
            // join_handle,
        };

        Ok(camera_feed)
    }

    pub fn list_cameras() -> Vec<String> {
        match nokhwa::query(ApiBackend::Auto) {
            Ok(cameras) => cameras
                .into_iter()
                .map(|i| i.human_name().to_string())
                .collect::<Vec<String>>(),
            Err(_) => Vec::new(),
        }
    }

    pub fn camera_info(&self) -> CameraInfo {
        self.camera_info.clone()
    }

    pub fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    pub async fn switch_cameras(&mut self, camera_name: &str) -> Result<(), MediaError> {
        let current_camera_name = self.camera_info.human_name();
        if camera_name != &current_camera_name {
            let (result_tx, result_rx) = flume::bounded::<CameraSwitchResult>(1);

            let _ = self
                .control
                .send_async(CameraControl::Switch(camera_name.to_string(), result_tx))
                .await;

            let (camera_info, video_info) = result_rx
                .recv_async()
                .await
                .map_err(|_| MediaError::Any("Failed to prepare camera feed"))??;

            self.camera_info = camera_info;
            self.video_info = video_info;
        }

        Ok(())
    }

    pub fn create_connection(&self) -> CameraConnection {
        CameraConnection {
            control: self.control.clone(),
        }
    }

    pub fn attach(&self, sender: Sender<RawCameraFrame>) {
        self.control
            .send(CameraControl::AttachConsumer(sender))
            .ok();
    }
}

impl Drop for CameraFeed {
    fn drop(&mut self) {
        let _ = self.control.send(CameraControl::Shutdown);
    }
}

fn find_camera(selected_camera: &str) -> Result<CameraInfo, MediaError> {
    let all_cameras = nokhwa::query(ApiBackend::Auto)?;

    all_cameras
        .into_iter()
        .find(|c| &c.human_name() == selected_camera)
        .ok_or(MediaError::DeviceUnreachable(selected_camera.to_string()))
}

fn create_camera(info: &CameraInfo) -> Result<Camera, MediaError> {
    #[cfg(feature = "debug-logging")]
    debug!("Creating camera with info: {:?}", info);

    let format = RequestedFormat::with_formats(
        RequestedFormatType::AbsoluteHighestFrameRate,
        &[FrameFormat::YUYV],
    );

    #[cfg(feature = "debug-logging")]
    trace!("Requested camera format: {:?}", format);

    let index = info.index().clone();

    #[cfg(target_os = "macos")]
    {
        let device = nokhwa_bindings_macos::AVCaptureDevice::new(&index).unwrap();
        if let Ok(formats) = device.supported_formats() {
            #[cfg(feature = "debug-logging")]
            trace!("Supported formats: {:?}", formats);
        }
    }

    let camera = Camera::new(index, format)?;

    #[cfg(feature = "debug-logging")]
    debug!("Created camera with format: {:?}", camera.camera_format());

    Ok(camera)
}

fn find_and_create_camera(selected_camera: &String) -> Result<(CameraInfo, Camera), MediaError> {
    let info = find_camera(selected_camera)?;
    let camera = create_camera(&info)?;

    #[cfg(feature = "debug-logging")]
    trace!("Camera format: {:?}", camera.camera_format());

    Ok((info, camera))
}

async fn start_capturing(
    camera_info: CameraInfo,
    control: Receiver<CameraControl>,
) -> Result<VideoInfo, MediaError> {
    let (ready_tx, ready_rx) = flume::bounded::<Result<VideoInfo, MediaError>>(1);

    thread::spawn(move || {
        run_camera_feed(camera_info, control, ready_tx);
    });

    let video_info = ready_rx
        .recv_async()
        .await
        .map_err(|_| MediaError::Any("Failed to prepare camera feed"))??;

    Ok(video_info)
    // Ok((video_info, join_handle))
}

// #[tracing::instrument(skip_all)]
fn run_camera_feed(
    camera_info: CameraInfo,
    control: Receiver<CameraControl>,
    ready_signal: Sender<Result<VideoInfo, MediaError>>,
) {
    let mut camera = match create_camera(&camera_info) {
        Ok(cam) => cam,
        Err(error) => {
            error!("Failed to create camera: {:?}", error);
            ready_signal.send(Err(error)).unwrap();
            return;
        }
    };

    if let Err(error) = camera.open_stream() {
        error!("Failed to open camera stream: {:?}", error);
        ready_signal.send(Err(error.into())).unwrap();
        return;
    }

    let mut ready_signal = Some(ready_signal);
    let mut camera_format = camera.camera_format();
    let mut video_info = {
        VideoInfo::from_raw_ffmpeg(
            match camera_format.format() {
                FrameFormat::BGRA => Pixel::BGRA,
                FrameFormat::MJPEG => {
                    todo!("handle mjpeg for camera")
                }
                FrameFormat::RAWRGB => Pixel::RGB24,
                FrameFormat::NV12 => Pixel::NV12,
                FrameFormat::GRAY => Pixel::GRAY8,
                FrameFormat::YUYV => Pixel::UYVY422,
            },
            camera_format.width(),
            camera_format.height(),
            camera_format.frame_rate(),
        )
    };

    let mut senders: Vec<Sender<RawCameraFrame>> = vec![];

    loop {
        match control.try_recv() {
            Err(TryRecvError::Disconnected) => {
                trace!("Control disconnected");
                break;
            }
            Ok(CameraControl::Shutdown) => {
                trace!("Deliberate shutdown");
                break;
            }
            Err(TryRecvError::Empty) => {}
            Ok(CameraControl::AttachConsumer(sender)) => {
                senders.push(sender);
            }
            Ok(CameraControl::Switch(camera_name, switch_result)) => {
                match find_and_create_camera(&camera_name) {
                    Err(error) => {
                        switch_result.send(Err(error)).unwrap();
                    }
                    Ok((new_info, mut new_camera)) => {
                        if new_camera.open_stream().is_ok() {
                            let _ = camera.stop_stream();
                            camera_format = new_camera.camera_format();
                            video_info = VideoInfo::from_raw_ffmpeg(
                                match camera_format.format() {
                                    FrameFormat::BGRA => Pixel::BGRA,
                                    FrameFormat::MJPEG => {
                                        todo!("handle mjpeg for camera")
                                    }
                                    FrameFormat::RAWRGB => Pixel::RGB24,
                                    FrameFormat::NV12 => Pixel::NV12,
                                    FrameFormat::GRAY => Pixel::GRAY8,
                                    FrameFormat::YUYV => Pixel::UYVY422,
                                },
                                camera_format.width(),
                                camera_format.height(),
                                camera_format.frame_rate(),
                            );
                            switch_result.send(Ok((new_info, video_info))).unwrap();
                            camera = new_camera;
                        } else {
                            switch_result
                                .send(Err(MediaError::DeviceUnreachable(camera_name)))
                                .unwrap();
                        }
                    }
                }
            }
        }

        match camera.frame() {
            Ok(raw_buffer) => {
                let captured_at = Instant::now();

                let frame = RawCameraFrame {
                    frame: buffer_to_ffvideo(raw_buffer),
                    captured_at,
                };

                ready_signal.take().map(|signal| {
                    signal.send(Ok(video_info)).ok();
                });

                let mut to_remove = vec![];

                for (i, sender) in senders.iter().enumerate() {
                    if let Err(TrySendError::Disconnected(_)) = sender.try_send(frame.clone()) {
                        warn!("Camera sender {} disconnected, will be removed", i);
                        to_remove.push(i);
                    };
                }

                if !to_remove.is_empty() {
                    debug!("Removing {} disconnected audio senders", to_remove.len());
                    for i in to_remove.into_iter().rev() {
                        senders.swap_remove(i);
                    }
                }
            }
            Err(error) => {
                warn!("Failed to capture frame: {:?}", error);
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
        }
    }

    let _ = camera.stop_stream();

    info!("Camera feed stopping");
}

fn buffer_to_ffvideo(buffer: nokhwa::Buffer) -> FFVideo {
    use ffmpeg::format::Pixel;
    let (format, load_data): (Pixel, fn(&mut FFVideo, &nokhwa::Buffer)) = {
        match buffer.source_frame_format() {
            FrameFormat::BGRA => (Pixel::BGRA, |frame, buffer| {
                let stride = frame.stride(0) as usize;
                let width = frame.width() as usize;
                let height = frame.height() as usize;

                for y in 0..height {
                    let row_length = width * 4;

                    frame.data_mut(0)[y * stride..(width * 4 * y + row_length)].copy_from_slice(
                        &buffer.buffer()[width * 4 * y..width * 4 * y + row_length],
                    );
                }
            }),
            FrameFormat::NV12 => (Pixel::NV12, |frame, buffer| {
                let width = frame.width() as usize;
                let height = frame.height() as usize;

                let stride = frame.stride(0) as usize;
                for y in 0..height {
                    let row_length = width;
                    frame.data_mut(0)[y * stride..(y * stride + row_length)]
                        .copy_from_slice(&buffer.buffer()[width * y..width * y + row_length]);
                }

                let stride = frame.stride(1) as usize;
                for y in 0..height / 2 {
                    let row_length = width;
                    frame.data_mut(1)[y * stride..(y * stride + row_length)]
                        .copy_from_slice(&buffer.buffer()[y * width..y * width + row_length]);
                }
            }),
            FrameFormat::YUYV => {
                // let bytes = buffer.buffer().len() as f32;
                // let ratio = bytes / (buffer.resolution().x() * buffer.resolution().y()) as f32;
                // if ratio == 2.0

                // nokhwa merges yuvu420 and uyvy422 into the same format, we should probably distinguish them with the frame size
                (Pixel::UYVY422, |frame, buffer| {
                    let width = frame.width() as usize;
                    let height = frame.height() as usize;

                    let stride = frame.stride(0) as usize;
                    for y in 0..height {
                        let row_length = width * 2;
                        frame.data_mut(0)[y * stride..(y * stride + row_length)].copy_from_slice(
                            &buffer.buffer()[2 * width * y..2 * width * y + row_length],
                        );
                    }
                })
            }
            _ => todo!("implement more camera formats"),
        }
    };

    let mut frame = FFVideo::new(format, buffer.resolution().x(), buffer.resolution().y());

    load_data(&mut frame, &buffer);

    frame
}

struct FrameConverter {
    video_info: VideoInfo,
    context: scaling::Context,
    pub format: FrameFormat,
    hw_converter: Option<HwConverter>,
}

pub enum HwConverter {
    NV12(NV12ToRGBA),
    UYVY(UYVYToRGBA),
}

impl FrameConverter {
    fn build(camera_format: CameraFormat) -> Self {
        let format = match camera_format.format() {
            FrameFormat::MJPEG => RawVideoFormat::Mjpeg,
            FrameFormat::YUYV => RawVideoFormat::YUYV420,
            FrameFormat::NV12 => RawVideoFormat::Nv12,
            FrameFormat::GRAY => RawVideoFormat::Gray,
            FrameFormat::RAWRGB => RawVideoFormat::RawRgb,
            FrameFormat::BGRA => RawVideoFormat::Bgra,
        };

        let video_info = VideoInfo::from_raw(
            format,
            camera_format.width(),
            camera_format.height(),
            camera_format.frame_rate(),
        );

        // Create FFmpeg converter
        let context = ffmpeg::software::converter(
            (video_info.width, video_info.height),
            if camera_format.format() == FrameFormat::YUYV {
                ffmpeg::format::Pixel::UYVY422
            } else {
                video_info.pixel_format
            },
            ffmpeg::format::Pixel::RGBA,
        )
        .unwrap();

        Self {
            video_info,
            context,
            format: camera_format.format(),
            hw_converter: None, // Don't use hardware converters
        }
    }

    fn rgba(&mut self, buffer: &nokhwa::Buffer) -> Vec<u8> {
        let resolution = buffer.resolution();

        match self.format {
            FrameFormat::YUYV => self.convert_with_ffmpeg(buffer, resolution),
            _ => match &self.hw_converter {
                Some(HwConverter::NV12(converter)) => converter.convert(
                    NV12Input::from_buffer(
                        buffer.buffer(),
                        resolution.width(),
                        resolution.height(),
                    ),
                    resolution.width(),
                    resolution.height(),
                ),
                _ => self.convert_with_ffmpeg(buffer, resolution),
            },
        }
    }

    fn convert_with_ffmpeg(&mut self, buffer: &nokhwa::Buffer, resolution: Resolution) -> Vec<u8> {
        if self.format == FrameFormat::YUYV {
            // For YUYV, we need to handle the conversion differently
            let stride = resolution.width() as usize * 2; // YUYV uses 2 bytes per pixel
            let src = buffer.buffer();

            // Create input frame with YUYV format and copy data
            let mut input_frame = FFVideo::new(
                ffmpeg::format::Pixel::UYVY422,
                resolution.width(),
                resolution.height(),
            );

            // Copy data line by line
            {
                let dst_stride = input_frame.stride(0);
                let dst = input_frame.data_mut(0);
                for y in 0..resolution.height() as usize {
                    let src_offset = y * stride;
                    let dst_offset = y * dst_stride;
                    dst[dst_offset..dst_offset + stride]
                        .copy_from_slice(&src[src_offset..src_offset + stride]);
                }
            }

            // Create output frame
            let mut rgba_frame = FFVideo::new(
                ffmpeg::format::Pixel::RGBA,
                resolution.width(),
                resolution.height(),
            );

            // Convert the frame
            if self.context.run(&input_frame, &mut rgba_frame).is_ok() {
                rgba_frame.data(0).to_vec()
            } else {
                vec![0; (resolution.width() * resolution.height() * 4) as usize]
            }
        } else {
            // For other formats, use the normal conversion path
            let stride = match self.format {
                FrameFormat::NV12 => resolution.width() as usize,
                FrameFormat::BGRA => resolution.width() as usize * 4,
                FrameFormat::MJPEG => resolution.width() as usize * 4,
                FrameFormat::GRAY => resolution.width() as usize,
                FrameFormat::RAWRGB => resolution.width() as usize * 3,
                _ => buffer.buffer_bytes().len() / resolution.height() as usize,
            };

            // Create input frame and copy data
            let mut input_frame = FFVideo::new(
                match self.format {
                    FrameFormat::NV12 => ffmpeg::format::Pixel::NV12,
                    FrameFormat::BGRA => ffmpeg::format::Pixel::BGRA,
                    FrameFormat::MJPEG => ffmpeg::format::Pixel::RGBA,
                    FrameFormat::GRAY => ffmpeg::format::Pixel::GRAY8,
                    FrameFormat::RAWRGB => ffmpeg::format::Pixel::RGB24,
                    _ => ffmpeg::format::Pixel::RGBA,
                },
                resolution.width(),
                resolution.height(),
            );

            // Copy data line by line
            {
                let dst_stride = input_frame.stride(0);
                let dst = input_frame.data_mut(0);
                let src = buffer.buffer();
                for y in 0..resolution.height() as usize {
                    let src_offset = y * stride;
                    let dst_offset = y * dst_stride;
                    dst[dst_offset..dst_offset + stride]
                        .copy_from_slice(&src[src_offset..src_offset + stride]);
                }
            }

            // Create output frame
            let mut rgba_frame = FFVideo::new(
                ffmpeg::format::Pixel::RGBA,
                resolution.width(),
                resolution.height(),
            );

            // Convert the frame
            if self.context.run(&input_frame, &mut rgba_frame).is_ok() {
                rgba_frame.data(0).to_vec()
            } else {
                vec![0; (resolution.width() * resolution.height() * 4) as usize]
            }
        }
    }

    fn raw(&mut self, buffer: &nokhwa::Buffer) -> FFVideo {
        dbg!(buffer.source_frame_format());
        self.video_info.wrap_frame(
            buffer.buffer(),
            0,
            buffer.buffer_bytes().len() / buffer.resolution().height() as usize,
        )
    }
}

fn dropping_send<T>(sender: &Sender<T>, value: T) -> Result<(), flume::SendError<T>> {
    sender.try_send(value).or_else(|error| match error {
        flume::TrySendError::Full(_) => {
            // tracing::debug!("Channel is full. Dropping camera frame");
            Ok(())
        }
        flume::TrySendError::Disconnected(v) => Err(flume::SendError(v)),
    })
}
