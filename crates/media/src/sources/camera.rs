use flume::{Receiver, Sender};
use std::time::{Instant, SystemTime};
use tracing::{error, info};

use crate::{
    data::{FFVideo, VideoInfo},
    feeds::{CameraConnection, CameraFeed, RawCameraFrame},
    pipeline::{clock::RealTimeClock, control::Control, task::PipelineSourceTask},
    MediaError,
};

pub struct CameraSource {
    feed_connection: CameraConnection,
    video_info: VideoInfo,
    output: Sender<(FFVideo, f64)>,
    start_time: SystemTime,
}

impl CameraSource {
    pub fn init(feed: &CameraFeed, output: Sender<(FFVideo, f64)>, start_time: SystemTime) -> Self {
        Self {
            feed_connection: feed.create_connection(),
            video_info: feed.video_info(),
            output,
            start_time,
        }
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    fn process_frame(&self, camera_frame: RawCameraFrame) -> Result<(), MediaError> {
        let RawCameraFrame { frame, captured_at } = camera_frame;
        if let Err(_) = self.output.send((
            frame,
            captured_at
                .duration_since(self.start_time)
                .unwrap()
                .as_secs_f64(),
        )) {
            return Err(MediaError::Any("Pipeline is unreachable! Stopping capture"));
        }

        Ok(())
    }

    fn pause_and_drain_frames(&self, frames_rx: Receiver<RawCameraFrame>) {
        let frames: Vec<RawCameraFrame> = frames_rx.drain().collect();
        drop(frames_rx);

        for frame in frames {
            if let Err(error) = self.process_frame(frame) {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for CameraSource {
    type Clock = RealTimeClock<Instant>;

    // #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        _: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) {
        let mut frames_rx: Option<Receiver<RawCameraFrame>> = None;

        info!("Camera source ready");

        let frames = frames_rx.get_or_insert_with(|| self.feed_connection.attach());

        ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => match frames.drain().last().or_else(|| frames.recv().ok()) {
                    Some(frame) => {
                        if let Err(error) = self.process_frame(frame) {
                            eprintln!("{error}");
                            break;
                        }
                    }
                    None => {
                        error!("Lost connection with the camera feed");
                        break;
                    }
                },
                Some(Control::Shutdown) | None => {
                    if let Some(rx) = frames_rx.take() {
                        self.pause_and_drain_frames(rx);
                    }
                    info!("Camera source stopped");
                    break;
                }
            }
        }
    }
}
