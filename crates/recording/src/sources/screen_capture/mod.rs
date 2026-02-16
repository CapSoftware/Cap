#[cfg(target_os = "macos")]
use crate::SendableShareableContent;
use cap_cursor_capture::CursorCropBounds;
#[cfg(target_os = "macos")]
use cap_media_info::ensure_even;
use cap_media_info::{AudioInfo, VideoInfo};
use scap_targets::{Display, DisplayId, Window, WindowId, bounds::*};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::SystemTime;
use tracing::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

pub struct StopCapturing;

#[derive(Debug, Clone, thiserror::Error)]
pub enum StopCapturingError {
    #[error("NotCapturing")]
    NotCapturing,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CaptureWindow {
    pub id: WindowId,
    pub owner_name: String,
    pub name: String,
    pub bounds: LogicalBounds,
    pub refresh_rate: u32,
    pub bundle_identifier: Option<String>,
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
    CameraOnly,
}

impl ScreenCaptureTarget {
    pub fn display(&self) -> Option<Display> {
        match self {
            Self::Display { id } => Display::from_id(id),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.display()),
            Self::Area { screen, .. } => Display::from_id(screen),
            Self::CameraOnly => None,
        }
    }

    pub fn window(&self) -> Option<WindowId> {
        match self {
            Self::Window { id } => Some(id.clone()),
            _ => None,
        }
    }

    pub fn cursor_crop(&self) -> Option<CursorCropBounds> {
        match self {
            Self::Display { .. } => {
                #[cfg(target_os = "macos")]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_macos(LogicalBounds::new(
                        LogicalPosition::new(0.0, 0.0),
                        display.raw_handle().logical_size()?,
                    )));
                }

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_linux(LogicalBounds::new(
                        LogicalPosition::new(0.0, 0.0),
                        display.raw_handle().logical_size()?,
                    )));
                }

                #[cfg(windows)]
                #[allow(clippy::needless_return)]
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
                #[allow(clippy::needless_return)]
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

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    let display_bounds = display.raw_handle().logical_bounds()?;
                    let window_bounds = window.raw_handle().logical_bounds()?;

                    return Some(CursorCropBounds::new_linux(LogicalBounds::new(
                        LogicalPosition::new(
                            window_bounds.position().x() - display_bounds.position().x(),
                            window_bounds.position().y() - display_bounds.position().y(),
                        ),
                        window_bounds.size(),
                    )));
                }

                #[cfg(windows)]
                #[allow(clippy::needless_return)]
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
                #[allow(clippy::needless_return)]
                {
                    return Some(CursorCropBounds::new_macos(*bounds));
                }

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    return Some(CursorCropBounds::new_linux(*bounds));
                }

                #[cfg(windows)]
                #[allow(clippy::needless_return)]
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
            Self::CameraOnly => None,
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
            Self::CameraOnly => None,
        }
    }

    pub fn title(&self) -> Option<String> {
        match self {
            Self::Display { id } => Display::from_id(id).and_then(|d| d.name()),
            Self::Window { id } => Window::from_id(id).and_then(|w| w.name()),
            Self::Area { screen, .. } => Display::from_id(screen).and_then(|d| d.name()),
            Self::CameraOnly => Some("Camera".to_string()),
        }
    }

    pub fn kind_str(&self) -> &str {
        match self {
            ScreenCaptureTarget::Display { .. } => "Display",
            ScreenCaptureTarget::Window { .. } => "Window",
            ScreenCaptureTarget::Area { .. } => "Area",
            ScreenCaptureTarget::CameraOnly => "Camera",
        }
    }
}

pub struct ScreenCaptureConfig<TCaptureFormat: ScreenCaptureFormat> {
    config: Config,
    video_info: VideoInfo,
    start_time: SystemTime,
    pub system_audio: bool,
    _phantom: std::marker::PhantomData<TCaptureFormat>,
    #[cfg(windows)]
    d3d_device: ::windows::Win32::Graphics::Direct3D11::ID3D11Device,
    #[cfg(target_os = "macos")]
    shareable_content: cidre::arc::R<cidre::sc::ShareableContent>,
    #[cfg(target_os = "macos")]
    pub excluded_windows: Vec<WindowId>,
}

impl<T: ScreenCaptureFormat> std::fmt::Debug for ScreenCaptureConfig<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScreenCaptureSource")
            // .field("bounds", &self.bounds)
            // .field("output_resolution", &self.output_resolution)
            .field("fps", &self.config.fps)
            .field("video_info", &self.video_info)
            .finish()
    }
}

unsafe impl<T: ScreenCaptureFormat> Send for ScreenCaptureConfig<T> {}
unsafe impl<T: ScreenCaptureFormat> Sync for ScreenCaptureConfig<T> {}

pub trait ScreenCaptureFormat {
    type VideoFormat;

    fn pixel_format() -> ffmpeg::format::Pixel;

    fn audio_info() -> AudioInfo;
}

impl<TCaptureFormat: ScreenCaptureFormat> Clone for ScreenCaptureConfig<TCaptureFormat> {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            video_info: self.video_info,
            start_time: self.start_time,
            system_audio: self.system_audio,
            _phantom: std::marker::PhantomData,
            #[cfg(windows)]
            d3d_device: self.d3d_device.clone(),
            #[cfg(target_os = "macos")]
            shareable_content: self.shareable_content.clone(),
            #[cfg(target_os = "macos")]
            excluded_windows: self.excluded_windows.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    display: DisplayId,
    crop_bounds: Option<CropBounds>,
    fps: u32,
    show_cursor: bool,
}

#[cfg(target_os = "macos")]
pub type CropBounds = LogicalBounds;

#[cfg(target_os = "linux")]
pub type CropBounds = LogicalBounds;

#[cfg(windows)]
pub type CropBounds = PhysicalBounds;

impl Config {
    pub fn fps(&self) -> u32 {
        self.fps
    }
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

impl<TCaptureFormat: ScreenCaptureFormat> ScreenCaptureConfig<TCaptureFormat> {
    #[allow(clippy::too_many_arguments)]
    pub async fn init(
        display: scap_targets::Display,
        crop_bounds: Option<CropBounds>,
        show_cursor: bool,
        max_fps: u32,
        start_time: SystemTime,
        system_audio: bool,
        #[cfg(windows)] d3d_device: ::windows::Win32::Graphics::Direct3D11::ID3D11Device,
        #[cfg(target_os = "macos")] shareable_content: SendableShareableContent,
        #[cfg(target_os = "macos")] excluded_windows: Vec<WindowId>,
    ) -> Result<Self, ScreenCaptureInitError> {
        cap_fail::fail!("ScreenCaptureSource::init");

        let target_refresh = validated_refresh_rate(display.refresh_rate());
        let fps = std::cmp::max(1, std::cmp::min(max_fps, target_refresh));

        let output_size: PhysicalSize = {
            #[cfg(target_os = "macos")]
            {
                crop_bounds.and_then(|b| {
                    let logical_size = b.size();
                    let scale = display.raw_handle().scale()?;
                    let width = ensure_even((logical_size.width() * scale) as u32) as f64;
                    let height = ensure_even((logical_size.height() * scale) as u32) as f64;
                    Some(PhysicalSize::new(width, height))
                })
            }

            #[cfg(target_os = "linux")]
            {
                crop_bounds.map(|b| {
                    let size = b.size();
                    let width = (size.width() as u32 / 2 * 2) as f64;
                    let height = (size.height() as u32 / 2 * 2) as f64;
                    PhysicalSize::new(width, height)
                })
            }

            #[cfg(target_os = "windows")]
            {
                crop_bounds.map(|b| b.size().map(|v| (v / 2.0).floor() * 2.0))
            }
        }
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
            start_time,
            system_audio,
            _phantom: std::marker::PhantomData,
            #[cfg(windows)]
            d3d_device,
            #[cfg(target_os = "macos")]
            shareable_content: shareable_content.retained(),
            #[cfg(target_os = "macos")]
            excluded_windows,
        })
    }

    #[cfg(windows)]
    pub fn d3d_device(&self) -> &::windows::Win32::Graphics::Direct3D11::ID3D11Device {
        &self.d3d_device
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn info(&self) -> VideoInfo {
        self.video_info
    }

    pub fn audio_info(&self) -> AudioInfo {
        TCaptureFormat::audio_info()
    }
}

fn validated_refresh_rate<T>(reported_refresh_rate: T) -> u32
where
    T: Into<f64>,
{
    let reported_refresh_rate = reported_refresh_rate.into();
    let fallback_refresh = 60;
    let rounded_refresh = reported_refresh_rate.round();
    let is_invalid_refresh = !rounded_refresh.is_finite() || rounded_refresh <= 0.0;
    let capped_refresh = if is_invalid_refresh {
        fallback_refresh as f64
    } else {
        rounded_refresh.min(500.0)
    };

    if is_invalid_refresh {
        warn!(
            ?reported_refresh_rate,
            fallback = fallback_refresh,
            "Display reported invalid refresh rate; falling back to default"
        );
        fallback_refresh
    } else {
        capped_refresh as u32
    }
}

pub fn list_displays() -> Vec<(CaptureDisplay, Display)> {
    scap_targets::Display::list()
        .into_iter()
        .filter_map(|display| {
            let refresh_rate = validated_refresh_rate(display.raw_handle().refresh_rate());

            Some((
                CaptureDisplay {
                    id: display.id(),
                    name: display.name()?,
                    refresh_rate,
                },
                display,
            ))
        })
        .collect()
}

pub fn list_windows() -> Vec<(CaptureWindow, Window)> {
    scap_targets::Window::list()
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

            let owner_name = v.owner_name()?;

            #[cfg(target_os = "macos")]
            let bundle_identifier = v.raw_handle().bundle_identifier();

            #[cfg(not(target_os = "macos"))]
            let bundle_identifier = None;

            let refresh_rate = v
                .display()
                .map(|display| validated_refresh_rate(display.raw_handle().refresh_rate()))?;

            Some((
                CaptureWindow {
                    id: v.id(),
                    name,
                    owner_name,
                    bounds: v.display_relative_logical_bounds()?,
                    refresh_rate,
                    bundle_identifier,
                },
                v,
            ))
        })
        .collect()
}
