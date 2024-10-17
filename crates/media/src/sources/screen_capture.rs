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
pub struct CaptureScreen {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window(CaptureWindow),
    Screen(CaptureScreen),
}

impl PartialEq<Target> for ScreenCaptureTarget {
    fn eq(&self, other: &Target) -> bool {
        match (self, other) {
            (Self::Window(capture_window), Target::Window(window)) => {
                window.id == capture_window.id
            },
            (ScreenCaptureTarget::Screen(capture_screen), Target::Display(display)) => {
                display.id == capture_screen.id
            },
            (&ScreenCaptureTarget::Window(_), &scap::Target::Display(_)) | (&ScreenCaptureTarget::Screen(_), &scap::Target::Window(_)) => todo!(),
        }
    }
}

pub struct ScreenCaptureSource {
    options: Options,
    video_info: VideoInfo,
}

impl ScreenCaptureSource {
    pub const DEFAULT_FPS: u32 = 30;

    pub fn init(
        capture_target: &ScreenCaptureTarget,
        fps: Option<u32>,
        resolution: Option<Resolution>,
    ) -> Self {
        let fps = fps.unwrap_or(Self::DEFAULT_FPS);
        let output_resolution = resolution.unwrap_or(Resolution::Captured);
        let targets = scap::get_all_targets();

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
            ScreenCaptureTarget::Screen(_capture_screen) => None,
        };

        let options = Options {
            fps,
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
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, frame_width, frame_height, fps),
        }
    }

    pub fn list_screens() -> Vec<CaptureScreen> {
        if !scap::has_permission() {
            return vec![];
        }
    
        let mut targets = vec![];
        let screens = scap::get_all_targets();
    
        for (idx, target) in screens.into_iter().enumerate() {
            // Handle Target::Screen variant (assuming this is how it's structured in scap)
            if let Target::Display(screen) = target {
                // Only add the screen if it hasn't been added already
                targets.push(CaptureScreen {
                    id: screen.id as u32,
                    name: format!("Screen {}", idx + 1),
                });
            }
        }
        targets
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
                    platform_windows
                        .get(&window.id)
                        .map(|platform_window| CaptureWindow {
                            id: window.id,
                            name: format!(
                                "{} - {}",
                                platform_window.owner_name, platform_window.name
                            ),
                            bounds: platform_window.bounds,
                        })
                }
                Target::Display(_) => None,
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

    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing screen capture source thread...");

        let maybe_capture_window_id = match &self.options.target {
            Some(Target::Window(window)) => Some(window.id),
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
                                    let mut buffer = FFVideo::new(
                                        self.video_info.pixel_format,
                                        self.video_info.width,
                                        self.video_info.height,
                                    );
                                    buffer.set_pts(Some(timestamp));

                                    let bytes_per_pixel = 4; // For BGRA format
                                    let width_in_bytes = frame.width as usize * bytes_per_pixel;
                                    let src_stride = width_in_bytes;
                                    let dst_stride = buffer.stride(0) as usize;
                                    let height = frame.height as usize;

                                    let src_data = &frame.data;
                                    let dst_data = buffer.data_mut(0);

                                    // Ensure we don't go out of bounds
                                    if src_data.len() < src_stride * height
                                        || dst_data.len() < dst_stride * height
                                    {
                                        eprintln!("Frame data size mismatch.");
                                        break;
                                    }

                                    // Copy data line by line considering strides
                                    for y in 0..height {
                                        let src_offset = y * src_stride;
                                        let dst_offset = y * dst_stride;
                                        // Copy only the width_in_bytes to avoid overwriting
                                        dst_data[dst_offset..dst_offset + width_in_bytes]
                                            .copy_from_slice(
                                                &src_data[src_offset..src_offset + width_in_bytes],
                                            );
                                    }

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
