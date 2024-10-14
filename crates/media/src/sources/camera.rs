use flume::{Receiver, Sender};
use std::time::Instant;

use crate::{
    data::{FFVideo, VideoInfo},
    feeds::{CameraConnection, CameraFeed, RawCameraFrame},
    pipeline::{clock::SynchronisedClock, control::Control, task::PipelineSourceTask},
    MediaError,
};

pub struct CameraSource {
    feed_connection: CameraConnection,
    video_info: VideoInfo,
}

impl CameraSource {
    pub fn init(camera_feed: Option<&CameraFeed>) -> Option<Self> {
        camera_feed.map(|feed| Self {
            feed_connection: feed.create_connection(),
            video_info: feed.video_info(),
        })
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    fn process_frame(
        &self,
        clock: &mut SynchronisedClock<Instant>,
        output: &Sender<FFVideo>,
        camera_frame: RawCameraFrame,
    ) -> Result<(), MediaError> {
        let RawCameraFrame {
            mut frame,
            captured_at,
        } = camera_frame;
        match clock.timestamp_for(captured_at) {
            None => {
                eprintln!("Clock is currently stopped. Dropping frames.");
            }
            Some(timestamp) => {
                frame.set_pts(Some(timestamp));
                if let Err(_) = output.send(frame) {
                    return Err(MediaError::Any("Pipeline is unreachable! Stopping capture"));
                }
            }
        }

        Ok(())
    }

    fn pause_and_drain_frames(
        &self,
        clock: &mut SynchronisedClock<Instant>,
        output: &Sender<FFVideo>,
        frames_rx: Receiver<RawCameraFrame>,
    ) {
        let frames: Vec<RawCameraFrame> = frames_rx.drain().collect();
        drop(frames_rx);

        for frame in frames {
            if let Err(error) = self.process_frame(clock, output, frame) {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for CameraSource {
    type Output = FFVideo;

    type Clock = SynchronisedClock<Instant>;

    // #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing camera source thread...");
        let mut frames_rx: Option<Receiver<RawCameraFrame>> = None;
        ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    let frames = frames_rx.get_or_insert_with(|| self.feed_connection.attach());

                    match frames.recv() {
                        Ok(frame) => {
                            if let Err(error) = self.process_frame(&mut clock, &output, frame) {
                                eprintln!("{error}");
                                break;
                            }
                        }
                        Err(_) => {
                            eprintln!("Lost connection with the camera feed");
                            break;
                        }
                    }
                }
                Some(Control::Pause) => {
                    // TODO: This blocks to process frames in the queue, which may delay resumption
                    // Some way to prevent this from delaying the listen loop?
                    if let Some(rx) = frames_rx.take() {
                        self.pause_and_drain_frames(&mut clock, &output, rx);
                    }
                }
                Some(Control::Shutdown) | None => {
                    if let Some(rx) = frames_rx.take() {
                        self.pause_and_drain_frames(&mut clock, &output, rx);
                    }
                    break;
                }
            }
        }

        println!("Shutting down screen capture source thread.");
    }
}
