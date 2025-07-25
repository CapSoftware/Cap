use cap_camera::{ModelID, StartCapturingError};
use cap_fail::{fail, fail_err};
use flume::{Receiver, Sender, TryRecvError, TrySendError};
use std::{
    sync::{mpsc, Arc},
    thread::{self},
    time::{Duration, Instant, SystemTime},
};
use tracing::{debug, error, info, trace, warn};

use crate::{
    data::{FFVideo, VideoInfo},
    MediaError,
};

use cap_camera_ffmpeg::*;

type CameraSwitchResult = Result<(cap_camera::CameraInfo, VideoInfo), SwitchCameraError>;

#[derive(Debug, thiserror::Error)]
pub enum SwitchCameraError {
    #[error("Camera not found")]
    CameraNotFound,
    #[error("Capture/0")]
    Capture(#[from] StartCapturingError),
    #[error("Failed to send request")]
    RequestFailed(flume::RecvError),
    #[error("Failed to initialize camera")]
    InitializeFailed(flume::RecvError),
}

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
    pub camera_info: cap_camera::CameraInfo,
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

        let camera_info = new_find_camera(&selected_camera).unwrap();
        let (control, control_receiver) = flume::bounded(1);

        let video_info = start_capturing(selected_camera, control_receiver).await?;

        let camera_feed = Self {
            camera_info,
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

    pub fn camera_info(&self) -> cap_camera::CameraInfo {
        self.camera_info.clone()
    }

    pub fn video_info(&self) -> VideoInfo {
        self.video_info
    }

    pub async fn switch_cameras(
        &mut self,
        model_id: cap_camera::ModelID,
    ) -> Result<(), SwitchCameraError> {
        fail_err!(
            "media::feeds::camera::switch_cameras",
            SwitchCameraError::CameraNotFound
        );

        if &model_id == self.camera_info.model_id() {
            return Ok(());
        }

        let (result_tx, result_rx) = flume::bounded(1);

        let _ = self
            .control
            .send_async(CameraControl::Switch(model_id, result_tx))
            .await;

        let (camera_info, video_info) = result_rx
            .recv_async()
            .await
            .map_err(SwitchCameraError::RequestFailed)??;

        self.camera_info = camera_info;
        self.video_info = video_info;

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

    let Some(new_camera) = new_find_camera(&model_id) else {
        return;
    };
    let Some(mut formats) = new_camera.formats() else {
        return;
    };
    let format = formats.swap_remove(0);

    debug!("Camera format: {:?}", &format);

    let (frame_tx, frame_rx) = mpsc::sync_channel(8);
    let mut handle = match new_camera.start_capturing(format.clone(), {
        let frame_tx = frame_tx.clone();
        move |frame| {
            let _ = frame_tx.send(frame);
        }
    }) {
        Err(e) => {
            dbg!(e);
            return;
        }
        Ok(v) => v,
    };

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
                let frame_tx = frame_tx.clone();
                let inner = move || {
                    let new_camera =
                        new_find_camera(&camera_model).ok_or(SwitchCameraError::CameraNotFound)?;

                    let mut formats = new_camera.formats().unwrap();
                    let format = formats.swap_remove(0);
                    let frame_rate = format.frame_rate() as u32;

                    let (ready_tx, ready_rx) = flume::bounded(1);
                    let mut ready_signal = Some(ready_tx);
                    let handle = new_camera.clone().start_capturing(format, move |frame| {
                        let Ok(ff_frame) = frame.to_ffmpeg() else {
                            return;
                        };

                        ready_signal.take().map(|signal| {
                            let video_info = VideoInfo::from_raw_ffmpeg(
                                ff_frame.format(),
                                ff_frame.width(),
                                ff_frame.height(),
                                frame_rate,
                            );

                            signal.send(video_info).ok();
                        });

                        let _ = frame_tx.send(frame);
                    })?;

                    Ok::<_, SwitchCameraError>((
                        handle,
                        new_camera,
                        ready_rx
                            .recv()
                            .map_err(SwitchCameraError::InitializeFailed)?,
                    ))
                };

                match inner() {
                    Ok((new_handle, camera_info, video_info)) => {
                        handle.stop_capturing();
                        handle = new_handle;
                        let _ = switch_result.send(Ok((camera_info, video_info)));
                    }
                    Err(e) => {
                        let _ = switch_result.send(Err(e));
                    }
                }
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
    }

    info!("Camera feed stopping");
}
