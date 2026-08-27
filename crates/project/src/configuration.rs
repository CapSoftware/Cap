use std::{
    collections::BTreeMap,
    fmt,
    ops::{Add, Div, Mul, Sub, SubAssign},
    path::Path,
    sync::LazyLock,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::DisplayNotch;

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
        #[serde(default)]
        noise_intensity: Option<f32>,
        #[serde(default)]
        noise_scale: Option<f32>,
        #[serde(default)]
        animated: Option<bool>,
        #[serde(default)]
        animation_speed: Option<f32>,
    },
    AnimatedGradient {
        #[serde(deserialize_with = "crate::animated_gradient::deserialize_config")]
        config: crate::AnimatedGradientConfig,
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

/// Decorative frame drawn around the screen recording (browser window,
/// macOS window, MacBook bezel, ...). The video is inset inside the frame's
/// chrome; the framed card as a whole follows padding / position / zoom
/// exactly like the bare video does today.
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FrameStyle {
    /// No frame: the video renders bare, exactly as before this feature.
    #[default]
    None,
    /// A macOS window title bar with traffic-light buttons.
    MacOS,
    /// A Windows 11 window title bar with minimize/maximize/close controls.
    Windows,
    /// A browser toolbar: traffic lights plus a centered URL pill.
    Browser,
    /// A MacBook mockup: black bezel, aluminum body and deck.
    Macbook,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FrameTheme {
    #[default]
    Dark,
    Light,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FrameConfiguration {
    pub style: FrameStyle,
    pub theme: FrameTheme,
    /// Text shown in the browser style's URL pill.
    pub url: String,
    /// Text shown in the macOS window style's title bar.
    pub title: String,
}

impl Default for FrameConfiguration {
    fn default() -> Self {
        Self {
            style: FrameStyle::None,
            theme: FrameTheme::default(),
            url: "Cap.so".to_string(),
            title: String::new(),
        }
    }
}

impl FrameConfiguration {
    pub fn active_style(config: Option<&FrameConfiguration>) -> FrameStyle {
        config.map(|f| f.style).unwrap_or(FrameStyle::None)
    }

    pub fn is_active(&self) -> bool {
        self.style != FrameStyle::None
    }
}

/// Draws a MacBook notch over the recording. Nothing here is inferred from the
/// video: a finished recording carries no evidence of the panel it came from.
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotchConfiguration {
    pub enabled: bool,
    /// Manual placement, as fractions of the video. Each `None` falls back to
    /// the geometry measured at capture time, else [`DEFAULT_MACBOOK_NOTCH`].
    pub x: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// Notch of a 14" MacBook Pro, measured via `NSScreen` on a 1512x982pt display.
///
/// Only a starting point for placing one by hand on recordings that carry no
/// measurements of their own. The cutout is physically the same size across
/// MacBook models but the panels are not, so this reads a little wide on
/// 15"/16" machines until adjusted.
pub const DEFAULT_MACBOOK_NOTCH: DisplayNotch = DisplayNotch {
    x: 0.438_492_063_492_063_5,
    width: 0.122_354_497_354_497_35,
    height: 0.032_586_558_044_806_514,
};

impl NotchConfiguration {
    /// Notch rect to draw, in fractions of the recorded video, or `None` when
    /// the overlay is switched off.
    pub fn resolve(&self, recorded: Option<DisplayNotch>) -> Option<DisplayNotch> {
        if !self.enabled {
            return None;
        }

        let base = recorded.unwrap_or(DEFAULT_MACBOOK_NOTCH);

        let width = self.width.unwrap_or(base.width).clamp(0.0, 1.0);
        let height = self.height.unwrap_or(base.height).clamp(0.0, 1.0);
        if width <= 0.0 || height <= 0.0 {
            return None;
        }

        let x = self.x.unwrap_or(base.x).clamp(0.0, 1.0 - width);

        Some(DisplayNotch { x, width, height })
    }
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
    /// Normalized (0-1) center of the display rect in output-frame space.
    /// `None` keeps the display centered. When a frame is active this is the
    /// center of the framed card (chrome included), not the bare video.
    pub display_position: Option<XY<f64>>,
    pub shadow: f32,
    pub advanced_shadow: Option<ShadowConfiguration>,
    pub border: Option<BorderConfiguration>,
    /// Decorative frame around the recording. `None` (or `FrameStyle::None`)
    /// renders the bare video exactly as before the feature existed.
    pub frame: Option<FrameConfiguration>,
    /// Redraws the recording device's physical notch over the capture. Distinct
    /// from `frame`: the decorative MacBook style is a mockup, this restores
    /// something the capture really did hide, and the two are independent.
    pub notch: Option<NotchConfiguration>,
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
            display_position: None,
            shadow: 73.6,
            advanced_shadow: Some(ShadowConfiguration::default()),
            border: None, // Border is disabled by default for backwards compatibility
            frame: None,  // No decorative frame by default
            notch: None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundBlurMode {
    #[default]
    Off,
    Light,
    Heavy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundBlurConfig {
    pub mode: BackgroundBlurMode,
}

impl BackgroundBlurConfig {
    pub fn is_active(&self) -> bool {
        self.mode != BackgroundBlurMode::Off
    }
}

impl Default for BackgroundBlurConfig {
    fn default() -> Self {
        Self {
            mode: BackgroundBlurMode::Off,
        }
    }
}

/// Parametric color grade for a single layer (screen or camera). Every field
/// except `intensity` has 0 as its identity, so a default struct renders
/// exactly like no grade at all. Adjustment fields are normalized: -1..1 for
/// bipolar controls, 0..1 for unipolar ones.
#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorCorrection {
    /// UI preset id ("none", "cinematic", ..., or "custom"). The renderer
    /// ignores this; the numeric fields below are the source of truth.
    pub preset: String,
    /// 0..1 master strength applied to every adjustment except `grain`,
    /// which has its own dedicated control.
    pub intensity: f32,
    /// -1..1, full scale is ±1.5 stops.
    pub exposure: f32,
    /// -1..1 around a mid-gray pivot.
    pub contrast: f32,
    /// -1..1; -1 is grayscale.
    pub saturation: f32,
    /// -1..1; positive warms, negative cools.
    pub temperature: f32,
    /// -1..1; positive shifts magenta, negative green.
    pub tint: f32,
    /// 0..1 lifted-blacks film fade.
    pub fade: f32,
    /// -1..1 teal-shadows/orange-highlights split toning (negative reverses).
    pub split_tone: f32,
    /// 0..1 edge darkening within the layer's own rect.
    pub vignette: f32,
    /// 0..1 animated film grain.
    pub grain: f32,
}

impl ColorCorrection {
    pub const PRESET_NONE: &'static str = "none";
}

impl Default for ColorCorrection {
    fn default() -> Self {
        Self {
            preset: Self::PRESET_NONE.to_string(),
            intensity: 1.0,
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            fade: 0.0,
            split_tone: 0.0,
            vignette: 0.0,
            grain: 0.0,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorCorrectionConfiguration {
    pub screen: ColorCorrection,
    pub camera: ColorCorrection,
    /// Whether the screen grade also covers the rendered cursor. On by
    /// default so the pointer reads as part of the graded footage; off keeps
    /// it crisp for legibility over vignettes and grain.
    pub grade_cursor: bool,
}

impl Default for ColorCorrectionConfiguration {
    fn default() -> Self {
        Self {
            screen: ColorCorrection::default(),
            camera: ColorCorrection::default(),
            grade_cursor: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct Camera {
    pub hide: bool,
    pub mirror: bool,
    pub position: CameraPosition,
    /// Normalized (0-1) center of the camera rect in output-frame space.
    /// Overrides `position` when set.
    pub manual_position: Option<XY<f64>>,
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
    #[serde(default)]
    pub background_blur: BackgroundBlurConfig,
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
            manual_position: None,
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
            background_blur: BackgroundBlurConfig::default(),
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
    Smooth,
    #[default]
    #[serde(alias = "regular", alias = "quick", alias = "rapid")]
    Mellow,
    Fast,
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
            tension: 530.0,
            mass: 1.0,
            friction: 40.0,
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
            Self::Smooth => Some(CursorSmoothingPreset {
                tension: 80.0,
                mass: 2.5,
                friction: 28.0,
            }),
            Self::Mellow => Some(CursorSmoothingPreset {
                tension: 470.0,
                mass: 3.0,
                friction: 70.0,
            }),
            Self::Fast => Some(CursorSmoothingPreset {
                tension: 380.0,
                mass: 1.0,
                friction: 30.0,
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
            size: 100,
            r#type: CursorType::default(),
            animation_style,
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
            raw: false,
            // Matches default_screen_motion_blur (the editor drives both
            // fields with one slider, and load() re-couples them).
            motion_blur: 1.0,
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
        0.15
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
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_audio_mode: Option<ClipSpeedAudioMode>,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClipSpeedAudioMode {
    #[default]
    Mute,
    MaintainPitch,
    MatchSpeed,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskEffectContract {
    pub blur_encoding_offset: f64,
    pub default_amount: f64,
    pub min_amount: f64,
    pub max_amount: f64,
}

static MASK_EFFECT_CONTRACT: LazyLock<MaskEffectContract> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../mask-effects.json"))
        .expect("embedded mask effect contract must be valid JSON")
});

pub fn mask_effect_contract() -> &'static MaskEffectContract {
    &MASK_EFFECT_CONTRACT
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
    #[serde(default)]
    pub track: u32,
    #[serde(default = "MaskSegment::default_enabled")]
    pub enabled: bool,
    pub mask_type: MaskKind,
    pub center: XY<f64>,
    pub size: XY<f64>,
    #[serde(default)]
    pub feather: f64,
    #[serde(default = "MaskSegment::default_opacity")]
    pub opacity: f64,
    #[serde(default = "MaskSegment::default_pixelation")]
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

    fn default_pixelation() -> f64 {
        mask_effect_contract().default_amount
    }

    fn default_fade_duration() -> f64 {
        0.15
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextAnimation {
    None,
    #[default]
    Fade,
    SlideUp,
    SlideDown,
    Pop,
    Typewriter,
}

/// How a text segment shares the frame with the display recording. The
/// variants name where the TEXT sits; the display card makes room for it.
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextLayout {
    /// Text draws over the untouched display (the original behavior).
    #[default]
    Overlay,
    /// The display card shrinks and fades away; text owns the frame.
    Fullscreen,
    /// Text in the left half, display card contained in the right half.
    SplitLeft,
    /// Text in the right half, display card contained in the left half.
    SplitRight,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub track: u32,
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
    /// Legacy symmetric fade. Superseded by the animation fields below; kept
    /// so configs written by new builds still fade in old builds. The
    /// `text_anim_version` migration seeds the animation durations from it.
    #[serde(default = "TextSegment::default_fade_duration")]
    pub fade_duration: f64,
    #[serde(default)]
    pub align: TextAlign,
    /// Px at the 1080p reference height, like `font_size`.
    #[serde(default)]
    pub letter_spacing: f32,
    #[serde(default = "TextSegment::default_line_height")]
    pub line_height: f32,
    #[serde(default = "TextSegment::default_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub shadow: f32,
    #[serde(default)]
    pub animation_in: TextAnimation,
    #[serde(default)]
    pub animation_out: TextAnimation,
    #[serde(default = "TextSegment::default_fade_duration")]
    pub animation_in_duration: f64,
    #[serde(default = "TextSegment::default_fade_duration")]
    pub animation_out_duration: f64,
    #[serde(default)]
    pub layout: TextLayout,
    /// Seconds the display card takes to morph aside (and back) at the
    /// segment edges when `layout` is not `Overlay`.
    #[serde(default = "TextSegment::default_layout_transition")]
    pub layout_transition: f64,
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

    fn default_line_height() -> f32 {
        1.2
    }

    fn default_opacity() -> f32 {
        1.0
    }

    fn default_layout_transition() -> f64 {
        0.5
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum SceneMode {
    #[default]
    Default,
    CameraOnly,
    HideCamera,
    SplitScreen,
    /// Like [`SceneMode::SplitScreen`], but the screen and camera render as
    /// padded, rounded, shadowed cards floating over the background instead
    /// of full-bleed halves. Shares [`SplitLayout`] for per-pane pan/zoom.
    Floating,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SplitLayout {
    pub screen_zoom: f64,
    pub screen_position: XY<f64>,
    pub camera_zoom: f64,
    pub camera_position: XY<f64>,
}

impl Default for SplitLayout {
    fn default() -> Self {
        Self {
            screen_zoom: 1.0,
            screen_position: XY::new(0.5, 0.5),
            camera_zoom: 1.0,
            camera_position: XY::new(0.5, 0.5),
        }
    }
}

fn default_scene_transition() -> f64 {
    0.3
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub mode: SceneMode,
    #[serde(default)]
    pub split_layout: Option<SplitLayout>,
    #[serde(default = "default_scene_transition")]
    pub transition_in: f64,
    #[serde(default = "default_scene_transition")]
    pub transition_out: f64,
}

// Shots cut straight into the pose; easing in and out is opt-in.
fn default_camera3d_transition() -> f64 {
    0.0
}

/// A 3D camera pose for the composed content plane. Angles are degrees.
///
/// Geometry: the content plane's longest side spans 2 world units, centered at
/// the origin facing +Z. `tilt_x`/`tilt_y`/`roll` orbit the CAMERA (Euler YXZ,
/// roll innermost); `rotate_x`/`rotate_y` rotate the CONTENT plane itself.
/// `zoom` is the camera DISTANCE in world units (larger = further = smaller on
/// screen); `fov` is the vertical field of view with no size compensation, so
/// apparent size ∝ 1 / (zoom · tan(fov/2)). `pan_x`/`pan_y` truck the camera in
/// its own plane (world units; +x moves the subject right, +y up).
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Camera3DProperties {
    /// Camera orbit pitch.
    #[serde(default)]
    pub tilt_x: f64,
    /// Camera orbit yaw.
    #[serde(default)]
    pub tilt_y: f64,
    /// Camera roll (innermost camera rotation).
    #[serde(default)]
    pub roll: f64,
    /// Content plane pitch.
    #[serde(default)]
    pub rotate_x: f64,
    /// Content plane yaw.
    #[serde(default)]
    pub rotate_y: f64,
    #[serde(default = "Camera3DProperties::default_fov")]
    pub fov: f64,
    /// Camera distance in world units.
    #[serde(default = "Camera3DProperties::default_zoom")]
    pub zoom: f64,
    #[serde(default)]
    pub pan_x: f64,
    #[serde(default)]
    pub pan_y: f64,
}

impl Camera3DProperties {
    fn default_fov() -> f64 {
        45.0
    }

    fn default_zoom() -> f64 {
        2.0
    }
}

impl Default for Camera3DProperties {
    fn default() -> Self {
        Self {
            tilt_x: 0.0,
            tilt_y: 0.0,
            roll: 0.0,
            rotate_x: 0.0,
            rotate_y: 0.0,
            fov: Self::default_fov(),
            zoom: Self::default_zoom(),
            pan_x: 0.0,
            pan_y: 0.0,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Camera3DBlurMode {
    #[default]
    None,
    Radial,
    Directional,
    TiltShift,
}

/// Screen-space focus blur applied over the composed frame while a 3d segment
/// is active (a UV-mask variable blur, not a depth-of-field). `strength` is a
/// blur radius in pixels at 1080p output height; the renderer scales it with
/// output size so preview and export match.
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Camera3DBlur {
    #[serde(default)]
    pub mode: Camera3DBlurMode,
    #[serde(default)]
    pub strength: f64,
    /// Widens and flattens the sharp-to-blurred transition (0..1).
    #[serde(default)]
    pub falloff: f64,
    /// Focus center in screen UV (radial mode).
    #[serde(default = "Camera3DBlur::default_focus_x")]
    pub focus_x: f64,
    #[serde(default = "Camera3DBlur::default_focus_y")]
    pub focus_y: f64,
    /// Sharp region size: radius (radial) or band width (tilt-shift).
    #[serde(default = "Camera3DBlur::default_focus_size")]
    pub focus_size: f64,
    /// Degrees; blur direction (directional) or band angle (tilt-shift).
    #[serde(default)]
    pub angle: f64,
    /// Where the directional blur begins along its axis (0..1).
    #[serde(default = "Camera3DBlur::default_dir_position")]
    pub dir_position: f64,
    /// Swaps the gaussian kernel for a ring-disc bokeh kernel with highlight
    /// gain. Strength is capped at 20 while enabled.
    #[serde(default)]
    pub bokeh: bool,
}

impl Camera3DBlur {
    fn default_focus_x() -> f64 {
        0.37
    }

    fn default_focus_y() -> f64 {
        0.5
    }

    fn default_focus_size() -> f64 {
        0.5
    }

    fn default_dir_position() -> f64 {
        0.5
    }
}

impl Default for Camera3DBlur {
    fn default() -> Self {
        Self {
            mode: Camera3DBlurMode::None,
            strength: 0.0,
            falloff: 0.0,
            focus_x: Self::default_focus_x(),
            focus_y: Self::default_focus_y(),
            focus_size: Self::default_focus_size(),
            angle: 0.0,
            dir_position: Self::default_dir_position(),
            bokeh: false,
        }
    }
}

/// One scalar keyframe on a per-property track. Interpolation between two
/// keyframes is a linear value lerp with time remapped by a cubic bezier whose
/// P1 comes from the left keyframe's `out_easing` and P2 from the right one's
/// `in_easing` (a split-handle model). Absent handles default to cubic
/// ease-in-out: P1 [0.65, 0], P2 [0.35, 1].
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Camera3DKeyframe {
    /// Seconds relative to the segment start.
    pub time: f64,
    pub value: f64,
    /// Bezier P1 for the track segment leaving this keyframe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_easing: Option<[f64; 2]>,
    /// Bezier P2 for the track segment entering this keyframe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_easing: Option<[f64; 2]>,
}

/// Per-property keyframe tracks. A property with an empty track holds the
/// segment's base value; each track holds independently before its first and
/// after its last keyframe.
#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Camera3DTracks {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tilt_x: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tilt_y: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roll: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotate_x: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotate_y: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fov: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zoom: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pan_x: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pan_y: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_strength: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_falloff: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_focus_size: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_focus_x: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_focus_y: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_angle: Vec<Camera3DKeyframe>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blur_dir_position: Vec<Camera3DKeyframe>,
}

impl Camera3DTracks {
    /// Every track, for whole-timeline operations like time remapping.
    pub fn all_tracks_mut(&mut self) -> [&mut Vec<Camera3DKeyframe>; 16] {
        [
            &mut self.tilt_x,
            &mut self.tilt_y,
            &mut self.roll,
            &mut self.rotate_x,
            &mut self.rotate_y,
            &mut self.fov,
            &mut self.zoom,
            &mut self.pan_x,
            &mut self.pan_y,
            &mut self.blur_strength,
            &mut self.blur_falloff,
            &mut self.blur_focus_size,
            &mut self.blur_focus_x,
            &mut self.blur_focus_y,
            &mut self.blur_angle,
            &mut self.blur_dir_position,
        ]
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Camera3DSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default = "Camera3DSegment::default_enabled")]
    pub enabled: bool,
    /// Base pose; per-property tracks override individual values.
    #[serde(default)]
    pub properties: Camera3DProperties,
    #[serde(default)]
    pub blur: Camera3DBlur,
    #[serde(default)]
    pub tracks: Camera3DTracks,
    /// Seconds to ease from the flat frame into the pose at the segment start.
    #[serde(default = "default_camera3d_transition")]
    pub transition_in: f64,
    /// Seconds to ease back to the flat frame before the segment end.
    #[serde(default = "default_camera3d_transition")]
    pub transition_out: f64,
}

impl Camera3DSegment {
    fn default_enabled() -> bool {
        true
    }
}

/// A timeline-positioned audio clip (background music or imported audio).
///
/// Unlike the recording's mic/system audio (which is keyed to recording clips),
/// these segments live in output/timeline time exactly like zoom/text/mask
/// segments. `path` is resolved relative to the project directory so projects
/// stay portable when moved.
#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackSegment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub track: u32,
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "AudioTrackSegment::default_enabled")]
    pub enabled: bool,
    /// Offset into the source audio file (seconds) at which playback begins.
    #[serde(default)]
    pub trim_start: f64,
    #[serde(default)]
    pub volume_db: f32,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// Source duration in seconds, persisted so the UI can clamp resizing
    /// without re-decoding the file.
    #[serde(default)]
    pub duration: Option<f64>,
}

impl AudioTrackSegment {
    fn default_enabled() -> bool {
        true
    }
}

pub const MIN_CLIP_TRANSITION_DURATION: f64 = 0.05;

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClipTransitionType {
    #[default]
    CrossFade,
    FadeThroughBlack,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransition {
    pub segment_index: u32,
    #[serde(rename = "type")]
    pub kind: ClipTransitionType,
    pub duration: f64,
}

fn deserialize_clip_transitions<'de, D>(deserializer: D) -> Result<Vec<ClipTransition>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let transitions = Vec::<ClipTransition>::deserialize(deserializer)?;
    let mut by_segment = BTreeMap::new();
    for transition in transitions {
        by_segment.insert(transition.segment_index, transition);
    }
    Ok(by_segment.into_values().collect())
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConfiguration {
    pub segments: Vec<TimelineSegment>,
    #[serde(
        default,
        deserialize_with = "deserialize_clip_transitions",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub transitions: Vec<ClipTransition>,
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
    #[serde(default)]
    pub audio_segments: Vec<AudioTrackSegment>,
    // Explicit rename: the digit boundary makes rename_all's camelCase output
    // easy to second-guess, and the editor TypeScript hardcodes this name.
    #[serde(default, rename = "camera3dSegments")]
    pub camera3d_segments: Vec<Camera3DSegment>,
}

#[derive(Clone, Copy, Debug)]
pub struct TimelineSource<'a> {
    pub source_time: f64,
    pub segment_index: usize,
    pub segment: &'a TimelineSegment,
}

#[derive(Clone, Copy, Debug)]
pub enum TimelineFrameMapping<'a> {
    Single {
        source: TimelineSource<'a>,
        output_end: f64,
    },
    Transition {
        outgoing: TimelineSource<'a>,
        incoming: TimelineSource<'a>,
        kind: ClipTransitionType,
        progress: f64,
        duration: f64,
        output_end: f64,
    },
    /// The recording clock is paused under a fullscreen text segment: the
    /// frozen `source` frame stands until `output_end` (the hold's end in
    /// output time). Video shows the frozen frame (hidden behind the takeover
    /// anyway); audio renders silence.
    Hold {
        source: TimelineSource<'a>,
        output_end: f64,
    },
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
    pub fn effective_transition(&self, segment_index: usize) -> Option<ClipTransition> {
        if segment_index == 0 || segment_index >= self.segments.len() {
            return None;
        }

        debug_assert!(
            self.transitions.windows(2).all(|transitions| {
                transitions[0].segment_index <= transitions[1].segment_index
            })
        );

        let transition_position = self
            .transitions
            .partition_point(|transition| transition.segment_index as usize <= segment_index);
        let transition = self.transitions.get(transition_position.checked_sub(1)?)?;
        if transition.segment_index as usize != segment_index {
            return None;
        }
        if !transition.duration.is_finite() || transition.duration <= 0.0 {
            return None;
        }

        let maximum = self.segments[segment_index - 1]
            .duration()
            .min(self.segments[segment_index].duration())
            / 2.0;
        if !maximum.is_finite() || maximum < MIN_CLIP_TRANSITION_DURATION {
            return None;
        }

        Some(ClipTransition {
            duration: transition
                .duration
                .clamp(MIN_CLIP_TRANSITION_DURATION, maximum),
            ..*transition
        })
    }

    /// Output-time windows where a fullscreen text segment pauses the
    /// recording clock, sorted and merged. Empty for every project without
    /// fullscreen text — the mapping below then short-circuits to the exact
    /// pre-hold arithmetic.
    pub fn hold_windows(&self) -> Vec<(f64, f64)> {
        let mut windows: Vec<(f64, f64)> = self
            .text_segments
            .iter()
            .filter(|s| s.enabled && s.layout == TextLayout::Fullscreen && s.end > s.start)
            .map(|s| (s.start, s.end))
            .collect();
        if windows.is_empty() {
            return windows;
        }
        windows.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut merged: Vec<(f64, f64)> = Vec::with_capacity(windows.len());
        for window in windows {
            match merged.last_mut() {
                Some(last) if window.0 <= last.1 => last.1 = last.1.max(window.1),
                _ => merged.push(window),
            }
        }
        merged
    }

    /// Total output seconds inserted by fullscreen text holds.
    pub fn held_duration(&self) -> f64 {
        self.hold_windows().iter().map(|(s, e)| e - s).sum()
    }

    pub fn get_frame_mapping(&self, frame_time: f64) -> Option<TimelineFrameMapping<'_>> {
        let holds = self.hold_windows();
        if holds.is_empty() {
            return self.get_frame_mapping_unheld(frame_time);
        }

        if let Some((hold_start, hold_end)) = active_hold_window(&holds, frame_time) {
            let effective = hold_start - held_time_before(&holds, hold_start);
            let source = match self.get_frame_mapping_unheld(effective)? {
                TimelineFrameMapping::Single { source, .. }
                | TimelineFrameMapping::Hold { source, .. } => source,
                TimelineFrameMapping::Transition { incoming, .. } => incoming,
            };
            return Some(TimelineFrameMapping::Hold {
                source,
                output_end: hold_end,
            });
        }

        let effective = frame_time - held_time_before(&holds, frame_time);
        let next_hold_start = holds
            .iter()
            .map(|(start, _)| *start)
            .find(|start| *start > frame_time);
        // The base mapping's output_end is in the un-held (gapless) domain;
        // put it back into output time and stop at the next hold so consumers
        // (audio chunking) never render contiguous recording samples across a
        // pause.
        let clamp_end = |output_end: f64| {
            let output_end = effective_to_output(&holds, output_end);
            next_hold_start.map_or(output_end, |hold| output_end.min(hold))
        };
        Some(match self.get_frame_mapping_unheld(effective)? {
            TimelineFrameMapping::Single { source, output_end } => TimelineFrameMapping::Single {
                source,
                output_end: clamp_end(output_end),
            },
            TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                duration,
                output_end,
            } => TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                duration,
                output_end: clamp_end(output_end),
            },
            hold @ TimelineFrameMapping::Hold { .. } => hold,
        })
    }

    fn get_frame_mapping_unheld(&self, frame_time: f64) -> Option<TimelineFrameMapping<'_>> {
        if self.transitions.is_empty() {
            return self.get_segment_time_without_transitions(frame_time).map(
                |(source_time, segment, segment_index, output_end)| TimelineFrameMapping::Single {
                    source: TimelineSource {
                        source_time,
                        segment_index,
                        segment,
                    },
                    output_end,
                },
            );
        }

        let mut segment_start = 0.0;

        for (segment_index, segment) in self.segments.iter().enumerate() {
            let incoming = self.effective_transition(segment_index);
            let incoming_duration = incoming.as_ref().map_or(0.0, |value| value.duration);

            if let Some(transition) = incoming {
                let output_end = segment_start + transition.duration;
                if frame_time >= segment_start && frame_time < output_end {
                    let elapsed = frame_time - segment_start;
                    let outgoing_segment = &self.segments[segment_index - 1];
                    let outgoing_time = outgoing_segment.interpolate_time(
                        outgoing_segment.duration() - transition.duration + elapsed,
                    )?;
                    let incoming_time = segment.interpolate_time(elapsed)?;

                    return Some(TimelineFrameMapping::Transition {
                        outgoing: TimelineSource {
                            source_time: outgoing_time,
                            segment_index: segment_index - 1,
                            segment: outgoing_segment,
                        },
                        incoming: TimelineSource {
                            source_time: incoming_time,
                            segment_index,
                            segment,
                        },
                        kind: transition.kind,
                        progress: (elapsed / transition.duration).clamp(0.0, 1.0),
                        duration: transition.duration,
                        output_end,
                    });
                }
            }

            let next_transition = self.effective_transition(segment_index + 1);
            let next_duration = next_transition.as_ref().map_or(0.0, |value| value.duration);
            let single_start = segment_start + incoming_duration;
            let output_end = segment_start + segment.duration() - next_duration;

            if frame_time >= single_start && frame_time < output_end {
                let source_time = segment.interpolate_time(frame_time - segment_start)?;
                return Some(TimelineFrameMapping::Single {
                    source: TimelineSource {
                        source_time,
                        segment_index,
                        segment,
                    },
                    output_end,
                });
            }

            segment_start += segment.duration() - next_duration;
        }

        None
    }

    pub fn get_segment_time(&self, frame_time: f64) -> Option<(f64, &TimelineSegment)> {
        match self.get_frame_mapping(frame_time)? {
            TimelineFrameMapping::Single { source, .. }
            | TimelineFrameMapping::Hold { source, .. } => {
                Some((source.source_time, source.segment))
            }
            TimelineFrameMapping::Transition { incoming, .. } => {
                Some((incoming.source_time, incoming.segment))
            }
        }
    }

    fn get_segment_time_without_transitions(
        &self,
        frame_time: f64,
    ) -> Option<(f64, &TimelineSegment, usize, f64)> {
        let mut accum_duration = 0.0;

        for (segment_index, segment) in self.segments.iter().enumerate() {
            if frame_time < accum_duration + segment.duration() {
                return segment
                    .interpolate_time(frame_time - accum_duration)
                    .map(|time| {
                        (
                            time,
                            segment,
                            segment_index,
                            accum_duration + segment.duration(),
                        )
                    });
            }

            accum_duration += segment.duration();
        }

        None
    }

    pub fn duration(&self) -> f64 {
        let segment_duration: f64 = self.segments.iter().map(TimelineSegment::duration).sum();
        let segment_duration = if self.transitions.is_empty() {
            segment_duration
        } else {
            segment_duration
                - (1..self.segments.len())
                    .filter_map(|segment_index| self.effective_transition(segment_index))
                    .map(|transition| transition.duration)
                    .sum::<f64>()
        };

        segment_duration + self.held_duration()
    }
}

fn active_hold_window(windows: &[(f64, f64)], time: f64) -> Option<(f64, f64)> {
    windows
        .iter()
        .find(|(start, end)| time >= *start && time < *end)
        .copied()
}

fn held_time_before(windows: &[(f64, f64)], time: f64) -> f64 {
    windows
        .iter()
        .map(|(start, end)| (time.min(*end) - start).max(0.0))
        .sum()
}

/// Inverse of the held-output -> gapless transform: places a gapless
/// timestamp back into output time, landing after every hold it passed.
fn effective_to_output(windows: &[(f64, f64)], effective: f64) -> f64 {
    let mut output = effective;
    for (start, end) in windows {
        if output >= *start {
            output += end - start;
        } else {
            break;
        }
    }
    output
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
    #[serde(alias = "manualPosition")]
    pub manual_position: Option<XY<f32>>,
    pub preset: String,
    pub animation: String,
    #[serde(alias = "highlightStyle")]
    pub highlight_style: String,
    pub uppercase: bool,
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

    fn default_preset() -> String {
        "classic".to_string()
    }

    fn default_animation() -> String {
        "bounce".to_string()
    }

    fn default_highlight_style() -> String {
        "color".to_string()
    }
}

impl Default for CaptionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            font: "System Sans-Serif".to_string(),
            size: 24,
            color: "#FFFFFF".to_string(),
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
            manual_position: None,
            preset: Self::default_preset(),
            animation: Self::default_animation(),
            highlight_style: Self::default_highlight_style(),
            uppercase: false,
        }
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsData {
    pub segments: Vec<CaptionSegment>,
    pub settings: CaptionSettings,
    /// When true, `segments` are stored in source/recording time and the
    /// rendered `timeline.caption_segments` are derived by projecting them
    /// through the current edit list, so captions stay aligned to their spoken
    /// content as clips are trimmed, deleted, reordered, or inserted. Legacy
    /// projects (false) stored segments in already-edited output time and are
    /// migrated to source time on first load.
    #[serde(default)]
    pub source_timed: bool,
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
    pub uppercase: bool,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            font: "System Sans-Serif".to_string(),
            size: 50,
            color: "#FFFFFF".to_string(),
            background_color: "#000000".to_string(),
            background_opacity: 95,
            position: "bottom-center".to_string(),
            font_weight: 400,
            fade_duration: 0.15,
            linger_duration: 0.8,
            grouping_threshold_ms: 500.0,
            show_modifiers: true,
            show_special_keys: true,
            uppercase: false,
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
    /// Whether `offsets` were computed automatically (recording start-time
    /// alignment + device sync calibration) rather than entered by the user.
    /// Cleared by the editor UI once the user edits an offset.
    #[serde(default)]
    pub offsets_auto_calculated: bool,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationType {
    Arrow,
    Circle,
    Rectangle,
    Text,
    Mask,
    Draw,
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
    #[serde(default)]
    pub points: Option<Vec<[f64; 2]>>,
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

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
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
    /// Per-layer cinematic color grades. Field-level default keeps old
    /// project files (and old saved presets) deserializing to the identity
    /// grade.
    #[serde(default)]
    pub color_correction: ColorCorrectionConfiguration,
    /// How text segment font sizes are interpreted. 0 (legacy): the renderer
    /// multiplied `font_size` by `size.y / 0.2`, coupling glyph size to the
    /// box. 1: `font_size` alone determines glyph size (1080p-relative);
    /// legacy configs are migrated on load by baking the box factor into
    /// `font_size`. The field-level default keeps old files at 0 while
    /// `Default::default()` produces the current version.
    #[serde(default)]
    pub text_size_version: u32,
    /// 0 (legacy): text segments animate with the single symmetric
    /// `fade_duration`. 1: the enter/exit animation fields drive timing;
    /// legacy configs are migrated on load by seeding both animation
    /// durations from `fade_duration`.
    #[serde(default)]
    pub text_anim_version: u32,
}

pub const TEXT_SIZE_VERSION: u32 = 1;
pub const TEXT_ANIM_VERSION: u32 = 1;

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

impl Default for ProjectConfiguration {
    fn default() -> Self {
        Self {
            aspect_ratio: Default::default(),
            background: Default::default(),
            camera: Default::default(),
            audio: Default::default(),
            cursor: Default::default(),
            hotkeys: Default::default(),
            timeline: Default::default(),
            captions: Default::default(),
            keyboard: Default::default(),
            clips: Default::default(),
            annotations: Default::default(),
            hidden_text_segments: Default::default(),
            screen_motion_blur: Self::default_screen_motion_blur(),
            screen_movement_spring: Default::default(),
            color_correction: Default::default(),
            text_size_version: TEXT_SIZE_VERSION,
            text_anim_version: TEXT_ANIM_VERSION,
        }
    }
}

impl ProjectConfiguration {
    fn default_screen_motion_blur() -> f32 {
        // Screen Studio's default blur amount is 1.0; with length-based blur
        // semantics (amount scales the smear length, output fully blurred)
        // 1.0 reproduces its out-of-the-box look.
        1.0
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
        let missing_screen_motion_blur = parsed_value.as_ref().is_some_and(|value| {
            value
                .as_object()
                .is_some_and(|object| !object.contains_key("screenMotionBlur"))
        });
        let needs_camera_migration = parsed_value
            .as_ref()
            .map(camera_config_needs_migration)
            .unwrap_or(false);
        let mut config: Self = serde_json::from_str(&config_str)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        let cursor_motion_blur = config.cursor.motion_blur.clamp(0.0, 1.0);
        let screen_motion_blur = config.screen_motion_blur.clamp(0.0, 1.0);
        let needs_motion_blur_clamp = (config.cursor.motion_blur - cursor_motion_blur).abs()
            > f32::EPSILON
            || (config.screen_motion_blur - screen_motion_blur).abs() > f32::EPSILON;
        let needs_screen_motion_blur_migration = missing_screen_motion_blur
            || (screen_motion_blur - cursor_motion_blur).abs() > f32::EPSILON;
        config.cursor.motion_blur = cursor_motion_blur;
        if needs_screen_motion_blur_migration {
            config.screen_motion_blur = config.cursor.motion_blur;
        } else {
            config.screen_motion_blur = screen_motion_blur;
        }

        // Legacy text configs coupled glyph size to the box: the renderer
        // multiplied font_size by size.y / 0.2. Bake that factor into
        // font_size so the new decoupled law renders them identically.
        let mut needs_text_size_migration = false;
        if config.text_size_version == 0 {
            if let Some(timeline) = config.timeline.as_mut() {
                for segment in &mut timeline.text_segments {
                    let scale = (segment.size.y / 0.2).clamp(0.25, 4.0) as f32;
                    let migrated = (segment.font_size * scale).clamp(1.0, 480.0);
                    if (migrated - segment.font_size).abs() > f32::EPSILON {
                        segment.font_size = migrated;
                        needs_text_size_migration = true;
                    }
                }
            }
            config.text_size_version = TEXT_SIZE_VERSION;
        }

        if config.text_anim_version == 0 {
            if let Some(timeline) = config.timeline.as_mut() {
                for segment in &mut timeline.text_segments {
                    let fade = segment.fade_duration.max(0.0);
                    segment.animation_in_duration = fade;
                    segment.animation_out_duration = fade;
                    if fade == 0.0 {
                        segment.animation_in = TextAnimation::None;
                        segment.animation_out = TextAnimation::None;
                    }
                }
            }
            config.text_anim_version = TEXT_ANIM_VERSION;
        }

        config
            .validate()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;

        if needs_camera_migration
            || needs_motion_blur_clamp
            || needs_screen_motion_blur_migration
            || needs_text_size_migration
        {
            match config.write(project_path) {
                Ok(_) => {
                    eprintln!("Updated project-config.json migrated settings");
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

        let project_path = project_path.as_ref();
        let config_path = project_path.join("project-config.json");
        let temp_path =
            project_path.join(format!(".project-config-{}.json.tmp", uuid::Uuid::new_v4()));

        std::fs::write(&temp_path, serde_json::to_string_pretty(self)?)?;

        if let Err(error) = std::fs::rename(&temp_path, &config_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }

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

#[cfg(test)]
mod notch_tests {
    use super::*;

    const RECORDED: DisplayNotch = DisplayNotch {
        x: 0.4,
        width: 0.2,
        height: 0.04,
    };

    fn enabled() -> NotchConfiguration {
        NotchConfiguration {
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn disabled_by_default() {
        assert_eq!(NotchConfiguration::default().resolve(Some(RECORDED)), None);
    }

    #[test]
    fn prefers_geometry_measured_at_capture_time() {
        assert_eq!(enabled().resolve(Some(RECORDED)), Some(RECORDED));
    }

    /// Recordings the recorder could not measure still get a notch on request;
    /// it just starts from the stock MacBook rect for the user to adjust.
    #[test]
    fn unmeasured_recordings_start_from_the_default_rect() {
        assert_eq!(enabled().resolve(None), Some(DEFAULT_MACBOOK_NOTCH));
    }

    /// Each field falls back independently, so resizing without repositioning
    /// leaves the notch where it was measured. Keeping the notch centred as it
    /// resizes is the editor's job, which lets its sliders show the real value.
    #[test]
    fn each_field_falls_back_on_its_own() {
        let resolved = NotchConfiguration {
            enabled: true,
            x: None,
            width: Some(0.1),
            height: Some(0.02),
        }
        .resolve(Some(RECORDED))
        .unwrap();

        assert_eq!(resolved.width, 0.1);
        assert_eq!(resolved.height, 0.02);
        assert_eq!(resolved.x, RECORDED.x);
    }

    #[test]
    fn explicit_x_overrides_the_centring() {
        let resolved = NotchConfiguration {
            enabled: true,
            x: Some(0.1),
            width: Some(0.2),
            height: None,
        }
        .resolve(Some(RECORDED))
        .unwrap();

        assert_eq!(resolved.x, 0.1);
    }

    #[test]
    fn placement_stays_inside_the_video() {
        let resolved = NotchConfiguration {
            enabled: true,
            x: Some(0.95),
            width: Some(0.2),
            height: None,
        }
        .resolve(Some(RECORDED))
        .unwrap();

        assert!(resolved.x + resolved.width <= 1.0, "{resolved:?}");
    }

    #[test]
    fn zero_sized_override_draws_nothing() {
        let config = NotchConfiguration {
            enabled: true,
            x: None,
            width: Some(0.0),
            height: None,
        };

        assert_eq!(config.resolve(Some(RECORDED)), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline_with_transitions(transitions: Vec<ClipTransition>) -> TimelineConfiguration {
        TimelineConfiguration {
            segments: vec![
                TimelineSegment {
                    recording_clip: 0,
                    timescale: 1.0,
                    start: 0.0,
                    end: 4.0,
                    name: None,
                    speed_audio_mode: None,
                },
                TimelineSegment {
                    recording_clip: 1,
                    timescale: 1.0,
                    start: 10.0,
                    end: 16.0,
                    name: None,
                    speed_audio_mode: None,
                },
            ],
            transitions,
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
        }
    }

    fn fullscreen_text(start: f64, end: f64) -> TextSegment {
        TextSegment {
            start,
            end,
            track: 0,
            enabled: true,
            content: "Title".to_string(),
            center: XY::new(0.5, 0.5),
            size: XY::new(0.35, 0.2),
            font_family: "sans-serif".to_string(),
            font_size: 48.0,
            font_weight: 700.0,
            italic: false,
            color: "#ffffff".to_string(),
            fade_duration: 0.15,
            align: TextAlign::Center,
            letter_spacing: 0.0,
            line_height: 1.2,
            opacity: 1.0,
            shadow: 0.0,
            animation_in: TextAnimation::Fade,
            animation_out: TextAnimation::Fade,
            animation_in_duration: 0.15,
            animation_out_duration: 0.15,
            layout: TextLayout::Fullscreen,
            layout_transition: 0.5,
        }
    }

    #[test]
    fn fullscreen_text_inserts_output_time() {
        let mut timeline = timeline_with_transitions(Vec::new());
        timeline.text_segments = vec![fullscreen_text(2.0, 5.0)];

        assert_eq!(timeline.duration(), 13.0);

        // Before the hold: unchanged mapping, but the chunk ends at the hold.
        assert!(matches!(
            timeline.get_frame_mapping(1.0),
            Some(TimelineFrameMapping::Single { source, output_end })
                if source.source_time == 1.0 && output_end == 2.0
        ));

        // Inside the hold: frozen at the recording instant where it started.
        assert!(matches!(
            timeline.get_frame_mapping(3.5),
            Some(TimelineFrameMapping::Hold { source, output_end })
                if source.source_time == 2.0 && output_end == 5.0
        ));
        let (frozen, _) = timeline.get_segment_time(3.5).unwrap();
        assert_eq!(frozen, 2.0);

        // After the hold: resumes exactly where it paused.
        let (resumed, _) = timeline.get_segment_time(5.0).unwrap();
        assert_eq!(resumed, 2.0);
        let (later, segment) = timeline.get_segment_time(7.5).unwrap();
        assert_eq!(later, 10.5);
        assert_eq!(segment.recording_clip, 1);
    }

    #[test]
    fn overlay_and_disabled_texts_do_not_hold() {
        let mut timeline = timeline_with_transitions(Vec::new());
        let mut overlay = fullscreen_text(2.0, 5.0);
        overlay.layout = TextLayout::Overlay;
        let mut disabled = fullscreen_text(6.0, 8.0);
        disabled.enabled = false;
        timeline.text_segments = vec![overlay, disabled];

        assert_eq!(timeline.duration(), 10.0);
        assert!(timeline.hold_windows().is_empty());
        let (time, _) = timeline.get_segment_time(4.5).unwrap();
        assert_eq!(time, 10.5);
    }

    #[test]
    fn overlapping_fullscreen_texts_merge_into_one_hold() {
        let mut timeline = timeline_with_transitions(Vec::new());
        timeline.text_segments = vec![fullscreen_text(2.0, 5.0), fullscreen_text(4.0, 6.0)];

        assert_eq!(timeline.hold_windows(), vec![(2.0, 6.0)]);
        assert_eq!(timeline.duration(), 14.0);
        let (frozen, _) = timeline.get_segment_time(5.5).unwrap();
        assert_eq!(frozen, 2.0);
        let (after, _) = timeline.get_segment_time(6.5).unwrap();
        assert_eq!(after, 2.5);
    }

    #[test]
    fn holds_compose_with_transitions() {
        let mut timeline = timeline_with_transitions(vec![ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 1.0,
        }]);
        timeline.text_segments = vec![fullscreen_text(1.0, 2.0)];

        assert_eq!(timeline.duration(), 10.0);
        // 6.0 output = 5.0 effective = 2.0s into the second clip (whose
        // output start is 3.0 after the 1s cross-fade overlap).
        let (time, segment) = timeline.get_segment_time(6.0).unwrap();
        assert_eq!(segment.recording_clip, 1);
        assert_eq!(time, 12.0);
    }

    #[test]
    fn timeline_without_transitions_keeps_legacy_mapping() {
        let timeline = timeline_with_transitions(Vec::new());

        assert_eq!(timeline.duration(), 10.0);
        let (time, segment) = timeline.get_segment_time(4.5).unwrap();
        assert_eq!(time, 10.5);
        assert_eq!(segment.recording_clip, 1);
        assert!(matches!(
            timeline.get_frame_mapping(4.5),
            Some(TimelineFrameMapping::Single { source, output_end: 10.0 })
                if source.segment_index == 1 && source.source_time == 10.5
        ));
        assert!(
            serde_json::to_value(&timeline)
                .unwrap()
                .get("transitions")
                .is_none()
        );
    }

    #[test]
    fn timeline_maps_both_sources_inside_transition() {
        let timeline = timeline_with_transitions(vec![ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 1.0,
        }]);

        assert_eq!(timeline.duration(), 9.0);
        assert_eq!(
            serde_json::to_value(&timeline).unwrap()["transitions"][0]["type"],
            "cross-fade"
        );
        assert!(matches!(
            timeline.get_frame_mapping(3.5),
            Some(TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind: ClipTransitionType::CrossFade,
                progress,
                duration: 1.0,
                output_end: 4.0,
            }) if outgoing.segment_index == 0
                && outgoing.source_time == 3.5
                && incoming.segment_index == 1
                && incoming.source_time == 10.5
                && progress == 0.5
        ));
    }

    #[test]
    fn timeline_segment_speed_audio_mode_is_backward_compatible() {
        let legacy: TimelineSegment = serde_json::from_value(serde_json::json!({
            "recordingSegment": 0,
            "timescale": 2.0,
            "start": 0.0,
            "end": 4.0
        }))
        .unwrap();
        assert_eq!(legacy.speed_audio_mode, None);

        let serialized = serde_json::to_value(&legacy).unwrap();
        assert!(serialized.get("speedAudioMode").is_none());

        let maintain_pitch: TimelineSegment = serde_json::from_value(serde_json::json!({
            "recordingSegment": 0,
            "timescale": 2.0,
            "start": 0.0,
            "end": 4.0,
            "speedAudioMode": "maintainPitch"
        }))
        .unwrap();
        assert_eq!(
            maintain_pitch.speed_audio_mode,
            Some(ClipSpeedAudioMode::MaintainPitch)
        );
    }

    #[test]
    fn timeline_clamps_transition_to_half_the_shorter_clip() {
        let timeline = timeline_with_transitions(vec![ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::FadeThroughBlack,
            duration: 9.0,
        }]);

        let transition = timeline.effective_transition(1).unwrap();
        assert_eq!(transition.duration, 2.0);
        assert_eq!(timeline.duration(), 8.0);
    }

    #[test]
    fn legacy_timeline_json_defaults_to_no_transitions() {
        let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 4.0 }
            ],
            "zoomSegments": []
        }))
        .unwrap();

        assert!(timeline.transitions.is_empty());
        assert_eq!(timeline.duration(), 4.0);
    }

    /// The editor TypeScript hardcodes these field names; the serialized
    /// form is a compatibility contract, not an implementation detail.
    #[test]
    fn camera3d_segments_serialize_with_stable_field_names() {
        let mut timeline = timeline_with_transitions(Vec::new());
        timeline.camera3d_segments = vec![Camera3DSegment {
            start: 1.0,
            end: 3.0,
            enabled: true,
            properties: Camera3DProperties {
                tilt_x: -28.0,
                tilt_y: 26.0,
                roll: 5.0,
                zoom: 1.59,
                pan_x: 0.37,
                pan_y: -0.15,
                ..Default::default()
            },
            blur: Camera3DBlur {
                mode: Camera3DBlurMode::Radial,
                strength: 19.0,
                falloff: 0.62,
                bokeh: true,
                ..Default::default()
            },
            tracks: Camera3DTracks {
                zoom: vec![
                    Camera3DKeyframe {
                        time: 0.0,
                        value: 0.715,
                        out_easing: Some([0.0, 0.0]),
                        in_easing: None,
                    },
                    Camera3DKeyframe {
                        time: 2.0,
                        value: 2.1,
                        out_easing: None,
                        in_easing: Some([1.0, 1.0]),
                    },
                ],
                ..Default::default()
            },
            transition_in: 0.3,
            transition_out: 0.3,
        }];

        let json = serde_json::to_value(&timeline).unwrap();
        let segment = &json["camera3dSegments"][0];
        assert_eq!(segment["start"], 1.0);
        assert_eq!(segment["properties"]["tiltX"], -28.0);
        assert_eq!(segment["properties"]["tiltY"], 26.0);
        assert_eq!(segment["properties"]["panX"], 0.37);
        assert_eq!(segment["properties"]["fov"], 45.0);
        assert_eq!(segment["properties"]["rotateX"], 0.0);
        assert_eq!(segment["blur"]["mode"], "radial");
        assert_eq!(segment["blur"]["strength"], 19.0);
        assert_eq!(segment["blur"]["focusX"], 0.37);
        assert_eq!(segment["blur"]["dirPosition"], 0.5);
        assert_eq!(segment["blur"]["bokeh"], true);
        assert_eq!(segment["tracks"]["zoom"][0]["time"], 0.0);
        assert_eq!(segment["tracks"]["zoom"][0]["value"], 0.715);
        assert_eq!(segment["tracks"]["zoom"][0]["outEasing"][1], 0.0);
        assert!(segment["tracks"]["zoom"][0].get("inEasing").is_none());
        assert!(segment["tracks"].get("tiltX").is_none());
        assert_eq!(segment["transitionIn"], 0.3);
        assert_eq!(
            serde_json::to_value(Camera3DBlurMode::TiltShift).unwrap(),
            serde_json::json!("tiltShift")
        );

        // Old configs without the field still load, and the loaded form
        // round-trips.
        let legacy: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 4.0 }
            ],
            "zoomSegments": []
        }))
        .unwrap();
        assert!(legacy.camera3d_segments.is_empty());

        let reloaded: TimelineConfiguration = serde_json::from_value(json).unwrap();
        assert_eq!(reloaded.camera3d_segments.len(), 1);
        assert_eq!(reloaded.camera3d_segments[0].tracks.zoom.len(), 2);
        assert_eq!(
            reloaded.camera3d_segments[0].tracks.zoom[0].out_easing,
            Some([0.0, 0.0])
        );
        assert_eq!(
            reloaded.camera3d_segments[0].blur.mode,
            Camera3DBlurMode::Radial
        );
    }

    #[test]
    fn transition_json_is_normalized_by_segment_index() {
        let timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 4.0 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 4.0, "end": 8.0 },
                { "recordingSegment": 0, "timescale": 1.0, "start": 8.0, "end": 12.0 }
            ],
            "transitions": [
                { "segmentIndex": 2, "type": "cross-fade", "duration": 0.5 },
                { "segmentIndex": 1, "type": "cross-fade", "duration": 0.25 },
                { "segmentIndex": 2, "type": "fade-through-black", "duration": 1.0 }
            ],
            "zoomSegments": []
        }))
        .unwrap();

        assert_eq!(timeline.transitions.len(), 2);
        assert_eq!(timeline.transitions[0].segment_index, 1);
        assert_eq!(timeline.transitions[1].segment_index, 2);
        assert_eq!(
            timeline.transitions[1].kind,
            ClipTransitionType::FadeThroughBlack
        );
    }

    fn write_config_with_motion_blur_values(
        project_path: &std::path::Path,
        cursor_motion_blur: f64,
        screen_motion_blur: Option<f64>,
    ) {
        let mut value = serde_json::to_value(ProjectConfiguration::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        match screen_motion_blur {
            Some(value) => {
                object.insert("screenMotionBlur".to_string(), Value::from(value));
            }
            None => {
                object.remove("screenMotionBlur");
            }
        }
        object
            .get_mut("cursor")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("motionBlur".to_string(), Value::from(cursor_motion_blur));

        std::fs::write(
            project_path.join("project-config.json"),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn default_motion_blur_is_full() {
        // 1.0 matches Screen Studio's default amount under length-based blur
        // semantics; the two fields must agree because the editor drives them
        // with one slider and load() re-couples them.
        let config = ProjectConfiguration::default();

        assert_eq!(config.cursor.motion_blur, 1.0);
        assert_eq!(config.screen_motion_blur, 1.0);
    }

    #[test]
    fn mask_without_pixelation_uses_a_visible_safe_default() {
        let segment: MaskSegment = serde_json::from_value(serde_json::json!({
            "start": 0.0,
            "end": 1.0,
            "maskType": "sensitive",
            "center": { "x": 0.5, "y": 0.5 },
            "size": { "x": 0.25, "y": 0.25 }
        }))
        .unwrap();

        assert_eq!(segment.pixelation, 16.0);
    }

    #[test]
    fn load_uses_cursor_motion_blur_when_screen_motion_blur_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_motion_blur_values(dir.path(), 0.0, None);

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        assert_eq!(config.cursor.motion_blur, 0.0);
        assert_eq!(config.screen_motion_blur, 0.0);
    }

    #[test]
    fn load_uses_cursor_motion_blur_when_screen_motion_blur_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_motion_blur_values(dir.path(), 0.0, Some(1.0));

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        assert_eq!(config.cursor.motion_blur, 0.0);
        assert_eq!(config.screen_motion_blur, 0.0);
    }

    #[test]
    fn load_caps_motion_blur_to_slider_range() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_motion_blur_values(dir.path(), 2.0, Some(2.0));

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        assert_eq!(config.cursor.motion_blur, 1.0);
        assert_eq!(config.screen_motion_blur, 1.0);
    }

    #[test]
    fn load_without_manual_positions_defaults_to_none() {
        let dir = tempfile::tempdir().unwrap();

        let mut value = serde_json::to_value(ProjectConfiguration::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object
            .get_mut("camera")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("manualPosition");
        object
            .get_mut("background")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("displayPosition");
        std::fs::write(
            dir.path().join("project-config.json"),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        assert!(config.camera.manual_position.is_none());
        assert!(config.background.display_position.is_none());
    }

    #[test]
    fn manual_positions_round_trip() {
        let dir = tempfile::tempdir().unwrap();

        let mut config = ProjectConfiguration::default();
        config.camera.manual_position = Some(XY::new(0.25, 0.75));
        config.background.display_position = Some(XY::new(0.5, 0.4));
        std::fs::write(
            dir.path().join("project-config.json"),
            serde_json::to_string(&config).unwrap(),
        )
        .unwrap();

        let loaded = ProjectConfiguration::load(dir.path()).unwrap();

        assert_eq!(loaded.camera.manual_position, Some(XY::new(0.25, 0.75)));
        assert_eq!(loaded.background.display_position, Some(XY::new(0.5, 0.4)));
    }

    fn write_config_with_text_segment(
        project_path: &std::path::Path,
        font_size: f32,
        size_y: f64,
        text_size_version: Option<u32>,
    ) {
        let config = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: Vec::new(),
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: vec![TextSegment {
                    start: 0.0,
                    end: 1.0,
                    track: 0,
                    enabled: true,
                    content: "Text".to_string(),
                    center: XY::new(0.5, 0.5),
                    size: XY::new(0.35, size_y),
                    font_family: "sans-serif".to_string(),
                    font_size,
                    font_weight: 700.0,
                    italic: false,
                    color: "#ffffff".to_string(),
                    fade_duration: 0.15,
                    align: TextAlign::Center,
                    letter_spacing: 0.0,
                    line_height: 1.2,
                    opacity: 1.0,
                    shadow: 0.0,
                    animation_in: TextAnimation::Fade,
                    animation_out: TextAnimation::Fade,
                    animation_in_duration: 0.15,
                    animation_out_duration: 0.15,
                    layout: TextLayout::Overlay,
                    layout_transition: 0.5,
                }],
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            ..Default::default()
        };

        let mut value = serde_json::to_value(&config).unwrap();
        let object = value.as_object_mut().unwrap();
        match text_size_version {
            Some(version) => {
                object.insert("textSizeVersion".to_string(), Value::from(version));
            }
            None => {
                object.remove("textSizeVersion");
            }
        }
        std::fs::write(
            project_path.join("project-config.json"),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn legacy_text_segment_bakes_box_scale_into_font_size() {
        let dir = tempfile::tempdir().unwrap();
        // Legacy renderer drew this at 96 * (0.4 / 0.2) = 2x glyph scale.
        write_config_with_text_segment(dir.path(), 96.0, 0.4, None);

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let segment = &config.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.font_size, 192.0);
        assert_eq!(config.text_size_version, TEXT_SIZE_VERSION);

        // The migration must persist so it never runs twice.
        let reloaded = ProjectConfiguration::load(dir.path()).unwrap();
        let segment = &reloaded.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.font_size, 192.0);
    }

    #[test]
    fn legacy_text_segment_at_base_height_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_text_segment(dir.path(), 48.0, 0.2, None);

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let segment = &config.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.font_size, 48.0);
        assert_eq!(config.text_size_version, TEXT_SIZE_VERSION);
    }

    #[test]
    fn current_text_config_is_not_rebaked() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_text_segment(dir.path(), 96.0, 0.4, Some(TEXT_SIZE_VERSION));

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let segment = &config.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.font_size, 96.0);
    }

    fn write_config_with_text_fade(project_path: &std::path::Path, fade_duration: f64) {
        let mut config = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: Vec::new(),
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: vec![TextSegment {
                    start: 0.0,
                    end: 1.0,
                    track: 0,
                    enabled: true,
                    content: "Text".to_string(),
                    center: XY::new(0.5, 0.5),
                    size: XY::new(0.35, 0.2),
                    font_family: "sans-serif".to_string(),
                    font_size: 48.0,
                    font_weight: 700.0,
                    italic: false,
                    color: "#ffffff".to_string(),
                    fade_duration,
                    align: TextAlign::Center,
                    letter_spacing: 0.0,
                    line_height: 1.2,
                    opacity: 1.0,
                    shadow: 0.0,
                    animation_in: TextAnimation::Fade,
                    animation_out: TextAnimation::Fade,
                    animation_in_duration: 0.15,
                    animation_out_duration: 0.15,
                    layout: TextLayout::Overlay,
                    layout_transition: 0.5,
                }],
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            ..Default::default()
        };
        config.text_anim_version = 0;

        let mut value = serde_json::to_value(&config).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("textAnimVersion");
        // A legacy file predates the animation fields entirely.
        if let Some(segments) = value
            .pointer_mut("/timeline/textSegments")
            .and_then(Value::as_array_mut)
        {
            for segment in segments {
                let object = segment.as_object_mut().unwrap();
                for key in [
                    "align",
                    "letterSpacing",
                    "lineHeight",
                    "opacity",
                    "shadow",
                    "animationIn",
                    "animationOut",
                    "animationInDuration",
                    "animationOutDuration",
                ] {
                    object.remove(key);
                }
            }
        }
        std::fs::write(
            project_path.join("project-config.json"),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn legacy_text_fade_seeds_animation_durations() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_text_fade(dir.path(), 0.5);

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let segment = &config.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.animation_in, TextAnimation::Fade);
        assert_eq!(segment.animation_out, TextAnimation::Fade);
        assert_eq!(segment.animation_in_duration, 0.5);
        assert_eq!(segment.animation_out_duration, 0.5);
        assert_eq!(config.text_anim_version, TEXT_ANIM_VERSION);
    }

    #[test]
    fn legacy_text_zero_fade_disables_animation() {
        let dir = tempfile::tempdir().unwrap();
        write_config_with_text_fade(dir.path(), 0.0);

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let segment = &config.timeline.as_ref().unwrap().text_segments[0];
        assert_eq!(segment.animation_in, TextAnimation::None);
        assert_eq!(segment.animation_out, TextAnimation::None);
        assert_eq!(segment.animation_in_duration, 0.0);
        assert_eq!(segment.animation_out_duration, 0.0);
    }

    #[test]
    fn legacy_config_without_motion_rework_fields_resolves_defaults() {
        let dir = tempfile::tempdir().unwrap();

        // Hand-written pre-rework project-config.json: zoom segments carry
        // only start/end/amount/mode (no glideDirection / glideSpeed /
        // instantAnimation / edgeSnapRatio), the cursor uses the old spring
        // triple, and the camera uses the position enum.
        let legacy_json = r#"{
            "camera": {
                "hide": false,
                "mirror": false,
                "position": { "x": "left", "y": "top" },
                "size": 25.0
            },
            "cursor": {
                "animationStyle": "custom",
                "tension": 120.0,
                "mass": 2.0,
                "friction": 32.0
            },
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 }
                ],
                "zoomSegments": [
                    { "start": 1.0, "end": 3.0, "amount": 2.0, "mode": "auto" },
                    {
                        "start": 5.0,
                        "end": 7.0,
                        "amount": 1.5,
                        "mode": { "manual": { "x": 0.25, "y": 0.75 } }
                    }
                ]
            }
        }"#;
        std::fs::write(dir.path().join("project-config.json"), legacy_json).unwrap();

        let config = ProjectConfiguration::load(dir.path()).unwrap();

        let timeline = config.timeline.as_ref().expect("timeline should load");
        assert_eq!(timeline.zoom_segments.len(), 2);
        for segment in &timeline.zoom_segments {
            assert_eq!(segment.glide_direction, GlideDirection::None);
            assert_eq!(segment.glide_speed, 0.5);
            assert!(!segment.instant_animation);
            assert_eq!(segment.edge_snap_ratio, 0.25);
        }
        assert!(matches!(timeline.zoom_segments[0].mode, ZoomMode::Auto));
        assert!(matches!(
            timeline.zoom_segments[1].mode,
            ZoomMode::Manual { x, y }
                if (x - 0.25).abs() < f32::EPSILON && (y - 0.75).abs() < f32::EPSILON
        ));

        // The old cursor spring triple survives untouched.
        assert_eq!(config.cursor.animation_style, CursorAnimationStyle::Custom);
        assert_eq!(config.cursor.tension, 120.0);
        assert_eq!(config.cursor.mass, 2.0);
        assert_eq!(config.cursor.friction, 32.0);

        // The camera position enum still parses.
        assert!(matches!(config.camera.position.x, CameraXPosition::Left));
        assert!(matches!(config.camera.position.y, CameraYPosition::Top));

        // Config written back by the load migration must round-trip with the
        // resolved defaults intact.
        let reloaded = ProjectConfiguration::load(dir.path()).unwrap();
        let reloaded_timeline = reloaded.timeline.as_ref().unwrap();
        assert_eq!(reloaded_timeline.zoom_segments.len(), 2);
        assert_eq!(reloaded_timeline.zoom_segments[0].glide_speed, 0.5);
        assert_eq!(reloaded_timeline.zoom_segments[0].edge_snap_ratio, 0.25);
        assert!(!reloaded_timeline.zoom_segments[0].instant_animation);

        // The screen movement spring (which drives the new zoom timeline)
        // resolves to its default for legacy configs.
        let spring = config.screen_movement_spring;
        let default_spring = ScreenMovementSpring::default();
        assert_eq!(spring.stiffness, default_spring.stiffness);
        assert_eq!(spring.damping, default_spring.damping);
        assert_eq!(spring.mass, default_spring.mass);
    }
}
