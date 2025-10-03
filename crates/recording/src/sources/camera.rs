use cap_media_info::VideoInfo;
use ffmpeg::frame;
use flume::{Receiver, Sender};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::{error, info};

use crate::{
    MediaError,
    feeds::camera::{self, CameraFeedLock, RawCameraFrame},
    pipeline::{control::Control, task::PipelineSourceTask},
};

pub struct CameraSource {
    feed: Arc<CameraFeedLock>,
    video_info: VideoInfo,
    output: Sender<(frame::Video, f64)>,
    first_frame_instant: Option<Instant>,
    first_frame_timestamp: Option<Duration>,
    start_instant: Instant,
}

impl CameraSource {
    pub fn init(
        feed: Arc<CameraFeedLock>,
        output: Sender<(frame::Video, f64)>,
        start_instant: Instant,
    ) -> Self {
        Self {
            video_info: *feed.video_info(),
            feed,
            output,
            first_frame_instant: None,
            first_frame_timestamp: None,
            start_instant,
        }
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    fn process_frame(
        &self,
        camera_frame: RawCameraFrame,
        first_frame_instant: Instant,
        first_frame_timestamp: Duration,
    ) -> Result<(), MediaError> {
        let check_skip_send = || {
            cap_fail::fail_err!("media::sources::camera::skip_send", ());

            Ok::<(), ()>(())
        };

        if check_skip_send().is_err() {
            return Ok(());
        }

        let relative_timestamp = camera_frame.timestamp - first_frame_timestamp;

        if self
            .output
            .send((
                camera_frame.frame,
                (first_frame_instant + relative_timestamp - self.start_instant).as_secs_f64(),
            ))
            .is_err()
        {
            return Err(MediaError::Any(
                "Pipeline is unreachable! Stopping capture".into(),
            ));
        }

        Ok(())
    }

    fn pause_and_drain_frames(&mut self, frames_rx: Receiver<RawCameraFrame>) {
        let frames: Vec<RawCameraFrame> = frames_rx.drain().collect();
        drop(frames_rx);

        for frame in frames {
            let first_frame_instant = *self.first_frame_instant.get_or_insert(frame.reference_time);
            let first_frame_timestamp = *self.first_frame_timestamp.get_or_insert(frame.timestamp);

            if let Err(error) =
                self.process_frame(frame, first_frame_instant, first_frame_timestamp)
            {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for CameraSource {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        let mut frames_rx: Option<Receiver<RawCameraFrame>> = None;

        info!("Camera source ready");

        let frames = frames_rx.get_or_insert_with(|| {
            let (tx, rx) = flume::bounded(5);
            let _ = self.feed.ask(camera::AddSender(tx)).blocking_send();
            rx
        });

        ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => match frames.drain().last().or_else(|| frames.recv().ok()) {
                    Some(frame) => {
                        let first_frame_instant =
                            *self.first_frame_instant.get_or_insert(frame.reference_time);
                        let first_frame_timestamp =
                            *self.first_frame_timestamp.get_or_insert(frame.timestamp);

                        if let Err(error) =
                            self.process_frame(frame, first_frame_instant, first_frame_timestamp)
                        {
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

        Ok(())
    }
}
