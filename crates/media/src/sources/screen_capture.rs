use cap_flags::FLAGS;
use flume::Sender;
use scap::{
    capturer::{
        get_output_frame_size, Area, Capturer, Options, Point, Resolution as ScapResolution, Size,
    },
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
    MediaError,
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
    pub refresh_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureScreen {
    pub id: u32,
    pub name: String,
    pub refresh_rate: u32,
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

impl ScreenCaptureTarget {
    pub fn recording_fps(&self) -> u32 {
        match self {
            ScreenCaptureTarget::Window(window) => window.refresh_rate,
            ScreenCaptureTarget::Screen(screen) => screen.refresh_rate,
        }
        .min(MAX_FPS)
    }
}

#[derive(Debug)]
pub struct ScreenCaptureSource<TCaptureFormat> {
    target: ScreenCaptureTarget,
    output_resolution: Option<ScapResolution>,
    output_type: Option<FrameType>,
    fps: u32,
    video_info: VideoInfo,
    _phantom: std::marker::PhantomData<TCaptureFormat>,
}

impl<TCaptureFormat> Clone for ScreenCaptureSource<TCaptureFormat> {
    fn clone(&self) -> Self {
        Self {
            target: self.target.clone(),
            output_resolution: self.output_resolution,
            output_type: self.output_type,
            fps: self.fps,
            video_info: self.video_info.clone(),
            _phantom: std::marker::PhantomData,
        }
    }
}

const MAX_FPS: u32 = 60;

impl<TCaptureFormat> ScreenCaptureSource<TCaptureFormat> {
    pub fn init(
        target: &ScreenCaptureTarget,
        output_resolution: Option<cap_project::Resolution>,
        output_type: Option<FrameType>,
    ) -> Self {
        let mut this = Self {
            target: target.clone(),
            output_resolution: output_resolution.map(|r| {
                // Choose the closest resolution based on height
                if r.height <= 480 {
                    ScapResolution::_480p
                } else if r.height <= 720 {
                    ScapResolution::_720p
                } else if r.height <= 1080 {
                    ScapResolution::_1080p
                } else if r.height <= 1440 {
                    ScapResolution::_1440p
                } else if r.height <= 2160 {
                    ScapResolution::_2160p
                } else {
                    ScapResolution::_4320p
                }
            }),
            output_type,
            fps: target.recording_fps(),
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, 0, 0, MAX_FPS),
            _phantom: std::marker::PhantomData,
        };

        let options = this.create_options();

        let [frame_width, frame_height] = get_output_frame_size(&options);
        this.video_info =
            VideoInfo::from_raw(RawVideoFormat::Bgra, frame_width, frame_height, MAX_FPS);

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
            ScreenCaptureTarget::Window(w) => {
                #[cfg(target_os = "macos")]
                {
                    targets.into_iter().find(|t| match &t {
                        Target::Window(window) if window.id == w.id => true,
                        _ => false,
                    })
                }
                #[cfg(not(target_os = "macos"))]
                {
                    todo!()
                }
            }
            ScreenCaptureTarget::Screen(capture_screen) => targets
                .iter()
                .find(|t| match t {
                    Target::Display(display) => display.id == capture_screen.id,
                    _ => false,
                })
                .cloned(),
        }
        .expect("Capture target not found");

        Options {
            fps: self.fps,
            show_cursor: FLAGS.record_mouse,
            show_highlight: true,
            target: Some(target),
            crop_area,
            output_type: self.output_type.unwrap_or(FrameType::YUVFrame),
            output_resolution: self.output_resolution.unwrap_or(ScapResolution::Captured),
            excluded_targets: Some(excluded_targets),
        }
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
        let mut capturer = match Capturer::build(dbg!(options)) {
            Ok(capturer) => capturer,
            Err(e) => {
                let error = format!("Failed to build capturer: {e}");
                eprintln!("{}", error);
                ready_signal
                    .send(Err(MediaError::Any("Failed to build capturer")))
                    .unwrap();
                return;
            }
        };
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
        let mut capturer = match Capturer::build(dbg!(self.create_options())) {
            Ok(capturer) => capturer,
            Err(e) => {
                let error = format!("Failed to build capturer: {e}");
                eprintln!("{}", error);
                ready_signal
                    .send(Err(MediaError::Any("Failed to build capturer")))
                    .unwrap();
                return;
            }
        };
        let mut capturing = false;
        ready_signal.send(Ok(())).ok();

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

pub fn list_screens() -> Vec<(CaptureScreen, Target)> {
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
        targets.push((
            CaptureScreen {
                id: screen.id,
                name: names
                    .get(&screen.id)
                    .cloned()
                    .unwrap_or_else(|| format!("Screen {}", idx + 1)),
                refresh_rate: get_target_fps(&Target::Display(screen.clone())).unwrap(),
            },
            Target::Display(screen),
        ));
    }
    targets
}

pub fn list_windows() -> Vec<(CaptureWindow, Target)> {
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
        .filter_map(|target| match &target {
            Target::Window(window) => {
                let id = window.id;
                platform_windows.get(&id).map(|platform_window| {
                    (
                        CaptureWindow {
                            id,
                            owner_name: platform_window.owner_name.clone(),
                            name: platform_window.name.clone(),
                            bounds: platform_window.bounds,
                            refresh_rate: get_target_fps(&target).unwrap(),
                        },
                        target,
                    )
                })
            }
            Target::Display(_) => None,
        })
        .collect()
}

pub fn get_target_fps(target: &scap::Target) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        match target {
            scap::Target::Display(display) => refresh_rate_for_display(display.raw_handle.id),
            scap::Target::Window(window) => {
                refresh_rate_for_display(display_for_window(window.raw_handle)?.id)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        todo!()
    }
}

#[cfg(target_os = "macos")]
fn display_for_window(
    window: core_graphics::window::CGWindowID,
) -> Option<core_graphics::display::CGDisplay> {
    use core_foundation::array::CFArray;
    use core_graphics::{
        display::{CFDictionary, CGDisplay, CGRect},
        window::{create_description_from_array, kCGWindowBounds},
    };

    let descriptions = create_description_from_array(CFArray::from_copyable(&[window]))?;

    let window_bounds = CGRect::from_dict_representation(
        &descriptions
            .get(0)?
            .get(unsafe { kCGWindowBounds })
            .downcast::<CFDictionary>()?,
    )?;

    for id in CGDisplay::active_displays().ok()? {
        let display = CGDisplay::new(id);
        if window_bounds.is_intersects(&display.bounds()) {
            return Some(display);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn refresh_rate_for_display(display_id: core_graphics::display::CGDirectDisplayID) -> Option<u32> {
    use core_graphics::display::CGDisplay;

    Some(
        CGDisplay::new(display_id)
            .display_mode()?
            .refresh_rate()
            .round() as u32,
    )
}
