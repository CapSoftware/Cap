use flume::Sender;
use nokhwa::{pixel_format::*, utils::*, Camera};
use std::time::Instant;

use crate::{
    data::{FFVideo, RawVideoFormat, VideoInfo},
    pipeline::{clock::SynchronisedClock, control::Control, task::PipelineSourceTask},
    MediaError,
};

fn create_camera(camera_info: &CameraInfo) -> Result<Camera, ()> {
    let format = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
    Camera::new(camera_info.index().clone(), format).map_err(|error| {
        tracing::error!("Error while initializing camera: {error}");
    })
}

pub struct CameraSource {
    info: CameraInfo,
    format: CameraFormat,
}

impl CameraSource {
    pub fn init(selected_camera: Option<&str>) -> Option<Self> {
        tracing::debug!("Selected camera: {:?}", selected_camera);

        let cameras = nokhwa::query(ApiBackend::Auto).unwrap();

        selected_camera
            .and_then(|camera_name| cameras.into_iter().find(|c| &c.human_name() == camera_name))
            .and_then(|camera_info| create_camera(&camera_info).ok())
            .and_then(|camera| {
                let format = camera.camera_format();
                if format_for(format.format()).is_some() {
                    return Some(Self {
                        info: camera.info().clone(),
                        format,
                    });
                }

                None
            })
    }

    pub fn list_cameras() -> Vec<String> {
        nokhwa::query(ApiBackend::Auto)
            .unwrap()
            .into_iter()
            .map(|i| i.human_name().to_string())
            .collect()
    }

    pub fn info(&self) -> VideoInfo {
        VideoInfo::from_raw(
            format_for(self.format.format()).unwrap(),
            self.format.width(),
            self.format.height(),
            self.format.frame_rate(),
        )
    }
}

fn format_for(format: FrameFormat) -> Option<RawVideoFormat> {
    match format {
        FrameFormat::YUYV => Some(RawVideoFormat::Yuyv),
        FrameFormat::RAWRGB => Some(RawVideoFormat::RawRgb),
        FrameFormat::NV12 => Some(RawVideoFormat::Nv12),
        _ => None,
    }
}

impl PipelineSourceTask for CameraSource {
    type Output = FFVideo;

    type Clock = SynchronisedClock<Instant>;

    #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        tracing::info!("Preparing camera source thread...");

        match create_camera(&self.info) {
            Ok(mut camera) if camera.camera_format() == self.format => {
                ready_signal.send(Ok(())).unwrap();
                let mut capturing = false;
                let info = self.info();

                loop {
                    match control_signal.last() {
                        Some(Control::Play) => {
                            if !capturing {
                                camera
                                    .open_stream()
                                    .expect("Failed to start camera recording");
                                capturing = true;

                                tracing::info!("Camera recording started.");
                            }

                            match camera.frame() {
                                // TODO: Set PTS in nokhwa library
                                Ok(frame) => match clock.timestamp_for(Instant::now()) {
                                    None => {
                                        tracing::warn!(
                                            "Clock is currently stopped. Dropping frames."
                                        )
                                    }
                                    Some(timestamp) => {
                                        let buffer = info.wrap_frame(
                                            frame.buffer(),
                                            timestamp.try_into().unwrap(),
                                        );
                                        if let Err(_) = output.send(buffer) {
                                            tracing::warn!(
                                                "Pipeline is unreachable. Dropping samples."
                                            )
                                        }
                                    }
                                },
                                Err(error) => {
                                    tracing::error!("Capture error: {error}");
                                    break;
                                }
                            }
                        }
                        Some(Control::Pause) => {
                            if capturing {
                                camera
                                    .stop_stream()
                                    .expect("Failed to halt camera recording");
                                capturing = false;
                            }
                        }
                        Some(Control::Shutdown) | None => {
                            if capturing {
                                camera
                                    .stop_stream()
                                    .expect("Failed to halt camera recording");
                            }
                            break;
                        }
                    }
                }
            }
            _ => ready_signal
                .send(Err(MediaError::TaskLaunch(
                    "Failed to create camera stream".into(),
                )))
                .unwrap(),
        };

        tracing::info!("Shutting down screen capture source thread.");
    }
}
