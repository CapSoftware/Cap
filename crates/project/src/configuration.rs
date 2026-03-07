use std::{
    env::temp_dir,
    fmt,
    ops::{Add, Div, Mul, Sub, SubAssign},
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
        #[serde(default = "default_alpha")]
        alpha: u8,
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

fn default_alpha() -> u8 {
    u8::MAX
}

impl Default for BackgroundSource {
    fn default() -> Self {
        BackgroundSource::Color {
            value: [255, 255, 255],
            alpha: 255,
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

impl<T: Mul<Output = T> + Copy> Mul<XY<T>> for XY<T> {
    type Output = Self;

    fn mul(self, other: Self) -> Self {
        Self {
            x: self.x * other.x,
            y: self.y * other.y,
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

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum CornerStyle {
    #[default]
    Squircle,
    Rounded,
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
#[serde(default)]
pub struct ShadowConfiguration {
    pub size: f32,
    pub opacity: f32,
    pub blur: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BorderConfiguration {
    pub enabled: bool,
    pub width: f32,
    pub color: Color,
    pub opacity: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundConfiguration {
    pub source: BackgroundSource,
    pub blur: f64,
    pub padding: f64,
    pub rounding: f64,
    pub rounding_type: CornerStyle,
    pub inset: u32,
    pub crop: Option<Crop>,
    pub shadow: f32,
    pub advanced_shadow: Option<ShadowConfiguration>,
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
            rounding_type: CornerStyle::default(),
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
#[serde(rename_all = "camelCase", default)]
pub struct CameraPosition {
    pub x: CameraXPosition,
    pub y: CameraYPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Camera {
    pub hide: bool,
    pub mirror: bool,
    pub position: CameraPosition,
    pub size: f32,
    #[serde(alias = "zoom_size")]
    pub zoom_size: Option<f32>,
    pub rounding: f32,
    pub shadow: f32,
    #[serde(alias = "advanced_shadow")]
    pub advanced_shadow: Option<ShadowConfiguration>,
    pub shape: CameraShape,
    #[serde(alias = "rounding_type")]
    pub rounding_type: CornerStyle,
    #[serde(default = "Camera::default_scale_during_zoom")]
    pub scale_during_zoom: f32,
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
        100.0
    }

    fn default_scale_during_zoom() -> f32 {
        0.7
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
            rounding_type: CornerStyle::default(),
            scale_during_zoom: Self::default_scale_during_zoom(),
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
#[serde(rename_all = "camelCase", default)]
pub struct AudioConfiguration {
    pub mute: bool,
    pub improve: bool,
    pub mic_volume_db: f32,
    pub mic_stereo_mode: StereoMode,
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CursorType {
    #[default]
    Auto,
    Pointer,
    Circle,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CursorAnimationStyle {
    Slow,
    #[default]
    #[serde(alias = "regular", alias = "quick", alias = "rapid", alias = "fast")]
    Mellow,
    Custom,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
pub struct CursorSmoothingPreset {
    pub tension: f32,
    pub mass: f32,
    pub friction: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClickSpringConfig {
    pub tension: f32,
    pub mass: f32,
    pub friction: f32,
}

impl Default for ClickSpringConfig {
    fn default() -> Self {
        Self {
            tension: 700.0,
            mass: 1.0,
            friction: 30.0,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenMovementSpring {
    pub stiffness: f32,
    pub damping: f32,
    pub mass: f32,
}

impl Default for ScreenMovementSpring {
    fn default() -> Self {
        Self {
            stiffness: 200.0,
            damping: 40.0,
            mass: 2.25,
        }
    }
}

impl CursorAnimationStyle {
    pub fn preset(self) -> Option<CursorSmoothingPreset> {
        match self {
            Self::Slow => Some(CursorSmoothingPreset {
                tension: 200.0,
                mass: 2.25,
                friction: 40.0,
            }),
            Self::Mellow => Some(CursorSmoothingPreset {
                tension: 470.0,
                mass: 3.0,
                friction: 70.0,
            }),
            Self::Custom => None,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CursorConfiguration {
    pub hide: bool,
    pub hide_when_idle: bool,
    pub hide_when_idle_delay: f32,
    pub size: u32,
    r#type: CursorType,
    pub animation_style: CursorAnimationStyle,
    pub tension: f32,
    pub mass: f32,
    pub friction: f32,
    pub raw: bool,
    pub motion_blur: f32,
    pub use_svg: bool,
    #[serde(default = "CursorConfiguration::default_rotation_amount")]
    pub rotation_amount: f32,
    #[serde(default)]
    pub base_rotation: f32,
    #[serde(default)]
    pub click_spring: Option<ClickSpringConfig>,
    #[serde(default)]
    pub stop_movement_in_last_seconds: Option<f32>,
}

impl Default for CursorConfiguration {
    fn default() -> Self {
        let animation_style = CursorAnimationStyle::default();
        let mut config = Self {
            hide: false,
            hide_when_idle: false,
            hide_when_idle_delay: Self::default_hide_when_idle_delay(),
            size: 150,
            r#type: CursorType::default(),
            animation_style,
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
            raw: false,
            motion_blur: 0.5,
            use_svg: true,
            rotation_amount: Self::default_rotation_amount(),
            base_rotation: 0.0,
            click_spring: None,
            stop_movement_in_last_seconds: None,
        };

        if let Some(preset) = animation_style.preset() {
            config.tension = preset.tension;
            config.mass = preset.mass;
            config.friction = preset.friction;
        }

        config
    }
}
impl CursorConfiguration {
    fn default_hide_when_idle_delay() -> f32 {
        2.0
    }

    fn default_rotation_amount() -> f32 {
        0.5
    }

    pub fn cursor_type(&self) -> &CursorType {
        &self.r#type
    }

    pub fn click_spring_config(&self) -> ClickSpringConfig {
        self.click_spring.unwrap_or_default()
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HotkeysConfiguration {
    show: bool,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSegment {
    #[serde(default, rename = "recordingSegment")]
    pub recording_clip: u32,
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

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum GlideDirection {
    #[default]
    None,
    Left,
    Right,
    Up,
    Down,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoomSegment {
    pub start: f64,
    pub end: f64,
    pub amount: f64,
    pub mode: ZoomMode,
    #[serde(default)]
    pub glide_direction: GlideDirection,
    #[serde(default = "ZoomSegment::default_glide_speed")]
    pub glide_speed: f64,
    #[serde(default)]
    pub instant_animation: bool,
    #[serde(default = "ZoomSegment::default_edge_snap_ratio")]
    pub edge_snap_ratio: f64,
}

impl ZoomSegment {
    fn default_glide_speed() -> f64 {
        0.5
    }

    fn default_edge_snap_ratio() -> f64 {
        0.25
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ZoomMode {
    Auto,
    Manual { x: f32, y: f32 },
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MaskKind {
    Sensitive,
    Highlight,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MaskScalarKeyframe {
    pub time: f64,
    pub value: f64,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MaskVectorKeyframe {
    pub time: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MaskKeyframes {
    #[serde(default)]
    pub position: Vec<MaskVectorKeyframe>,
    #[serde(default)]
    pub size: Vec<MaskVectorKeyframe>,
    #[serde(default)]
    pub intensity: Vec<MaskScalarKeyframe>,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaskSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default = "MaskSegment::default_enabled")]
    pub enabled: bool,
    pub mask_type: MaskKind,
    pub center: XY<f64>,
    pub size: XY<f64>,
    #[serde(default)]
    pub feather: f64,
    #[serde(default = "MaskSegment::default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub pixelation: f64,
    #[serde(default)]
    pub darkness: f64,
    #[serde(default = "MaskSegment::default_fade_duration")]
    pub fade_duration: f64,
    #[serde(default)]
    pub keyframes: MaskKeyframes,
}

impl MaskSegment {
    fn default_enabled() -> bool {
        true
    }

    fn default_opacity() -> f64 {
        1.0
    }

    fn default_fade_duration() -> f64 {
        0.15
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default = "TextSegment::default_enabled")]
    pub enabled: bool,
    #[serde(default = "TextSegment::default_content")]
    pub content: String,
    #[serde(default = "TextSegment::default_center")]
    pub center: XY<f64>,
    #[serde(default = "TextSegment::default_size")]
    pub size: XY<f64>,
    #[serde(default = "TextSegment::default_font_family")]
    pub font_family: String,
    #[serde(default = "TextSegment::default_font_size")]
    pub font_size: f32,
    #[serde(default = "TextSegment::default_font_weight")]
    pub font_weight: f32,
    #[serde(default)]
    pub italic: bool,
    #[serde(default = "TextSegment::default_color")]
    pub color: String,
    #[serde(default = "TextSegment::default_fade_duration")]
    pub fade_duration: f64,
}

impl TextSegment {
    fn default_enabled() -> bool {
        true
    }

    fn default_content() -> String {
        "Text".to_string()
    }

    fn default_center() -> XY<f64> {
        XY::new(0.5, 0.5)
    }

    fn default_size() -> XY<f64> {
        XY::new(0.35, 0.2)
    }

    fn default_font_family() -> String {
        "sans-serif".to_string()
    }

    fn default_font_size() -> f32 {
        48.0
    }

    fn default_font_weight() -> f32 {
        700.0
    }

    fn default_color() -> String {
        "#ffffff".to_string()
    }

    fn default_fade_duration() -> f64 {
        0.15
    }
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
    #[serde(default)]
    pub mask_segments: Vec<MaskSegment>,
    #[serde(default)]
    pub text_segments: Vec<TextSegment>,
    #[serde(default)]
    pub caption_segments: Vec<CaptionTrackSegment>,
    #[serde(default)]
    pub keyboard_segments: Vec<crate::KeyboardTrackSegment>,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrackSegment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<CaptionWord>,
    #[serde(default)]
    pub fade_duration_override: Option<f32>,
    #[serde(default)]
    pub linger_duration_override: Option<f32>,
    #[serde(default)]
    pub position_override: Option<String>,
    #[serde(default)]
    pub color_override: Option<String>,
    #[serde(default)]
    pub background_color_override: Option<String>,
    #[serde(default)]
    pub font_size_override: Option<u32>,
}

impl TimelineConfiguration {
    pub fn get_segment_time(&self, frame_time: f64) -> Option<(f64, &TimelineSegment)> {
        let mut accum_duration = 0.0;

        for segment in self.segments.iter() {
            if frame_time < accum_duration + segment.duration() {
                return segment
                    .interpolate_time(frame_time - accum_duration)
                    .map(|t| (t, segment));
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
pub struct CaptionWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub id: String,
    pub start: f32,
    pub end: f32,
    pub text: String,
    #[serde(default)]
    pub words: Vec<CaptionWord>,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptionPosition {
    TopLeft,
    TopCenter,
    TopRight,
    #[default]
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
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
    pub italic: bool,
    #[serde(alias = "fontWeight")]
    pub font_weight: u32,
    pub outline: bool,
    #[serde(alias = "outlineColor")]
    pub outline_color: String,
    #[serde(alias = "exportWithSubtitles")]
    pub export_with_subtitles: bool,
    #[serde(alias = "highlightColor")]
    pub highlight_color: String,
    #[serde(alias = "fadeDuration")]
    pub fade_duration: f32,
    #[serde(alias = "lingerDuration")]
    pub linger_duration: f32,
    #[serde(alias = "wordTransitionDuration")]
    pub word_transition_duration: f32,
    #[serde(alias = "activeWordHighlight")]
    pub active_word_highlight: bool,
}

impl CaptionSettings {
    fn default_highlight_color() -> String {
        "#FFFFFF".to_string()
    }

    fn default_font_weight() -> u32 {
        700
    }

    fn default_fade_duration() -> f32 {
        0.15
    }

    fn default_linger_duration() -> f32 {
        0.4
    }

    fn default_word_transition_duration() -> f32 {
        0.25
    }

    fn default_active_word_highlight() -> bool {
        false
    }
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            font: "System Sans-Serif".to_string(),
            size: 24,
            color: "#A0A0A0".to_string(),
            background_color: "#000000".to_string(),
            background_opacity: 90,
            position: "bottom-center".to_string(),
            italic: false,
            font_weight: Self::default_font_weight(),
            outline: false,
            outline_color: "#000000".to_string(),
            export_with_subtitles: false,
            highlight_color: Self::default_highlight_color(),
            fade_duration: Self::default_fade_duration(),
            linger_duration: Self::default_linger_duration(),
            word_transition_duration: Self::default_word_transition_duration(),
            active_word_highlight: Self::default_active_word_highlight(),
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsData {
    pub segments: Vec<CaptionSegment>,
    pub settings: CaptionSettings,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyboardSettings {
    pub enabled: bool,
    pub font: String,
    pub size: u32,
    pub color: String,
    pub background_color: String,
    pub background_opacity: u32,
    pub position: String,
    pub font_weight: u32,
    pub fade_duration: f32,
    pub linger_duration: f32,
    pub grouping_threshold_ms: f64,
    pub show_modifiers: bool,
    pub show_special_keys: bool,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            font: "System Sans-Serif".to_string(),
            size: 28,
            color: "#FFFFFF".to_string(),
            background_color: "#000000".to_string(),
            background_opacity: 85,
            position: "above-captions".to_string(),
            font_weight: 500,
            fade_duration: 0.15,
            linger_duration: 0.8,
            grouping_threshold_ms: 300.0,
            show_modifiers: true,
            show_special_keys: true,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardData {
    pub settings: KeyboardSettings,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct ClipOffsets {
    #[serde(default)]
    pub camera: f32,
    #[serde(default)]
    pub mic: f32,
    #[serde(default)]
    pub system_audio: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClipConfiguration {
    pub index: u32,
    pub offsets: ClipOffsets,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationType {
    Arrow,
    Circle,
    Rectangle,
    Text,
    Mask,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MaskType {
    Blur,
    Pixelate,
}

#[derive(Debug, PartialEq)]
pub enum AnnotationValidationError {
    MaskTypeMissing {
        id: String,
    },
    MaskLevelMissing {
        id: String,
    },
    MaskLevelInvalid {
        id: String,
        level: f64,
    },
    MaskDataNotAllowed {
        id: String,
        annotation_type: AnnotationType,
    },
}

impl fmt::Display for AnnotationValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MaskTypeMissing { id } => {
                write!(f, "annotation {id} of type mask is missing maskType")
            }
            Self::MaskLevelMissing { id } => {
                write!(f, "annotation {id} of type mask is missing maskLevel")
            }
            Self::MaskLevelInvalid { id, level } => {
                write!(f, "annotation {id} has invalid maskLevel {level}")
            }
            Self::MaskDataNotAllowed {
                id,
                annotation_type,
            } => write!(
                f,
                "annotation {id} with type {annotation_type:?} cannot include mask data"
            ),
        }
    }
}

impl std::error::Error for AnnotationValidationError {}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: AnnotationType,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub fill_color: String,
    pub opacity: f64,
    pub rotation: f64,
    pub text: Option<String>,
    #[serde(default)]
    pub mask_type: Option<MaskType>,
    #[serde(default)]
    pub mask_level: Option<f64>,
}

impl Annotation {
    pub fn validate(&self) -> Result<(), AnnotationValidationError> {
        match self.annotation_type {
            AnnotationType::Mask => {
                if self.mask_type.is_none() {
                    return Err(AnnotationValidationError::MaskTypeMissing {
                        id: self.id.clone(),
                    });
                }

                let level =
                    self.mask_level
                        .ok_or_else(|| AnnotationValidationError::MaskLevelMissing {
                            id: self.id.clone(),
                        })?;

                if !level.is_finite() || level <= 0.0 {
                    return Err(AnnotationValidationError::MaskLevelInvalid {
                        id: self.id.clone(),
                        level,
                    });
                }

                Ok(())
            }
            _ => {
                if self.mask_type.is_some() || self.mask_level.is_some() {
                    return Err(AnnotationValidationError::MaskDataNotAllowed {
                        id: self.id.clone(),
                        annotation_type: self.annotation_type,
                    });
                }

                Ok(())
            }
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectConfiguration {
    pub aspect_ratio: Option<AspectRatio>,
    pub background: BackgroundConfiguration,
    pub camera: Camera,
    pub audio: AudioConfiguration,
    pub cursor: CursorConfiguration,
    pub hotkeys: HotkeysConfiguration,
    pub timeline: Option<TimelineConfiguration>,
    pub captions: Option<CaptionsData>,
    pub keyboard: Option<KeyboardData>,
    pub clips: Vec<ClipConfiguration>,
    pub annotations: Vec<Annotation>,
    #[serde(skip_serializing)]
    pub hidden_text_segments: Vec<usize>,
    #[serde(default = "ProjectConfiguration::default_screen_motion_blur")]
    pub screen_motion_blur: f32,
    #[serde(default)]
    pub screen_movement_spring: ScreenMovementSpring,
}

fn camera_config_needs_migration(value: &Value) -> bool {
    value
        .get("camera")
        .and_then(|camera| camera.as_object())
        .is_some_and(|camera| {
            camera.contains_key("zoom_size")
                || camera.contains_key("advanced_shadow")
                || camera.contains_key("rounding_type")
        })
}

impl ProjectConfiguration {
    fn default_screen_motion_blur() -> f32 {
        0.5
    }

    pub fn validate(&self) -> Result<(), AnnotationValidationError> {
        for annotation in &self.annotations {
            annotation.validate()?;
        }

        Ok(())
    }

    pub fn load(project_path: impl AsRef<Path>) -> Result<Self, std::io::Error> {
        let project_path = project_path.as_ref();
        let config_path = project_path.join("project-config.json");
        let config_str = std::fs::read_to_string(&config_path)?;
        let parsed_value = serde_json::from_str::<Value>(&config_str).ok();
        let config: Self = serde_json::from_str(&config_str)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        config
            .validate()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;

        if parsed_value
            .as_ref()
            .map(camera_config_needs_migration)
            .unwrap_or(false)
        {
            match config.write(project_path) {
                Ok(_) => {
                    eprintln!("Updated project-config.json camera keys to camelCase");
                }
                Err(error) => {
                    eprintln!("Failed to migrate project-config.json: {error}");
                }
            }
        }

        Ok(config)
    }

    pub fn write(&self, project_path: impl AsRef<Path>) -> Result<(), std::io::Error> {
        self.validate()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;

        let temp_path = temp_dir().join(uuid::Uuid::new_v4().to_string());

        // Write to temporary file first to ensure readers don't see partial files
        std::fs::write(&temp_path, serde_json::to_string_pretty(self)?)?;

        std::fs::rename(
            &temp_path,
            project_path.as_ref().join("project-config.json"),
        )?;

        Ok(())
    }

    pub fn get_segment_time(&self, frame_time: f64) -> Option<(f64, &TimelineSegment)> {
        self.timeline
            .as_ref()
            .and_then(|t| t.get_segment_time(frame_time))
    }
}

pub const SLOW_SMOOTHING_SAMPLES: usize = 24;
pub const REGULAR_SMOOTHING_SAMPLES: usize = 16;
pub const FAST_SMOOTHING_SAMPLES: usize = 10;

pub const SLOW_VELOCITY_THRESHOLD: f64 = 0.003;
pub const REGULAR_VELOCITY_THRESHOLD: f64 = 0.008;
pub const FAST_VELOCITY_THRESHOLD: f64 = 0.015;
