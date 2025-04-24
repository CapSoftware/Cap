use cpal::traits::{DeviceTrait, HostTrait};
use ffmpeg::{format::Sample, ChannelLayout};
use ffmpeg_sys_next::AV_TIME_BASE_Q;
use flume::Sender;
use scap::{
    capturer::{Area, Capturer, Options, Point, Resolution as ScapResolution, Size},
    frame::{Frame, FrameType, VideoFrame},
    Target,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashMap, ops::ControlFlow, sync::Arc, time::SystemTime};
use tracing::{debug, error, info, trace, warn};

use crate::{
    data::{AudioInfo, FFVideo, PlanarData, RawVideoFormat, VideoInfo},
    pipeline::{clock::*, control::Control, task::PipelineSourceTask},
    platform::{self, logical_monitor_bounds, Bounds, Window},
    MediaError,
};

static EXCLUDED_WINDOWS: &[&str] = &[
    "Cap Camera",
    "Cap Recordings Overlay",
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window { id: u32 },
    Screen { id: u32 },
    Area { screen: u32, bounds: Bounds },
}

impl ScreenCaptureTarget {
    // only available on mac and windows
    pub fn primary_display() -> Self {
        ScreenCaptureTarget::Screen {
            id: scap::get_main_display().id,
        }
    }

    pub fn get_target(&self) -> Option<scap::Target> {
        let targets = scap::get_all_targets();

        match self {
            ScreenCaptureTarget::Window { id } => targets.into_iter().find(|t| match t {
                scap::Target::Window(window) => window.id == *id,
                _ => false,
            }),
            ScreenCaptureTarget::Screen { id } => targets.into_iter().find(|t| match t {
                scap::Target::Display(screen) => screen.id == *id,
                _ => false,
            }),
            ScreenCaptureTarget::Area { screen, .. } => targets.into_iter().find(|t| match t {
                scap::Target::Display(display) => display.id == *screen,
                _ => false,
            }),
        }
    }

    pub fn get_title(&self) -> Option<String> {
        let target = self.get_target();

        match target {
            None => None,
            Some(scap::Target::Window(window)) => Some(window.title.clone()),
            Some(scap::Target::Display(screen)) => Some(screen.title.clone()),
        }
    }
}

// impl PartialEq<Target> for ScreenCaptureTarget {
//     fn eq(&self, other: &Target) -> bool {
//         match (self, other) {
//             (Self::Window(capture_window), Target::Window(window)) => {
//                 window.id == capture_window.id
//             }
//             (ScreenCaptureTarget::Area(capture_area), Target::Display(display)) => {
//                 display.id == capture_area.screen.id
//             }
//             (ScreenCaptureTarget::Screen(capture_screen), Target::Display(display)) => {
//                 display.id == capture_screen.id
//             }
//             (&ScreenCaptureTarget::Window(_), &scap::Target::Display(_))
//             | (&ScreenCaptureTarget::Screen(_), &scap::Target::Window(_))
//             | (&ScreenCaptureTarget::Area(_), &scap::Target::Window(_)) => todo!(),
//         }
//     }
// }

// impl ScreenCaptureTarget {
//     pub fn recording_fps(&self) -> u32 {
//         match self {
//             ScreenCaptureTarget::Window(window) => window.
//             ScreenCaptureTarget::Screen(screen) => screen.refresh_rate,
//             ScreenCaptureTarget::Area(area) => area.screen.refresh_rate,
//         }
//         .min(MAX_FPS)
//     }
// }

pub struct ScreenCaptureSource<TCaptureFormat: ScreenCaptureFormat> {
    target: ScreenCaptureTarget,
    output_resolution: Option<ScapResolution>,
    output_type: Option<FrameType>,
    fps: u32,
    video_info: VideoInfo,
    options: Arc<Options>,
    show_camera: bool,
    force_show_cursor: bool,
    bounds: Bounds,
    // logical display size
    display_size: (f32, f32),
    video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
    _phantom: std::marker::PhantomData<TCaptureFormat>,
    start_time: SystemTime,
}

impl<T: ScreenCaptureFormat> std::fmt::Debug for ScreenCaptureSource<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenCaptureSource")
            .field("target", &self.target)
            .field("bounds", &self.bounds)
            .field("output_resolution", &self.output_resolution)
            .field("output_type", &self.output_type)
            .field("fps", &self.fps)
            .field("video_info", &self.video_info)
            .field(
                "audio_info",
                &self.audio_tx.as_ref().map(|_| self.audio_info()),
            )
            .finish()
    }
}

pub trait ScreenCaptureFormat {
    type VideoFormat;

    fn audio_info() -> AudioInfo;
}

impl ScreenCaptureFormat for AVFrameCapture {
    type VideoFormat = FFVideo;

    fn audio_info() -> AudioInfo {
        let host = cpal::default_host();
        let output_device = host.default_output_device().unwrap();
        let supported_config = output_device.default_output_config().unwrap();

        let mut info = AudioInfo::from_stream_config(&supported_config);

        info.sample_format = Sample::F32(ffmpeg::format::sample::Type::Packed);

        info
    }
}

unsafe impl<T: ScreenCaptureFormat> Send for ScreenCaptureSource<T> {}
unsafe impl<T: ScreenCaptureFormat> Sync for ScreenCaptureSource<T> {}

impl<TCaptureFormat: ScreenCaptureFormat> Clone for ScreenCaptureSource<TCaptureFormat> {
    fn clone(&self) -> Self {
        Self {
            target: self.target.clone(),
            output_resolution: self.output_resolution,
            output_type: self.output_type,
            fps: self.fps,
            video_info: self.video_info.clone(),
            options: self.options.clone(),
            show_camera: self.show_camera,
            force_show_cursor: self.force_show_cursor,
            bounds: self.bounds,
            display_size: self.display_size,
            video_tx: self.video_tx.clone(),
            audio_tx: self.audio_tx.clone(),
            _phantom: std::marker::PhantomData,
            start_time: self.start_time.clone(),
        }
    }
}

const MAX_FPS: u32 = 60;

struct OptionsConfig {
    scap_target: scap::Target,
    bounds: Bounds,
    crop_area: Option<Area>,
    display_size: (f32, f32),
}

struct CropRatio {
    position: (f32, f32),
    size: (f32, f32),
}

impl<TCaptureFormat: ScreenCaptureFormat> ScreenCaptureSource<TCaptureFormat> {
    pub fn init(
        target: &ScreenCaptureTarget,
        output_type: Option<FrameType>,
        show_camera: bool,
        force_show_cursor: bool,
        max_fps: u32,
        video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
        audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
        start_time: SystemTime,
    ) -> Result<Self, String> {
        cap_fail::fail!("media::screen_capture::init");

        let OptionsConfig {
            scap_target,
            bounds,
            crop_area,
            display_size,
        } = Self::get_options_config(&target)?;

        let fps = get_target_fps(&scap_target).map_err(|e| format!("target_fps / {e}"))?;
        let fps = fps.min(max_fps);

        if !(fps > 0) {
            return Err("FPS must be greater than 0".to_string());
        }

        let captures_audio = audio_tx.is_some();

        let mut this = Self {
            target: target.clone(),
            output_resolution: None,
            output_type,
            fps,
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, 0, 0, 0),
            options: Arc::new(Default::default()),
            bounds,
            display_size,
            show_camera,
            force_show_cursor,
            video_tx,
            audio_tx,
            _phantom: std::marker::PhantomData,
            start_time,
        };

        let options = this.create_options(scap_target, crop_area, captures_audio)?;

        this.options = Arc::new(options);

        #[cfg(target_os = "macos")]
        let video_size = {
            let [x, y] = scap::capturer::get_output_frame_size(&this.options);
            (x, y)
        };
        #[cfg(windows)]
        let video_size = (bounds.width as u32, bounds.height as u32);

        this.video_info =
            VideoInfo::from_raw(RawVideoFormat::Bgra, video_size.0, video_size.1, fps);

        Ok(this)
    }

    pub fn get_bounds(&self) -> &Bounds {
        &self.bounds
    }

    pub fn crop_ratio(&self) -> ((f32, f32), (f32, f32)) {
        if let Some(crop_area) = &self.options.crop_area {
            (
                (
                    crop_area.origin.x as f32 / self.display_size.0,
                    crop_area.origin.y as f32 / self.display_size.1,
                ),
                (
                    crop_area.size.width as f32 / self.display_size.0,
                    crop_area.size.height as f32 / self.display_size.1,
                ),
            )
        } else {
            ((0.0, 0.0), (1.0, 1.0))
        }
    }

    fn get_options_config(target: &ScreenCaptureTarget) -> Result<OptionsConfig, String> {
        let targets = scap::get_all_targets();

        Ok(match target {
            ScreenCaptureTarget::Window { id } => {
                let windows = list_windows();

                let (mut window_info, target) = windows
                    .into_iter()
                    .find(|t| t.0.id == *id)
                    .ok_or_else(|| "Capture window not found".to_string())?;

                let Target::Display(display) = display_for_target(&target, &targets)
                    .ok_or_else(|| "Screen for capture window not found".to_string())?
                else {
                    unreachable!()
                };

                let id = {
                    #[cfg(target_os = "macos")]
                    {
                        display.raw_handle.id
                    }

                    #[cfg(windows)]
                    {
                        display.raw_handle.0 as u32
                    }
                };

                let monitor_bounds = logical_monitor_bounds(id).unwrap();

                window_info.bounds.x -= monitor_bounds.position.x;
                window_info.bounds.y -= monitor_bounds.position.y;

                fn div_by_2able(n: f64) -> f64 {
                    n + n % 2.0
                }

                let crop = Area {
                    size: Size {
                        width: div_by_2able(window_info.bounds.width),
                        height: div_by_2able(window_info.bounds.height),
                    },
                    origin: Point {
                        x: div_by_2able(window_info.bounds.x),
                        y: div_by_2able(window_info.bounds.y),
                    },
                };

                OptionsConfig {
                    scap_target: Target::Display(display),
                    bounds: Bounds {
                        x: crop.origin.x,
                        y: crop.origin.y,
                        width: crop.size.width,
                        height: crop.size.height,
                    },
                    crop_area: Some(crop),
                    display_size: (
                        monitor_bounds.size.width as f32,
                        monitor_bounds.size.height as f32,
                    ),
                }
            }
            ScreenCaptureTarget::Screen { id } => {
                let screens = list_screens();

                let (screen_info, target) = screens
                    .into_iter()
                    .find(|(i, t)| i.id == *id)
                    .ok_or_else(|| "Target for screen capture not found".to_string())?;

                let bounds = platform::monitor_bounds(screen_info.id);

                OptionsConfig {
                    scap_target: target,
                    bounds,
                    crop_area: None,
                    display_size: (bounds.width as f32, bounds.height as f32),
                }
            }
            ScreenCaptureTarget::Area { screen, bounds } => {
                let screen_bounds = platform::monitor_bounds(*screen);

                let screens = list_screens();
                let screen = screens
                    .into_iter()
                    .find_map(|(i, t)| (i.id == *screen).then_some(t))
                    .ok_or_else(|| "Target for screen capture not found".to_string())?;

                OptionsConfig {
                    scap_target: screen,
                    bounds: *bounds,
                    crop_area: Some(Area {
                        size: Size {
                            width: bounds.width,
                            height: bounds.height,
                        },
                        origin: Point {
                            x: bounds.x,
                            y: bounds.y,
                        },
                    }),
                    display_size: (screen_bounds.width as f32, screen_bounds.height as f32),
                }
            }
        })
    }

    fn create_options(
        &self,
        target: scap::Target,
        crop_area: Option<Area>,
        captures_audio: bool,
    ) -> Result<Options, String> {
        let targets = scap::get_all_targets();

        let excluded_targets: Vec<scap::Target> = targets
            .iter()
            .filter(|target| match target {
                Target::Window(scap_window) => {
                    if scap_window.title == "Cap Camera" && self.show_camera {
                        false
                    } else {
                        EXCLUDED_WINDOWS.contains(&scap_window.title.as_str())
                    }
                }
                Target::Display(_) => false,
            })
            .cloned()
            .collect();

        debug!("configured target: {:#?}", self.target);

        Ok(Options {
            fps: self.fps,
            show_cursor: self.force_show_cursor,
            show_highlight: false,
            target: Some(target.clone()),
            crop_area,
            output_type: self.output_type.unwrap_or(FrameType::BGRAFrame),
            output_resolution: self.output_resolution.unwrap_or(ScapResolution::Captured),
            excluded_targets: (!excluded_targets.is_empty()).then(|| excluded_targets),
            captures_audio,
            exclude_current_process_audio: true,
        })
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    pub fn audio_info(&self) -> AudioInfo {
        TCaptureFormat::audio_info()
    }
}

#[derive(Debug)]
pub struct AVFrameCapture;

impl PipelineSourceTask for ScreenCaptureSource<AVFrameCapture> {
    type Clock = RealTimeClock<RawNanoseconds>;

    // #[instrument(skip_all)]
    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) {
        let video_info = self.video_info;
        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

        let start_time = self.start_time;

        inner(
            self,
            ready_signal,
            control_signal,
            |capturer| match capturer.get_next_frame() {
                Ok(Frame::Video(VideoFrame::BGRA(frame))) => {
                    if frame.height == 0 || frame.width == 0 {
                        return ControlFlow::Continue(());
                    }

                    let elapsed = frame.display_time.duration_since(start_time).unwrap();

                    let mut buffer =
                        FFVideo::new(video_info.pixel_format, video_info.width, video_info.height);

                    let bytes_per_pixel = 4;
                    let width_in_bytes = frame.width as usize * bytes_per_pixel;
                    let height = frame.height as usize;

                    let src_data = &frame.data;

                    let src_stride = src_data.len() / height;
                    let dst_stride = buffer.stride(0);

                    if src_data.len() < src_stride * height {
                        warn!("Frame data size mismatch.");
                        return ControlFlow::Continue(());
                    }

                    if src_stride < width_in_bytes {
                        warn!("Source stride is less than expected width in bytes.");
                        return ControlFlow::Continue(());
                    }

                    if buffer.data(0).len() < dst_stride * height {
                        warn!("Destination data size mismatch.");
                        return ControlFlow::Continue(());
                    }

                    {
                        let dst_data = buffer.data_mut(0);

                        for y in 0..height {
                            let src_offset = y * src_stride;
                            let dst_offset = y * dst_stride;
                            dst_data[dst_offset..dst_offset + width_in_bytes].copy_from_slice(
                                &src_data[src_offset..src_offset + width_in_bytes],
                            );
                        }
                    }

                    buffer.set_pts(Some(
                        (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
                    ));

                    if let Err(_) = video_tx.send((buffer, elapsed.as_secs_f64())) {
                        error!("Pipeline is unreachable. Shutting down recording.");
                        return ControlFlow::Break(());
                    }

                    ControlFlow::Continue(())
                }
                Ok(Frame::Audio(frame)) => {
                    if let Some(audio_tx) = &audio_tx {
                        let elapsed = frame.time().duration_since(start_time).unwrap();
                        let mut frame = scap_audio_to_ffmpeg(frame);
                        frame.set_pts(Some(
                            (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
                        ));
                        let _ = audio_tx.send((frame, elapsed.as_secs_f64()));
                    }
                    ControlFlow::Continue(())
                }
                Ok(_) => panic!("Unsupported video format"),
                Err(error) => {
                    error!("Capture error: {error}");
                    ControlFlow::Break(())
                }
            },
        )
    }
}

fn inner<T: ScreenCaptureFormat>(
    source: &mut ScreenCaptureSource<T>,
    ready_signal: crate::pipeline::task::PipelineReadySignal,
    mut control_signal: crate::pipeline::control::PipelineControlSignal,
    mut get_frame: impl FnMut(&mut Capturer) -> ControlFlow<()>,
) {
    trace!("Preparing screen capture source thread...");

    let maybe_capture_window_id = match &source.target {
        ScreenCaptureTarget::Window { id } => Some(*id),
        _ => None,
    };

    let mut capturer = match Capturer::build(source.options.as_ref().clone()) {
        Ok(capturer) => capturer,
        Err(e) => {
            error!("Failed to build capturer: {e}");
            let _ = ready_signal.send(Err(MediaError::Any("Failed to build capturer".into())));
            return;
        }
    };

    info!("Capturer built");

    let mut capturing = false;
    let _ = ready_signal.send(Ok(()));

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
                    ControlFlow::Break(_) => {
                        warn!("breaking from loop");
                        break;
                    }
                    ControlFlow::Continue(_) => {
                        continue;
                    }
                }
            }
        }
    }

    info!("Shut down screen capture source thread.");
}

#[derive(Debug)]
pub struct CMSampleBufferCapture;

#[cfg(target_os = "macos")]
impl ScreenCaptureFormat for CMSampleBufferCapture {
    type VideoFormat = cidre::arc::R<cidre::cm::SampleBuf>;

    fn audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            48_000,
            2,
        )
        .unwrap()
    }
}

#[cfg(target_os = "macos")]
impl PipelineSourceTask for ScreenCaptureSource<CMSampleBufferCapture> {
    type Clock = RealTimeClock<RawNanoseconds>;

    fn run(
        &mut self,
        clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) {
        use screencapturekit::stream::output_type::SCStreamOutputType;

        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

        let start = std::time::SystemTime::now();
        let start_time_unix = start
            .duration_since(std::time::UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs_f64();
        let start_cmtime = cidre::cm::Clock::host_time_clock().time();
        let start_cmtime = start_cmtime.value as f64 / start_cmtime.scale as f64;

        let start_time_f64 = self
            .start_time
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64();

        inner(
            self,
            ready_signal,
            control_signal,
            |capturer| match capturer.raw().get_next_sample_buffer() {
                Ok((sample_buffer, typ)) => {
                    let sample_buffer = unsafe {
                        std::mem::transmute::<_, cidre::arc::R<cidre::cm::SampleBuf>>(sample_buffer)
                    };

                    let frame_time =
                        sample_buffer.pts().value as f64 / sample_buffer.pts().scale as f64;
                    let unix_timestamp = start_time_unix + frame_time - start_cmtime;
                    let relative_time = unix_timestamp - start_time_f64;

                    match typ {
                        SCStreamOutputType::Screen => {
                            let Some(pixel_buffer) = sample_buffer.image_buf() else {
                                return ControlFlow::Continue(());
                            };

                            if pixel_buffer.height() == 0 || pixel_buffer.width() == 0 {
                                return ControlFlow::Continue(());
                            }

                            if let Err(_) = video_tx.send((sample_buffer, relative_time)) {
                                error!("Pipeline is unreachable. Shutting down recording.");
                                return ControlFlow::Continue(());
                            }
                        }
                        SCStreamOutputType::Audio => {
                            let Some(audio_tx) = &audio_tx else {
                                return ControlFlow::Continue(());
                            };

                            let buf_list = sample_buffer.audio_buf_list::<2>().unwrap();
                            let slice = buf_list.block().as_slice().unwrap();

                            let mut frame = ffmpeg::frame::Audio::new(
                                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                                sample_buffer.num_samples() as usize,
                                ChannelLayout::STEREO,
                            );
                            frame.set_rate(48_000);
                            let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                            for i in 0..frame.planes() {
                                frame.plane_data_mut(i).copy_from_slice(
                                    &slice[i * data_bytes_size as usize
                                        ..(i + 1) * data_bytes_size as usize],
                                );
                            }

                            frame.set_pts(Some((relative_time * AV_TIME_BASE_Q.den as f64) as i64));

                            let _ = audio_tx.send((frame, relative_time));
                        }
                    }

                    ControlFlow::Continue(())
                }
                Err(error) => {
                    eprintln!("Capture error: {error}");
                    ControlFlow::Break(())
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
                    let Ok(fps) = get_target_fps(&Target::Display(screen.clone())) else {
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

pub fn get_target_fps(target: &scap::Target) -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    match target {
        scap::Target::Display(display) => platform::get_display_refresh_rate(display.raw_handle.id),
        scap::Target::Window(window) => platform::get_display_refresh_rate(
            platform::display_for_window(window.raw_handle)
                .ok_or_else(|| "failed to get display for window".to_string())?
                .id,
        ),
    }
    #[cfg(target_os = "windows")]
    match target {
        scap::Target::Display(display) => platform::get_display_refresh_rate(display.raw_handle),
        scap::Target::Window(window) => platform::get_display_refresh_rate(
            platform::display_for_window(window.raw_handle)
                .ok_or_else(|| "failed to get display for window".to_string())?,
        ),
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    None
}

fn display_for_target<'a>(
    target: &'a scap::Target,
    targets: &'a [scap::Target],
) -> Option<scap::Target> {
    match target {
        scap::Target::Display(_) => Some(target),
        scap::Target::Window(window) => {
            #[cfg(target_os = "macos")]
            {
                let id = platform::display_for_window(window.raw_handle)?;
                targets.iter().find(|t| match t {
                    scap::Target::Display(d) => d.raw_handle.id == id.id,
                    _ => false,
                })
            }
            #[cfg(windows)]
            {
                let id = platform::display_for_window(window.raw_handle)?;
                targets.iter().find(|t| match t {
                    scap::Target::Display(d) => d.raw_handle == id,
                    _ => false,
                })
            }
        }
    }
    .cloned()
}

fn scap_audio_to_ffmpeg(scap_frame: scap::frame::AudioFrame) -> ffmpeg::frame::Audio {
    use ffmpeg::format::Sample;
    use scap::frame::AudioFormat;

    let format_typ = if scap_frame.is_planar() {
        ffmpeg::format::sample::Type::Planar
    } else {
        ffmpeg::format::sample::Type::Packed
    };

    let mut ffmpeg_frame = ffmpeg::frame::Audio::new(
        match scap_frame.format() {
            AudioFormat::F32 => Sample::F32(format_typ),
            AudioFormat::F64 => Sample::F64(format_typ),
            AudioFormat::I16 => Sample::I16(format_typ),
            AudioFormat::I32 => Sample::I32(format_typ),
            AudioFormat::U8 => Sample::U8(format_typ),
            _ => panic!("Unsupported sample format"),
        },
        scap_frame.sample_count(),
        ffmpeg::ChannelLayout::default(scap_frame.channels() as i32),
    );

    if scap_frame.is_planar() {
        for i in 0..scap_frame.planes() {
            ffmpeg_frame
                .plane_data_mut(i as usize)
                .copy_from_slice(scap_frame.plane_data(i as usize));
        }
    } else {
        ffmpeg_frame
            .data_mut(0)
            .copy_from_slice(scap_frame.raw_data());
    }

    ffmpeg_frame.set_rate(scap_frame.rate());

    ffmpeg_frame
}
