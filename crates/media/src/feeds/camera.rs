use cap_gpu_converters::{NV12Input, NV12ToRGBA, UYVYToRGBA};
use ffmpeg::software::scaling;
use flume::{Receiver, Sender, TryRecvError};
use nokhwa::{pixel_format::RgbFormat, utils::*, Camera};
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
    AttachRawConsumer(Sender<RawCameraFrame>),
    Shutdown,
}

pub struct RawCameraFrame {
    pub(crate) frame: FFVideo,
    pub(crate) captured_at: Instant,
}

pub struct CameraConnection {
    control: Sender<CameraControl>,
}

impl CameraConnection {
    pub fn attach(&self) -> Receiver<RawCameraFrame> {
        let (sender, receiver) = flume::bounded(60);
        self.control
            .send(CameraControl::AttachRawConsumer(sender))
            .unwrap();

        receiver
    }
}

// #[derive(Clone)]
pub struct CameraFeed {
    camera_info: CameraInfo,
    video_info: VideoInfo,
    control: Sender<CameraControl>,
    // join_handle: JoinHandle<()>,
}

impl CameraFeed {
    pub fn create_channel() -> (flume::Sender<WSFrame>, flume::Receiver<WSFrame>) {
        flume::bounded(60)
    }

    pub async fn init(
        selected_camera: &str,
        rgba_data: Sender<WSFrame>,
    ) -> Result<CameraFeed, MediaError> {
        #[cfg(feature = "debug-logging")]
        debug!("Initializing camera feed for: {}", selected_camera);

        let camera_info = find_camera(selected_camera)?;
        let (control, control_receiver) = flume::bounded(1);

        let (video_info, join_handle) =
            start_capturing(camera_info.clone(), control_receiver, rgba_data).await?;

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
    rgba_data: Sender<WSFrame>,
) -> Result<(VideoInfo, JoinHandle<()>), MediaError> {
    let (ready_tx, ready_rx) = flume::bounded::<Result<VideoInfo, MediaError>>(1);

    let join_handle = thread::spawn(move || {
        run_camera_feed(camera_info, control, rgba_data, ready_tx);
    });

    let video_info = ready_rx
        .recv_async()
        .await
        .map_err(|_| MediaError::Any("Failed to prepare camera feed"))??;

    Ok((video_info, join_handle))
}

// #[tracing::instrument(skip_all)]
fn run_camera_feed(
    camera_info: CameraInfo,
    control: Receiver<CameraControl>,
    rgba_data: Sender<WSFrame>,
    ready_signal: Sender<Result<VideoInfo, MediaError>>,
) {
    let mut maybe_raw_data: Option<Sender<RawCameraFrame>> = None;

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

    let mut converter = None;
    let mut ready_signal = Some(ready_signal);

    loop {
        match control.try_recv() {
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
            Ok(CameraControl::Shutdown) => break,
            Ok(CameraControl::AttachRawConsumer(rgba_sender)) => {
                maybe_raw_data = Some(rgba_sender);
            }
            Ok(CameraControl::Switch(camera_name, switch_result)) => {
                if maybe_raw_data.is_some() {
                    switch_result.send(Err(MediaError::Any("Cannot switch cameras while the feed is attached to a running pipeline"))).unwrap();
                } else {
                    match find_and_create_camera(&camera_name) {
                        Err(error) => {
                            switch_result.send(Err(error)).unwrap();
                        }
                        Ok((new_info, mut new_camera)) => {
                            let new_format = new_camera.camera_format();
                            let new_converter = FrameConverter::build(new_format);

                            if new_camera.open_stream().is_ok() {
                                let _ = camera.stop_stream();
                                switch_result
                                    .send(Ok((new_info, new_converter.video_info)))
                                    .unwrap();
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
        }

        // Actual data capture
        match camera.frame() {
            Ok(raw_buffer) => {
                let raw_buffer = if let FrameFormat::MJPEG = raw_buffer.source_frame_format() {
                    let rgba_buffer = raw_buffer
                        .decode_image::<nokhwa::pixel_format::RgbAFormat>()
                        .unwrap();
                    nokhwa::Buffer::new_from_cow(
                        raw_buffer.resolution(),
                        rgba_buffer.into_vec().into(),
                        FrameFormat::MJPEG,
                    )
                } else {
                    raw_buffer
                };

                let converter = converter.get_or_insert_with(|| {
                    let mut format = camera.camera_format();
                    format.set_format(raw_buffer.source_frame_format());
                    let converter = FrameConverter::build(format);
                    if let Some(ready_signal) = ready_signal.take() {
                        ready_signal.send(Ok(converter.video_info)).unwrap();
                    }
                    converter
                });

                if converter.format != raw_buffer.source_frame_format() {
                    let mut format = camera.camera_format();
                    format.set_format(raw_buffer.source_frame_format());
                    *converter = FrameConverter::build(format);
                }

                let captured_at = Instant::now();
                let rgba_frame = converter.rgba(&raw_buffer);

                if dropping_send(
                    &rgba_data,
                    WSFrame {
                        data: rgba_frame,
                        width: raw_buffer.resolution().width(),
                        height: raw_buffer.resolution().height(),
                        stride: raw_buffer.resolution().width() * 4,
                    },
                )
                .is_err()
                {
                    break;
                }

                if let Some(ref raw_data) = maybe_raw_data {
                    let frame = RawCameraFrame {
                        frame: converter.raw(&raw_buffer),
                        captured_at,
                    };
                    if dropping_send(raw_data, frame).is_err() {
                        maybe_raw_data = None;
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
            FrameFormat::YUYV => RawVideoFormat::Rgba,
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
        let resolution = buffer.resolution();

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

            input_frame
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

            input_frame
        }
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
