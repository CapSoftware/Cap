use cap_camera::ModelID;
use cap_fail::{fail, fail_err};
use flume::{Receiver, Sender, TryRecvError, TrySendError};
use futures::channel::oneshot;
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

type CameraSwitchResult = Result<(cap_camera::CameraInfo, VideoInfo), SetupCameraError>;

#[derive(Debug, thiserror::Error)]
pub enum SwitchCameraError {
    #[error("Setup/{0}")]
    Setup(#[from] SetupCameraError),
    #[error("Failed to send request")]
    RequestFailed(oneshot::Canceled),
    #[error("Failed to initialize camera")]
    InitializeFailed(oneshot::Canceled),
}

enum CameraControl {
    Switch(DeviceOrModelID, oneshot::Sender<CameraSwitchResult>),
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

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
pub enum DeviceOrModelID {
    DeviceID(String),
    ModelID(cap_camera::ModelID),
}

pub struct CameraFeed {
    pub camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    control: Sender<CameraControl>,
}

impl CameraFeed {
    pub async fn init(selected_camera: DeviceOrModelID) -> Result<CameraFeed, SetupCameraError> {
        trace!("Initializing camera feed for: {:?}", &selected_camera);

        fail_err!(
            "media::feeds::camera::init",
            SetupCameraError::Initialisation
        );

        let camera_info = find_camera(&selected_camera).unwrap();
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
    pub fn init_async(
        id: DeviceOrModelID,
    ) -> flume::Receiver<Result<CameraFeed, SetupCameraError>> {
        let (tx, rx) = flume::bounded(1);

        tokio::spawn(async move {
            let result = Self::init(id).await;
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

    pub async fn switch_cameras(&mut self, id: DeviceOrModelID) -> Result<(), SwitchCameraError> {
        fail_err!(
            "media::feeds::camera::switch_cameras",
            SwitchCameraError::Setup(SetupCameraError::CameraNotFound)
        );

        let (result_tx, result_rx) = oneshot::channel();

        let _ = self
            .control
            .send_async(CameraControl::Switch(id, result_tx))
            .await;

        let (camera_info, video_info) = result_rx
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

fn find_camera(selected_camera: &DeviceOrModelID) -> Option<cap_camera::CameraInfo> {
    cap_camera::list_cameras().find(|c| match selected_camera {
        DeviceOrModelID::DeviceID(device_id) => c.device_id() == device_id,
        DeviceOrModelID::ModelID(model_id) => c.model_id() == Some(model_id),
    })
}

async fn start_capturing(
    id: DeviceOrModelID,
    control: Receiver<CameraControl>,
) -> Result<VideoInfo, SetupCameraError> {
    let (ready_tx, ready_rx) = oneshot::channel();

    thread::spawn(move || {
        run_camera_feed(id, control, ready_tx);
    });

    let (_camera_info, video_info) = ready_rx
        .await
        .map_err(|_| SetupCameraError::Initialisation)??;

    Ok(video_info)
}

// #[tracing::instrument(skip_all)]
fn run_camera_feed(
    id: DeviceOrModelID,
    control: Receiver<CameraControl>,
    ready_tx: oneshot::Sender<Result<(cap_camera::CameraInfo, VideoInfo), SetupCameraError>>,
) {
    fail!("media::feeds::camera::run panic");

    let mut senders: Vec<Sender<RawCameraFrame>> = vec![];

    let (frame_tx, frame_rx) = mpsc::sync_channel(8);

    let mut id = id;
    let mut ready_signal = ready_tx;

    'outer: loop {
        let handle = match setup_camera(id, frame_tx.clone()) {
            Ok((handle, camera, video_info)) => {
                let _ = ready_signal.send(Ok((camera.clone(), video_info.clone())));
                handle
            }
            Err(e) => {
                let _ = ready_signal.send(Err(e));
                return;
            }
        };

        loop {
            match control.try_recv() {
                Err(TryRecvError::Disconnected) => {
                    trace!("Control disconnected");
                    break 'outer;
                }
                Ok(CameraControl::Shutdown) => {
                    handle.stop_capturing();
                    println!("Deliberate shutdown");
                    break 'outer;
                }
                Err(TryRecvError::Empty) => {}
                Ok(CameraControl::AttachConsumer(sender)) => {
                    senders.push(sender);
                }
                Ok(CameraControl::Switch(new_id, switch_result)) => {
                    id = new_id;
                    ready_signal = switch_result;
                    break;
                }
            }

            let Ok(ff_frame) = frame_rx.recv_timeout(Duration::from_secs(5)) else {
                return;
            };

            let captured_at = SystemTime::now();

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
    }

    info!("Camera feed stopping");
}

#[derive(Debug, thiserror::Error)]
pub enum SetupCameraError {
    #[error("Camera not found")]
    CameraNotFound,
    #[error("Invalid format")]
    InvalidFormat,
    #[error("Initialisation failed")]
    Initialisation,
    #[error("StartCapturing/{0}")]
    StartCapturing(#[from] cap_camera::StartCapturingError),
}

fn setup_camera(
    id: DeviceOrModelID,
    frame_tx: mpsc::SyncSender<FFVideo>,
) -> Result<
    (
        cap_camera::RecordingHandle,
        cap_camera::CameraInfo,
        VideoInfo,
    ),
    SetupCameraError,
> {
    let camera = find_camera(&id).ok_or(SetupCameraError::CameraNotFound)?;
    let mut formats = camera.formats().ok_or(SetupCameraError::InvalidFormat)?;
    if formats.len() < 1 {
        return Err(SetupCameraError::InvalidFormat);
    }

    let format = formats.remove(0);
    let frame_rate = format.frame_rate() as u32;

    let (ready_tx, ready_rx) = oneshot::channel();
    let mut ready_signal = Some(ready_tx);

    let capture_handle = camera.start_capturing(format.clone(), move |frame| {
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

        let _ = frame_tx.send(ff_frame);
    })?;

    let video_info =
        futures::executor::block_on(ready_rx).map_err(|_| SetupCameraError::Initialisation)?;

    Ok((capture_handle, camera, video_info))
}
