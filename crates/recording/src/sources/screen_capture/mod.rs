use cap_cursor_capture::CursorCropBounds;
use cap_displays::{Display, DisplayId, Window, WindowId, bounds::*};
use cap_media_info::{AudioInfo, VideoInfo};
use ffmpeg::sys::AV_TIME_BASE_Q;
use flume::Sender;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::SystemTime;
use tracing::{error, warn};

use crate::pipeline::{control::Control, task::PipelineSourceTask};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

pub struct StopCapturing;

#[derive(Debug, Clone)]
pub enum StopCapturingError {
    NotCapturing,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureWindow {
    pub id: WindowId,
    pub owner_name: String,
    pub name: String,
    pub bounds: LogicalBounds,
    pub refresh_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureDisplay {
    pub id: DisplayId,
    pub name: String,
    pub refresh_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureArea {
    pub screen: CaptureDisplay,
    pub bounds: LogicalBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "variant")]
pub enum ScreenCaptureTarget {
    Window {
        id: WindowId,
    },
    Display {
        id: DisplayId,
    },
    Area {
        screen: DisplayId,
        bounds: LogicalBounds,
    },
}

impl ScreenCaptureTarget {
    pub fn display(&self) -> Option<Display> {
        match self {
            Self::Display { id } => Display::from_id(id),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.display()),
            Self::Area { screen, .. } => Display::from_id(screen),
        }
    }

    pub fn cursor_crop(&self) -> Option<CursorCropBounds> {
        match self {
            Self::Display { .. } => {
                #[cfg(target_os = "macos")]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_macos(LogicalBounds::new(
                        LogicalPosition::new(0.0, 0.0),
                        display.raw_handle().logical_size()?,
                    )));
                }

                #[cfg(windows)]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_windows(PhysicalBounds::new(
                        PhysicalPosition::new(0.0, 0.0),
                        display.raw_handle().physical_size()?,
                    )));
                }
            }
            Self::Window { id } => {
                let window = Window::from_id(id)?;

                #[cfg(target_os = "macos")]
                {
                    let display = self.display()?;
                    let display_position = display.raw_handle().logical_position();
                    let window_bounds = window.raw_handle().logical_bounds()?;

                    return Some(CursorCropBounds::new_macos(LogicalBounds::new(
                        LogicalPosition::new(
                            window_bounds.position().x() - display_position.x(),
                            window_bounds.position().y() - display_position.y(),
                        ),
                        window_bounds.size(),
                    )));
                }

                #[cfg(windows)]
                {
                    let display_bounds = self.display()?.raw_handle().physical_bounds()?;
                    let window_bounds = window.raw_handle().physical_bounds()?;

                    return Some(CursorCropBounds::new_windows(PhysicalBounds::new(
                        PhysicalPosition::new(
                            window_bounds.position().x() - display_bounds.position().x(),
                            window_bounds.position().y() - display_bounds.position().y(),
                        ),
                        PhysicalSize::new(
                            window_bounds.size().width(),
                            window_bounds.size().height(),
                        ),
                    )));
                }
            }
            Self::Area { bounds, .. } => {
                #[cfg(target_os = "macos")]
                {
                    return Some(CursorCropBounds::new_macos(*bounds));
                }

                #[cfg(windows)]
                {
                    let display = self.display()?;
                    let display_bounds = display.raw_handle().physical_bounds()?;
                    let display_logical_size = display.logical_size()?;

                    let scale = display_bounds.size().width() / display_logical_size.width();

                    return Some(CursorCropBounds::new_windows(PhysicalBounds::new(
                        PhysicalPosition::new(
                            bounds.position().x() * scale,
                            bounds.position().y() * scale,
                        ),
                        PhysicalSize::new(
                            bounds.size().width() * scale,
                            bounds.size().height() * scale,
                        ),
                    )));
                }
            }
        }
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        match self {
            Self::Display { id } => Display::from_id(id).and_then(|d| d.physical_size()),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.physical_size()),
            Self::Area { bounds, .. } => {
                let display = self.display()?;
                let scale = display.physical_size()?.width() / display.logical_size()?.width();
                let size = bounds.size();

                Some(PhysicalSize::new(
                    size.width() * scale,
                    size.height() * scale,
                ))
            }
        }
    }

    pub fn title(&self) -> Option<String> {
        match self {
            Self::Display { id } => Display::from_id(id).and_then(|d| d.name()),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.name()),
            Self::Area { screen, .. } => Display::from_id(screen).and_then(|d| d.name()),
        }
    }
}

pub struct ScreenCaptureSource<TCaptureFormat: ScreenCaptureFormat> {
    config: Config,
    video_info: VideoInfo,
    tokio_handle: tokio::runtime::Handle,
    video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
    audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
    start_time: SystemTime,
    _phantom: std::marker::PhantomData<TCaptureFormat>,
}

impl<T: ScreenCaptureFormat> std::fmt::Debug for ScreenCaptureSource<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenCaptureSource")
            // .field("bounds", &self.bounds)
            // .field("output_resolution", &self.output_resolution)
            .field("fps", &self.config.fps)
            .field("video_info", &self.video_info)
            .field(
                "audio_info",
                &self.audio_tx.as_ref().map(|_| self.audio_info()),
            )
            .finish()
    }
}

unsafe impl<T: ScreenCaptureFormat> Send for ScreenCaptureSource<T> {}
unsafe impl<T: ScreenCaptureFormat> Sync for ScreenCaptureSource<T> {}

pub trait ScreenCaptureFormat {
    type VideoFormat;

    fn pixel_format() -> ffmpeg::format::Pixel;

    fn audio_info() -> AudioInfo;
}

impl<TCaptureFormat: ScreenCaptureFormat> Clone for ScreenCaptureSource<TCaptureFormat> {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            video_info: self.video_info,
            video_tx: self.video_tx.clone(),
            audio_tx: self.audio_tx.clone(),
            tokio_handle: self.tokio_handle.clone(),
            start_time: self.start_time,
            _phantom: std::marker::PhantomData,
        }
    }
}

#[derive(Clone, Debug)]
struct Config {
    display: DisplayId,
    #[cfg(windows)]
    crop_bounds: Option<PhysicalBounds>,
    #[cfg(target_os = "macos")]
    crop_bounds: Option<LogicalBounds>,
    fps: u32,
    show_cursor: bool,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ScreenCaptureInitError {
    #[error("NoDisplay")]
    NoDisplay,
    #[error("NoWindow")]
    NoWindow,
    #[error("Bounds")]
    NoBounds,
}

impl<TCaptureFormat: ScreenCaptureFormat> ScreenCaptureSource<TCaptureFormat> {
    #[allow(clippy::too_many_arguments)]
    pub async fn init(
        target: &ScreenCaptureTarget,
        show_cursor: bool,
        max_fps: u32,
        video_tx: Sender<(TCaptureFormat::VideoFormat, f64)>,
        audio_tx: Option<Sender<(ffmpeg::frame::Audio, f64)>>,
        start_time: SystemTime,
        tokio_handle: tokio::runtime::Handle,
    ) -> Result<Self, ScreenCaptureInitError> {
        cap_fail::fail!("ScreenCaptureSource::init");

        let display = target.display().ok_or(ScreenCaptureInitError::NoDisplay)?;

        let fps = max_fps.min(display.refresh_rate() as u32);

        let crop_bounds = match target {
            ScreenCaptureTarget::Display { .. } => None,
            ScreenCaptureTarget::Window { id } => {
                let window = Window::from_id(&id).ok_or(ScreenCaptureInitError::NoWindow)?;

                #[cfg(target_os = "macos")]
                {
                    let raw_display_bounds = display
                        .raw_handle()
                        .logical_bounds()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;
                    let raw_window_bounds = window
                        .raw_handle()
                        .logical_bounds()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;

                    Some(LogicalBounds::new(
                        LogicalPosition::new(
                            raw_window_bounds.position().x() - raw_display_bounds.position().x(),
                            raw_window_bounds.position().y() - raw_display_bounds.position().y(),
                        ),
                        raw_window_bounds.size(),
                    ))
                }

                #[cfg(windows)]
                {
                    let raw_display_position = display
                        .raw_handle()
                        .physical_position()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;
                    let raw_window_bounds = window
                        .raw_handle()
                        .physical_bounds()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;

                    Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            raw_window_bounds.position().x() - raw_display_position.x(),
                            raw_window_bounds.position().y() - raw_display_position.y(),
                        ),
                        raw_window_bounds.size(),
                    ))
                }
            }
            ScreenCaptureTarget::Area {
                bounds: relative_bounds,
                ..
            } => {
                #[cfg(target_os = "macos")]
                {
                    Some(*relative_bounds)
                }

                #[cfg(windows)]
                {
                    let raw_display_size = display
                        .physical_size()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;
                    let logical_display_size = display
                        .logical_size()
                        .ok_or(ScreenCaptureInitError::NoBounds)?;

                    Some(PhysicalBounds::new(
                        PhysicalPosition::new(
                            (relative_bounds.position().x() / logical_display_size.width())
                                * raw_display_size.width(),
                            (relative_bounds.position().y() / logical_display_size.height())
                                * raw_display_size.height(),
                        ),
                        PhysicalSize::new(
                            (relative_bounds.size().width() / logical_display_size.width())
                                * raw_display_size.width(),
                            (relative_bounds.size().height() / logical_display_size.height())
                                * raw_display_size.height(),
                        ),
                    ))
                }
            }
        };

        let output_size = crop_bounds
            .and_then(|b| {
                #[cfg(target_os = "macos")]
                {
                    let logical_size = b.size();
                    let scale = display.raw_handle().scale()?;
                    Some(PhysicalSize::new(
                        logical_size.width() * scale,
                        logical_size.height() * scale,
                    ))
                }

                #[cfg(windows)]
                Some(b.size().map(|v| (v / 2.0).floor() * 2.0))
            })
            .or_else(|| display.physical_size())
            .ok_or(ScreenCaptureInitError::NoBounds)?;

        Ok(Self {
            config: Config {
                display: display.id(),
                crop_bounds,
                fps,
                show_cursor,
            },
            video_info: VideoInfo::from_raw_ffmpeg(
                TCaptureFormat::pixel_format(),
                output_size.width() as u32,
                output_size.height() as u32,
                fps,
            ),
            video_tx,
            audio_tx,
            tokio_handle,
            start_time,
            _phantom: std::marker::PhantomData,
        })
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    pub fn audio_info(&self) -> AudioInfo {
        TCaptureFormat::audio_info()
    }
}

pub fn list_displays() -> Vec<(CaptureDisplay, Display)> {
    cap_displays::Display::list()
        .into_iter()
        .filter_map(|display| {
            Some((
                CaptureDisplay {
                    id: display.id(),
                    name: display.name()?,
                    refresh_rate: display.raw_handle().refresh_rate() as u32,
                },
                display,
            ))
        })
        .collect()
}

pub fn list_windows() -> Vec<(CaptureWindow, Window)> {
    cap_displays::Window::list()
        .into_iter()
        .flat_map(|v| {
            let name = v.name()?;

            if name.is_empty() {
                return None;
            }

            #[cfg(target_os = "macos")]
            {
                if v.raw_handle().level() != Some(0)
                    || v.owner_name().filter(|v| v == "Window Server").is_some()
                {
                    return None;
                }
            }

            #[cfg(windows)]
            {
                if !v.raw_handle().is_valid() || !v.raw_handle().is_on_screen() {
                    return None;
                }
            }

            Some((
                CaptureWindow {
                    id: v.id(),
                    name,
                    owner_name: v.owner_name()?,
                    bounds: v.display_relative_logical_bounds()?,
                    refresh_rate: v.display()?.raw_handle().refresh_rate() as u32,
                },
                v,
            ))
        })
        .collect()
}
