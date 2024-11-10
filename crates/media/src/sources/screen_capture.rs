use cap_flags::FLAGS;
use cidre::cm;
use core_foundation::base::{kCFAllocatorDefault, CFAllocatorRef};
use flume::Sender;
use scap::{
    capturer::{get_output_frame_size, Area, Capturer, Options, Point, Resolution, Size},
    frame::FrameType,
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    ffi::c_void,
    path::PathBuf,
    ptr::{null, null_mut},
};

use crate::{
    data::{FFVideo, RawVideoFormat, VideoInfo},
    pipeline::{clock::*, control::Control, task::PipelineSourceTask},
    platform::{self, Bounds, Window},
};

static EXCLUDED_WINDOWS: [&str; 4] = [
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
            }
            (ScreenCaptureTarget::Screen(capture_screen), Target::Display(display)) => {
                display.id == capture_screen.id
            }
            (&ScreenCaptureTarget::Window(_), &scap::Target::Display(_))
            | (&ScreenCaptureTarget::Screen(_), &scap::Target::Window(_)) => todo!(),
        }
    }
}

pub struct ScreenCaptureSource<T> {
    options: Options,
    video_info: VideoInfo,
    target: ScreenCaptureTarget,
    pub bounds: Bounds,
    phantom: std::marker::PhantomData<T>,
}

impl<T> ScreenCaptureSource<T> {
    pub const DEFAULT_FPS: u32 = 30;

    pub fn init(
        capture_target: &ScreenCaptureTarget,
        fps: Option<u32>,
        resolution: Option<Resolution>,
    ) -> Self {
        let fps = fps.unwrap_or(Self::DEFAULT_FPS);
        let output_resolution = resolution.unwrap_or(Resolution::Captured);
        let targets = dbg!(scap::get_all_targets());

        let excluded_targets: Vec<scap::Target> = targets
            .iter()
            .filter(|target| {
                matches!(target, Target::Window(scap_window)
                    if EXCLUDED_WINDOWS.contains(&scap_window.title.as_str()))
            })
            .cloned()
            .collect();

        let (crop_area, bounds) = match capture_target {
            ScreenCaptureTarget::Window(capture_window) => (
                Some(Area {
                    size: Size {
                        width: capture_window.bounds.width,
                        height: capture_window.bounds.height,
                    },
                    origin: Point {
                        x: capture_window.bounds.x,
                        y: capture_window.bounds.y,
                    },
                }),
                capture_window.bounds,
            ),
            ScreenCaptureTarget::Screen(capture_screen) => {
                (None, platform::monitor_bounds(capture_screen.id))
            }
        };

        let target = match capture_target {
            ScreenCaptureTarget::Window(w) => None,
            ScreenCaptureTarget::Screen(capture_screen) => targets
                .iter()
                .find(|t| match t {
                    Target::Display(display) => display.id == capture_screen.id,
                    _ => false,
                })
                .cloned(),
        };

        let options = Options {
            fps,
            show_cursor: !FLAGS.zoom,
            show_highlight: true,
            excluded_targets: Some(excluded_targets),
            output_type: FrameType::YUVFrame,
            output_resolution,
            crop_area,
            target,
            ..Default::default()
        };

        let [frame_width, frame_height] = get_output_frame_size(&options);

        Self {
            options,
            target: capture_target.clone(),
            bounds,
            video_info: VideoInfo::from_raw(RawVideoFormat::Nv12, frame_width, frame_height, fps),
            phantom: Default::default(),
        }
    }

    pub fn list_screens() -> Vec<CaptureScreen> {
        if !scap::has_permission() {
            return vec![];
        }

        let mut targets = vec![];
        let screens = scap::get_all_targets().into_iter().filter_map(|t| match t {
            Target::Display(screen) => Some(screen),
            _ => None,
        });

        let names = crate::platform::window_names();

        for (idx, screen) in screens.into_iter().enumerate() {
            // Handle Target::Screen variant (assuming this is how it's structured in scap)
            #[cfg(target_os = "macos")]
            targets.push(CaptureScreen {
                id: screen.id,
                name: names
                    .get(&screen.raw_handle.id)
                    .cloned()
                    .unwrap_or_else(|| format!("Screen {}", idx + 1)),
            });
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

pub struct AVFrameCapture;

impl PipelineSourceTask for ScreenCaptureSource<AVFrameCapture> {
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

        let maybe_capture_window_id = match &self.target {
            ScreenCaptureTarget::Window(window) => Some(window.id),
            _ => None,
        };
        let mut capturer = Capturer::new(dbg!(self.options.clone()));
        let mut capturing = false;
        ready_signal.send(Ok(())).unwrap();

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

                    match capturer.raw().get_next_pixel_buffer() {
                        Ok(pixel_buffer) => {
                            if pixel_buffer.height() == 0 || pixel_buffer.width() == 0 {
                                continue;
                            }

                            let raw_timestamp = RawNanoseconds(pixel_buffer.display_time());
                            match clock.timestamp_for(raw_timestamp) {
                                None => {
                                    eprintln!("Clock is currently stopped. Dropping frames.");
                                }
                                Some(timestamp) => {
                                    let mut frame = FFVideo::new(
                                        self.video_info.pixel_format,
                                        self.video_info.width,
                                        self.video_info.height,
                                    );
                                    frame.set_pts(Some(timestamp));

                                    let planes = pixel_buffer.planes();

                                    for (i, plane) in planes.into_iter().enumerate() {
                                        let data = plane.data();

                                        for y in 0..plane.height() {
                                            let buffer_y_offset = y * plane.bytes_per_row();
                                            let frame_y_offset = y * frame.stride(i);

                                            let num_bytes =
                                                frame.stride(i).min(plane.bytes_per_row());

                                            frame.data_mut(i)
                                                [frame_y_offset..frame_y_offset + num_bytes]
                                                .copy_from_slice(
                                                    &data[buffer_y_offset
                                                        ..buffer_y_offset + num_bytes],
                                                );
                                        }
                                    }

                                    if let Err(_) = output.send(frame) {
                                        eprintln!(
                                            "Pipeline is unreachable. Shutting down recording."
                                        );
                                        break;
                                    }
                                }
                            };
                        }
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

#[cfg(target_os = "macos")]
pub struct CMSampleBufferCapture;

#[cfg(target_os = "macos")]
impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
    type Clock = SynchronisedClock<RawNanoseconds>;
    type Output = screencapturekit::cm_sample_buffer::CMSampleBuffer;

    fn run(
        &mut self,
        _: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        use cidre::*;

        println!("Preparing screen capture source thread...");

        let maybe_capture_window_id = match &self.target {
            ScreenCaptureTarget::Window(window) => Some(window.id),
            _ => None,
        };
        let mut capturer = Capturer::new(dbg!(self.options.clone()));
        let mut capturing = false;
        ready_signal.send(Ok(())).unwrap();

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

                    match capturer.raw().get_next_pixel_buffer() {
                        Ok(pixel_buffer) => {
                            if pixel_buffer.height() == 0 || pixel_buffer.width() == 0 {
                                continue;
                            }

                            if let Err(_) = output.send(pixel_buffer.into()) {
                                eprintln!("Pipeline is unreachable. Shutting down recording.");
                                break;
                            }
                        }
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
