use flume::Sender;
use scap::{
    capturer::{get_output_frame_size, Capturer, Options, Resolution},
    frame::{Frame, FrameType},
    Target,
};
use serde::Serialize;
use specta::Type;
use std::collections::HashSet;

use crate::data::{FFVideo, RawVideoFormat, VideoInfo};
use crate::pipeline::{clock::*, control::Control, task::PipelineSourceTask};

static EXCLUDED_WINDOWS: [&'static str; 4] = [
    "Cap",
    "Cap Camera",
    "Cap Recordings",
    "Cap In Progress Recording",
];

#[derive(Serialize, Type)]
pub enum CaptureTarget {
    Window { id: u32, name: String },
    Screen { id: u32, name: String },
}

impl PartialEq<Target> for CaptureTarget {
    fn eq(&self, other: &Target) -> bool {
        match (self, other) {
            (Self::Window { id, .. }, Target::Window(window)) => window.id == *id,
            (Self::Screen { id, .. }, Target::Display(display)) => display.id == *id,
            _ => false,
        }
    }
}

pub struct ScreenCaptureSource {
    options: Options,
    video_info: VideoInfo,
}

impl ScreenCaptureSource {
    pub const DEFAULT_FPS: u32 = 30;

    // TODO: Settings that can be passed here to control video quality
    pub fn init(
        capture_target: &CaptureTarget,
        fps: Option<u32>,
        resolution: Option<Resolution>,
    ) -> Self {
        let fps = fps.unwrap_or(Self::DEFAULT_FPS);
        let output_resolution = resolution.unwrap_or(Resolution::Captured);
        let targets = scap::get_all_targets();

        // warning: this will fall back to the default display if the selected capture target
        // is not in the current list
        let target = targets
            .iter()
            .find(|target| capture_target.eq(target))
            .cloned();
        let excluded_targets: Vec<scap::Target> = targets
            .into_iter()
            .filter(|target| match target {
                Target::Window(scap_window)
                    if EXCLUDED_WINDOWS.contains(&scap_window.title.as_str()) =>
                {
                    true
                }
                _ => false,
            })
            .collect();

        let options = Options {
            fps,
            target,
            show_cursor: true,
            show_highlight: true,
            excluded_targets: Some(excluded_targets),
            output_type: FrameType::BGRAFrame,
            output_resolution,
            crop_area: None,
        };

        let [frame_width, frame_height] = get_output_frame_size(&options);

        Self {
            options,
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, frame_width, frame_height, fps),
        }
    }

    pub fn list_targets() -> Vec<CaptureTarget> {
        if !scap::has_permission() {
            return vec![];
        }

        let targets = scap::get_all_targets();

        let valid_window_ids: HashSet<u32> = crate::platform::get_on_screen_windows()
            .iter()
            .map(|window| window.window_id)
            .collect();

        targets
            .into_iter()
            .filter_map(|target| match target {
                Target::Window(window) => match valid_window_ids.contains(&window.id) {
                    true => Some(CaptureTarget::Window {
                        id: window.id,
                        name: window.title,
                    }),
                    false => None,
                },
                Target::Display(display) => Some(CaptureTarget::Screen {
                    id: display.id,
                    name: display.title,
                }),
            })
            .collect()
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }
}

impl PipelineSourceTask for ScreenCaptureSource {
    type Clock = SynchronisedClock<RawNanoseconds>;
    type Output = FFVideo;

    #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        tracing::info!("Preparing screen capture source thread...");

        let mut capturer = Capturer::new(self.options.clone());
        let mut capturing = false;
        let _ = ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    if !capturing {
                        capturer.start_capture();
                        capturing = true;

                        tracing::info!("Screen recording started.");
                    }

                    match capturer.get_next_frame() {
                        Ok(Frame::BGRA(frame)) => {
                            let raw_timestamp = RawNanoseconds(frame.display_time);
                            match clock.timestamp_for(raw_timestamp) {
                                None => {
                                    tracing::warn!("Clock is currently stopped. Dropping frames.")
                                }
                                Some(timestamp) => {
                                    // TODO: I wonder if we should do stride adjustments here or leave it for later (as it is now).
                                    let buffer = self.video_info.wrap_frame(&frame.data, timestamp);

                                    if let Err(_) = output.send(buffer) {
                                        tracing::error!(
                                            "Pipeline is unreachable. Shutting down recording."
                                        );
                                        break;
                                    }
                                }
                            };
                        }
                        Ok(_) => unreachable!(),
                        Err(error) => {
                            tracing::error!("Capture error: {error}");
                            break;
                        }
                    }
                }
                Some(Control::Pause) => {
                    tracing::info!("Received pause signal");
                    if capturing {
                        capturer.stop_capture();
                        capturing = false;
                    }
                }
                Some(Control::Shutdown) | None => {
                    tracing::info!("Received shutdown signal");
                    if capturing {
                        capturer.stop_capture();
                    }
                    break;
                }
            }
        }

        tracing::info!("Shutting down screen capture source thread.");
    }
}
