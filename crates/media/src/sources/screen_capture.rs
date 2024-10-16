use flume::Sender;
use scap::{
    capturer::{get_output_frame_size, Area, Capturer, Options, Point, Resolution, Size},
    frame::{Frame, FrameType},
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

use crate::pipeline::{clock::*, control::Control, task::PipelineSourceTask};
use crate::{
    data::{FFVideo, RawVideoFormat, VideoInfo},
    platform::{Bounds, Window},
};

static EXCLUDED_WINDOWS: [&'static str; 4] = [
    "Cap",
    "Cap Camera",
    "Cap Recordings",
    "Cap In Progress Recording",
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureWindow {
    pub id: u32,
    pub name: String,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window(CaptureWindow),
    // TODO: Bring back selectable screens/multi-screen support once I figure out the UI
    Screen,
    // Screen {
    //     id: u32,
    //     name: String,
    // },
}

// impl Default for ScreenCaptureTarget {
//     fn default() -> Self {
//         let target = scap::targets::get_main_display();

//         Self::Screen {
//             id: target.id,
//             name: target.title,
//         }
//     }
// }

impl PartialEq<Target> for ScreenCaptureTarget {
    fn eq(&self, other: &Target) -> bool {
        match (self, other) {
            (Self::Window(capture_window), Target::Window(window)) => {
                window.id == capture_window.id
            }
            // (Self::Screen { id, .. }, Target::Display(display)) => display.id == *id,
            (Self::Screen, Target::Display(_)) => true,
            _ => false,
        }
    }
}

pub struct ScreenCaptureSource {
    options: Options,
    video_info: VideoInfo,
    target: ScreenCaptureTarget,
}

impl ScreenCaptureSource {
    pub const DEFAULT_FPS: u32 = 30;

    // TODO: Settings that can be passed here to control video quality
    pub fn init(
        capture_target: &ScreenCaptureTarget,
        fps: Option<u32>,
        resolution: Option<Resolution>,
    ) -> Self {
        let fps = fps.unwrap_or(Self::DEFAULT_FPS);
        let output_resolution = resolution.unwrap_or(Resolution::Captured);
        let targets = scap::get_all_targets();

        // TODO: Revert to using actual target not crop area
        // warning: this will fall back to the default display if the selected capture target
        // is not in the current list
        // let target = targets
        //     .iter()
        //     .find(|target| capture_target.eq(target))
        //     .cloned();
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

        let crop_area = match capture_target {
            ScreenCaptureTarget::Window(capture_window) => Some(Area {
                size: Size {
                    width: capture_window.bounds.width,
                    height: capture_window.bounds.height,
                },
                origin: Point {
                    x: capture_window.bounds.x,
                    y: capture_window.bounds.y,
                },
            }),
            ScreenCaptureTarget::Screen => None,
        };

        let options = Options {
            fps,
            // target,
            show_cursor: true,
            show_highlight: true,
            excluded_targets: Some(excluded_targets),
            output_type: FrameType::BGRAFrame,
            output_resolution,
            crop_area,
            ..Default::default()
        };

        let [frame_width, frame_height] = get_output_frame_size(&options);

        Self {
            options,
            target: capture_target.clone(),
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, frame_width, frame_height, fps),
        }
    }

    pub fn list_targets() -> Vec<CaptureWindow> {
        if !scap::has_permission() {
            return vec![];
        }

        let targets = scap::get_all_targets();

        let platform_windows: HashMap<u32, Window> = crate::platform::get_on_screen_windows()
            .into_iter()
            .map(|window| (window.window_id, window))
            .collect();

        targets
            .into_iter()
            .filter_map(|target| match target {
                Target::Window(window) => {
                    platform_windows.get(&window.id).map(|platform_window| {
                        CaptureWindow {
                            id: window.id,
                            // TODO: Only include window name if application has more than one window open?
                            name: format!(
                                "{} - {}",
                                platform_window.owner_name, platform_window.name
                            ),
                            bounds: platform_window.bounds,
                        }
                    })
                }
                Target::Display(_) => None,
                // Target::Display(display) => Some(ScreenCaptureTarget::Screen {
                //     id: display.id,
                //     name: display.title,
                // }),
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

    // #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing screen capture source thread...");

        let maybe_capture_window_id = match &self.target {
            ScreenCaptureTarget::Window(window) => Some(window.id),
            _ => None,
        };
        let mut capturer = Capturer::new(self.options.clone());
        let mut capturing = false;
        let _ = ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    if !capturing {
                        if let Some(window_id) = maybe_capture_window_id {
                            crate::platform::bring_window_to_focus(window_id);
                        }
                        capturer.start_capture();
                        capturing = true;

                        println!("Screen recording started.");
                    }

                    match capturer.get_next_frame() {
                        Ok(Frame::BGRA(frame)) => {
                            let raw_timestamp = RawNanoseconds(frame.display_time);
                            match clock.timestamp_for(raw_timestamp) {
                                None => {
                                    eprintln!("Clock is currently stopped. Dropping frames.")
                                }
                                Some(timestamp) => {
                                    // TODO: I wonder if we should do stride adjustments here or leave it for later (as it is now).
                                    let buffer = self.video_info.wrap_frame(&frame.data, timestamp);

                                    if let Err(_) = output.send(buffer) {
                                        eprintln!(
                                            "Pipeline is unreachable. Shutting down recording."
                                        );
                                        break;
                                    }
                                }
                            };
                        }
                        Ok(_) => unreachable!(),
                        Err(error) => {
                            eprintln!("Capture error: {error}");
                            break;
                        }
                    }
                }
                Some(Control::Pause) => {
                    println!("Received pause signal");
                    if capturing {
                        capturer.stop_capture();
                        capturing = false;
                    }
                }
                Some(Control::Shutdown) | None => {
                    println!("Received shutdown signal");
                    if capturing {
                        capturer.stop_capture();
                    }
                    break;
                }
            }
        }

        println!("Shutting down screen capture source thread.");
    }
}
