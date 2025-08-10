use cap_fail::{fail, fail_err};
use cap_media_info::VideoInfo;
use ffmpeg::frame;
use flume::{Receiver, Sender, TryRecvError, TrySendError};
use futures::channel::oneshot;
use std::{
    cmp::Ordering,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tracing::{debug, error, info, trace, warn};

use cap_camera_ffmpeg::*;

pub struct CameraFeedInfo {
    pub camera: cap_camera::CameraInfo,
    pub video_info: VideoInfo,
    pub reference_time: Instant,
}

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
    Switch(
        DeviceOrModelID,
        oneshot::Sender<Result<CameraFeedInfo, SetupCameraError>>,
    ),
    AttachConsumer(Sender<RawCameraFrame>),
    Shutdown,
}

#[derive(Clone)]
pub struct RawCameraFrame {
    pub frame: frame::Video,
    pub timestamp: Duration,
    pub refrence_time: Instant,
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

impl DeviceOrModelID {
    pub fn from_info(info: &cap_camera::CameraInfo) -> Self {
        info.model_id()
            .map(|v| Self::ModelID(v.clone()))
            .unwrap_or_else(|| Self::DeviceID(info.device_id().to_string()))
    }
}

pub struct CameraFeed {
    pub camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    reference_time: Instant,
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

        let (ready_tx, ready_rx) = oneshot::channel();

        thread::spawn(move || {
            run_camera_feed(selected_camera, control_receiver, ready_tx);
        });

        let state = ready_rx
            .await
            .map_err(|_| SetupCameraError::Initialisation)??;

        let camera_feed = Self {
            camera_info,
            control,
            video_info: state.video_info,
            reference_time: state.reference_time,
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

        let data = result_rx
            .await
            .map_err(SwitchCameraError::RequestFailed)??;

        self.camera_info = data.camera;
        self.video_info = data.video_info;
        self.reference_time = data.reference_time;

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

// #[tracing::instrument(skip_all)]
fn run_camera_feed(
    id: DeviceOrModelID,
    control: Receiver<CameraControl>,
    ready_tx: oneshot::Sender<Result<CameraFeedInfo, SetupCameraError>>,
) {
    fail!("media::feeds::camera::run panic");

    let mut senders: Vec<Sender<RawCameraFrame>> = vec![];

    let mut state = match setup_camera(id) {
        Ok(state) => {
            let _ = ready_tx.send(Ok(CameraFeedInfo {
                camera: state.camera_info.clone(),
                video_info: state.video_info,
                reference_time: state.reference_time,
            }));
            state
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    'outer: loop {
        debug!("Video feed camera format: {:#?}", &state.video_info);

        loop {
            match control.try_recv() {
                Err(TryRecvError::Disconnected) => {
                    trace!("Control disconnected");
                    break 'outer;
                }
                Ok(CameraControl::Shutdown) => {
                    state
                        .handle
                        .stop_capturing()
                        .map_err(|err| error!("Error stopping capture: {err:?}"))
                        .ok();
                    println!("Deliberate shutdown");
                    break 'outer;
                }
                Err(TryRecvError::Empty) => {}
                Ok(CameraControl::AttachConsumer(sender)) => {
                    senders.push(sender);
                }
                Ok(CameraControl::Switch(new_id, switch_result)) => match setup_camera(new_id) {
                    Ok(new_state) => {
                        let _ = switch_result.send(Ok(CameraFeedInfo {
                            camera: new_state.camera_info.clone(),
                            video_info: new_state.video_info,
                            reference_time: new_state.reference_time,
                        }));
                        state = new_state;

                        break;
                    }
                    Err(e) => {
                        let _ = switch_result.send(Err(e));
                        continue;
                    }
                },
            }

            let Ok(frame) = state.frame_rx.recv_timeout(Duration::from_secs(5)) else {
                return;
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
    #[error("Camera timed out")]
    Timeout(mpsc::RecvTimeoutError),
    #[error("StartCapturing/{0}")]
    StartCapturing(#[from] cap_camera::StartCapturingError),
    #[error("Failed to initialize camera")]
    Initialisation,
}

const CAMERA_INIT_TIMEOUT: Duration = Duration::from_secs(4);

struct SetupCameraState {
    handle: cap_camera::RecordingHandle,
    camera_info: cap_camera::CameraInfo,
    video_info: VideoInfo,
    frame_rx: mpsc::Receiver<RawCameraFrame>,
    reference_time: Instant,
}

fn setup_camera(id: DeviceOrModelID) -> Result<SetupCameraState, SetupCameraError> {
    let camera = find_camera(&id).ok_or(SetupCameraError::CameraNotFound)?;
    let formats = camera.formats().ok_or(SetupCameraError::InvalidFormat)?;
    if formats.is_empty() {
        return Err(SetupCameraError::InvalidFormat);
    }

    let mut ideal_formats = formats
        .clone()
        .into_iter()
        .filter(|f| f.frame_rate() >= 30.0 && f.width() < 2000 && f.height() < 2000)
        .collect::<Vec<_>>();

    if ideal_formats.is_empty() {
        ideal_formats = formats;
    };

    // Sort formats to prioritize:
    // 1. Closest to 16:9 aspect ratio
    // 2. Highest resolution (total pixels)
    // 3. Highest frame rate
    // Most relevant ends up in index 0
    ideal_formats.sort_by(|a, b| {
        let target_aspect_ratio = 16.0 / 9.0;

        let aspect_ratio_a = a.width() as f32 / a.height() as f32;
        let aspect_ratio_b = b.width() as f32 / b.height() as f32;

        let aspect_cmp_a = (aspect_ratio_a - target_aspect_ratio).abs();
        let aspect_cmp_b = (aspect_ratio_b - target_aspect_ratio).abs();

        let aspect_cmp = aspect_cmp_a.partial_cmp(&aspect_cmp_b);
        let resolution_cmp = (a.width() * a.height()).cmp(&(b.width() * b.height()));
        let fr_cmp = a.frame_rate().partial_cmp(&b.frame_rate());

        aspect_cmp
            .unwrap_or(Ordering::Equal)
            .then(resolution_cmp.reverse())
            .then(fr_cmp.unwrap_or(Ordering::Equal).reverse())
    });

    let format = ideal_formats.swap_remove(0);
    let frame_rate = format.frame_rate() as u32;

    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let mut ready_signal = Some(ready_tx);

    let (frame_tx, frame_rx) = mpsc::sync_channel(8);

    let capture_handle = camera.start_capturing(format.clone(), move |frame| {
        let Ok(mut ff_frame) = frame.to_ffmpeg() else {
            return;
        };

        ff_frame.set_pts(Some(frame.timestamp.as_micros() as i64));

        if let Some(signal) = ready_signal.take() {
            let video_info = VideoInfo::from_raw_ffmpeg(
                ff_frame.format(),
                ff_frame.width(),
                ff_frame.height(),
                frame_rate,
            );

            let _ = signal.send((video_info, frame.reference_time));
        }

        let _ = frame_tx.send(RawCameraFrame {
            frame: ff_frame,
            timestamp: frame.timestamp,
            refrence_time: frame.reference_time,
        });
    })?;

    let (video_info, reference_time) = ready_rx
        .recv_timeout(CAMERA_INIT_TIMEOUT)
        .map_err(SetupCameraError::Timeout)?;

    Ok(SetupCameraState {
        handle: capture_handle,
        camera_info: camera,
        video_info,
        frame_rx,
        reference_time,
    })
}
