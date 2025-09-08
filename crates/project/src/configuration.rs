use std::{
    ops::{Add, Div, Mul, Sub, SubAssign},
    path::Path,
};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum AspectRatio {
    #[default]
    Wide,
    Vertical,
    Square,
    Classic,
    Tall,
}

pub type Color = [u16; 3];

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum BackgroundSource {
    Wallpaper {
        path: Option<String>,
    },
    Image {
        path: Option<String>,
    },
    Color {
        value: Color,
    },
    Gradient {
        from: Color,
        to: Color,
        #[serde(default = "default_gradient_angle")]
        angle: u16,
    },
}

fn default_gradient_angle() -> u16 {
    90
}

impl Default for BackgroundSource {
    fn default() -> Self {
        BackgroundSource::Wallpaper {
            path: Some("sequoia-dark".to_string()),
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XY<T> {
    pub x: T,
    pub y: T,
}

impl<T> XY<T> {
    pub const fn new(x: T, y: T) -> Self {
        Self { x, y }
    }

    pub fn map<U, F: Fn(T) -> U>(self, f: F) -> XY<U> {
        XY {
            x: f(self.x),
            y: f(self.y),
        }
    }
}

impl<T: Add<Output = T>> Add for XY<T> {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }
}

impl<T: Sub<Output = T>> Sub for XY<T> {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }
}

impl<T: Sub<Output = T> + Copy> Sub<T> for XY<T> {
    type Output = Self;

    fn sub(self, other: T) -> Self {
        Self {
            x: self.x - other,
            y: self.y - other,
        }
    }
}

impl<T: Mul<Output = T> + Copy> Mul<T> for XY<T> {
    type Output = Self;

    fn mul(self, other: T) -> Self {
        Self {
            x: self.x * other,
            y: self.y * other,
        }
    }
}

impl<T: Mul<Output = T> + Copy> Mul<XY<T>> for XY<T> {
    type Output = Self;

    fn mul(self, other: Self) -> Self {
        Self {
            x: self.x * other.x,
            y: self.y * other.y,
        }
    }
}

impl<T: Div<Output = T> + Copy> Div<T> for XY<T> {
    type Output = Self;

    fn div(self, other: T) -> Self {
        Self {
            x: self.x / other,
            y: self.y / other,
        }
    }
}

impl<T: Div<Output = T>> Div<XY<T>> for XY<T> {
    type Output = Self;

    fn div(self, other: XY<T>) -> Self {
        Self {
            x: self.x / other.x,
            y: self.y / other.y,
        }
    }
}

impl<T> SubAssign for XY<T>
where
    T: SubAssign + Copy,
{
    fn sub_assign(&mut self, rhs: Self) {
        self.x -= rhs.x;
        self.y -= rhs.y;
    }
}

impl From<XY<f32>> for XY<f64> {
    fn from(val: XY<f32>) -> Self {
        XY {
            x: val.x as f64,
            y: val.y as f64,
        }
    }
}

impl<T> From<(T, T)> for XY<T> {
    fn from(val: (T, T)) -> Self {
        XY { x: val.0, y: val.1 }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub position: XY<u32>,
    pub size: XY<u32>,
}

impl Crop {
    pub fn aspect_ratio(&self) -> f32 {
        self.size.x as f32 / self.size.y as f32
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
pub struct ShadowConfiguration {
    pub size: f32,    // Overall shadow size (0-100)
    pub opacity: f32, // Shadow opacity (0-100)
    pub blur: f32,    // Shadow blur amount (0-100)
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BorderConfiguration {
    pub enabled: bool,
    pub width: f32,   // Border width in pixels
    pub color: Color, // Border color (RGB)
    pub opacity: f32, // Border opacity (0-100)
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundConfiguration {
    pub source: BackgroundSource,
    pub blur: f64,
    pub padding: f64,
    pub rounding: f64,
    pub inset: u32,
    pub crop: Option<Crop>,
    #[serde(default)]
    pub shadow: f32,
    #[serde(default)]
    pub advanced_shadow: Option<ShadowConfiguration>,
    #[serde(default)]
    pub border: Option<BorderConfiguration>,
}

impl Default for BorderConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            width: 5.0,
            color: [255, 255, 255], // White
            opacity: 80.0,          // 80% opacity
        }
    }
}

impl Default for BackgroundConfiguration {
    fn default() -> Self {
        Self {
            source: BackgroundSource::default(),
            blur: 0.0,
            padding: 0.0,
            rounding: 0.0,
            inset: 0,
            crop: None,
            shadow: 73.6,
            advanced_shadow: Some(ShadowConfiguration::default()),
            border: None, // Border is disabled by default for backwards compatibility
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum CameraXPosition {
    Left,
    Center,
    #[default]
    Right,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum CameraYPosition {
    Top,
    #[default]
    Bottom,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CameraPosition {
    pub x: CameraXPosition,
    pub y: CameraYPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Camera {
    pub hide: bool,
    pub mirror: bool,
    pub position: CameraPosition,
    pub size: f32,
    pub zoom_size: Option<f32>,
    #[serde(default = "Camera::default_rounding")]
    pub rounding: f32,
    #[serde(default)]
    pub shadow: f32,
    #[serde(default)]
    pub advanced_shadow: Option<ShadowConfiguration>,
    #[serde(default)]
    pub shape: CameraShape,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum CameraShape {
    #[default]
    Square,
    Source,
}

impl Camera {
    pub fn default_zoom_size() -> f32 {
        60.0
    }

    fn default_rounding() -> f32 {
        30.0
    }
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            hide: false,
            mirror: false,
            position: CameraPosition::default(),
            size: 30.0,
            zoom_size: Some(Self::default_zoom_size()),
            rounding: Self::default_rounding(),
            shadow: 62.5,
            advanced_shadow: Some(ShadowConfiguration {
                size: 33.9,
                opacity: 44.2,
                blur: 10.5,
            }),
            shape: CameraShape::Square,
        }
    }
}

impl Default for ShadowConfiguration {
    fn default() -> Self {
        Self {
            size: 14.4,
            opacity: 68.1,
            blur: 3.8,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StereoMode {
    #[default]
    Stereo,
    MonoL,
    MonoR,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfiguration {
    pub mute: bool,
    pub improve: bool,
    #[serde(default)]
    pub mic_volume_db: f32,
    #[serde(default)]
    pub mic_stereo_mode: StereoMode,
    #[serde(default)]
    pub system_volume_db: f32,
}

impl Default for AudioConfiguration {
    fn default() -> Self {
        Self {
            mute: false,
            improve: false,
            mic_volume_db: 0.0,
            mic_stereo_mode: StereoMode::default(),
            system_volume_db: 0.0,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum CursorType {
    #[default]
    Pointer,
    Circle,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum CursorAnimationStyle {
    #[default]
    Regular,
    Slow,
    Fast,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorConfiguration {
    #[serde(default)]
    pub hide: bool,
    hide_when_idle: bool,
    pub size: u32,
    r#type: CursorType,
    pub animation_style: CursorAnimationStyle,
    pub tension: f32,
    pub mass: f32,
    pub friction: f32,
    #[serde(default = "CursorConfiguration::default_raw")]
    pub raw: bool,
    #[serde(default)]
    pub motion_blur: f32,
    #[serde(default = "yes")]
    pub use_svg: bool,
}

fn yes() -> bool {
    true
}

impl Default for CursorConfiguration {
    fn default() -> Self {
        Self {
            hide: false,
            hide_when_idle: false,
            size: 100,
            r#type: CursorType::default(),
            animation_style: CursorAnimationStyle::Regular,
            tension: 100.0,
            mass: 1.0,
            friction: 20.0,
            raw: false,
            motion_blur: 0.5,
            use_svg: true,
        }
    }
}
impl CursorConfiguration {
    fn default_raw() -> bool {
        true
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HotkeysConfiguration {
    show: bool,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSegment {
    #[serde(default)]
    pub recording_segment: u32,
    pub timescale: f64,
    pub start: f64,
    pub end: f64,
}

impl TimelineSegment {
    fn interpolate_time(&self, tick: f64) -> Option<f64> {
        if tick > self.duration() {
            None
        } else {
            Some(self.start + tick * self.timescale)
        }
    }

    /// in seconds
    pub fn duration(&self) -> f64 {
        (self.end - self.start) / self.timescale
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoomSegment {
    pub start: f64,
    pub end: f64,
    pub amount: f64,
    pub mode: ZoomMode,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ZoomMode {
    Auto,
    Manual { x: f32, y: f32 },
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum SceneMode {
    #[default]
    Default,
    CameraOnly,
    HideCamera,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub mode: SceneMode,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConfiguration {
    pub segments: Vec<TimelineSegment>,
    pub zoom_segments: Vec<ZoomSegment>,
    #[serde(default)]
    pub scene_segments: Vec<SceneSegment>,
}

impl TimelineConfiguration {
    pub fn get_segment_time(&self, frame_time: f64) -> Option<(f64, u32)> {
        let mut accum_duration = 0.0;

        for segment in self.segments.iter() {
            if frame_time < accum_duration + segment.duration() {
                return segment
                    .interpolate_time(frame_time - accum_duration)
                    .map(|t| (t, segment.recording_segment));
            }

            accum_duration += segment.duration();
        }

        None
    }

    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration()).sum()
    }
}

pub const WALLPAPERS_PATH: &str = "assets/backgrounds/macOS";

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub id: String,
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSettings {
    pub enabled: bool,
    pub font: String,
    pub size: u32,
    pub color: String,
    #[serde(alias = "backgroundColor")]
    pub background_color: String,
    #[serde(alias = "backgroundOpacity")]
    pub background_opacity: u32,
    pub position: String,
    pub bold: bool,
    pub italic: bool,
    pub outline: bool,
    #[serde(alias = "outlineColor")]
    pub outline_color: String,
    #[serde(alias = "exportWithSubtitles")]
    pub export_with_subtitles: bool,
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            font: "System Sans-Serif".to_string(),
            size: 24,
            color: "#FFFFFF".to_string(),
            background_color: "#000000".to_string(),
            background_opacity: 80,
            position: "bottom".to_string(),
            bold: true,
            italic: false,
            outline: true,
            outline_color: "#000000".to_string(),
            export_with_subtitles: false,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct CaptionsData {
    pub segments: Vec<CaptionSegment>,
    pub settings: CaptionSettings,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct ProjectConfiguration {
    pub aspect_ratio: Option<AspectRatio>,
    pub background: BackgroundConfiguration,
    pub camera: Camera,
    pub audio: AudioConfiguration,
    pub cursor: CursorConfiguration,
    pub hotkeys: HotkeysConfiguration,
    #[serde(default)]
    pub timeline: Option<TimelineConfiguration>,
    #[serde(default)]
    pub captions: Option<CaptionsData>,
}

impl ProjectConfiguration {
    pub fn load(project_path: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let config_str =
            std::fs::read_to_string(project_path.as_ref().join("project-config.json"))?;
        let config: Self = serde_json::from_str(&config_str).unwrap_or_default();

        Ok(config)
    }

    pub fn write(&self, project_path: impl AsRef<Path>) -> Result<(), std::io::Error> {
        std::fs::write(
            project_path.as_ref().join("project-config.json"),
            serde_json::to_string_pretty(self)?,
        )
    }

    pub fn get_segment_time(&self, frame_time: f64) -> Option<(f64, u32)> {
        self.timeline
            .as_ref()
            .map(|t| t.get_segment_time(frame_time))
            .unwrap_or(Some((frame_time, 0)))
    }
}

pub const SLOW_SMOOTHING_SAMPLES: usize = 24;
pub const REGULAR_SMOOTHING_SAMPLES: usize = 16;
pub const FAST_SMOOTHING_SAMPLES: usize = 10;

pub const SLOW_VELOCITY_THRESHOLD: f64 = 0.003;
pub const REGULAR_VELOCITY_THRESHOLD: f64 = 0.008;
pub const FAST_VELOCITY_THRESHOLD: f64 = 0.015;
