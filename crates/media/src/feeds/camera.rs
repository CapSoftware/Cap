use ffmpeg::software::scaling;
use flume::{Receiver, Sender, TryRecvError};
use nokhwa::{pixel_format::*, utils::*, Camera};
use std::{
    thread::{self, JoinHandle},
    time::Instant,
};
use tracing::{error, info, warn};

use crate::{
    data::{FFVideo, RawVideoFormat, VideoInfo},
    MediaError,
};

type CameraSwitchResult = Result<(CameraInfo, VideoInfo), MediaError>;

enum CameraControl {
    Switch(String, Sender<CameraSwitchResult>),
    AttachRawConsumer(Sender<RawCameraFrame>),
    Shutdown,
}

pub type CameraFrameSender = Sender<Vec<u8>>;
pub type CameraFrameReceiver = Receiver<Vec<u8>>;

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

pub struct CameraFeed {
    camera_info: CameraInfo,
    video_info: VideoInfo,
    control: Sender<CameraControl>,
    join_handle: JoinHandle<()>,
}

impl CameraFeed {
    pub fn create_channel() -> (CameraFrameSender, CameraFrameReceiver) {
        flume::bounded(60)
    }

    pub async fn init(
        selected_camera: &String,
        rgba_data: Sender<Vec<u8>>,
    ) -> Result<CameraFeed, MediaError> {
        println!("Selected camera: {:?}", selected_camera);

        let camera_info = find_camera(&selected_camera)?;
        let (control, control_receiver) = flume::bounded(1);

        let (video_info, join_handle) =
            start_capturing(camera_info.clone(), control_receiver, rgba_data).await?;

        let camera_feed = Self {
            camera_info,
            video_info,
            control,
            join_handle,
        };

        Ok(camera_feed)
    }

    pub fn list_cameras() -> Vec<String> {
        nokhwa::query(ApiBackend::Auto)
            .unwrap()
            .into_iter()
            .map(|i| i.human_name().to_string())
            .collect()
    }

    pub fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    pub async fn switch_cameras(&mut self, camera_name: &String) -> Result<(), MediaError> {
        let current_camera_name = self.camera_info.human_name();
        if camera_name != &current_camera_name {
            let (result_tx, result_rx) = flume::bounded::<CameraSwitchResult>(1);

            let _ = self
                .control
                .send_async(CameraControl::Switch(camera_name.clone(), result_tx))
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

fn find_camera(selected_camera: &String) -> Result<CameraInfo, MediaError> {
    let all_cameras = nokhwa::query(ApiBackend::Auto)?;

    all_cameras
        .into_iter()
        .find(|c| &c.human_name() == selected_camera)
        .ok_or(MediaError::DeviceUnreachable(selected_camera.clone()))
}

fn create_camera(info: &CameraInfo) -> Result<Camera, MediaError> {
    // TODO: Make selected format more flexible
    // let format = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::AbsoluteHighestResolution);
    let format =
        RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Closest(CameraFormat::new(
            Resolution {
                width_x: 1920,
                height_y: 1080,
            },
            FrameFormat::YUYV,
            30,
        )));
    let index = info.index().clone();
    Ok(Camera::new(index, format)?)
}

fn find_and_create_camera(selected_camera: &String) -> Result<(CameraInfo, Camera), MediaError> {
    let info = find_camera(selected_camera)?;
    let camera = create_camera(&info)?;

    Ok((info, camera))
}

async fn start_capturing(
    camera_info: CameraInfo,
    control: Receiver<CameraControl>,
    rgba_data: Sender<Vec<u8>>,
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
    rgba_data: Sender<Vec<u8>>,
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

    let mut converter = FrameConverter::build(camera.camera_format());

    if let Err(error) = camera.open_stream() {
        error!("Failed to open camera stream: {:?}", error);
        ready_signal.send(Err(error.into())).unwrap();
        return;
    }

    info!("Camera stream opened successfully");
    ready_signal.send(Ok(converter.video_info)).unwrap();
    println!("Launched camera feed");

    loop {
        match control.try_recv() {
            Err(TryRecvError::Disconnected) => {
                println!("Control receiver is unreachable! Shutting down");
                break;
            }
            Err(TryRecvError::Empty) => {
                // No signal received, nothing to do
            }
            Ok(CameraControl::Shutdown) => {
                println!("Shutdown request received.");
                break;
            }
            Ok(CameraControl::AttachRawConsumer(rgba_sender)) => {
                eprintln!("Attaching to a new pipeline consumer. Any previously attached consumer will be dropped");
                maybe_raw_data = Some(rgba_sender);
            }
            Ok(CameraControl::Switch(camera_name, switch_result)) => {
                if maybe_raw_data.is_some() {
                    switch_result.send(Err(MediaError::Any("Cannot switch cameras while the feed is attached to a running pipeline"))).unwrap();
                } else {
                    println!("Switching camera to {camera_name}");

                    match find_and_create_camera(&camera_name) {
                        Err(error) => {
                            eprintln!("{error}");
                            switch_result.send(Err(error)).unwrap();
                        }
                        Ok((new_info, mut new_camera)) => {
                            let new_format = new_camera.camera_format();
                            let new_converter = FrameConverter::build(new_format);

                            if new_camera.open_stream().is_ok() {
                                println!("Now using {camera_name}");
                                let _ = camera.stop_stream();
                                switch_result
                                    .send(Ok((new_info, new_converter.video_info)))
                                    .unwrap();
                                camera = new_camera;
                                converter = new_converter;
                            } else {
                                eprintln!(
                                    "Unable to switch to {camera_name}. Still using previous camera"
                                );
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
                // TODO: Merge fix in nokhwa lib to use presentation timestamps from the system, like scap does
                let captured_at = Instant::now();

                let rgba_frame = converter.rgba(&raw_buffer);

                if dropping_send(&rgba_data, rgba_frame).is_err() {
                    // TODO: Also allow changing the connection?
                    eprintln!("Camera preview has been disconnected. Shutting down feed");
                    break;
                }

                if let Some(ref raw_data) = maybe_raw_data {
                    let frame = RawCameraFrame {
                        frame: converter.raw(&raw_buffer),
                        captured_at,
                    };
                    if dropping_send(raw_data, frame).is_err() {
                        eprintln!("Raw data consumer has been disconnected.");
                        maybe_raw_data = None;
                    }
                }
            }
            Err(error) => {
                warn!("Failed to capture frame: {:?}", error);
                // Optionally, add a small delay to avoid busy-waiting
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
        }
    }

    let _ = camera.stop_stream();
    println!("Closed {} stream", camera.info().human_name());
}

struct FrameConverter {
    video_info: VideoInfo,
    context: scaling::Context,
}

impl FrameConverter {
    fn build(camera_format: CameraFormat) -> Self {
        let format = match camera_format.format() {
            FrameFormat::MJPEG => RawVideoFormat::Mjpeg,
            FrameFormat::YUYV => RawVideoFormat::Yuyv,
            FrameFormat::NV12 => RawVideoFormat::Nv12,
            FrameFormat::GRAY => RawVideoFormat::Gray,
            FrameFormat::RAWRGB => RawVideoFormat::RawRgb,
        };

        let video_info = VideoInfo::from_raw(
            format,
            camera_format.width(),
            camera_format.height(),
            camera_format.frame_rate(),
        );

        let context = ffmpeg::software::converter(
            (video_info.width, video_info.height),
            video_info.pixel_format,
            ffmpeg::format::Pixel::RGBA,
        )
        .unwrap();

        Self {
            video_info,
            context,
        }
    }

    fn rgba(&mut self, buffer: &nokhwa::Buffer) -> Vec<u8> {
        let resolution = buffer.resolution();

        let input_frame = self.video_info.wrap_frame(buffer.buffer(), 0);
        let mut rgba_frame = FFVideo::empty();

        self.context.run(&input_frame, &mut rgba_frame).unwrap();

        let mut data = rgba_frame.data(0).to_vec();

        data.extend_from_slice(&resolution.height().to_le_bytes());
        data.extend_from_slice(&resolution.width().to_le_bytes());

        data
    }

    fn raw(&mut self, buffer: &nokhwa::Buffer) -> FFVideo {
        self.video_info.wrap_frame(buffer.buffer(), 0)
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
