use cap_media_info::{AudioInfo, PlanarData, RawVideoFormat, VideoInfo};
use cpal::traits::{DeviceTrait, HostTrait};
use ffmpeg::{format::Sample, frame};
use ffmpeg_sys_next::AV_TIME_BASE_Q;
use flume::Sender;
use scap::{
    Target,
    capturer::{Area, Capturer, Options, Point, Resolution as ScapResolution, Size},
    frame::{Frame, FrameType, VideoFrame},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashMap, ops::ControlFlow, rc::Rc, time::SystemTime};
use tracing::{debug, error, info, trace, warn};
#[cfg(target_os = "windows")]
use windows::Win32::{Foundation::HWND, Graphics::Gdi::HMONITOR};

use crate::{
    MediaError,
    pipeline::{clock::*, control::Control, task::PipelineSourceTask},
    platform::{self, Bounds, Window, logical_monitor_bounds},
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
            Some(scap::Target::Display(screen)) => {
                let names = crate::platform::display_names();

                Some(
                    names
                        .get(&screen.id)
                        .cloned()
                        .unwrap_or_else(|| screen.title.clone()),
                )
            }
        }
    }
}

pub struct ScreenCaptureSource<TCaptureFormat: ScreenCaptureFormat> {
    target: ScreenCaptureTarget,
    output_type: Option<FrameType>,
    fps: u32,
    video_info: VideoInfo,
    options: Rc<Options>,
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
            // .field("output_resolution", &self.output_resolution)
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
    type VideoFormat = ffmpeg::frame::Video;

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
            target: self.target,
            output_type: self.output_type,
            fps: self.fps,
            video_info: self.video_info,
            options: self.options.clone(),
            show_camera: self.show_camera,
            force_show_cursor: self.force_show_cursor,
            bounds: self.bounds,
            display_size: self.display_size,
            video_tx: self.video_tx.clone(),
            audio_tx: self.audio_tx.clone(),
            _phantom: std::marker::PhantomData,
            start_time: self.start_time,
        }
    }
}

struct OptionsConfig {
    scap_target: scap::Target,
    bounds: Bounds,
    crop_area: Option<Area>,
    display_size: (f32, f32),
}

pub struct CropRatio {
    pub position: (f32, f32),
    pub size: (f32, f32),
}

impl<TCaptureFormat: ScreenCaptureFormat> ScreenCaptureSource<TCaptureFormat> {
    #[allow(clippy::too_many_arguments)]
    pub async fn init(
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
        } = Self::get_options_config(target)?;

        let fps = get_target_fps(&scap_target).map_err(|e| format!("target_fps / {e}"))?;
        let fps = fps.min(max_fps);

        let captures_audio = audio_tx.is_some();

        let mut this = Self {
            target: *target,
            output_type,
            fps,
            video_info: VideoInfo::from_raw(RawVideoFormat::Bgra, 0, 0, 0),
            options: std::rc::Rc::new(Default::default()),
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

        this.options = std::rc::Rc::new(options);

        #[cfg(target_os = "macos")]
        let video_size = {
            let [x, y] = scap::capturer::get_output_frame_size(&this.options);
            (x, y)
        };
        #[cfg(windows)]
        // not sure how reliable this is for the general case so just use it for screen capture for now
        let video_size = if matches!(target, ScreenCaptureTarget::Screen { .. }) {
            let [x, y] = scap::capturer::get_output_frame_size(&this.options);
            (x, y)
        } else {
            (bounds.width as u32, bounds.height as u32)
        };

        this.video_info =
            VideoInfo::from_raw(RawVideoFormat::Bgra, video_size.0, video_size.1, fps);

        Ok(this)
    }

    pub fn get_bounds(&self) -> &Bounds {
        &self.bounds
    }

    pub fn crop_ratio(&self) -> CropRatio {
        if let Some(crop_area) = &self.options.crop_area {
            CropRatio {
                position: (
                    crop_area.origin.x as f32 / self.display_size.0,
                    crop_area.origin.y as f32 / self.display_size.1,
                ),
                size: (
                    crop_area.size.width as f32 / self.display_size.0,
                    crop_area.size.height as f32 / self.display_size.1,
                ),
            }
        } else {
            CropRatio {
                position: (0.0, 0.0),
                size: (1.0, 1.0),
            }
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
                        display.raw_handle.0
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
                    .find(|(i, _t)| i.id == *id)
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
            output_resolution: ScapResolution::Captured,
            excluded_targets: (!excluded_targets.is_empty()).then_some(excluded_targets),
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
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        let video_info = self.video_info;
        let video_tx = self.video_tx.clone();
        let audio_tx = self.audio_tx.clone();

        let start_time = self.start_time;

        let mut video_i = 0;
        let mut audio_i = 0;

        let mut frames_dropped = 0;

        // Frame drop rate tracking state
        use std::collections::VecDeque;
        use std::time::{Duration, Instant};

        let mut frame_events: VecDeque<(Instant, bool)> = VecDeque::new();
        let window_duration = Duration::from_secs(3);
        let max_drop_rate_threshold = 0.25;
        let mut last_cleanup = Instant::now();
        let mut last_log = Instant::now();
        let log_interval = Duration::from_secs(5);

        // Helper function to clean up old frame events
        let cleanup_old_events = |frame_events: &mut VecDeque<(Instant, bool)>, now: Instant| {
            let cutoff = now - window_duration;
            while let Some(&(timestamp, _)) = frame_events.front() {
                if timestamp < cutoff {
                    frame_events.pop_front();
                } else {
                    break;
                }
            }
        };

        // Helper function to calculate current drop rate
        let calculate_drop_rate =
            |frame_events: &mut VecDeque<(Instant, bool)>| -> (f64, usize, usize) {
                let now = Instant::now();
                cleanup_old_events(frame_events, now);

                if frame_events.is_empty() {
                    return (0.0, 0, 0);
                }

                let total_frames = frame_events.len();
                let dropped_frames = frame_events.iter().filter(|(_, dropped)| *dropped).count();
                let drop_rate = dropped_frames as f64 / total_frames as f64;

                (drop_rate, dropped_frames, total_frames)
            };

        inner(
            self,
            ready_signal,
            control_signal,
            |capturer| match capturer.get_next_frame() {
                Ok(Frame::Video(VideoFrame::BGRA(frame))) => {
                    video_i += 1;

                    if frame.height == 0 || frame.width == 0 {
                        return ControlFlow::Continue(());
                    }

                    let Ok(elapsed) = frame.display_time.duration_since(start_time) else {
                        warn!("Skipping video frame {video_i} as elapsed time is invalid");
                        return ControlFlow::Continue(());
                    };

                    let mut buffer = frame::Video::new(
                        video_info.pixel_format,
                        video_info.width,
                        video_info.height,
                    );

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

                    // Record frame attempt and check if it was dropped
                    let now = Instant::now();
                    let frame_dropped = match video_tx.try_send((buffer, elapsed.as_secs_f64())) {
                        Err(flume::TrySendError::Disconnected(_)) => {
                            return ControlFlow::Break(Err(
                                "Pipeline is unreachable. Shutting down recording".to_string(),
                            ));
                        }
                        Err(flume::TrySendError::Full(_)) => {
                            warn!("Screen capture sender is full, dropping frame");
                            frames_dropped += 1;
                            true
                        }
                        _ => false,
                    };

                    frame_events.push_back((now, frame_dropped));

                    if now.duration_since(last_cleanup) > Duration::from_millis(100) {
                        cleanup_old_events(&mut frame_events, now);
                        last_cleanup = now;
                    }

                    // Check drop rate and potentially exit
                    let (drop_rate, dropped_count, total_count) =
                        calculate_drop_rate(&mut frame_events);

                    if drop_rate > max_drop_rate_threshold && total_count >= 10 {
                        error!(
                            "High frame drop rate detected: {:.1}% ({}/{} frames in last {}s). Exiting capture.",
                            drop_rate * 100.0,
                            dropped_count,
                            total_count,
                            window_duration.as_secs()
                        );
                        return ControlFlow::Break(Err("Recording can't keep up with screen capture. Try reducing your display's resolution or refresh rate.".to_string()));
                    }

                    // Periodic logging of drop rate
                    if now.duration_since(last_log) > log_interval && total_count > 0 {
                        info!(
                            "Frame drop rate: {:.1}% ({}/{} frames, total dropped: {})",
                            drop_rate * 100.0,
                            dropped_count,
                            total_count,
                            frames_dropped
                        );
                        last_log = now;
                    }

                    ControlFlow::Continue(())
                }
                Ok(Frame::Audio(frame)) => {
                    if let Some(audio_tx) = &audio_tx {
                        let Ok(elapsed) = frame.time().duration_since(start_time) else {
                            warn!("Skipping audio frame {audio_i} as elapsed time is invalid");
                            return ControlFlow::Continue(());
                        };
                        let mut frame = scap_audio_to_ffmpeg(frame);
                        frame.set_pts(Some(
                            (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
                        ));
                        let _ = audio_tx.send((frame, elapsed.as_secs_f64()));
                        audio_i += 1;
                    }
                    ControlFlow::Continue(())
                }
                Ok(_) => panic!("Unsupported video format"),
                Err(error) => ControlFlow::Break(Err(format!("Capture error: {error}"))),
            },
        )
    }
}

fn inner<T: ScreenCaptureFormat>(
    source: &mut ScreenCaptureSource<T>,
    ready_signal: crate::pipeline::task::PipelineReadySignal,
    mut control_signal: crate::pipeline::control::PipelineControlSignal,
    mut get_frame: impl FnMut(&mut Capturer) -> ControlFlow<Result<(), String>>,
) -> Result<(), String> {
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
            return Err(e.to_string());
        }
    };

    info!("Capturer built");

    let mut capturing = false;
    let _ = ready_signal.send(Ok(()));

    cap_fail::fail!("macos screen_capture start panic");

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
                    ControlFlow::Break(res) => {
                        warn!("breaking from loop");

                        if let Err(e) = &res {
                            error!("Capture loop broke with error: {}", e)
                        }

                        return res;
                    }
                    ControlFlow::Continue(_) => {
                        continue;
                    }
                }
            }
        }
    }

    info!("Shut down screen capture source thread.");
    Ok(())
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
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
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
                    use cidre::sc;

                    #[allow(clippy::useless_transmute)]
                    let sample_buffer = unsafe {
                        std::mem::transmute::<_, cidre::arc::R<cidre::cm::SampleBuf>>(sample_buffer)
                    };

                    let frame_time =
                        sample_buffer.pts().value as f64 / sample_buffer.pts().scale as f64;
                    let unix_timestamp = start_time_unix + frame_time - start_cmtime;
                    let relative_time = unix_timestamp - start_time_f64;

                    match typ {
                        // sc::stream::OutputType::Screen => {
                        //     let Some(pixel_buffer) = sample_buffer.image_buf() else {
                        //         return ControlFlow::Continue(());
                        //     };

                        //     if pixel_buffer.height() == 0 || pixel_buffer.width() == 0 {
                        //         return ControlFlow::Continue(());
                        //     }

                        //     let check_skip_send = || {
                        //         cap_fail::fail_err!(
                        //             "media::sources::screen_capture::skip_send",
                        //             ()
                        //         );

                        //         Ok::<(), ()>(())
                        //     };

                        //     if check_skip_send().is_ok()
                        //         && video_tx.send((sample_buffer, relative_time)).is_err()
                        //     {
                        //         error!("Pipeline is unreachable. Shutting down recording.");
                        //         return ControlFlow::Continue(());
                        //     }
                        // }
                        // sc::stream::OutputType::Audio => {
                        //     use ffmpeg::ChannelLayout;

                        //     let res = || {
                        //         cap_fail::fail_err!("screen_capture audio skip", ());
                        //         Ok::<(), ()>(())
                        //     };
                        //     if res().is_err() {
                        //         return ControlFlow::Continue(());
                        //     }

                        //     let Some(audio_tx) = &audio_tx else {
                        //         return ControlFlow::Continue(());
                        //     };

                        //     let buf_list = sample_buffer.audio_buf_list::<2>().unwrap();
                        //     let slice = buf_list.block().as_slice().unwrap();

                        //     let mut frame = ffmpeg::frame::Audio::new(
                        //         ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                        //         sample_buffer.num_samples() as usize,
                        //         ChannelLayout::STEREO,
                        //     );
                        //     frame.set_rate(48_000);
                        //     let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                        //     for i in 0..frame.planes() {
                        //         use cap_media_info::PlanarData;

                        //         frame.plane_data_mut(i).copy_from_slice(
                        //             &slice[i * data_bytes_size as usize
                        //                 ..(i + 1) * data_bytes_size as usize],
                        //         );
                        //     }

                        //     frame.set_pts(Some((relative_time * AV_TIME_BASE_Q.den as f64) as i64));

                        //     let _ = audio_tx.send((frame, relative_time));
                        // }
                        _ => {}
                    }

                    ControlFlow::Continue(())
                }
                Err(error) => ControlFlow::Break(Err(format!("Capture error: {error}"))),
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
        scap::Target::Display(display) => platform::get_display_refresh_rate(display.raw_handle.0),
        scap::Target::Window(window) => platform::get_display_refresh_rate(
            platform::display_for_window(window.raw_handle)
                .ok_or_else(|| "failed to get display for window".to_string())?
                .id,
        ),
    }
    #[cfg(target_os = "windows")]
    match target {
        scap::Target::Display(display) => {
            platform::get_display_refresh_rate(HMONITOR(display.raw_handle.0))
        }
        scap::Target::Window(window) => platform::get_display_refresh_rate(
            platform::display_for_window(HWND(window.raw_handle.0))
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
                    scap::Target::Display(d) => d.raw_handle.0 == id.id,
                    _ => false,
                })
            }
            #[cfg(windows)]
            {
                let id = platform::display_for_window(HWND(window.raw_handle.0))?;
                targets.iter().find(|t| match t {
                    scap::Target::Display(d) => d.raw_handle.0 == id.0,
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

mod new_stuff {
    use kameo::prelude::*;

    mod macos {
        use super::*;
        use cidre::*;

        #[derive(Actor)]
        pub struct MacOSScreenCapture {
            capturer: Option<scap_screencapturekit::Capturer>,
        }

        // Public

        pub struct StartCapturing {
            target: arc::R<sc::ContentFilter>,
            frame_handler: Recipient<NewFrame>,
            error_handler: Option<Recipient<CaptureError>>,
        }

        // External

        pub struct NewFrame(pub scap_screencapturekit::Frame);

        // Internal

        pub struct CaptureError(arc::R<ns::Error>);

        #[derive(Debug, Clone)]
        pub enum StartCapturingError {
            AlreadyCapturing,
            CapturerBuild(arc::R<ns::Error>),
            Start(arc::R<ns::Error>),
        }

        impl Message<StartCapturing> for MacOSScreenCapture {
            type Reply = Result<(), StartCapturingError>;

            async fn handle(
                &mut self,
                msg: StartCapturing,
                _: &mut Context<Self, Self::Reply>,
            ) -> Self::Reply {
                if self.capturer.is_some() {
                    return Err(StartCapturingError::AlreadyCapturing);
                }

                let capturer = {
                    let mut capturer_builder = scap_screencapturekit::Capturer::builder(
                        msg.target.clone(),
                        sc::StreamCfg::new(),
                    )
                    .with_output_sample_buf_cb(move |frame| {
                        let _ = msg.frame_handler.tell(NewFrame(frame)).try_send();
                    });

                    if let Some(error_handler) = msg.error_handler {
                        capturer_builder = capturer_builder.with_stop_with_err_cb(move |_, err| {
                            let _ = error_handler
                                .tell(CaptureError(err.retained()))
                                .blocking_send();
                        });
                    }

                    capturer_builder
                        .build()
                        .map_err(StartCapturingError::CapturerBuild)?
                };

                capturer.start().await.map_err(StartCapturingError::Start)?;

                self.capturer = Some(capturer);

                Ok(())
            }
        }

        impl Message<CaptureError> for MacOSScreenCapture {
            type Reply = ();

            async fn handle(
                &mut self,
                msg: CaptureError,
                ctx: &mut Context<Self, Self::Reply>,
            ) -> Self::Reply {
                dbg!(msg.0);
                if let Some(capturer) = self.capturer.as_mut() {
                    let _ = capturer.stop().await;
                    ctx.actor_ref().kill();
                }
            }
        }

        #[tokio::test]
        async fn kameo_test() {
            use std::time::Duration;

            #[derive(Actor)]
            struct FrameHandler;

            impl Message<NewFrame> for FrameHandler {
                type Reply = ();

                async fn handle(
                    &mut self,
                    msg: NewFrame,
                    _: &mut Context<Self, Self::Reply>,
                ) -> Self::Reply {
                    dbg!(msg.0.output_type());
                }
            }

            let actor = MacOSScreenCapture::spawn(MacOSScreenCapture { capturer: None });

            let frame_handler = FrameHandler::spawn(FrameHandler);

            actor
                .ask(StartCapturing {
                    target: cap_displays::Display::primary()
                        .raw_handle()
                        .as_content_filter()
                        .await
                        .unwrap(),
                    frame_handler: frame_handler.clone().recipient(),
                    error_handler: None,
                })
                .await
                .inspect_err(|e| {
                    dbg!(e);
                })
                .ok();

            actor
                .ask(StartCapturing {
                    target: cap_displays::Display::primary()
                        .raw_handle()
                        .as_content_filter()
                        .await
                        .unwrap(),
                    frame_handler: frame_handler.recipient(),
                    error_handler: None,
                })
                .await
                .inspect_err(|e| {
                    dbg!(e);
                })
                .ok();

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    mod windows {
        use super::*;
        use ::windows::Graphics::Capture::GraphicsCaptureItem;
        use scap_ffmpeg::AsFFmpeg;

        #[derive(Actor)]
        pub struct WindowsScreenCapture {
            capturer: Option<scap_direct3d::Capturer>,
        }

        pub struct StartCapturing {
            target: GraphicsCaptureItem,
            settings: scap_direct3d::Settings,
            frame_handler: Recipient<NewFrame>,
            error_handler: Option<Recipient<CaptureError>>,
        }

        struct NewFrame {
            ff_frame: ffmpeg::frame::Video,
        }

        impl Message<StartCapturing> for WindowsScreenCapture {
            type Reply = ();

            async fn handle(
                &mut self,
                msg: StartCapturing,
                ctx: &mut Context<Self, Self::Reply>,
            ) -> Self::Reply {
                let capturer = scap_direct3d::Capturer::new(msg.target, msg.settings);

                let capture_handle = capturer.start(
                    |frame| {
                        let ff_frame = frame.as_ffmpeg().unwrap();

                        let _ = msg.frame_handler.tell(NewFrame { ff_frame }).try_send();

                        Ok(())
                    },
                    || {
                        Ok(());
                    },
                );
            }
        }

        #[tokio::test]
        async fn kameo_test() {
            use std::time::Duration;

            #[derive(Actor)]
            struct FrameHandler;

            impl Message<NewFrame> for FrameHandler {
                type Reply = ();

                async fn handle(
                    &mut self,
                    msg: NewFrame,
                    _: &mut Context<Self, Self::Reply>,
                ) -> Self::Reply {
                    dbg!(
                        msg.ff_frame.width(),
                        msg.ff_frame.height(),
                        msg.ff_frame.format()
                    );
                }
            }

            let actor = WindowsScreenCapture::spawn(WindowsScreenCapture { capturer: None });

            let frame_handler = FrameHandler::spawn(FrameHandler);

            actor
                .ask(StartCapturing {
                    target: cap_displays::Display::primary()
                        .raw_handle()
                        .try_as_capture_item()
                        .unwrap(),
                    settings: scap_direct3d::Settings {
                        is_border_required: Some(false),
                        is_cursor_capture_enabled: Some(false),
                        pixel_format: scap_direct3d::PixelFormat::R8G8B8A8Unorm,
                    },
                    frame_handler: frame_handler.clone().recipient(),
                    error_handler: None,
                })
                .await
                .inspect_err(|e| {
                    dbg!(e);
                })
                .ok();

            // actor
            //     .ask(StartCapturing {
            //         target: cap_displays::Display::primary()
            //             .raw_handle()
            //             .as_content_filter()
            //             .await
            //             .unwrap(),
            //         frame_handler: frame_handler.recipient(),
            //         error_handler: None,
            //     })
            //     .await
            //     .inspect_err(|e| {
            //         dbg!(e);
            //     })
            //     .ok();

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
