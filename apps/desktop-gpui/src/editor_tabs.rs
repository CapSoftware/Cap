//! The five config-sidebar tabs beyond Background: Camera, Audio, Cursor,
//! Keyboard and Captions.
//!
//! | tab | source |
//! |---|---|
//! | Camera | `CameraConfig` (`ConfigSidebar.tsx:2978-3330`) |
//! | Audio | the inline `KTabs.Content value="audio"` (`:942-1016`) plus `SyncOffsetsConfig` (`:6081-6178`) |
//! | Cursor | the inline `KTabs.Content value="cursor"` (`:1017-1052`, controls at `:820-1000`) |
//! | Keyboard | `KeyboardTab.tsx` |
//! | Captions | `CaptionsTab.tsx` |
//!
//! Everything here writes a real `ProjectConfiguration` key path through
//! [`EditorWindow::edit_project`], which is the same fan-out a timeline edit or
//! a background slider takes.
//!
use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
    time::Duration,
};

#[cfg(test)]
use cap_project::CaptionsData;
use cap_project::{
    BackgroundBlurConfig, BackgroundBlurMode, CameraShape, CameraXPosition, CameraYPosition,
    CaptionSegment, CaptionSettings, CornerStyle, CursorAnimationStyle, CursorRippleConfig,
    KeyboardData, KeyboardSettings, ProjectConfiguration, ShadowConfiguration, StereoMode,
};
use gpui::{
    AnyElement, Bounds, Context, EntityId, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, Pixels, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, relative, svg,
};
use serde_json::Value;

use crate::{
    editor_color::GradeTarget,
    editor_sidebar::{SliderKey, collapsible, dashed_divider},
    editor_window::EditorWindow,
    store, transcription, ui,
};

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

/// `CAMERA_SHAPES` (`ConfigSidebar.tsx:381-391`).
pub const CAMERA_SHAPES: [(CameraShape, &str); 2] = [
    (CameraShape::Square, "Square"),
    (CameraShape::Source, "Source"),
];

/// The three `backgroundBlur` rows (`:3078-3082`).
pub const CAMERA_BLUR_MODES: [(BackgroundBlurMode, &str); 3] = [
    (BackgroundBlurMode::Off, "Off"),
    (BackgroundBlurMode::Light, "Light Blur"),
    (BackgroundBlurMode::Heavy, "Heavy Blur"),
];

/// `CORNER_STYLE_OPTIONS` (`:399-402`).
pub const CORNER_STYLES: [(CornerStyle, &str); 2] = [
    (CornerStyle::Squircle, "Squircle"),
    (CornerStyle::Rounded, "Rounded"),
];

/// `STEREO_MODES` (`:375-379`).
pub const STEREO_MODES: [(StereoMode, &str); 3] = [
    (StereoMode::Stereo, "Stereo"),
    (StereoMode::MonoL, "Mono L"),
    (StereoMode::MonoR, "Mono R"),
];

/// `CURSOR_ANIMATION_STYLE_OPTIONS` (`:434-476`) -- the four presets plus the
/// `custom` value the physics sliders drop the picker into.
pub const CURSOR_STYLES: [(CursorAnimationStyle, &str, &str); 4] = [
    (
        CursorAnimationStyle::Slow,
        "Slow",
        "Long, drifting movement",
    ),
    (
        CursorAnimationStyle::Smooth,
        "Smooth",
        "Soft, floaty movement",
    ),
    (
        CursorAnimationStyle::Mellow,
        "Mellow",
        "Balanced, natural movement",
    ),
    (CursorAnimationStyle::Fast, "Fast", "Snappy, close tracking"),
];

/// `FONT_OPTIONS` (`text-style.tsx:12-16`).
pub const FONT_OPTIONS: [&str; 3] = ["System Sans-Serif", "System Serif", "System Monospace"];

/// `TEXT_WEIGHT_OPTIONS` (`text-style.tsx:36-40`).
pub const TEXT_WEIGHTS: [(u32, &str); 3] = [(400, "Normal"), (500, "Medium"), (700, "Bold")];

/// `KEYBOARD_POSITION_OPTIONS` (`text-style.tsx:28-35`).
pub const KEYBOARD_POSITIONS: [(&str, &str); 6] = [
    ("top-left", "Top Left"),
    ("top-center", "Top Center"),
    ("top-right", "Top Right"),
    ("bottom-left", "Bottom Left"),
    ("bottom-center", "Bottom Center"),
    ("bottom-right", "Bottom Right"),
];

/// `CAPTION_POSITION_OPTIONS` (`text-style.tsx:18-26`) -- the keyboard's six
/// with `manual` in front.
pub const CAPTION_POSITIONS: [(&str, &str); 7] = [
    ("manual", "Manual"),
    ("top-left", "Top Left"),
    ("top-center", "Top Center"),
    ("top-right", "Top Right"),
    ("bottom-left", "Bottom Left"),
    ("bottom-center", "Bottom Center"),
    ("bottom-right", "Bottom Right"),
];

/// `CAPTION_ANIMATION_OPTIONS` (`text-style.tsx:64-68`).
pub const CAPTION_ANIMATIONS: [(&str, &str); 3] =
    [("none", "None"), ("bounce", "Bounce"), ("pop", "Pop")];

/// `CAPTION_HIGHLIGHT_STYLE_OPTIONS` (`text-style.tsx:70-73`).
pub const CAPTION_HIGHLIGHT_STYLES: [(&str, &str); 2] = [("color", "Color"), ("pill", "Pill")];

/// One row of `MODEL_OPTIONS` (`CaptionsTab.tsx:72-78`).
pub struct CaptionModel {
    pub name: &'static str,
    pub label: &'static str,
    /// The engine identity the source shows in an info tooltip.
    pub model_name: &'static str,
    pub size: &'static str,
    pub description: &'static str,
}

/// `MODEL_OPTIONS` (`CaptionsTab.tsx:87-116`).
pub static CAPTION_MODELS: &[CaptionModel] = &[
    CaptionModel {
        name: "best",
        label: "Recommended",
        model_name: "parakeet-tdt-0.6b-v3 int8",
        size: "~640MB",
        description: "Best balance for most recordings",
    },
    CaptionModel {
        name: "best-max",
        label: "High Accuracy",
        model_name: "parakeet-tdt-0.6b-v3",
        size: "~2.4GB",
        description: "Larger download, higher accuracy",
    },
    CaptionModel {
        name: "small",
        label: "Small",
        model_name: "whisper.cpp small",
        size: "466MB",
        description: "Smallest download",
    },
    CaptionModel {
        name: "medium",
        label: "Medium",
        model_name: "whisper.cpp medium",
        size: "1.5GB",
        description: "Slower, more accurate",
    },
];

/// `availableModelOptions` (`CaptionsTab.tsx:416-420`): the two Parakeet
/// entries are hidden on Intel macOS.
pub fn available_caption_models() -> &'static [CaptionModel] {
    if transcription::supports_parakeet() {
        CAPTION_MODELS
    } else {
        &CAPTION_MODELS[2..]
    }
}

/// `LANGUAGE_OPTIONS` (`CaptionsTab.tsx:118-148`), de-duplicated: the array
/// repeats `ar`/`hi`/`bn`/`ta` at the end, and a Kobalte listbox keyed on the
/// code renders each once.
pub const CAPTION_LANGUAGES: [(&str, &str); 26] = [
    ("auto", "Auto Detect"),
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("de", "German"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("tr", "Turkish"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("zh", "Chinese"),
    ("ar", "Arabic"),
    ("hi", "Hindi"),
    ("bn", "Bengali"),
    ("ta", "Tamil"),
    ("te", "Telugu"),
    ("mr", "Marathi"),
    ("gu", "Gujarati"),
    ("pa", "Punjabi"),
    ("ur", "Urdu"),
    ("fa", "Persian"),
    ("he", "Hebrew"),
];

/// `CAPTION_STYLE_PRESETS` (`store/captions.ts:57-160`).
pub struct CaptionPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub font_weight: u32,
    pub size: u32,
    pub color: &'static str,
    pub background_color: &'static str,
    pub background_opacity: u32,
    pub outline: bool,
    pub outline_color: &'static str,
    pub highlight_color: &'static str,
    pub active_word_highlight: bool,
    pub highlight_style: &'static str,
    pub animation: &'static str,
    pub uppercase: bool,
    pub fade_duration: f32,
}

pub static CAPTION_PRESETS: &[CaptionPreset] = &[
    CaptionPreset {
        id: "classic",
        label: "Classic",
        description: "Clean text on a solid rounded background.",
        font_weight: 700,
        size: 50,
        color: "#FFFFFF",
        background_color: "#000000",
        background_opacity: 90,
        outline: false,
        outline_color: "#000000",
        highlight_color: "#FFFFFF",
        active_word_highlight: false,
        highlight_style: "color",
        animation: "bounce",
        uppercase: false,
        fade_duration: 0.2,
    },
    CaptionPreset {
        id: "karaoke",
        label: "Karaoke",
        description: "Words light up in sync with speech.",
        font_weight: 700,
        size: 52,
        color: "#FFFFFF",
        background_color: "#000000",
        background_opacity: 35,
        outline: false,
        outline_color: "#000000",
        highlight_color: "#FFD400",
        active_word_highlight: true,
        highlight_style: "color",
        animation: "none",
        uppercase: false,
        fade_duration: 0.12,
    },
    CaptionPreset {
        id: "highlight",
        label: "Highlight",
        description: "Bold caps with a pill behind the active word.",
        font_weight: 700,
        size: 54,
        color: "#FFFFFF",
        background_color: "#000000",
        background_opacity: 0,
        outline: true,
        outline_color: "#000000",
        highlight_color: "#7C3AED",
        active_word_highlight: true,
        highlight_style: "pill",
        animation: "bounce",
        uppercase: true,
        fade_duration: 0.12,
    },
    CaptionPreset {
        id: "pop",
        label: "Pop",
        description: "Playful caps that pop in with a vibrant accent.",
        font_weight: 700,
        size: 56,
        color: "#FFFFFF",
        background_color: "#000000",
        background_opacity: 0,
        outline: true,
        outline_color: "#000000",
        highlight_color: "#FACC15",
        active_word_highlight: true,
        highlight_style: "color",
        animation: "pop",
        uppercase: true,
        fade_duration: 0.18,
    },
    CaptionPreset {
        id: "minimal",
        label: "Minimal",
        description: "Subtle outlined text with no background.",
        font_weight: 600,
        size: 46,
        color: "#FFFFFF",
        background_color: "#000000",
        background_opacity: 0,
        outline: true,
        outline_color: "#000000",
        highlight_color: "#FFFFFF",
        active_word_highlight: false,
        highlight_style: "color",
        animation: "none",
        uppercase: false,
        fade_duration: 0.25,
    },
];

/// `DEFAULT_CAMERA_SCALE_DURING_ZOOM` (`projectConfig.ts:27`).
pub const DEFAULT_CAMERA_SCALE_DURING_ZOOM: f32 = 0.7;

/// The camera tab's `ShadowSettings` fallback, and the background tab's -- the
/// UI's `{50, 18, 50}` rather than `ShadowConfiguration::default()`.
const UI_SHADOW_FALLBACK: ShadowConfiguration = ShadowConfiguration {
    size: 50.,
    opacity: 18.,
    blur: 50.,
};

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CameraSlider {
    Size,
    ZoomSize,
    Rounding,
    Shadow,
    ShadowSize,
    ShadowOpacity,
    ShadowBlur,
}

impl CameraSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            // `minValue={20} maxValue={80} step={0.1}` (`:3204-3206`).
            Self::Size => (20., 80., 0.1),
            // `minValue={10} maxValue={60}` (`:3213-3215`).
            Self::ZoomSize => (10., 60., 0.1),
            _ => (0., 100., 0.1),
        }
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        let camera = &project.camera;
        let shadow = camera.advanced_shadow.as_ref();
        match self {
            Self::Size => camera.size,
            // `project.camera.zoomSize ?? 60`
            Self::ZoomSize => camera.zoom_size.unwrap_or(60.),
            Self::Rounding => camera.rounding,
            Self::Shadow => camera.shadow,
            Self::ShadowSize => shadow.map_or(UI_SHADOW_FALLBACK.size, |s| s.size),
            Self::ShadowOpacity => shadow.map_or(UI_SHADOW_FALLBACK.opacity, |s| s.opacity),
            Self::ShadowBlur => shadow.map_or(UI_SHADOW_FALLBACK.blur, |s| s.blur),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AudioSlider {
    MicVolume,
    SystemVolume,
}

impl AudioSlider {
    /// `minValue={-30} maxValue={10} step={0.1}` on both (`:787-791`,
    /// `:806-810`).
    pub fn limits(self) -> (f32, f32, f32) {
        (-30., 10., 0.1)
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        match self {
            Self::MicVolume => project.audio.mic_volume_db,
            Self::SystemVolume => project.audio.system_volume_db,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CursorSlider {
    Size,
    Tilt,
    IdleDelay,
    Tension,
    Friction,
    Mass,
    RippleStrength,
    RippleSize,
    RippleDuration,
}

impl CursorSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Size => (20., 300., 1.),
            Self::Tilt => (0., 1., 0.01),
            Self::IdleDelay => (0.5, 5., 0.1),
            Self::Tension => (1., 600., 1.),
            Self::Friction => (0., 200., 0.1),
            Self::Mass => (0.1, 15., 0.01),
            // Strength and size are stored as fractions and shown as
            // percentages; `CursorRippleConfig`'s own ranges, x100.
            Self::RippleStrength => (0., 100., 1.),
            Self::RippleSize => (25., 300., 1.),
            Self::RippleDuration => (
                CursorRippleConfig::DURATION_RANGE.0,
                CursorRippleConfig::DURATION_RANGE.1,
                0.05,
            ),
        }
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        let cursor = &project.cursor;
        match self {
            Self::Size => cursor.size as f32,
            Self::Tilt => cursor.rotation_amount,
            Self::IdleDelay => cursor.hide_when_idle_delay,
            Self::Tension => cursor.tension,
            Self::Friction => cursor.friction,
            Self::Mass => cursor.mass,
            Self::RippleStrength => cursor.ripple.strength_clamped() * 100.,
            Self::RippleSize => cursor.ripple.size_clamped() * 100.,
            Self::RippleDuration => cursor.ripple.duration_clamped(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CaptionSlider {
    Size,
    BackgroundOpacity,
    FadeDuration,
}

impl CaptionSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Size => (12., 100., 1.),
            Self::BackgroundOpacity => (0., 100., 1.),
            // `value={[getSetting("fadeDuration") * 100]}` over 0..50.
            Self::FadeDuration => (0., 50., 1.),
        }
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        let settings = caption_settings(project);
        match self {
            Self::Size => settings.size as f32,
            Self::BackgroundOpacity => settings.background_opacity as f32,
            Self::FadeDuration => settings.fade_duration * 100.,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyboardSlider {
    Size,
    BackgroundOpacity,
    FadeDuration,
    LingerDuration,
    GroupingThreshold,
}

impl KeyboardSlider {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Size => (12., 100., 1.),
            Self::BackgroundOpacity => (0., 100., 1.),
            Self::FadeDuration => (0., 50., 1.),
            // `minValue={0} maxValue={300} step={5}` (`KeyboardTab.tsx:366-368`).
            Self::LingerDuration => (0., 300., 5.),
            // `minValue={50} maxValue={1000} step={10}` (`:380-382`).
            Self::GroupingThreshold => (50., 1000., 10.),
        }
    }

    pub fn read(self, project: &ProjectConfiguration) -> f32 {
        let settings = keyboard_settings(project);
        match self {
            Self::Size => settings.size as f32,
            Self::BackgroundOpacity => settings.background_opacity as f32,
            Self::FadeDuration => settings.fade_duration * 100.,
            Self::LingerDuration => settings.linger_duration * 100.,
            Self::GroupingThreshold => settings.grouping_threshold_ms as f32,
        }
    }
}

/// `project?.captions?.settings ?? defaultCaptionSettings`
/// (`CaptionsTab.tsx:315-319`).
pub fn caption_settings(project: &ProjectConfiguration) -> CaptionSettings {
    project
        .captions
        .as_ref()
        .map(|captions| captions.settings.clone())
        .unwrap_or_default()
}

/// `project?.keyboard?.settings ?? defaultKeyboardSettings`
/// (`KeyboardTab.tsx:39-48`).
pub fn keyboard_settings(project: &ProjectConfiguration) -> KeyboardSettings {
    project
        .keyboard
        .as_ref()
        .map(|keyboard| keyboard.settings.clone())
        .unwrap_or_default()
}

/// `updateCaptionSetting` (`CaptionsTab.tsx:321-338`): a settings write is a
/// no-op when the project has no captions block at all, which is what the
/// source's `if (!project?.captions) return` says.
fn with_caption_settings(
    project: &mut ProjectConfiguration,
    change: impl FnOnce(&mut CaptionSettings),
) -> bool {
    let Some(captions) = project.captions.as_mut() else {
        return false;
    };
    change(&mut captions.settings);
    true
}

/// `updateSetting` (`KeyboardTab.tsx:50-61`): unlike captions, this one
/// *creates* the block from the defaults when it is missing.
fn with_keyboard_settings(
    project: &mut ProjectConfiguration,
    change: impl FnOnce(&mut KeyboardSettings),
) -> bool {
    let keyboard = project.keyboard.get_or_insert_with(KeyboardData::default);
    change(&mut keyboard.settings);
    true
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarMenu {
    BackgroundCornerStyle,
    CameraBlur,
    CameraShape,
    CameraCornerStyle,
    AudioStereo,
    CaptionModel,
    CaptionLanguage,
    CaptionFont,
    CaptionHighlightStyle,
    CaptionPosition,
    CaptionAnimation,
    CaptionWeight,
    KeyboardFont,
    KeyboardPosition,
    KeyboardWeight,
    /// The segment panels' own selects carry their segment index.
    ///
    /// `TextFontFamily` is `FontPicker` (`FontPicker.tsx`), which is the one
    /// select in the sidebar the source draws as a **combobox** rather than a
    /// `KSelect`: it lists every installed family, so it filters as you type.
    /// See the README's font-picker deviation.
    TextFontFamily(usize),
    TextWeight(usize),
    TextAnimationIn(usize),
    TextAnimationOut(usize),
    Camera3DBlurMode(usize),
    Camera3DEasing(usize),
}

pub struct OpenMenu {
    pub kind: SidebarMenu,
    pub state: ui::MenuState,
}

impl EditorWindow {
    /// The rows a menu draws, with a check mark on the value in force.
    pub(crate) fn sidebar_menu_items(&self, kind: SidebarMenu) -> Vec<ui::MenuItem> {
        let project = &self.project;
        let captions = caption_settings(project);
        let keyboard = keyboard_settings(project);
        match kind {
            SidebarMenu::BackgroundCornerStyle => CORNER_STYLES
                .iter()
                .map(|(style, label)| {
                    ui::MenuItem::new(*label, *style == project.background.rounding_type)
                })
                .collect(),
            SidebarMenu::CameraBlur => CAMERA_BLUR_MODES
                .iter()
                .map(|(mode, label)| {
                    ui::MenuItem::new(*label, *mode == project.camera.background_blur.mode)
                })
                .collect(),
            SidebarMenu::CameraShape => CAMERA_SHAPES
                .iter()
                .map(|(shape, label)| {
                    ui::MenuItem::new(
                        *label,
                        std::mem::discriminant(shape)
                            == std::mem::discriminant(&project.camera.shape),
                    )
                })
                .collect(),
            SidebarMenu::CameraCornerStyle => CORNER_STYLES
                .iter()
                .map(|(style, label)| {
                    ui::MenuItem::new(*label, *style == project.camera.rounding_type)
                })
                .collect(),
            SidebarMenu::AudioStereo => STEREO_MODES
                .iter()
                .map(|(mode, label)| {
                    ui::MenuItem::new(*label, *mode == project.audio.mic_stereo_mode)
                })
                .collect(),
            SidebarMenu::CaptionModel => {
                let selected = self.selected_caption_model().name;
                available_caption_models()
                    .iter()
                    .map(|model| {
                        ui::MenuItem::new(
                            SharedString::from(format!(
                                "{} · {} · {}",
                                model.label, model.size, model.description
                            )),
                            model.name == selected,
                        )
                    })
                    .collect()
            }
            SidebarMenu::CaptionLanguage => CAPTION_LANGUAGES
                .iter()
                .map(|(code, label)| {
                    ui::MenuItem::new(*label, *code == self.sidebar.caption_language)
                })
                .collect(),
            SidebarMenu::CaptionFont => FONT_OPTIONS
                .iter()
                .map(|font| ui::MenuItem::new(*font, *font == captions.font))
                .collect(),
            SidebarMenu::CaptionHighlightStyle => CAPTION_HIGHLIGHT_STYLES
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == captions.highlight_style))
                .collect(),
            SidebarMenu::CaptionPosition => CAPTION_POSITIONS
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == captions.position))
                .collect(),
            SidebarMenu::CaptionAnimation => CAPTION_ANIMATIONS
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == captions.animation))
                .collect(),
            SidebarMenu::CaptionWeight => TEXT_WEIGHTS
                .iter()
                .map(|(weight, label)| ui::MenuItem::new(*label, *weight == captions.font_weight))
                .collect(),
            SidebarMenu::KeyboardFont => FONT_OPTIONS
                .iter()
                .map(|font| ui::MenuItem::new(*font, *font == keyboard.font))
                .collect(),
            SidebarMenu::KeyboardPosition => KEYBOARD_POSITIONS
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == keyboard.position))
                .collect(),
            SidebarMenu::KeyboardWeight => TEXT_WEIGHTS
                .iter()
                .map(|(weight, label)| ui::MenuItem::new(*label, *weight == keyboard.font_weight))
                .collect(),
            SidebarMenu::TextFontFamily(index)
            | SidebarMenu::TextWeight(index)
            | SidebarMenu::TextAnimationIn(index)
            | SidebarMenu::TextAnimationOut(index)
            | SidebarMenu::Camera3DBlurMode(index)
            | SidebarMenu::Camera3DEasing(index) => self.panel_menu_items(kind, index),
        }
    }

    pub(crate) fn open_sidebar_menu(
        &mut self,
        kind: SidebarMenu,
        trigger_bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A focused field would swallow the menu's arrows and Enter before the
        // root's `on_key_down` ever saw them -- its bindings sit deeper in the
        // dispatch path -- so opening a menu takes focus back, exactly as
        // clicking a `<button>` blurs a focused `<input>` in the webview.
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        let items = self.sidebar_menu_items(kind);
        self.sidebar.menu = Some(OpenMenu {
            kind,
            state: ui::MenuState::anchored(trigger_bounds, &items),
        });
        cx.notify();
    }

    /// Arrows / Home / End / Enter / Escape on an open menu. Returns whether
    /// the key was consumed, which is what keeps Escape from also clearing the
    /// timeline selection underneath.
    pub(crate) fn sidebar_menu_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(menu) = self.sidebar.menu.as_mut() else {
            return false;
        };
        let kind = menu.kind;
        match menu.state.on_key(key) {
            ui::MenuKey::Moved => {
                cx.notify();
                true
            }
            ui::MenuKey::Commit(index) => {
                self.choose_sidebar_menu(kind, index, window, cx);
                true
            }
            ui::MenuKey::Dismiss => {
                self.sidebar.menu = None;
                cx.notify();
                true
            }
            ui::MenuKey::Ignored => false,
        }
    }

    pub(crate) fn render_sidebar_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.sidebar.menu.as_ref()?;
        let kind = menu.kind;
        let items = self.sidebar_menu_items(kind);
        Some(
            ui::Menu::plain(&self.theme, "sidebar-menu", items, &menu.state)
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    this.choose_sidebar_menu(kind, *index, window, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    this.sidebar.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    fn choose_sidebar_menu(
        &mut self,
        kind: SidebarMenu,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar.menu = None;
        match kind {
            SidebarMenu::BackgroundCornerStyle => {
                let Some((style, _)) = CORNER_STYLES.get(index) else {
                    return;
                };
                let style = *style;
                self.edit_project("rounding-type", window, cx, move |project| {
                    if project.background.rounding_type == style {
                        return false;
                    }
                    project.background.rounding_type = style;
                    true
                });
            }
            SidebarMenu::CameraBlur => {
                let Some((mode, _)) = CAMERA_BLUR_MODES.get(index) else {
                    return;
                };
                let mode = *mode;
                self.edit_project("camera-blur", window, cx, move |project| {
                    if project.camera.background_blur.mode == mode {
                        return false;
                    }
                    project.camera.background_blur = BackgroundBlurConfig { mode };
                    true
                });
            }
            SidebarMenu::CameraShape => {
                let Some((shape, _)) = CAMERA_SHAPES.get(index) else {
                    return;
                };
                let shape = *shape;
                self.edit_project("camera-shape", window, cx, move |project| {
                    project.camera.shape = shape;
                    true
                });
            }
            SidebarMenu::CameraCornerStyle => {
                let Some((style, _)) = CORNER_STYLES.get(index) else {
                    return;
                };
                let style = *style;
                self.edit_project("camera-corner-style", window, cx, move |project| {
                    if project.camera.rounding_type == style {
                        return false;
                    }
                    project.camera.rounding_type = style;
                    true
                });
            }
            SidebarMenu::AudioStereo => {
                let Some((mode, _)) = STEREO_MODES.get(index) else {
                    return;
                };
                let mode = mode.clone();
                self.edit_project("audio-stereo", window, cx, move |project| {
                    if project.audio.mic_stereo_mode == mode {
                        return false;
                    }
                    project.audio.mic_stereo_mode = mode;
                    true
                });
            }
            // The two transcription pickers are local UI state in the source
            // too (`createSignal` persisted to `localStorage`,
            // `CaptionsTab.tsx:622-641`), not project config; the store's
            // `gpui` section is this app's `localStorage`.
            SidebarMenu::CaptionModel => {
                if let Some(model) = available_caption_models().get(index) {
                    self.sidebar.caption_model = model.name;
                    if !store::set_store_setting(
                        transcription::GPUI_STORE_SECTION,
                        transcription::SELECTED_MODEL_KEY,
                        Value::String(model.name.to_string()),
                    ) {
                        tracing::warn!("the store refused the transcription model write");
                    }
                    cx.notify();
                }
            }
            SidebarMenu::CaptionLanguage => {
                if let Some((code, _)) = CAPTION_LANGUAGES.get(index) {
                    self.sidebar.caption_language = code;
                    if !store::set_store_setting(
                        transcription::GPUI_STORE_SECTION,
                        transcription::SELECTED_LANGUAGE_KEY,
                        Value::String((*code).to_string()),
                    ) {
                        tracing::warn!("the store refused the transcription language write");
                    }
                    cx.notify();
                }
            }
            SidebarMenu::CaptionFont => {
                let Some(font) = FONT_OPTIONS.get(index) else {
                    return;
                };
                let font = font.to_string();
                self.set_caption_setting("caption-font", window, cx, move |settings| {
                    settings.font = font
                });
            }
            SidebarMenu::CaptionHighlightStyle => {
                let Some((value, _)) = CAPTION_HIGHLIGHT_STYLES.get(index) else {
                    return;
                };
                let value = value.to_string();
                self.set_caption_setting("caption-highlight-style", window, cx, move |settings| {
                    settings.highlight_style = value
                });
            }
            SidebarMenu::CaptionPosition => {
                let Some((value, _)) = CAPTION_POSITIONS.get(index) else {
                    return;
                };
                let value = value.to_string();
                self.set_caption_setting("caption-position", window, cx, move |settings| {
                    settings.position = value
                });
            }
            SidebarMenu::CaptionAnimation => {
                let Some((value, _)) = CAPTION_ANIMATIONS.get(index) else {
                    return;
                };
                let value = value.to_string();
                self.set_caption_setting("caption-animation", window, cx, move |settings| {
                    settings.animation = value
                });
            }
            SidebarMenu::CaptionWeight => {
                let Some((weight, _)) = TEXT_WEIGHTS.get(index) else {
                    return;
                };
                let weight = *weight;
                self.set_caption_setting("caption-weight", window, cx, move |settings| {
                    settings.font_weight = weight
                });
            }
            SidebarMenu::KeyboardFont => {
                let Some(font) = FONT_OPTIONS.get(index) else {
                    return;
                };
                let font = font.to_string();
                self.set_keyboard_setting("keyboard-font", window, cx, move |settings| {
                    settings.font = font
                });
            }
            SidebarMenu::KeyboardPosition => {
                let Some((value, _)) = KEYBOARD_POSITIONS.get(index) else {
                    return;
                };
                let value = value.to_string();
                self.set_keyboard_setting("keyboard-position", window, cx, move |settings| {
                    settings.position = value
                });
            }
            SidebarMenu::KeyboardWeight => {
                let Some((weight, _)) = TEXT_WEIGHTS.get(index) else {
                    return;
                };
                let weight = *weight;
                self.set_keyboard_setting("keyboard-weight", window, cx, move |settings| {
                    settings.font_weight = weight
                });
            }
            SidebarMenu::TextFontFamily(segment)
            | SidebarMenu::TextWeight(segment)
            | SidebarMenu::TextAnimationIn(segment)
            | SidebarMenu::TextAnimationOut(segment)
            | SidebarMenu::Camera3DBlurMode(segment)
            | SidebarMenu::Camera3DEasing(segment) => {
                self.choose_panel_menu(kind, segment, index, window, cx)
            }
        }
    }

    pub(crate) fn set_caption_setting(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut CaptionSettings),
    ) {
        self.edit_project(reason, window, cx, |project| {
            with_caption_settings(project, |settings| {
                change(settings);
                // `STYLE_PRESET_KEYS` knocks the grade to "custom"
                // (`CaptionsTab.tsx:326-336`). Every setter routed through here
                // is one of those keys except the two `enabled`-style ones,
                // which are handled by their own call sites.
                if reason != "caption-enabled" && reason != "caption-export" {
                    settings.preset = "custom".to_string();
                }
            })
        });
    }

    pub(crate) fn set_keyboard_setting(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut KeyboardSettings),
    ) {
        self.edit_project(reason, window, cx, |project| {
            with_keyboard_settings(project, change)
        });
    }
}

// ---------------------------------------------------------------------------
// The slider arms
// ---------------------------------------------------------------------------

impl EditorWindow {
    pub(crate) fn apply_camera_slider(
        &mut self,
        slider: CameraSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project("camera-slider", window, cx, move |project| {
            let camera = &mut project.camera;
            match slider {
                CameraSlider::Size => camera.size = value,
                CameraSlider::ZoomSize => camera.zoom_size = Some(value),
                CameraSlider::Rounding => camera.rounding = value,
                CameraSlider::Shadow => camera.shadow = value,
                // `...(project.camera.advancedShadow ?? {50, 18, 50})`
                // (`:3253-3259`) -- the same UI fallback the background tab has.
                CameraSlider::ShadowSize
                | CameraSlider::ShadowOpacity
                | CameraSlider::ShadowBlur => {
                    let mut shadow = camera.advanced_shadow.clone().unwrap_or(UI_SHADOW_FALLBACK);
                    match slider {
                        CameraSlider::ShadowSize => shadow.size = value,
                        CameraSlider::ShadowOpacity => shadow.opacity = value,
                        _ => shadow.blur = value,
                    }
                    camera.advanced_shadow = Some(shadow);
                }
            }
            true
        });
    }

    pub(crate) fn apply_audio_slider(
        &mut self,
        slider: AudioSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project("audio-slider", window, cx, move |project| {
            match slider {
                AudioSlider::MicVolume => project.audio.mic_volume_db = value,
                AudioSlider::SystemVolume => project.audio.system_volume_db = value,
            }
            true
        });
    }

    pub(crate) fn apply_cursor_slider(
        &mut self,
        slider: CursorSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project("cursor-slider", window, cx, move |project| {
            let cursor = &mut project.cursor;
            match slider {
                CursorSlider::Size => cursor.size = value.round() as u32,
                CursorSlider::Tilt => cursor.rotation_amount = value,
                // `clampIdleDelay`: `round(min(5, max(0.5, v)) * 10) / 10`
                // (`:525-526`).
                CursorSlider::IdleDelay => {
                    cursor.hide_when_idle_delay = (value.clamp(0.5, 5.) * 10.).round() / 10.
                }
                // `setCursorPhysics` (`:531-546`): write the field, then
                // re-match the four presets and fall to `custom`.
                CursorSlider::Tension | CursorSlider::Friction | CursorSlider::Mass => {
                    match slider {
                        CursorSlider::Tension => cursor.tension = value,
                        CursorSlider::Friction => cursor.friction = value,
                        _ => cursor.mass = value,
                    }
                    cursor.animation_style =
                        match_cursor_preset(cursor.tension, cursor.mass, cursor.friction)
                            .unwrap_or(CursorAnimationStyle::Custom);
                }
                CursorSlider::RippleStrength => cursor.ripple.strength = value / 100.,
                CursorSlider::RippleSize => cursor.ripple.size = value / 100.,
                CursorSlider::RippleDuration => cursor.ripple.duration = value,
            }
            true
        });
    }

    pub(crate) fn apply_caption_slider(
        &mut self,
        slider: CaptionSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_caption_setting("caption-slider", window, cx, move |settings| match slider {
            CaptionSlider::Size => settings.size = value.round() as u32,
            CaptionSlider::BackgroundOpacity => settings.background_opacity = value.round() as u32,
            CaptionSlider::FadeDuration => settings.fade_duration = value / 100.,
        });
    }

    pub(crate) fn apply_keyboard_slider(
        &mut self,
        slider: KeyboardSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.set_keyboard_setting(
            "keyboard-slider",
            window,
            cx,
            move |settings| match slider {
                KeyboardSlider::Size => settings.size = value.round() as u32,
                KeyboardSlider::BackgroundOpacity => {
                    settings.background_opacity = value.round() as u32
                }
                KeyboardSlider::FadeDuration => settings.fade_duration = value / 100.,
                KeyboardSlider::LingerDuration => settings.linger_duration = value / 100.,
                KeyboardSlider::GroupingThreshold => {
                    settings.grouping_threshold_ms = f64::from(value)
                }
            },
        );
    }
}

/// `findCursorPreset` (`:477-504`): the four named presets, matched on all
/// three physics values. Anything else is `custom`.
pub fn match_cursor_preset(tension: f32, mass: f32, friction: f32) -> Option<CursorAnimationStyle> {
    CURSOR_STYLES.iter().find_map(|(style, _, _)| {
        let preset = style.preset()?;
        ((preset.tension - tension).abs() < f32::EPSILON
            && (preset.mass - mass).abs() < f32::EPSILON
            && (preset.friction - friction).abs() < f32::EPSILON)
            .then_some(*style)
    })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// A `<span class="text-gray-11 text-sm">` label over a control -- the
    /// `flex flex-col gap-2` pair the caption and keyboard tabs stack every
    /// row in.
    fn labelled(&self, label: &'static str, control: AnyElement) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(14.))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .child(label),
            )
            .child(control)
            .into_any_element()
    }

    /// The same pair at `text-xs`, which is what the segment panels and the
    /// text tab use.
    pub(crate) fn labelled_small(&self, label: &'static str, control: AnyElement) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .child(label),
            )
            .child(control)
            .into_any_element()
    }

    pub(crate) fn menu_select(
        &self,
        kind: SidebarMenu,
        id: &'static str,
        label: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        ui::Select::plain(&self.theme, id, label)
            .stretch_label()
            .on_open(
                cx.listener(move |this, bounds: &Bounds<Pixels>, window, cx| {
                    this.open_sidebar_menu(kind, *bounds, window, cx);
                }),
            )
            .into_any_element()
    }

    /// The same, for a trigger whose element id has to carry a segment index
    /// so two panels' selects cannot collide.
    pub(crate) fn menu_select_owned(
        &self,
        kind: SidebarMenu,
        id: SharedString,
        label: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        ui::Select::plain(&self.theme, id, label)
            .stretch_label()
            .on_open(
                cx.listener(move |this, bounds: &Bounds<Pixels>, window, cx| {
                    this.open_sidebar_menu(kind, *bounds, window, cx);
                }),
            )
            .into_any_element()
    }

    // -- Camera --------------------------------------------------------------

    /// `CameraConfig` (`ConfigSidebar.tsx:2978-3330`).
    pub(crate) fn render_camera_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let camera = &self.project.camera;
        let manual = camera.manual_position;

        let shape_label = CAMERA_SHAPES
            .iter()
            .find(|(shape, _)| {
                std::mem::discriminant(shape) == std::mem::discriminant(&camera.shape)
            })
            .map_or("Square", |(_, label)| *label);
        let blur_label = CAMERA_BLUR_MODES
            .iter()
            .find(|(mode, _)| *mode == camera.background_blur.mode)
            .map_or("Off", |(_, label)| *label);
        let corner_label = CORNER_STYLES
            .iter()
            .find(|(style, _)| *style == camera.rounding_type)
            .map_or("Squircle", |(_, label)| *label);

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "Camera")
                    .icon("icons/camera.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            .child(self.render_camera_position(cx))
                            .child(ui::Subfield::plain(&theme, "Hide Camera").child(
                                ui::Toggle::plain(&theme, "camera-hide", camera.hide).on_click(
                                    cx.listener(|this, _, window, cx| {
                                        let next = !this.project.camera.hide;
                                        this.edit_project("camera-hide", window, cx, move |p| {
                                            p.camera.hide = next;
                                            true
                                        });
                                    }),
                                ),
                            ))
                            .child(ui::Subfield::plain(&theme, "Mirror Camera").child(
                                ui::Toggle::plain(&theme, "camera-mirror", camera.mirror).on_click(
                                    cx.listener(|this, _, window, cx| {
                                        let next = !this.project.camera.mirror;
                                        this.edit_project("camera-mirror", window, cx, move |p| {
                                            p.camera.mirror = next;
                                            true
                                        });
                                    }),
                                ),
                            ))
                            .child(ui::Subfield::plain(&theme, "Background Blur").child(
                                div().w(px(160.)).child(self.menu_select(
                                    SidebarMenu::CameraBlur,
                                    "camera-blur",
                                    blur_label,
                                    cx,
                                )),
                            ))
                            .child(ui::Subfield::plain(&theme, "Shape").child(
                                div().w(px(160.)).child(self.menu_select(
                                    SidebarMenu::CameraShape,
                                    "camera-shape",
                                    shape_label,
                                    cx,
                                )),
                            )),
                    ),
            )
            // `<div class="w-full border-t border-dashed border-gray-5" />`
            .child(dashed_divider(Hsla::from(theme.gray_5)))
            .child(
                ui::Field::plain(&theme, "Size")
                    .icon("icons/enlarge.svg")
                    .child(self.slider(SliderKey::Camera(CameraSlider::Size), "%", cx)),
            )
            .child(
                ui::Field::plain(&theme, "Size During Zoom")
                    .icon("icons/enlarge.svg")
                    .child(self.slider(SliderKey::Camera(CameraSlider::ZoomSize), "%", cx)),
            )
            .child(
                ui::Subfield::plain(&theme, "Keep original size during zoom").child(
                    ui::Toggle::plain(&theme, "camera-keep-size", camera.scale_during_zoom >= 1.)
                        .on_click(cx.listener(|this, _, window, cx| {
                            // `keep ? 1 : DEFAULT_CAMERA_SCALE_DURING_ZOOM`.
                            let keep = this.project.camera.scale_during_zoom >= 1.;
                            let next = if keep {
                                DEFAULT_CAMERA_SCALE_DURING_ZOOM
                            } else {
                                1.
                            };
                            this.edit_project("camera-scale-zoom", window, cx, move |p| {
                                p.camera.scale_during_zoom = next;
                                true
                            });
                        })),
                ),
            )
            .child(
                ui::Field::plain(&theme, "Rounded Corners")
                    .icon("icons/corners.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.slider(SliderKey::Camera(CameraSlider::Rounding), "%", cx))
                            .child(self.corner_style_select(
                                SidebarMenu::CameraCornerStyle,
                                "camera-corner-style",
                                corner_label,
                                cx,
                            )),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Shadow")
                    .icon("icons/shadow.svg")
                    .child(self.slider(SliderKey::Camera(CameraSlider::Shadow), "%", cx))
                    .child(self.render_camera_shadow_settings(cx)),
            )
            // `<ColorCorrectionSection target="camera" />` (`:3324`).
            .child(self.render_color_correction(GradeTarget::Camera, cx))
            .children(manual.map(|_| {
                // The custom-position reset row, shown only once the camera has
                // been dragged on the canvas (`:3054-3066`).
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child("Custom position (dragged on canvas)"),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "camera-position-reset")
                            .label("Reset")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.edit_project("camera-manual-position", window, cx, |p| {
                                    p.camera.manual_position = None;
                                    true
                                });
                            })),
                    )
                    .into_any_element()
            }))
            .into_any_element()
    }

    /// `CornerStyleSelect` (`:3331-3396`): a `text-[0.65rem] uppercase` label
    /// over the trigger.
    fn corner_style_select(
        &self,
        kind: SidebarMenu,
        id: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(10.4))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .child("CORNER STYLE"),
            )
            .child(self.menu_select(kind, id, label, cx))
            .into_any_element()
    }

    /// The six-dot position grid (`:2996-3053`): a `h-30` card with a dot
    /// pinned into each corner and the two centres.
    fn render_camera_position(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let camera = &self.project.camera;
        // A camera dragged on the canvas has a manual position and none of the
        // six dots match (`:2982-2987`).
        let selected = camera.manual_position.is_none();
        let (x, y) = (&camera.position.x, &camera.position.y);

        let dots = [(0usize, 0usize), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)];
        let x_index = match x {
            CameraXPosition::Left => 0usize,
            CameraXPosition::Center => 1,
            CameraXPosition::Right => 2,
        };
        let y_index = match y {
            CameraYPosition::Top => 0usize,
            CameraYPosition::Bottom => 1,
        };

        let mut grid = div()
            .relative()
            .mt(px(12.))
            .w_full()
            // `h-30`
            .h(px(120.))
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_2));

        for (item_x, item_y) in dots {
            let checked = selected && x_index == item_x && y_index == item_y;
            let mut dot = div()
                .id(SharedString::from(format!(
                    "camera-position-{item_x}-{item_y}"
                )))
                .absolute()
                // `size-6 rounded-md`, `bg-blue-9` selected, `bg-gray-5` not.
                .size(px(24.))
                .flex_none()
                .rounded(px(6.))
                .flex()
                .justify_center()
                .items_center()
                .bg(if checked {
                    Hsla::from(theme.blue_9)
                } else {
                    Hsla::from(theme.gray_5)
                })
                // `size-2 bg-solid-white rounded-full`
                .child(div().size(px(8.)).rounded_full().bg(gpui::white()));

            dot = match item_x {
                0 => dot.left(px(8.)),
                2 => dot.right(px(8.)),
                _ => dot.left(gpui::relative(0.5)).ml(px(-12.)),
            };
            dot = if item_y == 0 {
                dot.top(px(8.))
            } else {
                dot.bottom(px(8.))
            };

            grid = grid.child(dot.on_click(cx.listener(move |this, _, window, cx| {
                this.edit_project("camera-position", window, cx, move |project| {
                    project.camera.position = cap_project::CameraPosition {
                        x: match item_x {
                            0 => CameraXPosition::Left,
                            2 => CameraXPosition::Right,
                            _ => CameraXPosition::Center,
                        },
                        y: if item_y == 0 {
                            CameraYPosition::Top
                        } else {
                            CameraYPosition::Bottom
                        },
                    };
                    // The batch clears the manual override too (`:3011-3016`).
                    project.camera.manual_position = None;
                    true
                });
            })));
        }

        div()
            .flex()
            .flex_col()
            .child(ui::Subfield::plain(&theme, "Position"))
            .child(grid)
            .into_any_element()
    }

    /// `ShadowSettings` on the camera tab -- the same component the background
    /// tab's shadow field uses, against `camera.advancedShadow`.
    fn render_camera_shadow_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let open = self.sidebar.camera_shadow_open.is_open();

        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("camera-shadow-advanced")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_12))
                    .cursor_pointer()
                    .child(div().text_size(px(14.)).child("Advanced shadow settings"))
                    .child(
                        svg()
                            .path(if open {
                                "icons/chevron-down.svg"
                            } else {
                                "icons/chevron-right.svg"
                            })
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.sidebar.camera_shadow_open.toggle();
                        this.animate_collapsibles(window, cx);
                    })),
            )
            .child(collapsible(
                &self.sidebar.camera_shadow_open,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .mt(px(16.))
                    .child(ui::Field::plain(&theme, "Size").child(self.slider(
                        SliderKey::Camera(CameraSlider::ShadowSize),
                        "",
                        cx,
                    )))
                    .child(ui::Field::plain(&theme, "Opacity").child(self.slider(
                        SliderKey::Camera(CameraSlider::ShadowOpacity),
                        "",
                        cx,
                    )))
                    .child(ui::Field::plain(&theme, "Blur").child(self.slider(
                        SliderKey::Camera(CameraSlider::ShadowBlur),
                        "",
                        cx,
                    )))
                    .into_any_element(),
            ))
            .into_any_element()
    }

    // -- Audio ---------------------------------------------------------------

    /// The audio tab (`:942-1016`) and `SyncOffsetsConfig` (`:6081-6178`).
    pub(crate) fn render_audio_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let audio = &self.project.audio;
        let summary = self.summary();
        let muted = audio.mute;
        let has_microphone = summary.is_some_and(|summary| summary.has_microphone);
        let has_system_audio = summary.is_some_and(|summary| summary.has_system_audio);
        let stereo_mic = summary.is_some_and(|summary| summary.mic_channels == Some(2));
        let stereo_label = STEREO_MODES
            .iter()
            .find(|(mode, _)| *mode == audio.mic_stereo_mode)
            .map_or("Stereo", |(_, label)| *label);

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "Audio Controls")
                    .icon("icons/volume-2.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(16.))
                            .child(ui::Subfield::plain(&theme, "Mute Audio").child(
                                ui::Toggle::plain(&theme, "audio-mute", audio.mute).on_click(
                                    cx.listener(|this, _, window, cx| {
                                        let next = !this.project.audio.mute;
                                        this.edit_project("audio-mute", window, cx, move |p| {
                                            p.audio.mute = next;
                                            true
                                        });
                                    }),
                                ),
                            ))
                            // Only a two-channel microphone gets the stereo row
                            // (`:709-711`).
                            .children(stereo_mic.then(|| {
                                ui::Subfield::plain(&theme, "Microphone Stereo Mode")
                                    .child(div().w(px(160.)).child(self.menu_select(
                                        SidebarMenu::AudioStereo,
                                        "audio-stereo",
                                        stereo_label,
                                        cx,
                                    )))
                                    .into_any_element()
                            })),
                    ),
            )
            .children(has_microphone.then(|| {
                ui::Field::plain(&theme, "Microphone Volume")
                    .icon("icons/microphone.svg")
                    // `disabled={project.audio.mute}` (`:786`).
                    .child(self.slider_disabled(
                        SliderKey::Audio(AudioSlider::MicVolume),
                        "db",
                        muted,
                        cx,
                    ))
                    .into_any_element()
            }))
            .children(has_system_audio.then(|| {
                ui::Field::plain(&theme, "System Audio Volume")
                    .icon("icons/monitor-outline.svg")
                    // `disabled={project.audio.mute}` (`:804`).
                    .child(self.slider_disabled(
                        SliderKey::Audio(AudioSlider::SystemVolume),
                        "db",
                        muted,
                        cx,
                    ))
                    .into_any_element()
            }))
            .children(self.render_sync_offsets(cx))
            .into_any_element()
    }

    // -- Cursor --------------------------------------------------------------

    /// The cursor tab (`:820-1000`).
    pub(crate) fn render_cursor_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let cursor = &self.project.cursor;
        let hidden = cursor.hide;

        let mut body = div().flex().flex_col().gap(px(24.)).child(
            ui::Field::plain(&theme, "Show cursor").value(
                ui::Toggle::plain(&theme, "cursor-show", !hidden)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_project("cursor-hide", window, cx, move |p| {
                            p.cursor.hide = !hidden;
                            true
                        });
                    }))
                    .into_any_element(),
            ),
        );

        // `<Show when={!project.cursor.hide}>` -- everything else is behind it.
        if hidden {
            return body.into_any_element();
        }

        let style_index = CURSOR_STYLES
            .iter()
            .position(|(style, _, _)| *style == cursor.animation_style);
        let idle = cursor.hide_when_idle;

        body = body
            .child(
                ui::Field::plain(&theme, "Cursor Style")
                    .icon("icons/cursor.svg")
                    .child(self.render_cursor_style_picker(cx)),
            )
            .child(
                ui::Field::plain(&theme, "Size")
                    .icon("icons/enlarge.svg")
                    .child(self.slider(SliderKey::Cursor(CursorSlider::Size), "", cx)),
            )
            .child(
                ui::Field::plain(&theme, "Tilt")
                    .icon("icons/rotate-3d.svg")
                    .child(self.slider(SliderKey::Cursor(CursorSlider::Tilt), "x100%", cx)),
            )
            .child(self.render_cursor_ripple(cx))
            .child(
                ui::Field::plain(&theme, "Hide When Idle")
                    .icon("icons/timer.svg")
                    .value(
                        ui::Toggle::plain(&theme, "cursor-idle", idle)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_project("cursor-idle", window, cx, move |p| {
                                    p.cursor.hide_when_idle = !idle;
                                    true
                                });
                            }))
                            .into_any_element(),
                    ),
            );

        if idle {
            // `<Subfield name="Inactivity Delay" class="gap-4 items-center">`
            // with a `w-12 text-right` readout beside the slider (`:945-967`).
            let readout = format!("{:.1}s", cursor.hide_when_idle_delay);
            body = body.child(
                ui::Subfield::plain(&theme, "Inactivity Delay")
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(12.))
                            .items_center()
                            .child(self.slider_flex(
                                SliderKey::Cursor(CursorSlider::IdleDelay),
                                "s",
                                cx,
                            ))
                            .child(
                                div()
                                    .w(px(48.))
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child(readout),
                            ),
                    ),
            );
        }

        let smooth = !cursor.raw;
        let mut body = body
            .child(
                ui::Field::plain(&theme, "Cursor Movement Style")
                    .icon("icons/rabbit.svg")
                    .child(
                        ui::RadioCards::plain(
                            &theme,
                            "cursor-style",
                            CURSOR_STYLES
                                .iter()
                                .map(|(_, label, description)| {
                                    ui::RadioCard::new(*label, Some(description))
                                })
                                .collect(),
                            style_index,
                        )
                        .on_select(cx.listener(
                            |this, index: &usize, window, cx| {
                                let Some((style, _, _)) = CURSOR_STYLES.get(*index) else {
                                    return;
                                };
                                let style = *style;
                                // `applyCursorStylePreset` (`:551-561`): the style and
                                // its three physics values, in one batch.
                                this.edit_project("cursor-style", window, cx, move |project| {
                                    project.cursor.animation_style = style;
                                    if let Some(preset) = style.preset() {
                                        project.cursor.tension = preset.tension;
                                        project.cursor.mass = preset.mass;
                                        project.cursor.friction = preset.friction;
                                    }
                                    true
                                });
                            },
                        )),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        ui::Field::plain(&theme, "Smooth Movement")
                            .icon("icons/ease-curve.svg")
                            .value(
                                ui::Toggle::plain(&theme, "cursor-smooth", smooth)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.sidebar.cursor_physics_open.set_open(!smooth);
                                        this.animate_collapsibles(window, cx);
                                        this.edit_project("cursor-raw", window, cx, move |p| {
                                            p.cursor.raw = smooth;
                                            true
                                        });
                                    }))
                                    .into_any_element(),
                            ),
                    )
                    .child(collapsible(
                        &self.sidebar.cursor_physics_open,
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(16.))
                            // `pt-4 pb-6`
                            .pt(px(16.))
                            .pb(px(24.))
                            .child(ui::Field::plain(&theme, "Tension").child(self.slider(
                                SliderKey::Cursor(CursorSlider::Tension),
                                "",
                                cx,
                            )))
                            .child(ui::Field::plain(&theme, "Friction").child(self.slider(
                                SliderKey::Cursor(CursorSlider::Friction),
                                "",
                                cx,
                            )))
                            .child(ui::Field::plain(&theme, "Mass").child(self.slider(
                                SliderKey::Cursor(CursorSlider::Mass),
                                "",
                                cx,
                            )))
                            .into_any_element(),
                    )),
            );

        // An explicit family forces the SVG assets, so the toggle would be
        // showing a setting the renderer is already overriding.
        if cursor.cursor_type().family().is_none() {
            body = body.child(
                ui::Field::plain(&theme, "High Quality SVG Cursors")
                    .icon("icons/sparkles.svg")
                    .value(
                        ui::Toggle::plain(&theme, "cursor-svg", cursor.use_svg)
                            .on_click(cx.listener(|this, _, window, cx| {
                                let next = !this.project.cursor.use_svg;
                                this.edit_project("cursor-svg", window, cx, move |p| {
                                    p.cursor.use_svg = next;
                                    true
                                });
                            }))
                            .into_any_element(),
                    ),
            );
        }

        body.into_any_element()
    }

    // -- Keyboard ------------------------------------------------------------

    /// `KeyboardTab` (`KeyboardTab.tsx:128-553`).
    pub(crate) fn render_keyboard_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let settings = keyboard_settings(&self.project);
        let enabled = settings.enabled;
        let has_segments = self
            .project
            .timeline
            .as_ref()
            .is_some_and(|timeline| !timeline.keyboard_segments.is_empty());
        let font_label = settings.font.clone();
        let position_label = KEYBOARD_POSITIONS
            .iter()
            .find(|(value, _)| *value == settings.position)
            .map_or("Bottom Center", |(_, label)| *label);
        let weight_label = TEXT_WEIGHTS
            .iter()
            .find(|(weight, _)| *weight == settings.font_weight)
            .map_or("Normal", |(_, label)| *label);

        // `class={cx("space-y-4", !enabled && "opacity-50 pointer-events-none")}`
        let body = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .when(!enabled, |this| this.opacity(0.5))
            .child(
                ui::Field::plain(&theme, "Font Settings")
                    .icon("icons/keyboard.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled(
                                "Font Family",
                                self.menu_select(
                                    SidebarMenu::KeyboardFont,
                                    "keyboard-font",
                                    font_label,
                                    cx,
                                ),
                            ))
                            .child(
                                self.labelled(
                                    "Size",
                                    self.slider(SliderKey::Keyboard(KeyboardSlider::Size), "", cx)
                                        .into_any_element(),
                                ),
                            )
                            .child(self.labelled(
                                "Text Color",
                                self.render_hex_field(
                                    crate::editor_panels::FieldKey::KeyboardColor,
                                    &settings.color,
                                    cx,
                                ),
                            )),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Background Settings")
                    .icon("icons/keyboard.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled(
                                "Background Color",
                                self.render_hex_field(
                                    crate::editor_panels::FieldKey::KeyboardBackground,
                                    &settings.background_color,
                                    cx,
                                ),
                            ))
                            .child(
                                self.labelled(
                                    "Background Opacity",
                                    self.slider(
                                        SliderKey::Keyboard(KeyboardSlider::BackgroundOpacity),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Position")
                    .icon("icons/keyboard.svg")
                    .child(self.menu_select(
                        SidebarMenu::KeyboardPosition,
                        "keyboard-position",
                        position_label,
                        cx,
                    )),
            )
            .child(
                ui::Field::plain(&theme, "Font Weight")
                    .icon("icons/keyboard.svg")
                    .child(self.menu_select(
                        SidebarMenu::KeyboardWeight,
                        "keyboard-weight",
                        weight_label,
                        cx,
                    )),
            )
            .child(
                ui::Field::plain(&theme, "Animation")
                    .icon("icons/keyboard.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled_readout(
                                "Fade Duration",
                                SliderKey::Keyboard(KeyboardSlider::FadeDuration),
                                format!("{:.0}ms", settings.fade_duration * 1000.),
                                cx,
                            ))
                            .child(self.labelled_readout(
                                "Linger Duration",
                                SliderKey::Keyboard(KeyboardSlider::LingerDuration),
                                format!("{:.1}s", settings.linger_duration),
                                cx,
                            ))
                            .child(self.labelled_readout(
                                "Grouping Threshold",
                                SliderKey::Keyboard(KeyboardSlider::GroupingThreshold),
                                format!("{:.0}ms", settings.grouping_threshold_ms),
                                cx,
                            )),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Behavior")
                    .icon("icons/keyboard.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                ui::Subfield::plain(&theme, "Show Modifiers").child(
                                    ui::Toggle::plain(
                                        &theme,
                                        "keyboard-modifiers",
                                        settings.show_modifiers,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            let next =
                                                !keyboard_settings(&this.project).show_modifiers;
                                            this.set_keyboard_setting(
                                                "keyboard-modifiers",
                                                window,
                                                cx,
                                                move |settings| settings.show_modifiers = next,
                                            );
                                        },
                                    )),
                                ),
                            )
                            .child(
                                ui::Subfield::plain(&theme, "Show Special Keys").child(
                                    ui::Toggle::plain(
                                        &theme,
                                        "keyboard-special",
                                        settings.show_special_keys,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            let next =
                                                !keyboard_settings(&this.project).show_special_keys;
                                            this.set_keyboard_setting(
                                                "keyboard-special",
                                                window,
                                                cx,
                                                move |settings| settings.show_special_keys = next,
                                            );
                                        },
                                    )),
                                ),
                            )
                            .child(
                                ui::Subfield::plain(&theme, "Uppercase").child(
                                    ui::Toggle::plain(
                                        &theme,
                                        "keyboard-uppercase",
                                        settings.uppercase,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            let next = !keyboard_settings(&this.project).uppercase;
                                            this.set_keyboard_setting(
                                                "keyboard-uppercase",
                                                window,
                                                cx,
                                                move |settings| settings.uppercase = next,
                                            );
                                        },
                                    )),
                                ),
                            ),
                    ),
            )
            // `Generate Keyboard Segments` -- `commands.generateKeyboardSegments`
            // reads the recording's own key log through a Tauri command this
            // app does not have, so the button renders and says so.
            .child(
                div().pt(px(8.)).child(
                    ui::Button::plain(
                        &theme,
                        "keyboard-generate",
                        ui::ButtonVariant::Primary,
                        ui::ButtonSize::Md,
                    )
                    .label(if has_segments {
                        "Regenerate Keyboard Segments"
                    } else {
                        "Generate Keyboard Segments"
                    })
                    .full_width()
                    .disabled(true),
                ),
            )
            .children((!has_segments).then(|| {
                div()
                    .py(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .items_center()
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child("No keyboard segments yet."),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(
                                "Click \"Generate Keyboard Segments\" to create segments from \
                                 recorded keyboard presses.",
                            ),
                    )
                    .into_any_element()
            }));

        // The whole tab is one `Field` with the master toggle in its header and
        // a `Beta` badge (`KeyboardTab.tsx:128-135`).
        ui::Field::plain(&theme, "Show keyboard")
            .badge("Beta")
            .value(
                ui::Toggle::plain(&theme, "keyboard-enabled", enabled)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        let next = !enabled;
                        this.tracks.keyboard = next;
                        this.edit_project("keyboard-enabled", window, cx, move |project| {
                            let keyboard =
                                project.keyboard.get_or_insert_with(KeyboardData::default);
                            keyboard.settings.enabled = next;
                            true
                        });
                        if !next
                            && this.selection.as_ref().is_some_and(|s| {
                                s.track == crate::editor_timeline::TrackKind::Keyboard
                            })
                        {
                            this.set_selection(None, cx);
                        }
                    }))
                    .into_any_element(),
            )
            .child(body)
            .into_any_element()
    }

    /// A slider with a `text-xs text-right` readout underneath -- the shape the
    /// keyboard and caption tabs use for every duration.
    fn labelled_readout(
        &self,
        label: &'static str,
        slider: SliderKey,
        readout: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(14.))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .child(label),
            )
            .child(self.slider(slider, "", cx))
            .child(
                div()
                    .w_full()
                    .text_size(px(12.))
                    .text_color(Hsla::from(self.theme.gray_11))
                    .text_right()
                    .child(readout),
            )
            .into_any_element()
    }

    // -- Captions ------------------------------------------------------------

    /// `CaptionsTab` (`CaptionsTab.tsx:765-1561`).
    pub(crate) fn render_captions_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let settings = caption_settings(&self.project);
        let has_captions = self
            .project
            .timeline
            .as_ref()
            .is_some_and(|timeline| !timeline.caption_segments.is_empty())
            || self
                .project
                .captions
                .as_ref()
                .is_some_and(|captions| !captions.segments.is_empty());

        self.ensure_captions_init(cx);
        let snapshot = transcription::ui_snapshot(&self.project_path);
        let models = available_caption_models();
        let model = self.selected_caption_model();

        let language_label = CAPTION_LANGUAGES
            .iter()
            .find(|(code, _)| *code == self.sidebar.caption_language)
            .map_or("Auto Detect", |(_, label)| *label);
        let font_label = settings.font.clone();
        let position_label = CAPTION_POSITIONS
            .iter()
            .find(|(value, _)| *value == settings.position)
            .map_or("Bottom Center", |(_, label)| *label);
        let animation_label = CAPTION_ANIMATIONS
            .iter()
            .find(|(value, _)| *value == settings.animation)
            .map_or("Bounce", |(_, label)| *label);
        let highlight_label = CAPTION_HIGHLIGHT_STYLES
            .iter()
            .find(|(value, _)| *value == settings.highlight_style)
            .map_or("Color", |(_, label)| *label);
        let weight_label = TEXT_WEIGHTS
            .iter()
            .find(|(weight, _)| *weight == settings.font_weight)
            .map_or("Bold", |(_, label)| *label);

        let model_downloaded = snapshot.downloaded.contains(model.name);
        let active_download = snapshot
            .download
            .as_ref()
            .filter(|download| download.state == transcription::DownloadState::Downloading);
        let is_downloading = active_download.is_some();
        let download_percent = active_download.map_or(0_u32, |download| {
            download.progress.clamp(0.0, 100.0).round() as u32
        });
        let downloading_label = active_download
            .and_then(|download| models.iter().find(|entry| entry.name == download.model))
            .map_or(model.label, |entry| entry.label);
        let download_message = active_download
            .map(|download| download.message.clone())
            .filter(|message| !message.is_empty());
        let download_failure = snapshot
            .download
            .as_ref()
            .filter(|download| {
                download.state == transcription::DownloadState::Failed
                    && download.model == model.name
            })
            .map(|download| download.message.clone());
        let deleting = snapshot.deleting.as_deref() == Some(model.name);
        let any_deleting = snapshot.deleting.is_some();
        let generating = snapshot.generating;
        // `hasAudio` (`CaptionsTab.tsx:600-605`).
        let has_audio = self
            .summary()
            .is_some_and(|summary| summary.has_microphone || summary.has_system_audio);
        let error_color = Hsla::from(gpui::rgb(0xef4444));

        // The `KSelect.Trigger` with label, description and size
        // (`CaptionsTab.tsx:824-860`); the info tooltip carries the engine
        // identity the source puts behind the ⓘ button.
        let model_trigger = div()
            .id("caption-model")
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(8.))
            .rounded(px(8.))
            .bg(self.panel_bg())
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .truncate()
                            .child(model.label),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .truncate()
                            .child(model.description),
                    ),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(10.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(model.size),
            )
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_11)),
            )
            .tooltip({
                let model_name = SharedString::new_static(model.model_name);
                move |_window, cx| ui::Tooltip::new(&theme, model_name.clone()).view(cx)
            });
        let model_trigger = ui::Menu::trigger(
            model_trigger,
            cx.listener(|this, bounds: &Bounds<Pixels>, window, cx| {
                this.open_sidebar_menu(SidebarMenu::CaptionModel, *bounds, window, cx);
            }),
        );

        // The download / generate column (`CaptionsTab.tsx:936-1032`).
        let action = if model_downloaded {
            let mut column = div().flex().flex_col().gap(px(8.));
            if has_audio {
                column = column.child(
                    ui::Button::plain(
                        &theme,
                        "caption-generate",
                        ui::ButtonVariant::Primary,
                        ui::ButtonSize::Md,
                    )
                    .label(if generating {
                        "Generating..."
                    } else if has_captions {
                        "Regenerate Captions"
                    } else {
                        "Generate Captions"
                    })
                    .full_width()
                    .disabled(generating || any_deleting)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.generate_captions_clicked(window, cx);
                    })),
                );
            }
            column = column.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .min_w_0()
                            .child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .text_color(Hsla::from(theme.gray_9)),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .truncate()
                                    .child(SharedString::from(format!(
                                        "{} model downloaded",
                                        model.label
                                    ))),
                            ),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "caption-delete",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .icon("icons/trash.svg")
                        .label(if deleting { "Deleting..." } else { "Delete" })
                        .disabled(generating || is_downloading || deleting)
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.delete_caption_model(cx);
                        })),
                    ),
            );
            if let Some(error) = snapshot.generation_error.clone() {
                column = column.child(
                    div()
                        .text_size(px(12.))
                        .text_color(error_color)
                        .child(error),
                );
            }
            column
        } else {
            let download_button = ui::Button::plain(
                &theme,
                "caption-download",
                ui::ButtonVariant::Primary,
                ui::ButtonSize::Md,
            )
            .full_width()
            .disabled(is_downloading)
            .on_click(cx.listener(|this, _, _window, cx| {
                this.start_caption_model_download(cx);
            }));
            let download_button = if is_downloading {
                download_button.label(format!(
                    "Downloading {downloading_label}... {download_percent}%"
                ))
            } else {
                download_button
                    .icon("icons/download.svg")
                    .label(format!("Download {} Model", model.label))
            };

            let mut column = div().flex().flex_col().gap(px(8.)).child(download_button);
            if is_downloading {
                column = column
                    .child(
                        div()
                            .w_full()
                            .h(px(6.))
                            .rounded_full()
                            .overflow_hidden()
                            .bg(Hsla::from(theme.gray_3))
                            .child(
                                div()
                                    .h_full()
                                    .rounded_full()
                                    .bg(Hsla::from(theme.blue_9))
                                    .w(relative(download_percent as f32 / 100.)),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(download_message.unwrap_or_else(|| {
                                "Keep Cap open while the model downloads. Editor reloads will \
                                 reconnect automatically."
                                    .to_string()
                            })),
                    );
            }
            if let Some(failure) = download_failure {
                column = column.child(
                    div()
                        .text_size(px(12.))
                        .text_color(error_color)
                        .child(failure),
                );
            }
            column
        };

        let transcription = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Subfield::plain(&theme, "Model").child(div().w(px(220.)).child(model_trigger)),
            )
            .children((!transcription::supports_parakeet()).then(|| {
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(
                        "Parakeet caption models are unavailable on Intel Macs. Whisper models \
                         remain available.",
                    )
            }))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("One time download to your system. All captions are stored locally."),
            )
            .child(
                ui::Subfield::plain(&theme, "Language").child(div().w(px(200.)).child(
                    self.menu_select(
                        SidebarMenu::CaptionLanguage,
                        "caption-language",
                        language_label,
                        cx,
                    ),
                )),
            )
            .child(div().pt(px(8.)).child(action));

        let style = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .when(!has_captions, |this| this.opacity(0.5))
            .child(
                ui::Field::plain(&theme, "Style")
                    .icon("icons/message-bubble.svg")
                    .child(self.render_caption_presets(&settings, cx)),
            )
            .child(
                ui::Field::plain(&theme, "Font Settings")
                    .icon("icons/message-bubble.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled(
                                "Font Family",
                                self.menu_select(
                                    SidebarMenu::CaptionFont,
                                    "caption-font",
                                    font_label,
                                    cx,
                                ),
                            ))
                            .child(
                                self.labelled(
                                    "Size",
                                    self.slider(SliderKey::Caption(CaptionSlider::Size), "", cx)
                                        .into_any_element(),
                                ),
                            )
                            .child(
                                ui::Subfield::plain(&theme, "Uppercase").child(
                                    ui::Toggle::plain(
                                        &theme,
                                        "caption-uppercase",
                                        settings.uppercase,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            let next = !caption_settings(&this.project).uppercase;
                                            this.set_caption_setting(
                                                "caption-uppercase",
                                                window,
                                                cx,
                                                move |settings| settings.uppercase = next,
                                            );
                                        },
                                    )),
                                ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        ui::Subfield::plain(&theme, "Active Word Highlight").child(
                                            ui::Toggle::plain(
                                                &theme,
                                                "caption-active-word",
                                                settings.active_word_highlight,
                                            )
                                            .on_click(
                                                cx.listener(|this, _, window, cx| {
                                                    let next = !caption_settings(&this.project)
                                                        .active_word_highlight;
                                                    this.set_caption_setting(
                                                        "caption-active-word",
                                                        window,
                                                        cx,
                                                        move |settings| {
                                                            settings.active_word_highlight = next
                                                        },
                                                    );
                                                }),
                                            ),
                                        ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(Hsla::from(theme.gray_10))
                                            .child(
                                                "This is the first version of captions in Cap. \
                                                 Active word highlighting may be inaccurate in \
                                                 some situations. We're working on a fix for this \
                                                 and it will be released in upcoming versions.",
                                            ),
                                    ),
                            )
                            .children(settings.active_word_highlight.then(|| {
                                self.labelled(
                                    "Highlight Style",
                                    self.menu_select(
                                        SidebarMenu::CaptionHighlightStyle,
                                        "caption-highlight-style",
                                        highlight_label,
                                        cx,
                                    ),
                                )
                            }))
                            .child(self.labelled(
                                "Text Color",
                                self.render_hex_field(
                                    crate::editor_panels::FieldKey::CaptionColor,
                                    &settings.color,
                                    cx,
                                ),
                            )),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Background Settings")
                    .icon("icons/message-bubble.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled(
                                "Background Color",
                                self.render_hex_field(
                                    crate::editor_panels::FieldKey::CaptionBackground,
                                    &settings.background_color,
                                    cx,
                                ),
                            ))
                            .child(
                                self.labelled(
                                    "Background Opacity",
                                    self.slider(
                                        SliderKey::Caption(CaptionSlider::BackgroundOpacity),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Position")
                    .icon("icons/message-bubble.svg")
                    .child(self.menu_select(
                        SidebarMenu::CaptionPosition,
                        "caption-position",
                        position_label,
                        cx,
                    )),
            )
            .child(
                ui::Field::plain(&theme, "Animation")
                    .icon("icons/message-bubble.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.labelled(
                                "Animation Style",
                                self.menu_select(
                                    SidebarMenu::CaptionAnimation,
                                    "caption-animation",
                                    animation_label,
                                    cx,
                                ),
                            ))
                            .child(self.labelled(
                                "Highlight Color",
                                self.render_hex_field(
                                    crate::editor_panels::FieldKey::CaptionHighlight,
                                    &settings.highlight_color,
                                    cx,
                                ),
                            ))
                            .child(self.labelled_readout(
                                "Fade Duration",
                                SliderKey::Caption(CaptionSlider::FadeDuration),
                                format!("{:.0}ms", settings.fade_duration * 1000.),
                                cx,
                            )),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Font Weight")
                    .icon("icons/message-bubble.svg")
                    .child(self.menu_select(
                        SidebarMenu::CaptionWeight,
                        "caption-weight",
                        weight_label,
                        cx,
                    )),
            )
            .child(
                ui::Field::plain(&theme, "Export Options")
                    .icon("icons/message-bubble.svg")
                    .child(
                        ui::Subfield::plain(&theme, "Export with Subtitles").child(
                            ui::Toggle::plain(
                                &theme,
                                "caption-export",
                                settings.export_with_subtitles,
                            )
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    let next =
                                        !caption_settings(&this.project).export_with_subtitles;
                                    this.set_caption_setting(
                                        "caption-export",
                                        window,
                                        cx,
                                        move |settings| settings.export_with_subtitles = next,
                                    );
                                },
                            )),
                        ),
                    ),
            );

        // An extra flex ancestor here repeats intrinsic layout while scrolling.
        ui::Field::plain(&theme, "Captions")
            .icon("icons/message-bubble.svg")
            .badge("Beta")
            .child(transcription)
            .child(style.mt(px(8.)))
            .into_any_element()
    }

    /// The five style presets (`CaptionsTab.tsx:1041-1075`), each previewing
    /// "Make it pop" in its own style with the third word emphasised.
    fn render_caption_presets(
        &self,
        settings: &CaptionSettings,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let active = settings.preset.clone();

        div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(8.))
            .children(CAPTION_PRESETS.iter().enumerate().map(|(index, preset)| {
                let selected = active == preset.id;
                div()
                    .id(SharedString::from(format!("caption-preset-{}", preset.id)))
                    // Two across the 382px column with `gap-2`.
                    .w(px(187.))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .p(px(6.))
                    .rounded(px(8.))
                    .bg(self.panel_bg())
                    .border_1()
                    .border_color(if selected {
                        Hsla::from(theme.blue_9)
                    } else {
                        Hsla::from(theme.gray_3)
                    })
                    // `ring-1 ring-blue-9`, painted behind an opaque card.
                    .when(selected, |this| {
                        this.shadow(vec![gpui::BoxShadow {
                            color: Hsla::from(theme.blue_9),
                            offset: gpui::point(px(0.), px(0.)),
                            blur_radius: px(0.),
                            spread_radius: px(1.),
                            inset: false,
                        }])
                    })
                    .child(self.caption_preset_preview(preset))
                    .child(
                        div()
                            .px(px(2.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child(preset.label),
                    )
                    .tooltip({
                        let description = SharedString::from(preset.description);
                        move |_window, cx| ui::Tooltip::new(&theme, description.clone()).view(cx)
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.apply_caption_preset(index, window, cx);
                    }))
            }))
            .into_any_element()
    }

    /// `CaptionPresetPreview` (`CaptionsTab.tsx:182-238`).
    fn caption_preset_preview(&self, preset: &CaptionPreset) -> AnyElement {
        let words = ["Make", "it", "pop"];
        let color = crate::editor_sidebar::hex_to_rgb(preset.color)
            .map(|rgba| gpui::rgba(u32::from_be_bytes(rgba)))
            .unwrap_or_else(|| gpui::rgba(0xffffffff));
        let highlight = crate::editor_sidebar::hex_to_rgb(preset.highlight_color)
            .map(|rgba| gpui::rgba(u32::from_be_bytes(rgba)))
            .unwrap_or_else(|| gpui::rgba(0xffffffff));
        let background = crate::editor_sidebar::hex_to_rgb(preset.background_color)
            .map(|rgba| {
                let mut colour = Hsla::from(gpui::rgba(u32::from_be_bytes(rgba)));
                colour.a = preset.background_opacity as f32 / 100.;
                colour
            })
            .unwrap_or_else(gpui::transparent_black);

        div()
            .h(px(48.))
            .w_full()
            .rounded(px(6.))
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_center()
            // `background: linear-gradient(135deg, #4b4f57, #232427)`
            .bg(gpui::linear_gradient(
                135.,
                gpui::linear_color_stop(gpui::rgb(0x4b4f57), 0.),
                gpui::linear_color_stop(gpui::rgb(0x232427), 1.),
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(4.))
                    .px(px(8.))
                    .py(px(4.))
                    .bg(background)
                    .children(words.into_iter().enumerate().map(|(index, word)| {
                        let emphasised = preset.active_word_highlight && index == 2;
                        let pill = emphasised && preset.highlight_style == "pill";
                        let coloured = emphasised && preset.highlight_style == "color";
                        let text = if preset.uppercase {
                            word.to_uppercase()
                        } else {
                            word.to_string()
                        };
                        div()
                            .text_size(px(11.))
                            .font_weight(FontWeight(preset.font_weight as f32))
                            .text_color(if coloured {
                                Hsla::from(highlight)
                            } else {
                                Hsla::from(color)
                            })
                            .when(pill, |this| {
                                this.bg(Hsla::from(highlight)).rounded(px(4.)).px(px(4.))
                            })
                            .child(text)
                    })),
            )
            .into_any_element()
    }

    fn apply_caption_preset(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(preset) = CAPTION_PRESETS.get(index) else {
            return;
        };
        self.edit_project("caption-preset", window, cx, move |project| {
            // Unlike the keyboard tab, the source's caption setters bail when
            // there is no captions block. `applyCaptionPreset` goes through the
            // same setter, so it does too.
            let Some(captions) = project.captions.as_mut() else {
                return false;
            };
            let settings = &mut captions.settings;
            settings.preset = preset.id.to_string();
            settings.font_weight = preset.font_weight;
            settings.size = preset.size;
            settings.color = preset.color.to_string();
            settings.background_color = preset.background_color.to_string();
            settings.background_opacity = preset.background_opacity;
            settings.outline = preset.outline;
            settings.outline_color = preset.outline_color.to_string();
            settings.highlight_color = preset.highlight_color.to_string();
            settings.active_word_highlight = preset.active_word_highlight;
            settings.highlight_style = preset.highlight_style.to_string();
            settings.animation = preset.animation.to_string();
            settings.uppercase = preset.uppercase;
            settings.fade_duration = preset.fade_duration;
            true
        });
    }

    // -- Transcription glue ---------------------------------------------------

    /// `resolveCaptionModel` (`captions.ts:58-68`): the selected name if this
    /// platform offers it, otherwise the platform default -- the first
    /// available entry, which is `best` everywhere and `small` on Intel macOS.
    pub(crate) fn selected_caption_model(&self) -> &'static CaptionModel {
        let models = available_caption_models();
        models
            .iter()
            .find(|model| model.name == self.sidebar.caption_model)
            .unwrap_or(&models[0])
    }

    /// The Captions tab's `onMount` (`CaptionsTab.tsx:557-615`): scan the
    /// model folder, restore the persisted model/language selection, and --
    /// when a download started by an earlier editor window is still streaming
    /// -- reattach the progress poller. Deferred out of render because it
    /// mutates the sidebar state, and keyed by entity so it runs once per
    /// window.
    fn ensure_captions_init(&self, cx: &mut Context<Self>) {
        static INITIALISED: LazyLock<Mutex<HashSet<EntityId>>> =
            LazyLock::new(|| Mutex::new(HashSet::new()));
        if !INITIALISED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(cx.entity().entity_id())
        {
            return;
        }

        let entity = cx.entity();
        cx.defer(move |cx: &mut gpui::App| {
            entity.update(cx, |this, cx| {
                transcription::refresh_downloaded_models();

                let section = store::store_section(transcription::GPUI_STORE_SECTION);
                if let Some(saved) = section
                    .get(transcription::SELECTED_MODEL_KEY)
                    .and_then(Value::as_str)
                    && let Some(saved_model) = available_caption_models()
                        .iter()
                        .find(|model| model.name == saved)
                {
                    this.sidebar.caption_model = saved_model.name;
                }
                if let Some(saved) = section
                    .get(transcription::SELECTED_LANGUAGE_KEY)
                    .and_then(Value::as_str)
                    && let Some((code, _)) =
                        CAPTION_LANGUAGES.iter().find(|(code, _)| *code == saved)
                {
                    this.sidebar.caption_language = code;
                }

                if transcription::download_active() {
                    this.spawn_caption_download_poll(cx);
                }
                cx.notify();
            });
        });
    }

    /// Repaints the tab while a download streams -- the stand-in for Tauri's
    /// `DownloadProgress` events plus the 1s status poll
    /// (`CaptionsTab.tsx:550-555`); the hub already carries the numbers.
    fn spawn_caption_download_poll(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(150))
                    .await;
                let active = transcription::download_active();
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
                if !active {
                    break;
                }
            }
        })
        .detach();
    }

    /// `downloadModel` (`CaptionsTab.tsx:643-690`). The download runs on the
    /// tokio runtime and survives this window; the poll task repaints.
    fn start_caption_model_download(&mut self, cx: &mut Context<Self>) {
        let model = self.selected_caption_model().name;
        if !transcription::begin_download(model) {
            return;
        }
        gpui_tokio::Tokio::spawn(cx, transcription::run_model_download(model.to_string())).detach();
        self.spawn_caption_download_poll(cx);
        cx.notify();
    }

    /// `deleteModel` (`CaptionsTab.tsx:692-713`).
    fn delete_caption_model(&mut self, cx: &mut Context<Self>) {
        let model = self.selected_caption_model().name;
        if !transcription::begin_delete(model) {
            return;
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .spawn(async move { transcription::run_model_delete(model) })
                .await;
            let _ = this.update(cx, |_, cx| cx.notify());
        })
        .detach();
    }

    /// `generateCaptions` (`CaptionsTab.tsx:715-757`): transcribe on the
    /// tokio blocking pool, then apply the result through one `edit_project`
    /// write so a regenerate is a single undo entry.
    fn generate_captions_clicked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(summary) = self.summary() else {
            return;
        };
        let recording_durations = summary.clip_display_durations.clone();
        let recording_duration = summary.recording_duration;
        let project_path = self.project_path.clone();
        let model = self.selected_caption_model().name;
        let language = self.sidebar.caption_language;

        if !transcription::begin_generation(&project_path) {
            return;
        }
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let task_path = project_path.clone();
            let task = gpui_tokio::Tokio::spawn(cx, async move {
                tokio::task::spawn_blocking(move || {
                    transcription::transcribe_blocking(&task_path, model, language)
                })
                .await
                .map_err(|error| format!("Transcription task panicked: {error}"))?
            });
            let result = match task.await {
                Ok(result) => result,
                Err(error) => Err(format!("Transcription task failed: {error}")),
            };

            match result {
                Ok(segments) => {
                    transcription::finish_generation(&project_path, None);
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.apply_generated_captions(
                            segments,
                            &recording_durations,
                            recording_duration,
                            window,
                            cx,
                        );
                    });
                }
                Err(error) => {
                    tracing::error!("caption generation failed: {error}");
                    transcription::finish_generation(
                        &project_path,
                        Some(format!(
                            "Failed to generate captions: {}",
                            transcription::caption_generation_error_message(&error)
                        )),
                    );
                    let _ = this.update(cx, |_, cx| cx.notify());
                }
            }
        })
        .detach();
    }

    /// The success half of `generateCaptions` (`CaptionsTab.tsx:730-744`):
    /// `applyCaptionResultToProject` inside the project-write fan-out, then
    /// the caption track lane switched on.
    fn apply_generated_captions(
        &mut self,
        segments: Vec<CaptionSegment>,
        recording_durations: &[f64],
        recording_duration: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let recording_durations = recording_durations.to_vec();
        self.edit_project("caption-generate", window, cx, move |project| {
            transcription::apply_caption_result(
                project,
                segments,
                &recording_durations,
                recording_duration,
            );
            true
        });
        // `setEditorState("timeline", "tracks", "caption", true)`.
        self.tracks.caption = true;
        cx.notify();
    }

    // -- Sync offsets --------------------------------------------------------

    /// `SyncOffsetsConfig` (`:6081-6178`): per **recording** clip, not per
    /// timeline segment, which is why it lives with the audio settings rather
    /// than in a segment panel.
    fn render_sync_offsets(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = self.theme;
        let summary = self.summary()?;
        if !(summary.has_system_audio || summary.has_microphone || summary.has_camera) {
            return None;
        }
        let clips = summary.recording_clips.max(1);

        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(24.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.gray_12))
                                .child("Sync"),
                        )
                        .child(div().text_color(Hsla::from(theme.gray_11)).child(
                            "Fine-tune source offsets if audio or camera drifts out of \
                                     sync with the screen recording.",
                        )),
                )
                .children((0..clips).map(|clip| {
                    let auto = self
                        .project
                        .clips
                        .iter()
                        .find(|item| item.index as usize == clip)
                        .is_some_and(|item| item.offsets_auto_calculated);
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(24.))
                        .children((clips > 1).then(|| {
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.gray_12))
                                .child(SharedString::from(format!("Clip {clip}")))
                                .into_any_element()
                        }))
                        .children(auto.then(|| {
                            div()
                                .text_color(Hsla::from(theme.gray_11))
                                .child(
                                    "Cap calculated these offsets automatically to keep audio in \
                                     sync with the video. Adjust them if anything still sounds \
                                     off.",
                                )
                                .into_any_element()
                        }))
                        .children(summary.has_system_audio.then(|| {
                            self.render_offset_field(
                                clip,
                                OffsetKind::SystemAudio,
                                "System Audio Offset",
                                auto,
                                cx,
                            )
                        }))
                        .children(summary.has_microphone.then(|| {
                            self.render_offset_field(
                                clip,
                                OffsetKind::Mic,
                                "Microphone Offset",
                                auto,
                                cx,
                            )
                        }))
                        .children(summary.has_camera.then(|| {
                            self.render_offset_field(
                                clip,
                                OffsetKind::Camera,
                                "Camera Offset",
                                auto,
                                cx,
                            )
                        }))
                        .into_any_element()
                }))
                .into_any_element(),
        )
    }
}

/// Which of `ClipOffsets`' three a `SourceOffsetField` edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OffsetKind {
    SystemAudio,
    Mic,
    Camera,
}

impl OffsetKind {
    pub fn read(self, offsets: &cap_project::ClipOffsets) -> f32 {
        match self {
            Self::SystemAudio => offsets.system_audio,
            Self::Mic => offsets.mic,
            Self::Camera => offsets.camera,
        }
    }

    pub fn write(self, offsets: &mut cap_project::ClipOffsets, value: f32) {
        match self {
            Self::SystemAudio => offsets.system_audio = value,
            Self::Mic => offsets.mic = value,
            Self::Camera => offsets.camera = value,
        }
    }
}

/// The default caption block a project without one would need. Kept next to the
/// setters so the two stories -- "captions bail, keyboard creates" -- sit
/// together, and used by the test below that pins the asymmetry.
#[cfg(test)]
fn default_captions() -> CaptionsData {
    CaptionsData::default()
}

impl EditorWindow {
    /// `SourceOffsetField` (`ConfigSidebar.tsx:6179-6243`): a `NumberField`
    /// reading milliseconds, an `ms` label, and four nudge buttons.
    fn render_offset_field(
        &self,
        clip: usize,
        kind: OffsetKind,
        name: &'static str,
        auto: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let key = crate::editor_panels::FieldKey::SyncOffset(clip, kind);
        let current = self
            .project
            .clips
            .iter()
            .find(|item| item.index as usize == clip)
            .map_or(0., |item| f64::from(kind.read(&item.offsets)));

        let mut field = ui::Field::plain(&theme, name);
        if auto {
            field = field.badge("Auto-synced");
        }

        field
            .child(
                // `flex flex-row justify-between items-center -mt-2 w-full`
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .mt(px(-8.))
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .gap(px(4.))
                            .child(self.render_number_field(key, "ms", 80.)),
                    )
                    .child(div().flex().flex_row().gap(px(4.)).children(
                        [-100_i32, -10, 10, 100].map(|delta| {
                            div()
                                .id(SharedString::from(format!(
                                    "offset-{clip}-{kind:?}-{delta}"
                                )))
                                .px(px(4.))
                                .py(px(2.))
                                .rounded(px(2.))
                                .border_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .bg(Hsla::from(theme.gray_1))
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.gray_11))
                                .child(SharedString::from(format!(
                                    "{}{}ms",
                                    if delta > 0 { "+" } else { "-" },
                                    delta.abs()
                                )))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    // `rawValue() + v`, in milliseconds.
                                    let next = (current * 1000.).round() + f64::from(delta);
                                    this.set_clip_offset(clip, kind, next, window, cx);
                                }))
                        }),
                    )),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tab_slider_has_the_range_its_call_site_declares() {
        assert_eq!(CameraSlider::Size.limits(), (20., 80., 0.1));
        assert_eq!(CameraSlider::ZoomSize.limits(), (10., 60., 0.1));
        assert_eq!(CameraSlider::ShadowBlur.limits(), (0., 100., 0.1));
        assert_eq!(AudioSlider::MicVolume.limits(), (-30., 10., 0.1));
        assert_eq!(CursorSlider::Size.limits(), (20., 300., 1.));
        assert_eq!(CursorSlider::IdleDelay.limits(), (0.5, 5., 0.1));
        assert_eq!(CursorSlider::Mass.limits(), (0.1, 15., 0.01));
        assert_eq!(KeyboardSlider::LingerDuration.limits(), (0., 300., 5.));
        assert_eq!(
            KeyboardSlider::GroupingThreshold.limits(),
            (50., 1000., 10.)
        );
        assert_eq!(CaptionSlider::FadeDuration.limits(), (0., 50., 1.));
    }

    #[test]
    fn the_percent_sliders_read_and_write_the_same_number() {
        // `value={[getSetting("fadeDuration") * 100]}` / `v[0] / 100`.
        let mut project = ProjectConfiguration {
            keyboard: Some(KeyboardData::default()),
            ..Default::default()
        };
        project.keyboard.as_mut().unwrap().settings.fade_duration = 0.15;
        assert!((KeyboardSlider::FadeDuration.read(&project) - 15.).abs() < 1e-4);
        project.keyboard.as_mut().unwrap().settings.linger_duration = 0.8;
        assert!((KeyboardSlider::LingerDuration.read(&project) - 80.).abs() < 1e-4);
    }

    #[test]
    fn the_physics_sliders_fall_back_to_custom_off_a_preset() {
        // Mellow's preset is `{470, 3, 70}`.
        assert_eq!(
            match_cursor_preset(470., 3., 70.),
            Some(CursorAnimationStyle::Mellow)
        );
        assert_eq!(match_cursor_preset(471., 3., 70.), None);
        // Every named style in the picker has a preset behind it.
        for (style, ..) in CURSOR_STYLES {
            assert!(style.preset().is_some(), "{style:?} has no preset");
        }
    }

    #[test]
    fn the_catalogues_match_the_source() {
        assert_eq!(CAPTION_PRESETS.len(), 5);
        assert_eq!(CAPTION_PRESETS[0].id, "classic");
        assert_eq!(CAPTION_PRESETS[2].highlight_style, "pill");
        assert_eq!(CAPTION_POSITIONS[0].0, "manual");
        assert_eq!(KEYBOARD_POSITIONS.len(), 6);
        assert_eq!(FONT_OPTIONS.len(), 3);
        assert_eq!(TEXT_WEIGHTS.len(), 3);
        assert_eq!(CAMERA_BLUR_MODES.len(), 3);
        // `MODEL_OPTIONS` (`CaptionsTab.tsx:87-116`): two Parakeet entries in
        // front of the two Whisper ones, so the Intel-macOS slice keeps
        // exactly the Whisper pair.
        assert_eq!(CAPTION_MODELS.len(), 4);
        assert_eq!(CAPTION_MODELS[0].name, "best");
        assert_eq!(CAPTION_MODELS[1].name, "best-max");
        assert_eq!(CAPTION_MODELS[2].name, "small");
        assert_eq!(CAPTION_MODELS[3].name, "medium");
        assert!(
            CAPTION_MODELS[2..]
                .iter()
                .all(|model| !transcription::is_parakeet_model(model.name))
        );
    }

    #[test]
    fn a_project_without_a_captions_block_refuses_a_settings_write() {
        // `if (!project?.captions) return` (`CaptionsTab.tsx:325`).
        let mut project = ProjectConfiguration::default();
        assert!(!with_caption_settings(&mut project, |settings| {
            settings.size = 99
        }));
        project.captions = Some(default_captions());
        assert!(with_caption_settings(&mut project, |settings| {
            settings.size = 99
        }));
        assert_eq!(caption_settings(&project).size, 99);
    }

    #[test]
    fn a_keyboard_settings_write_creates_the_block_it_needs() {
        // `if (!project?.keyboard) { setProject("keyboard", { settings: {...} }) }`
        let mut project = ProjectConfiguration::default();
        assert!(with_keyboard_settings(&mut project, |settings| {
            settings.size = 72
        }));
        assert_eq!(keyboard_settings(&project).size, 72);
        // The rest of the defaults come along, not just the written key.
        assert_eq!(keyboard_settings(&project).position, "bottom-center");
    }
}
