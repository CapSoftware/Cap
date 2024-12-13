use std::{
    ops::{Add, Div, Mul, Sub},
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
        id: u16,
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
        BackgroundSource::Color {
            value: [71, 133, 255],
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct XY<T> {
    pub x: T,
    pub y: T,
}

impl<T> XY<T> {
    pub fn new(x: T, y: T) -> Self {
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

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default)]
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundConfiguration {
    pub source: BackgroundSource,
    pub blur: u32,
    pub padding: f64,
    pub rounding: f64,
    pub inset: u32,
    pub crop: Option<Crop>,
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
    pub rounding: f32,
    pub shadow: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            hide: false,
            mirror: false,
            position: CameraPosition::default(),
            size: 30.0,
            zoom_size: None,
            rounding: 100.0,
            shadow: 0.0,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfiguration {
    mute: bool,
    improve: bool,
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
    hide_when_idle: bool,
    pub size: u32,
    r#type: CursorType,
    pub animation_style: CursorAnimationStyle,
}

impl Default for CursorConfiguration {
    fn default() -> Self {
        Self {
            hide_when_idle: false,
            size: 100,
            r#type: CursorType::default(),
            animation_style: CursorAnimationStyle::Regular,
        }
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
    pub recording_segment: Option<u32>,
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

    fn duration(&self) -> f64 {
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConfiguration {
    pub segments: Vec<TimelineSegment>,
    #[serde(default)]
    pub zoom_segments: Vec<ZoomSegment>,
}

impl TimelineConfiguration {
    pub fn get_recording_time(&self, tick_time: f64) -> Option<(f64, Option<u32>)> {
        let mut accum_duration = 0.0;

        for segment in self.segments.iter() {
            if tick_time < accum_duration + segment.duration() {
                return segment
                    .interpolate_time(tick_time - accum_duration)
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

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfiguration {
    pub aspect_ratio: Option<AspectRatio>,
    pub background: BackgroundConfiguration,
    pub camera: Camera,
    pub audio: AudioConfiguration,
    pub cursor: CursorConfiguration,
    pub hotkeys: HotkeysConfiguration,
    #[serde(default)]
    pub timeline: Option<TimelineConfiguration>,
    pub motion_blur: Option<f32>,
}

impl ProjectConfiguration {
    pub fn load(project_path: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        std::fs::read_to_string(project_path.as_ref().join("project-config.json"))
            .map(|s| serde_json::from_str(&s).unwrap_or_default())
    }

    pub fn write(&self, project_path: impl AsRef<Path>) -> Result<(), std::io::Error> {
        std::fs::write(
            project_path.as_ref().join("project-config.json"),
            serde_json::to_string_pretty(self)?,
        )
    }

    pub fn timeline(&self) -> Option<&TimelineConfiguration> {
        self.timeline.as_ref()
    }
}

impl Default for ProjectConfiguration {
    fn default() -> Self {
        ProjectConfiguration {
            aspect_ratio: None,
            background: BackgroundConfiguration {
                source: BackgroundSource::default(),
                ..Default::default()
            },
            camera: Camera::default(),
            audio: AudioConfiguration::default(),
            cursor: CursorConfiguration::default(),
            hotkeys: HotkeysConfiguration::default(),
            timeline: None,
            motion_blur: None,
        }
    }
}

pub const SLOW_SMOOTHING_SAMPLES: usize = 24;
pub const REGULAR_SMOOTHING_SAMPLES: usize = 16;
pub const FAST_SMOOTHING_SAMPLES: usize = 10;

pub const SLOW_VELOCITY_THRESHOLD: f64 = 0.003;
pub const REGULAR_VELOCITY_THRESHOLD: f64 = 0.008;
pub const FAST_VELOCITY_THRESHOLD: f64 = 0.015;
