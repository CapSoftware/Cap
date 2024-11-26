use cap_flags::FLAGS;
use flume::Sender;
use scap::{
    capturer::{get_output_frame_size, Area, Capturer, Options, Point, Resolution, Size},
    frame::{Frame, FrameType},
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

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
    pub owner_name: String,
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
    target: ScreenCaptureTarget,
    fps: u32,
    resolution: Resolution,
    video_info: VideoInfo,
    phantom: std::marker::PhantomData<T>,
}

impl<T> Clone for ScreenCaptureSource<T> {
    fn clone(&self) -> Self {
        Self {
            target: self.target.clone(),
            fps: self.fps,
            resolution: self.resolution,
            video_info: self.video_info,
            phantom: Default::default(),
        }
    }
}

unsafe impl<T> Send for ScreenCaptureSource<T> {}
unsafe impl<T> Sync for ScreenCaptureSource<T> {}

impl<T> ScreenCaptureSource<T> {
    pub const DEFAULT_FPS: u32 = 30;

    pub fn init(
        capture_target: &ScreenCaptureTarget,
        fps: Option<u32>,
        resolution: Option<Resolution>,
    ) -> Self {
        let output_resolution = resolution.unwrap_or(Resolution::Captured);
        let fps = fps.unwrap_or(Self::DEFAULT_FPS);

        let mut this = Self {
            target: capture_target.clone(),
            fps,
            resolution: output_resolution,
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, 0, 0, fps),
            phantom: Default::default(),
        };

        let options = this.create_options();

        let [frame_width, frame_height] = get_output_frame_size(&options);

        this.video_info = VideoInfo::from_raw(RawVideoFormat::Bgra, frame_width, frame_height, fps);

        this
    }

    pub fn get_bounds(&self) -> Bounds {
        match &self.target {
            ScreenCaptureTarget::Window(capture_window) => capture_window.bounds,
            ScreenCaptureTarget::Screen(capture_screen) => {
                platform::monitor_bounds(capture_screen.id)
            }
        }
    }

    fn create_options(&self) -> Options {
        let targets = dbg!(scap::get_all_targets());

        let excluded_targets: Vec<scap::Target> = targets
            .iter()
            .filter(|target| {
                matches!(target, Target::Window(scap_window)
                if EXCLUDED_WINDOWS.contains(&scap_window.title.as_str()))
            })
            .cloned()
            .collect();

        let crop_area = match &self.target {
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
            ScreenCaptureTarget::Screen(_) => None,
        };

        let target = match &self.target {
            ScreenCaptureTarget::Window(w) => None,
            ScreenCaptureTarget::Screen(capture_screen) => targets
                .iter()
                .find(|t| match t {
                    Target::Display(display) => display.id == capture_screen.id,
                    _ => false,
                })
                .cloned(),
        };

        Options {
            fps: self.fps,
            show_cursor: !FLAGS.record_mouse,
            show_highlight: true,
            excluded_targets: Some(excluded_targets),
            output_type: if cfg!(windows) {
                FrameType::BGRAFrame
            } else {
                FrameType::YUVFrame
            },
            output_resolution: self.resolution,
            crop_area,
            target,
            ..Default::default()
        }
    }

    pub fn list_screens() -> Vec<CaptureScreen> {
        if !scap::has_permission() {
            return vec![];
        }

        let mut targets = vec![];
        let screens = scap::get_all_targets()
            .into_iter()
            .filter_map(|t| match t {
                Target::Display(screen) => Some(screen),
                _ => None,
            })
            .collect::<Vec<_>>();

        let names = crate::platform::display_names();

        for (idx, screen) in screens.into_iter().enumerate() {
            targets.push(CaptureScreen {
                id: screen.id,
                name: names
                    .get(&screen.id)
                    .cloned()
                    .unwrap_or_else(|| format!("Screen {}", idx + 1)),
            });
        }
        targets
    }

    pub fn list_windows() -> Vec<CaptureWindow> {
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
                            owner_name: platform_window.owner_name.clone(),
                            name: platform_window.name.clone(),
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
    type Clock = RealTimeClock<RawNanoseconds>;
    type Output = FFVideo;

    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing screen capture source thread...");

        let options = self.create_options();

        let maybe_capture_window_id = match &self.target {
            ScreenCaptureTarget::Window(window) => Some(window.id),
            _ => None,
        };
        let mut capturer = Capturer::new(dbg!(options));
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

                    match capturer.get_next_frame() {
                        Ok(Frame::BGRA(frame)) => {
                            if frame.height == 0 || frame.width == 0 {
                                continue;
                            }

                            let raw_timestamp = RawNanoseconds(frame.display_time);
                            match clock.timestamp_for(raw_timestamp) {
                                None => {
                                    eprintln!("Clock is currently stopped. Dropping frames.");
                                }
                                Some(timestamp) => {
                                    let mut buffer = FFVideo::new(
                                        self.video_info.pixel_format,
                                        self.video_info.width,
                                        self.video_info.height,
                                    );
                                    buffer.set_pts(Some(timestamp));

                                    let bytes_per_pixel = 4;
                                    let width_in_bytes = frame.width as usize * bytes_per_pixel;
                                    let height = frame.height as usize;

                                    let src_data = &frame.data;

                                    let src_stride = src_data.len() / height;
                                    let dst_stride = buffer.stride(0);

                                    if src_data.len() < src_stride * height {
                                        eprintln!("Frame data size mismatch.");
                                        continue;
                                    }

                                    if src_stride < width_in_bytes {
                                        eprintln!(
                                            "Source stride is less than expected width in bytes."
                                        );
                                        continue;
                                    }

                                    if buffer.data(0).len() < dst_stride * height {
                                        eprintln!("Destination data size mismatch.");
                                        continue;
                                    }

                                    {
                                        let dst_data = buffer.data_mut(0);

                                        for y in 0..height {
                                            let src_offset = y * src_stride;
                                            let dst_offset = y * dst_stride;
                                            dst_data[dst_offset..dst_offset + width_in_bytes]
                                                .copy_from_slice(
                                                    &src_data
                                                        [src_offset..src_offset + width_in_bytes],
                                                );
                                        }
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

pub struct CMSampleBufferCapture;

#[cfg(target_os = "macos")]
impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
    type Clock = RealTimeClock<RawNanoseconds>;
    type Output = screencapturekit::cm_sample_buffer::CMSampleBuffer;

    fn run(
        &mut self,
        _: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing screen capture source thread...");

        let maybe_capture_window_id = match &self.target {
            ScreenCaptureTarget::Window(window) => Some(window.id),
            _ => None,
        };
        let mut capturer = Capturer::new(dbg!(self.create_options()));
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
                        // capturer.stop_capture();
                    }
                    break;
                }
            }
        }

        println!("Shutting down screen capture source thread.");
    }
}
