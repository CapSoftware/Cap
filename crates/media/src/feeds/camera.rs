use cap_camera::ModelID;
use cap_fail::{fail, fail_err};
use ffmpeg::format::Pixel;
use flume::{Receiver, Sender, TryRecvError, TrySendError};
// use nokhwa::{pixel_format::RgbAFormat, utils::*, Camera};
use std::{
    sync::{mpsc, Arc},
    thread::{self},
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Mutex;
use tracing::{debug, error, info, trace, warn};

use crate::{
    data::{FFVideo, VideoInfo},
    MediaError,
};

use cap_camera_ffmpeg::*;

#[cfg(windows)]
use cap_camera_windows::{PixelFormat, VideoFormatInner};

type CameraSwitchResult = Result<(cap_camera::CameraInfo, VideoInfo), MediaError>;

enum CameraControl {
    Switch(ModelID, Sender<CameraSwitchResult>),
    AttachConsumer(Sender<RawCameraFrame>),
    Shutdown,
}

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: FFVideo,
    pub captured_at: SystemTime,
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
    // pub camera_info: CameraInfo,
    video_info: VideoInfo,
    control: Sender<CameraControl>,
}

impl CameraFeed {
    pub async fn init(selected_camera: ModelID) -> Result<CameraFeed, MediaError> {
        trace!("Initializing camera feed for: {}", selected_camera);

        fail_err!(
            "media::feeds::camera::init",
            MediaError::Any("forced fail".into())
        );

        new_find_camera(&selected_camera).unwrap();

        // let camera_info = find_camera(selected_camera).unwrap();
        let (control, control_receiver) = flume::bounded(1);

        let video_info = start_capturing(selected_camera, control_receiver).await?;

        let camera_feed = Self {
            // camera_info,
            video_info,
            control,
        };

        Ok(camera_feed)
    }

    /// Initialize camera asynchronously, returning a receiver immediately.
    /// The actual initialization happens in a background task.
    /// Dropping the receiver cancels the initialization.
    pub fn init_async(selected_camera: ModelID) -> flume::Receiver<Result<CameraFeed, MediaError>> {
        let (tx, rx) = flume::bounded(1);

        tokio::spawn(async move {
            let result = Self::init(selected_camera).await;
            // Only send if receiver still exists
            let _ = tx.send(result);
        });

        rx
    }

    pub fn list_cameras() -> Vec<cap_camera::CameraInfo> {
        cap_camera::list_cameras().collect()
    }

    // pub fn camera_info(&self) -> CameraInfo {
    //     self.camera_info.clone()
    // }

    pub fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    pub async fn switch_cameras(
        &mut self,
        model_id: cap_camera::ModelID,
    ) -> Result<(), MediaError> {
        fail_err!(
            "media::feeds::camera::switch_cameras",
            MediaError::Any("forced fail".into())
        );

        // let current_camera_name = self.camera_info.human_name();
        // if camera_name != &current_camera_name {
        //     let (result_tx, result_rx) = flume::bounded::<CameraSwitchResult>(1);

        //     let _ = self
        //         .control
        //         .send_async(CameraControl::Switch(camera_name.to_string(), result_tx))
        //         .await;

        //     let (camera_info, video_info) = result_rx
        //         .recv_async()
        //         .await
        //         .map_err(|_| MediaError::Any("Failed to prepare camera feed".into()))??;

        //     // self.camera_info = camera_info;
        //     self.video_info = video_info;
        // }

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

fn new_find_camera(selected_camera: &ModelID) -> Option<cap_camera::CameraInfo> {
    cap_camera::list_cameras().find(|c| c.model_id() == selected_camera)
}

// fn find_camera(selected_camera: &str) -> Result<CameraInfo, MediaError> {
//     let all_cameras = nokhwa::query(ApiBackend::Auto)?;

//     all_cameras
//         .into_iter()
//         .find(|c| &c.human_name() == selected_camera)
//         .ok_or(MediaError::DeviceUnreachable(selected_camera.to_string()))
// }

// fn create_camera(info: &CameraInfo) -> Result<Camera, MediaError> {
//     #[cfg(feature = "debug-logging")]
//     debug!("Creating camera with info: {:?}", info);

//     let format = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::AbsoluteHighestFrameRate);

//     #[cfg(feature = "debug-logging")]
//     trace!("Requested camera format: {:?}", format);

//     let index = info.index().clone();

//     #[cfg(target_os = "macos")]
//     {
//         let device = nokhwa_bindings_macos::AVCaptureDevice::new(&index).unwrap();
//         if let Ok(formats) = device.supported_formats() {
//             #[cfg(feature = "debug-logging")]
//             trace!("Supported formats: {:?}", formats);
//         }
//     }

//     let camera = Camera::new(index, format)?;

//     #[cfg(feature = "debug-logging")]
//     debug!("Created camera with format: {:?}", camera.camera_format());

//     Ok(camera)
// }

// fn find_and_create_camera(selected_camera: &String) -> Result<(CameraInfo, Camera), MediaError> {
//     let info = find_camera(selected_camera)?;
//     let camera = create_camera(&info)?;

//     #[cfg(feature = "debug-logging")]
//     trace!("Camera format: {:?}", camera.camera_format());

//     Ok((info, camera))
// }

async fn start_capturing(
    model_id: ModelID,
    control: Receiver<CameraControl>,
) -> Result<VideoInfo, MediaError> {
    let (ready_tx, ready_rx) = flume::bounded::<Result<VideoInfo, MediaError>>(1);

    thread::spawn(move || {
        run_camera_feed(model_id, control, ready_tx);
    });

    let video_info = ready_rx
        .recv_async()
        .await
        .map_err(|_| MediaError::Any("Failed to prepare camera feed".into()))??;

    Ok(video_info)
    // Ok((video_info, join_handle))
}

// #[tracing::instrument(skip_all)]
fn run_camera_feed(
    model_id: ModelID,
    control: Receiver<CameraControl>,
    ready_signal: Sender<Result<VideoInfo, MediaError>>,
) {
    fail!("media::feeds::camera::run panic");

    let mut ready_signal = Some(ready_signal);

    let mut senders: Vec<Sender<RawCameraFrame>> = vec![];

    let new_camera = new_find_camera(&model_id).unwrap();
    let mut formats = new_camera.formats().unwrap();
    let format = formats.swap_remove(0);

    debug!("Camera format: {:?}", &format);

    let (frame_tx, frame_rx) = mpsc::sync_channel(8);
    let mut handle = new_camera
        .start_capturing(format.clone(), move |frame| {
            let _ = frame_tx.send(frame);
        })
        .unwrap();

    loop {
        match control.try_recv() {
            Err(TryRecvError::Disconnected) => {
                trace!("Control disconnected");
                break;
            }
            Ok(CameraControl::Shutdown) => {
                println!("Deliberate shutdown");
                break;
            }
            Err(TryRecvError::Empty) => {}
            Ok(CameraControl::AttachConsumer(sender)) => {
                senders.push(sender);
            }
            Ok(CameraControl::Switch(camera_model, switch_result)) => {
                new_find_camera(&camera_model);
                // match find_and_create_camera(&camera_name) {
                //     Err(error) => {
                //         switch_result.send(Err(error)).unwrap();
                //     }
                //     Ok((new_info, mut new_camera)) => {
                //         if new_camera.open_stream().is_ok() {
                //             // let _ = camera.stop_stream();
                //             // camera_format = new_camera.camera_format();
                //             // video_info = VideoInfo::from_raw_ffmpeg(
                //             //     match camera_format.format() {
                //             //         FrameFormat::BGRA => Pixel::BGRA,
                //             //         FrameFormat::MJPEG => {
                //             //             Pixel::RGB24
                //             //             // todo!("handle mjpeg for camera")
                //             //         }
                //             //         FrameFormat::RAWRGB => Pixel::RGB24,
                //             //         FrameFormat::NV12 => Pixel::NV12,
                //             //         FrameFormat::GRAY => Pixel::GRAY8,
                //             //         FrameFormat::YUYV => {
                //             //             let pix_fmt = if cfg!(windows) {
                //             //                 tracing::debug!("Using YUYV422 format for Windows camera in buffer_to_ffvideo");
                //             //                 Pixel::YUYV422 // This is correct for Windows
                //             //             } else {
                //             //                 Pixel::UYVY422
                //             //             };
                //             //             pix_fmt
                //             //         }
                //             //     },
                //             //     camera_format.width(),
                //             //     camera_format.height(),
                //             //     camera_format.frame_rate(),
                //             // );
                //             // switch_result.send(Ok((new_info, video_info))).unwrap();
                //             // camera = new_camera;
                //         } else {
                //             switch_result
                //                 .send(Err(MediaError::DeviceUnreachable(camera_name)))
                //                 .unwrap();
                //         }
                //     }
                // }
            }
        }

        let Ok(frame) = frame_rx.recv_timeout(Duration::from_secs(5)) else {
            return;
        };

        let Ok(ff_frame) = frame.to_ffmpeg() else {
            continue;
        };

        let captured_at = SystemTime::now();

        ready_signal.take().map(|signal| {
            let video_info = VideoInfo::from_raw_ffmpeg(
                ff_frame.format(),
                ff_frame.width(),
                ff_frame.height(),
                format.frame_rate() as u32,
            );
            dbg!(video_info);
            signal.send(Ok(video_info)).ok();
        });

        let frame = RawCameraFrame {
            frame: ff_frame,
            captured_at,
        };

        let mut to_remove = vec![];

        for (i, sender) in senders.iter().enumerate() {
            if let Err(TrySendError::Disconnected(_)) = sender.try_send(frame.clone()) {
                warn!("Camera sender {} disconnected, will be removed", i);
                to_remove.push(i);
            };
        }

        if !to_remove.is_empty() {
            // debug!("Removing {} disconnected audio senders", to_remove.len());
            for i in to_remove.into_iter().rev() {
                senders.swap_remove(i);
            }
        }

        // match camera.frame() {
        //     Ok(raw_buffer) => {
        //         let captured_at = raw_buffer.timestamp().unwrap_or_else(|| SystemTime::now());

        //         let frame = RawCameraFrame {
        //             frame: buffer_to_ffvideo(raw_buffer),
        //             captured_at,
        //         };

        //         ready_signal.take().map(|signal| {
        //             signal.send(Ok(video_info)).ok();
        //         });

        //         let mut to_remove = vec![];

        //         for (i, sender) in senders.iter().enumerate() {
        //             if let Err(TrySendError::Disconnected(_)) = sender.try_send(frame.clone()) {
        //                 warn!("Camera sender {} disconnected, will be removed", i);
        //                 to_remove.push(i);
        //             };
        //         }

        //         if !to_remove.is_empty() {
        //             debug!("Removing {} disconnected audio senders", to_remove.len());
        //             for i in to_remove.into_iter().rev() {
        //                 senders.swap_remove(i);
        //             }
        //         }
        //     }
        //     Err(error) => {
        //         warn!("Failed to capture frame: {:?}", error);
        //         std::thread::sleep(std::time::Duration::from_millis(10));
        //         continue;
        //     }
        // }
    }

    // let _ = camera.stop_stream();

    info!("Camera feed stopping");
}
