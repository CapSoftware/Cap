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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct XY<T> {
    pub x: T,
    pub y: T,
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundConfiguration {
    pub source: BackgroundSource,
    pub blur: u32,
    pub padding: f32,
    pub rounding: f32,
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CameraConfiguration {
    pub hide: bool,
    pub mirror: bool,
    pub position: CameraPosition,
    pub rounding: f32,
    pub shadow: u32,
    // min 20 max 80
    #[serde(default = "CameraConfiguration::default_size")]
    pub size: f32,
}

impl CameraConfiguration {
    fn default_size() -> f32 {
        30.0
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
pub struct CursorConfiguration {
    hide_when_idle: bool,
    size: u32,
    r#type: CursorType,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HotkeysConfiguration {
    show: bool,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSegment {
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConfiguration {
    pub segments: Vec<TimelineSegment>,
}

impl TimelineConfiguration {
    pub fn get_recording_time(&self, tick_time: f64) -> Option<f64> {
        let mut accum_duration = 0.0;

        for segment in &self.segments {
            if tick_time < accum_duration + segment.duration() {
                return segment.interpolate_time(tick_time - accum_duration);
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
    pub camera: CameraConfiguration,
    pub audio: AudioConfiguration,
    pub cursor: CursorConfiguration,
    pub hotkeys: HotkeysConfiguration,
    #[serde(default)]
    pub timeline: Option<TimelineConfiguration>,
}

impl ProjectConfiguration {
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
            camera: CameraConfiguration {
                position: CameraPosition {
                    x: CameraXPosition::Right,
                    y: CameraYPosition::Bottom,
                },
                ..Default::default()
            },
            audio: AudioConfiguration::default(),
            cursor: CursorConfiguration::default(),
            hotkeys: HotkeysConfiguration::default(),
            timeline: None,
        }
    }
}
