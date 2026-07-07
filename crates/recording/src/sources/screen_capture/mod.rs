#[cfg(target_os = "macos")]
use crate::SendableShareableContent;
use cap_cursor_capture::CursorCropBounds;
use cap_media_info::{AudioInfo, VideoInfo, ensure_even};
use scap_targets::{Display, DisplayId, Window, WindowId, bounds::*};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::SystemTime;
use tracing::*;

pub mod cadence;

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

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug)]
pub enum LinuxCaptureSource {
    Display,
    Window,
    Area,
}

#[cfg(target_os = "linux")]
impl LinuxCaptureSource {
    pub fn from_target(target: &ScreenCaptureTarget) -> Self {
        match target {
            ScreenCaptureTarget::Window { .. } => Self::Window,
            ScreenCaptureTarget::Area { .. } => Self::Area,
            ScreenCaptureTarget::Display { .. } | ScreenCaptureTarget::CameraOnly => Self::Display,
        }
    }
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

                #[cfg(windows)]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_windows(PhysicalBounds::new(
                        PhysicalPosition::new(0.0, 0.0),
                        display.raw_handle().physical_size()?,
                    )));
                }

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    return Some(CursorCropBounds::new_linux(PhysicalBounds::new(
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

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    let display_bounds = self.display()?.raw_handle().physical_bounds()?;
                    let window_bounds = window.raw_handle().physical_bounds()?;

                    return Some(CursorCropBounds::new_linux(PhysicalBounds::new(
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

                #[cfg(windows)]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    let bounds = logical_area_to_physical_bounds(
                        *bounds,
                        display.logical_size()?,
                        display.physical_size()?,
                    )?;

                    return Some(CursorCropBounds::new_windows(bounds));
                }

                #[cfg(target_os = "linux")]
                #[allow(clippy::needless_return)]
                {
                    let display = self.display()?;
                    let bounds = logical_area_to_physical_bounds(
                        *bounds,
                        display.logical_size()?,
                        display.physical_size()?,
                    )?;

                    return Some(CursorCropBounds::new_linux(bounds));
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

                #[cfg(target_os = "macos")]
                {
                    let scale = display.physical_size()?.width() / display.logical_size()?.width();
                    let size = bounds.size();

                    Some(PhysicalSize::new(
                        size.width() * scale,
                        size.height() * scale,
                    ))
                }

                #[cfg(any(windows, target_os = "linux"))]
                {
                    Some(
                        logical_area_to_physical_bounds(
                            *bounds,
                            display.logical_size()?,
                            display.physical_size()?,
                        )?
                        .size(),
                    )
                }
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

fn constrain_capture_size(size: PhysicalSize, max_size: Option<(u32, u32)>) -> PhysicalSize {
    let width = size.width() as u32;
    let height = size.height() as u32;
    let Some((max_width, max_height)) = max_size else {
        return PhysicalSize::new(ensure_even(width) as f64, ensure_even(height) as f64);
    };

    if width <= max_width && height <= max_height {
        return PhysicalSize::new(ensure_even(width) as f64, ensure_even(height) as f64);
    }

    let width_scale = max_width as f64 / width as f64;
    let height_scale = max_height as f64 / height as f64;
    let scale = width_scale.min(height_scale);
    let constrained_width = ensure_even((width as f64 * scale).round() as u32);
    let constrained_height = ensure_even((height as f64 * scale).round() as u32);

    tracing::info!(
        input_width = width,
        input_height = height,
        output_width = constrained_width,
        output_height = constrained_height,
        max_width,
        max_height,
        "Screen capture input constrained for camera recording"
    );

    PhysicalSize::new(constrained_width as f64, constrained_height as f64)
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
    #[cfg(target_os = "linux")]
    linux_source: LinuxCaptureSource,
}

#[cfg(target_os = "macos")]
pub type CropBounds = LogicalBounds;

#[cfg(windows)]
pub type CropBounds = PhysicalBounds;

#[cfg(target_os = "linux")]
pub type CropBounds = PhysicalBounds;

#[cfg(any(windows, target_os = "linux", test))]
pub(crate) fn logical_area_to_physical_bounds(
    bounds: LogicalBounds,
    logical_display_size: LogicalSize,
    physical_display_size: PhysicalSize,
) -> Option<PhysicalBounds> {
    let (x, width) = logical_axis_to_physical(
        bounds.position().x(),
        bounds.size().width(),
        logical_display_size.width(),
        physical_display_size.width(),
    )?;
    let (y, height) = logical_axis_to_physical(
        bounds.position().y(),
        bounds.size().height(),
        logical_display_size.height(),
        physical_display_size.height(),
    )?;

    Some(PhysicalBounds::new(
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    ))
}

#[cfg(any(windows, target_os = "linux", test))]
fn logical_axis_to_physical(
    position: f64,
    size: f64,
    logical_extent: f64,
    physical_extent: f64,
) -> Option<(f64, f64)> {
    if !position.is_finite()
        || !size.is_finite()
        || !logical_extent.is_finite()
        || !physical_extent.is_finite()
        || logical_extent <= 0.0
        || physical_extent <= 0.0
    {
        return None;
    }

    let start = position.clamp(0.0, logical_extent);
    let end = (position + size).clamp(0.0, logical_extent);
    let scale = physical_extent / logical_extent;
    let physical_start = start.min(end) * scale;
    let physical_end = start.max(end) * scale;
    let min_size = 2.0_f64.min(physical_extent);
    let size = (physical_end - physical_start).clamp(min_size, physical_extent);
    let position = physical_start.min(physical_extent - size).max(0.0);

    Some((position, size))
}

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
        max_capture_size: Option<(u32, u32)>,
        start_time: SystemTime,
        system_audio: bool,
        #[cfg(target_os = "linux")] linux_source: LinuxCaptureSource,
        #[cfg(windows)] d3d_device: ::windows::Win32::Graphics::Direct3D11::ID3D11Device,
        #[cfg(target_os = "macos")] shareable_content: SendableShareableContent,
        #[cfg(target_os = "macos")] excluded_windows: Vec<WindowId>,
    ) -> Result<Self, ScreenCaptureInitError> {
        cap_fail::fail!("ScreenCaptureSource::init");

        let target_refresh = validated_refresh_rate(display.refresh_rate());
        let fps = std::cmp::max(1, std::cmp::min(max_fps, target_refresh));

        let native_output_size: PhysicalSize = {
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

            #[cfg(target_os = "windows")]
            {
                crop_bounds.map(|b| b.size().map(|v| (v / 2.0).floor() * 2.0))
            }

            #[cfg(target_os = "linux")]
            {
                crop_bounds.map(|b| b.size().map(|v| (v / 2.0).floor() * 2.0))
            }
        }
        .or_else(|| display.physical_size())
        .ok_or(ScreenCaptureInitError::NoBounds)?;
        let output_size = constrain_capture_size(native_output_size, max_capture_size);

        Ok(Self {
            config: Config {
                display: display.id(),
                crop_bounds,
                fps,
                show_cursor,
                #[cfg(target_os = "linux")]
                linux_source,
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
        .map(|display| {
            let refresh_rate = validated_refresh_rate(display.raw_handle().refresh_rate());

            (
                CaptureDisplay {
                    id: display.id(),
                    name: display
                        .name()
                        .unwrap_or_else(|| format!("Display {}", display.id())),
                    refresh_rate,
                },
                display,
            )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_area_to_physical_bounds_scales_each_axis() {
        let bounds = LogicalBounds::new(
            LogicalPosition::new(120.0, 80.0),
            LogicalSize::new(640.0, 360.0),
        );
        let physical = logical_area_to_physical_bounds(
            bounds,
            LogicalSize::new(1920.0, 1080.0),
            PhysicalSize::new(3840.0, 2160.0),
        )
        .unwrap();

        assert_eq!(physical.position().x(), 240.0);
        assert_eq!(physical.position().y(), 160.0);
        assert_eq!(physical.size().width(), 1280.0);
        assert_eq!(physical.size().height(), 720.0);
    }

    #[test]
    fn logical_area_to_physical_bounds_clamps_to_display() {
        let bounds = LogicalBounds::new(
            LogicalPosition::new(-10.0, 100.0),
            LogicalSize::new(2_000.0, 1_000.0),
        );
        let physical = logical_area_to_physical_bounds(
            bounds,
            LogicalSize::new(1920.0, 1080.0),
            PhysicalSize::new(3840.0, 2160.0),
        )
        .unwrap();

        assert_eq!(physical.position().x(), 0.0);
        assert_eq!(physical.position().y(), 200.0);
        assert_eq!(physical.size().width(), 3840.0);
        assert_eq!(physical.size().height(), 1960.0);
    }

    #[test]
    fn logical_area_to_physical_bounds_keeps_edge_crop_inside_display() {
        let bounds = LogicalBounds::new(
            LogicalPosition::new(1930.0, -20.0),
            LogicalSize::new(100.0, 0.0),
        );
        let physical = logical_area_to_physical_bounds(
            bounds,
            LogicalSize::new(1920.0, 1080.0),
            PhysicalSize::new(3840.0, 2160.0),
        )
        .unwrap();

        assert_eq!(physical.position().x(), 3838.0);
        assert_eq!(physical.position().y(), 0.0);
        assert_eq!(physical.size().width(), 2.0);
        assert_eq!(physical.size().height(), 2.0);
    }
}
