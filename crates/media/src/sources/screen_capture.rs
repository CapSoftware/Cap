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
use std::{collections::HashMap, ops::ControlFlow};
use tracing::{error, info, trace, warn};

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
pub struct CaptureArea {
    pub screen: CaptureScreen,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window(CaptureWindow),
    Screen(CaptureScreen),
    Area(CaptureArea),
}

impl PartialEq<Target> for ScreenCaptureTarget {
    fn eq(&self, other: &Target) -> bool {
        match (self, other) {
            (Self::Window(capture_window), Target::Window(window)) => {
                window.id == capture_window.id
            }
            (ScreenCaptureTarget::Area(capture_area), Target::Display(display)) => {
                display.id == capture_area.screen.id
            }
            (ScreenCaptureTarget::Screen(capture_screen), Target::Display(display)) => {
                display.id == capture_screen.id
            }
            (&ScreenCaptureTarget::Window(_), &scap::Target::Display(_))
            | (&ScreenCaptureTarget::Screen(_), &scap::Target::Window(_))
            | (&ScreenCaptureTarget::Area(_), &scap::Target::Window(_)) => todo!(),
        }
    }
}

impl ScreenCaptureTarget {
    pub fn recording_fps(&self) -> u32 {
        match self {
            ScreenCaptureTarget::Window(window) => window.refresh_rate,
            ScreenCaptureTarget::Screen(screen) => screen.refresh_rate,
            ScreenCaptureTarget::Area(area) => area.screen.refresh_rate,
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
            ScreenCaptureTarget::Area(capture_area) => capture_area.bounds,
        }
    }

    fn create_options(&self) -> Options {
        let targets = scap::get_all_targets();

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
            ScreenCaptureTarget::Area(capture_area) => Some(Area {
                size: Size {
                    width: capture_area.bounds.width,
                    height: capture_area.bounds.height,
                },
                origin: Point {
                    x: capture_area.bounds.x,
                    y: capture_area.bounds.y,
                },
            }),
        };

        let target = match &self.target {
            ScreenCaptureTarget::Window(w) => {
                let window_target = targets
                    .iter()
                    .find_map(|t| match t {
                        Target::Window(window) if window.id == w.id => Some(window),
                        _ => None,
                    })
                    .unwrap();

                #[cfg(target_os = "macos")]
                {
                    platform::display_for_window(window_target.raw_handle).and_then(|display| {
                        targets.into_iter().find(|t| match t {
                            Target::Display(d) => d.raw_handle.id == display.id,
                            _ => false,
                        })
                    })
                }
                #[cfg(target_os = "windows")]
                {
                    platform::display_for_window(window_target.raw_handle).and_then(|display| {
                        targets.into_iter().find(|t| match t {
                            Target::Display(d) => d.raw_handle == display,
                            _ => false,
                        })
                    })
                }
                #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                None
            }
            ScreenCaptureTarget::Screen(capture_screen) => targets
                .iter()
                .find(|t| match t {
                    Target::Display(display) => display.id == capture_screen.id,
                    _ => false,
                })
                .cloned(),
            ScreenCaptureTarget::Area(capture_area) => targets
                .iter()
                .find(|t| match t {
                    Target::Display(display) => display.id == capture_area.screen.id,
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
            output_type: self.output_type.unwrap_or(FrameType::BGRAFrame),
            output_resolution: self.output_resolution.unwrap_or(ScapResolution::Captured),
            excluded_targets: None,
            // excluded_targets: Some(excluded_targets),
        }
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }
}

#[derive(Debug)]
pub struct AVFrameCapture;

impl PipelineSourceTask for ScreenCaptureSource<AVFrameCapture> {
    type Clock = RealTimeClock<RawNanoseconds>;
    type Output = FFVideo;

    // #[instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        let video_info = self.video_info;
        inner(
            self,
            ready_signal,
            control_signal,
            |capturer| match capturer.get_next_frame() {
                Ok(Frame::BGRA(frame)) => {
                    if frame.height == 0 || frame.width == 0 {
                        return Some(ControlFlow::Continue(()));
                    }

                    let raw_timestamp = RawNanoseconds(frame.display_time);
                    match clock.timestamp_for(raw_timestamp) {
                        None => {
                            warn!("Clock is currently stopped. Dropping frames.");
                            None
                        }
                        Some(timestamp) => {
                            let mut buffer = FFVideo::new(
                                video_info.pixel_format,
                                video_info.width,
                                video_info.height,
                            );
                            buffer.set_pts(Some(timestamp));

                            let bytes_per_pixel = 4;
                            let width_in_bytes = frame.width as usize * bytes_per_pixel;
                            let height = frame.height as usize;

                            let src_data = &frame.data;

                            let src_stride = src_data.len() / height;
                            let dst_stride = buffer.stride(0);

                            if src_data.len() < src_stride * height {
                                warn!("Frame data size mismatch.");
                                return Some(ControlFlow::Continue(()));
                            }

                            if src_stride < width_in_bytes {
                                warn!("Source stride is less than expected width in bytes.");
                                return Some(ControlFlow::Continue(()));
                            }

                            if buffer.data(0).len() < dst_stride * height {
                                warn!("Destination data size mismatch.");
                                return Some(ControlFlow::Continue(()));
                            }

                            {
                                let dst_data = buffer.data_mut(0);

                                for y in 0..height {
                                    let src_offset = y * src_stride;
                                    let dst_offset = y * dst_stride;
                                    dst_data[dst_offset..dst_offset + width_in_bytes]
                                        .copy_from_slice(
                                            &src_data[src_offset..src_offset + width_in_bytes],
                                        );
                                }
                            }

                            if let Err(_) = output.send(buffer) {
                                error!("Pipeline is unreachable. Shutting down recording.");
                                return Some(ControlFlow::Break(()));
                            }

                            None
                        }
                    }
                }
                Ok(_) => unreachable!(),
                Err(error) => {
                    error!("Capture error: {error}");
                    Some(ControlFlow::Break(()))
                }
            },
        )
    }
}

fn inner<T>(
    source: &mut ScreenCaptureSource<T>,
    ready_signal: crate::pipeline::task::PipelineReadySignal,
    mut control_signal: crate::pipeline::control::PipelineControlSignal,
    mut get_frame: impl FnMut(&mut Capturer) -> Option<ControlFlow<()>>,
) {
    trace!("Preparing screen capture source thread...");

    let maybe_capture_window_id = match &source.target {
        ScreenCaptureTarget::Window(window) => Some(window.id),
        _ => None,
    };
    let mut capturer = match Capturer::build(source.create_options()) {
        Ok(capturer) => capturer,
        Err(e) => {
            error!("Failed to build capturer: {e}");
            ready_signal
                .send(Err(MediaError::Any("Failed to build capturer")))
                .ok();
            return;
        }
    };

    info!("Capturer built");

    let mut capturing = false;
    ready_signal.send(Ok(())).ok();

    let t = std::time::Instant::now();

    loop {
        match control_signal.last() {
            Some(Control::Shutdown) | None => {
                trace!("Received shutdown signal");
                if capturing {
                    capturer.stop_capture();
                    info!("Capturer stopped")
                }
                break;
            }
            Some(Control::Play) => {
                if !capturing {
                    if let Some(window_id) = maybe_capture_window_id {
                        crate::platform::bring_window_to_focus(window_id);
                    }
                    capturer.start_capture();
                    capturing = true;

                    info!("Screen recording started.");
                }

                match get_frame(&mut capturer) {
                    Some(ControlFlow::Break(_)) => {
                        break;
                    }
                    Some(ControlFlow::Continue(_)) => {
                        continue;
                    }
                    None => {}
                }
            }
        }
    }

    info!("Shut down screen capture source thread.");
}

#[derive(Debug)]
pub struct CMSampleBufferCapture;

#[cfg(target_os = "macos")]
impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
    type Clock = RealTimeClock<RawNanoseconds>;
    type Output = screencapturekit::cm_sample_buffer::CMSampleBuffer;

    fn run(
        &mut self,
        _: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        inner(
            self,
            ready_signal,
            control_signal,
            |capturer| match capturer.raw().get_next_pixel_buffer() {
                Ok(pixel_buffer) => {
                    if pixel_buffer.height() == 0 || pixel_buffer.width() == 0 {
                        return Some(ControlFlow::Continue(()));
                    }

                    if let Err(_) = output.send(pixel_buffer.into()) {
                        eprintln!("Pipeline is unreachable. Shutting down recording.");
                        return Some(ControlFlow::Continue(()));
                    }

                    None
                }
                Err(error) => {
                    eprintln!("Capture error: {error}");
                    Some(ControlFlow::Break(()))
                }
            },
        )
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
                refresh_rate: {
                    let Some(fps) = get_target_fps(&Target::Display(screen.clone())) else {
                        continue;
                    };

                    fps
                },
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
                            refresh_rate: get_target_fps(&target).unwrap_or_default(),
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
    match target {
        scap::Target::Display(display) => platform::get_display_refresh_rate(display.raw_handle.id),
        scap::Target::Window(window) => {
            platform::get_display_refresh_rate(platform::display_for_window(window.raw_handle)?.id)
        }
    }
    #[cfg(target_os = "windows")]
    match target {
        scap::Target::Display(display) => platform::get_display_refresh_rate(display.raw_handle),
        scap::Target::Window(window) => {
            platform::get_display_refresh_rate(platform::display_for_window(window.raw_handle)?)
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    None
}
