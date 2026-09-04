//! The eight segment panels, and the text fields the whole sidebar shares.
//!
//! `sidebarSelection()` (`ConfigSidebar.tsx:577-580`) is the timeline selection
//! excluding clip; when one exists the scroll body takes `hidden` and this
//! region is drawn over it (`:1077-1093`). E5a built the routing; this module
//! builds what lands in it.
//!
//! | panel | source |
//! |---|---|
//! | zoom | `ZoomSegmentConfig` (`:5577-5881`), `ZoomMultiSegmentConfig` (`:5882-6080`) |
//! | text | `TextSegmentConfig` (`:3613-4000`) |
//! | caption | `CaptionSegmentConfig` (`:4231-4341`) |
//! | mask | `MaskSegmentConfig` (`:4342-4520`) |
//! | scene | `SceneSegmentConfig` (`:6293-6495`) |
//! | 3D | `Camera3DSegmentConfig` (`:4882-5435`) |
//! | audio | `AudioSegmentConfig` (`:4001-4132`) |
//! | keyboard | `KeyboardSegmentConfig` (`:4133-4230`) |
//!
//! Seven of the eight open with the same Done / "N … selected" / Delete row,
//! which is `ui::SelectionHeader`; the scene panel's single-segment case is the
//! one that draws its own two-button variant (`:6326-6344`), and its
//! multi-select case draws the header **and nothing else** -- reproduced, not
//! filled in.

use cap_project::{
    AudioTrackSegment, Camera3DBlur, Camera3DBlurMode, Camera3DKeyframe, Camera3DProperties,
    Camera3DSegment, CaptionTrackSegment, KeyboardTrackSegment, MaskKind, MaskSegment, SceneMode,
    SceneSegment, SplitLayout, TextAlign, TextAnimation, TextLayout, TextSegment,
    TimelineConfiguration, XY, ZoomMode, ZoomSegment, mask_effect_contract,
};
use gpui::{
    AnyElement, AppContext, Context, Entity, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseDownEvent, ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_edits::Selection,
    editor_sidebar::{ColorTarget, PadKey, PanelSection, SliderKey, collapsible, dashed_divider},
    editor_tabs::{OffsetKind, SidebarMenu},
    editor_timeline::TrackKind,
    editor_window::EditorWindow,
    ui,
};

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

/// `TEXT_FONT_SIZE_MIN` / `_MAX` (`text.ts:7-8`).
pub const TEXT_FONT_SIZE_MIN: f32 = 8.;
pub const TEXT_FONT_SIZE_MAX: f32 = 400.;

/// `MIN_VOLUME_DB` / `MAX_VOLUME_DB` (`audio.ts:24-25`).
pub const MIN_VOLUME_DB: f32 = -30.;
pub const MAX_VOLUME_DB: f32 = 12.;

/// `TEXT_SEGMENT_WEIGHT_OPTIONS` (`text-style.tsx:42-50`).
pub const TEXT_SEGMENT_WEIGHTS: [(f32, &str); 7] = [
    (300., "Light"),
    (400., "Regular"),
    (500., "Medium"),
    (600., "Semibold"),
    (700., "Bold"),
    (800., "Extra Bold"),
    (900., "Black"),
];

/// `TEXT_ANIMATION_OPTIONS` (`text-style.tsx:52-62`).
pub const TEXT_ANIMATIONS: [(TextAnimation, &str); 6] = [
    (TextAnimation::None, "None"),
    (TextAnimation::Fade, "Fade"),
    (TextAnimation::SlideUp, "Slide up"),
    (TextAnimation::SlideDown, "Slide down"),
    (TextAnimation::Pop, "Pop"),
    (TextAnimation::Typewriter, "Typewriter"),
];

/// `TEXT_LAYOUT_OPTIONS` (`:3583-3590`): the renderer also has `splitLeft` /
/// `splitRight`, and the source deliberately exposes only these two.
pub const TEXT_LAYOUTS: [(TextLayout, &str, &str); 2] = [
    (TextLayout::Overlay, "Overlay", "icons/box-select.svg"),
    (TextLayout::Fullscreen, "Fullscreen", "icons/maximize.svg"),
];

/// `TEXT_ALIGN_OPTIONS` (`:3596-3600`).
pub const TEXT_ALIGNS: [(TextAlign, &str); 3] = [
    (TextAlign::Left, "icons/align-left.svg"),
    (TextAlign::Center, "icons/align-center.svg"),
    (TextAlign::Right, "icons/align-right.svg"),
];

// ---------------------------------------------------------------------------
// Text presets (`text-presets.ts`)
// ---------------------------------------------------------------------------

/// `TextPresetStyle` (`text-presets.ts:3-16`).
pub struct TextPresetStyle {
    pub font_stack: &'static [&'static str],
    pub font_size: f32,
    pub font_weight: f32,
    pub italic: bool,
    pub align: TextAlign,
    pub letter_spacing: f32,
    pub line_height: f32,
    pub shadow: f32,
    pub animation_in: TextAnimation,
    pub animation_in_duration: f64,
    pub animation_out: TextAnimation,
    pub animation_out_duration: f64,
}

/// `TextPreset` (`:18-25`). `center` is only set by presets that imply
/// placement, and it is the one field that moves the box.
pub struct TextPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub sample: &'static str,
    pub style: TextPresetStyle,
    pub center: Option<XY<f64>>,
}

const SANS_STACK: &[&str] = &["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"];
const SERIF_STACK: &[&str] = &["Georgia", "Times New Roman", "serif"];
const MONO_STACK: &[&str] = &["Menlo", "Consolas", "monospace"];

/// `TEXT_PRESETS` (`text-presets.ts:27-181`), in order.
pub static TEXT_PRESETS: &[TextPreset] = &[
    TextPreset {
        id: "title",
        name: "Title",
        sample: "Big Title",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 96.,
            font_weight: 700.,
            italic: false,
            align: TextAlign::Center,
            letter_spacing: -1.,
            line_height: 1.1,
            shadow: 0.35,
            animation_in: TextAnimation::SlideUp,
            animation_in_duration: 0.35,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "subtitle",
        name: "Subtitle",
        sample: "A calmer supporting line",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 44.,
            font_weight: 500.,
            italic: false,
            align: TextAlign::Center,
            letter_spacing: 0.,
            line_height: 1.3,
            shadow: 0.25,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.3,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "lower-third",
        name: "Lower Third",
        sample: "Name / Context",
        center: Some(XY { x: 0.22, y: 0.85 }),
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 40.,
            font_weight: 600.,
            italic: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.25,
            shadow: 0.4,
            animation_in: TextAnimation::SlideUp,
            animation_in_duration: 0.3,
            animation_out: TextAnimation::SlideDown,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "kicker",
        name: "Kicker",
        sample: "NEW FEATURE",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 26.,
            font_weight: 700.,
            italic: false,
            align: TextAlign::Center,
            letter_spacing: 6.,
            line_height: 1.2,
            shadow: 0.2,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.2,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "stat",
        name: "Big Stat",
        sample: "128%",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 160.,
            font_weight: 800.,
            italic: false,
            align: TextAlign::Center,
            letter_spacing: -2.,
            line_height: 1.,
            shadow: 0.3,
            animation_in: TextAnimation::Pop,
            animation_in_duration: 0.4,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "quote",
        name: "Quote",
        sample: "\u{201c}Make it feel effortless\u{201d}",
        center: None,
        style: TextPresetStyle {
            font_stack: SERIF_STACK,
            font_size: 56.,
            font_weight: 500.,
            italic: true,
            align: TextAlign::Center,
            letter_spacing: 0.,
            line_height: 1.35,
            shadow: 0.2,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.4,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.3,
        },
    },
    TextPreset {
        id: "code",
        name: "Code",
        sample: "$ cap record",
        center: None,
        style: TextPresetStyle {
            font_stack: MONO_STACK,
            font_size: 36.,
            font_weight: 400.,
            italic: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.4,
            shadow: 0.,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.2,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "typewriter",
        name: "Typewriter",
        sample: "typing it out\u{2026}",
        center: None,
        style: TextPresetStyle {
            font_stack: MONO_STACK,
            font_size: 44.,
            font_weight: 500.,
            italic: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.3,
            shadow: 0.,
            animation_in: TextAnimation::Typewriter,
            animation_in_duration: 0.8,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
];

/// `GENERIC_FONT_OPTIONS` (`utils/fonts.ts:15-19`) -- the three families the
/// renderer resolves itself, which head the font picker's list.
pub const GENERIC_FONTS: [(&str, &str); 3] = [
    ("sans-serif", "System Sans"),
    ("serif", "System Serif"),
    ("monospace", "System Mono"),
];

/// `fontFamilyLabel` (`utils/fonts.ts:27-32`).
pub fn font_family_label(value: &str) -> String {
    GENERIC_FONTS
        .iter()
        .find(|(generic, _)| *generic == value.trim().to_ascii_lowercase())
        .map_or_else(|| value.to_string(), |(_, label)| (*label).to_string())
}

/// `pickFontFamily` (`text-presets.ts:184-201`): the first family of the stack
/// that is actually installed, else the generic the stack ends with.
pub fn pick_font_family(stack: &[&str], installed: &[String]) -> String {
    for family in stack {
        let normalized = family.to_ascii_lowercase();
        if matches!(normalized.as_str(), "sans-serif" | "serif" | "monospace") {
            return normalized;
        }
        if installed
            .iter()
            .any(|name| name.eq_ignore_ascii_case(family))
        {
            return (*family).to_string();
        }
    }
    stack
        .last()
        .map_or_else(|| "sans-serif".to_string(), |family| (*family).to_string())
}

/// `applyTextPreset` (`text-presets.ts:205-238`). Content, timing and colour
/// stay the user's; the box is scaled with the font change about its **top**
/// edge, exactly as the Size slider does.
pub fn apply_text_preset(segment: &mut TextSegment, preset: &TextPreset, installed: &[String]) {
    let style = &preset.style;
    let box_scale = f64::from(
        style.font_size
            / if segment.font_size == 0. {
                48.
            } else {
                segment.font_size
            },
    );
    let top_edge = segment.center.y - segment.size.y / 2.;
    segment.size.x = (segment.size.x * box_scale).min(1.);
    segment.size.y *= box_scale;
    segment.center.y = top_edge + segment.size.y / 2.;

    segment.font_family = pick_font_family(style.font_stack, installed);
    segment.font_size = style.font_size;
    segment.font_weight = style.font_weight;
    segment.italic = style.italic;
    segment.align = style.align;
    segment.letter_spacing = style.letter_spacing;
    segment.line_height = style.line_height;
    segment.opacity = 1.;
    segment.shadow = style.shadow;
    segment.animation_in = style.animation_in;
    segment.animation_out = style.animation_out;
    segment.animation_in_duration = style.animation_in_duration;
    segment.animation_out_duration = style.animation_out_duration;
    segment.fade_duration = style
        .animation_in_duration
        .max(style.animation_out_duration);
    if let Some(center) = preset.center {
        segment.center = center;
    }
}

/// `matchTextPreset` (`text-presets.ts:240-265`): which preset, if any, the
/// segment currently *is*. Everything but content, timing, colour and position
/// has to agree, with the source's own 0.011 tolerance on the float fields.
pub fn match_text_preset(segment: &TextSegment, installed: &[String]) -> Option<&'static str> {
    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.011
    }
    TEXT_PRESETS
        .iter()
        .find(|preset| {
            let style = &preset.style;
            segment.font_family == pick_font_family(style.font_stack, installed)
                && segment.font_weight == style.font_weight
                && segment.italic == style.italic
                && segment.align == style.align
                && near(segment.letter_spacing.into(), style.letter_spacing.into())
                && near(segment.line_height.into(), style.line_height.into())
                && near(segment.shadow.into(), style.shadow.into())
                && segment.animation_in == style.animation_in
                && segment.animation_out == style.animation_out
                && near(segment.animation_in_duration, style.animation_in_duration)
                && near(segment.animation_out_duration, style.animation_out_duration)
        })
        .map(|preset| preset.id)
}

/// The installed families, as `listSystemFonts` provides them to the source
/// (`utils/fonts.ts:7-13`, which is `cap_rendering::system_font_families`
/// behind a Tauri command).
///
/// Enumerating them builds a `fontdb` over the system's fonts, which is far too
/// slow for a render pass, so it happens once on a background thread and the
/// picker shows only the three generics until it lands -- the same shape as the
/// source's `createResource`, which is `undefined` on the first frame too.
static INSTALLED_FONTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
static FONTS_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn installed_fonts() -> &'static [String] {
    INSTALLED_FONTS.get().map_or(&[], Vec::as_slice)
}

/// The picker's rows: `[...GENERIC_FONT_OPTIONS, ...installedFonts]`
/// (`FontPicker.tsx:25-28`), as `(stored value, shown label)`.
pub fn font_picker_options() -> Vec<(String, String)> {
    GENERIC_FONTS
        .iter()
        .map(|(value, label)| ((*value).to_string(), (*label).to_string()))
        .chain(
            installed_fonts()
                .iter()
                .map(|name| (name.clone(), name.clone())),
        )
        .collect()
}

/// The family a preset **card** draws its sample in. The CSS stack falls
/// through family by family; gpui takes one name, so this is the same
/// [`pick_font_family`] resolution the applied value uses, with the generics
/// mapped onto the app's own face -- gpui's text system has no `serif` /
/// `monospace` aliases, so a stack that resolves to a generic draws in Geist.
fn preset_font_family(stack: &[&str], installed: &[String]) -> SharedString {
    let picked = pick_font_family(stack, installed);
    if matches!(picked.as_str(), "sans-serif" | "serif" | "monospace") {
        return SharedString::from("Geist");
    }
    SharedString::from(picked)
}

/// Kick the enumeration off, at most once per process.
pub fn warm_installed_fonts() {
    if FONTS_STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(|| {
        let families = cap_rendering::system_font_families();
        tracing::info!(count = families.len(), "enumerated system fonts");
        let _ = INSTALLED_FONTS.set(families);
    });
}

/// The five scene modes and their descriptions (`:6295-6315`, `:6373-6404`).
pub const SCENE_MODES: [(SceneMode, &str, &str, &str); 5] = [
    (
        SceneMode::Default,
        "Default",
        "icons/monitor-outline.svg",
        "Shows both screen and camera",
    ),
    (
        SceneMode::CameraOnly,
        "Camera Only",
        "icons/video.svg",
        "Shows only the camera feed",
    ),
    (
        SceneMode::HideCamera,
        "Hide Camera",
        "icons/eye-off.svg",
        "Shows only the screen recording",
    ),
    (
        SceneMode::SplitScreen,
        "Split Screen",
        "icons/columns-2.svg",
        "Screen and camera side by side (auto-stacks in portrait)",
    ),
    (
        SceneMode::Floating,
        "Floating",
        "icons/panel-right.svg",
        "Screen and camera float side by side as rounded cards over the background",
    ),
];

/// `CAMERA3D_SLIDERS` (`:4519-4530`) with its icons (`:4544-4557`).
pub const CAMERA3D_POSE_SLIDERS: [(Camera3DProperty, &str, &str, &str); 9] = [
    (
        Camera3DProperty::TiltX,
        "Tilt X",
        "\u{b0}",
        "icons/rotate-3d.svg",
    ),
    (
        Camera3DProperty::TiltY,
        "Tilt Y",
        "\u{b0}",
        "icons/rotate-3d.svg",
    ),
    (
        Camera3DProperty::Roll,
        "Roll",
        "\u{b0}",
        "icons/rotate-cw.svg",
    ),
    (
        Camera3DProperty::RotateX,
        "Rotate X",
        "\u{b0}",
        "icons/rotate-3d.svg",
    ),
    (
        Camera3DProperty::RotateY,
        "Rotate Y",
        "\u{b0}",
        "icons/rotate-3d.svg",
    ),
    (
        Camera3DProperty::Fov,
        "Field of view",
        "\u{b0}",
        "icons/maximize.svg",
    ),
    (Camera3DProperty::Zoom, "Zoom", "", "icons/search.svg"),
    (Camera3DProperty::PanX, "Pan X", "", "icons/move.svg"),
    (Camera3DProperty::PanY, "Pan Y", "", "icons/move.svg"),
];

/// `CAMERA3D_BLUR_MODE_OPTIONS` (`:4560-4569`).
pub const CAMERA3D_BLUR_MODES: [(Camera3DBlurMode, &str); 4] = [
    (Camera3DBlurMode::None, "None"),
    (Camera3DBlurMode::Radial, "Radial"),
    (Camera3DBlurMode::Directional, "Directional"),
    (Camera3DBlurMode::TiltShift, "Tilt Shift"),
];

/// `CAMERA3D_BLUR_SLIDERS` (`:4577-4602`): each mode exposes only the
/// parameters it reads, in display order.
pub fn camera3d_blur_sliders(mode: Camera3DBlurMode) -> &'static [(Camera3DBlurKey, &'static str)] {
    match mode {
        Camera3DBlurMode::None => &[],
        Camera3DBlurMode::Radial => &[
            (Camera3DBlurKey::Strength, "Strength"),
            (Camera3DBlurKey::FocusX, "Focus X"),
            (Camera3DBlurKey::FocusY, "Focus Y"),
            (Camera3DBlurKey::FocusSize, "Focus size"),
            (Camera3DBlurKey::Falloff, "Falloff"),
        ],
        Camera3DBlurMode::Directional => &[
            (Camera3DBlurKey::Strength, "Strength"),
            (Camera3DBlurKey::Angle, "Angle"),
            (Camera3DBlurKey::DirPosition, "Position"),
            (Camera3DBlurKey::Falloff, "Falloff"),
        ],
        Camera3DBlurMode::TiltShift => &[
            (Camera3DBlurKey::Strength, "Strength"),
            (Camera3DBlurKey::FocusY, "Scan"),
            (Camera3DBlurKey::FocusSize, "Focus size"),
            (Camera3DBlurKey::Angle, "Angle"),
            (Camera3DBlurKey::Falloff, "Falloff"),
        ],
    }
}

/// `MOTION_EASINGS` (`three-d.ts:957-963`).
pub const MOTION_EASINGS: [(&str, &str, [f64; 2], [f64; 2]); 4] = [
    ("linear", "Linear", [0., 0.], [1., 1.]),
    ("smooth", "Smooth", [0.65, 0.], [0.35, 1.]),
    ("easeIn", "Ease in", [0.32, 0.], [1., 1.]),
    ("easeOut", "Ease out", [0., 0.], [0.68, 1.]),
];

/// `CAMERA3D_RESET_POSE` (`three-d.ts:927-937`): a canonical long lens.
pub const CAMERA3D_RESET_POSE: Camera3DProperties = Camera3DProperties {
    tilt_x: 0.,
    tilt_y: 0.,
    roll: 0.,
    rotate_x: 0.,
    rotate_y: 0.,
    fov: 24.,
    zoom: 4.5,
    pan_x: 0.,
    pan_y: 0.,
};

// ---------------------------------------------------------------------------
// The 3D panel's templates (`three-d.ts:270-925`)
// ---------------------------------------------------------------------------

/// A pose, spelled as the source's `pose({...})` does: the default properties
/// with the named overrides on top.
const fn pose(p: Camera3DProperties) -> Camera3DProperties {
    p
}

/// `defaultCamera3DProperties()` (`three-d.ts`), which is what every `pose()`
/// and `anglePresetPose()` starts from.
const DEFAULT_POSE: Camera3DProperties = Camera3DProperties {
    tilt_x: 0.,
    tilt_y: 0.,
    roll: 0.,
    rotate_x: 0.,
    rotate_y: 0.,
    fov: 45.,
    zoom: 1.,
    pan_x: 0.,
    pan_y: 0.,
};

/// `showcaseCamera3DBlur()` -- the defocus every card carries unless it was
/// authored with its own.
fn showcase_blur() -> Camera3DBlur {
    default_camera3d_blur()
}

/// `detailCamera3DBlur()` (`three-d.ts:304-314`): a tight, hard-edged spot.
fn detail_blur() -> Camera3DBlur {
    Camera3DBlur {
        mode: Camera3DBlurMode::Radial,
        strength: 20.,
        falloff: 0.76,
        focus_x: 0.11,
        focus_y: 0.5,
        focus_size: 0.18,
        angle: 0.,
        dir_position: 0.5,
        bokeh: true,
    }
}

/// `overheadCamera3DBlur()` (`three-d.ts:320-330`): a wide, soft band.
fn overhead_blur() -> Camera3DBlur {
    Camera3DBlur {
        mode: Camera3DBlurMode::Radial,
        strength: 18.,
        falloff: 0.72,
        focus_x: 0.03,
        focus_y: 0.36,
        focus_size: 0.55,
        angle: 0.,
        dir_position: 0.5,
        bokeh: true,
    }
}

/// `Camera3DAnglePreset` (`three-d.ts:270-298`): a named opening pose plus the
/// drift it plays out over.
pub struct AnglePreset {
    pub id: &'static str,
    pub name: &'static str,
    pub values: Camera3DProperties,
    /// The end pose. The source spells it as a partial `drift` merged onto the
    /// opening pose, which is the same thing written out.
    pub drift: Camera3DProperties,
    pub blur: fn() -> Camera3DBlur,
}

/// `CAMERA3D_ANGLE_PRESET_KEYS` (`three-d.ts`): only these five decide whether
/// a pose *is* a preset -- `rotateX` / `rotateY` are the fold, not the angle.
const ANGLE_PRESET_KEYS: [Camera3DProperty; 5] = [
    Camera3DProperty::TiltX,
    Camera3DProperty::TiltY,
    Camera3DProperty::Roll,
    Camera3DProperty::Zoom,
    Camera3DProperty::Fov,
];

/// `ANGLE_PRESETS` (`three-d.ts:340-418`), in order.
pub static ANGLE_PRESETS: &[AnglePreset] = &[
    AnglePreset {
        id: "spotlight",
        name: "Spotlight",
        values: Camera3DProperties {
            zoom: 1.35,
            pan_x: 0.39,
            pan_y: -0.4,
            ..DEFAULT_POSE
        },
        // Slow push in with a slight rise.
        drift: Camera3DProperties {
            zoom: 1.22,
            pan_x: 0.39,
            pan_y: -0.34,
            ..DEFAULT_POSE
        },
        blur: showcase_blur,
    },
    AnglePreset {
        id: "perspective",
        name: "Perspective",
        values: Camera3DProperties {
            tilt_x: -28.,
            tilt_y: 26.,
            roll: 5.,
            zoom: 1.59,
            pan_x: 0.37,
            pan_y: -0.15,
            ..DEFAULT_POSE
        },
        // Orbit sweep.
        drift: Camera3DProperties {
            tilt_x: -28.,
            tilt_y: 18.,
            roll: 5.,
            zoom: 1.53,
            pan_x: 0.37,
            pan_y: -0.15,
            ..DEFAULT_POSE
        },
        blur: showcase_blur,
    },
    AnglePreset {
        id: "center",
        name: "Center",
        values: Camera3DProperties {
            zoom: 2.,
            ..DEFAULT_POSE
        },
        // Slow pull back.
        drift: Camera3DProperties {
            zoom: 2.25,
            ..DEFAULT_POSE
        },
        blur: showcase_blur,
    },
    AnglePreset {
        id: "low-angle",
        name: "Low angle",
        values: Camera3DProperties {
            tilt_x: -50.,
            tilt_y: 1.,
            zoom: 1.5,
            ..DEFAULT_POSE
        },
        // Low-angle rise.
        drift: Camera3DProperties {
            tilt_x: -44.,
            tilt_y: 1.,
            zoom: 1.5,
            pan_y: -0.12,
            ..DEFAULT_POSE
        },
        blur: showcase_blur,
    },
    AnglePreset {
        id: "close-up",
        name: "Close up",
        values: Camera3DProperties {
            tilt_x: 26.,
            tilt_y: -22.,
            roll: 1.,
            zoom: 0.8,
            pan_x: -0.3,
            pan_y: -0.4,
            ..DEFAULT_POSE
        },
        // Truck across the close-up.
        drift: Camera3DProperties {
            tilt_x: 26.,
            tilt_y: -27.,
            roll: 1.,
            zoom: 0.8,
            pan_x: -0.36,
            pan_y: -0.4,
            ..DEFAULT_POSE
        },
        // The close-up is the one card that focuses tight and far left.
        blur: detail_blur,
    },
];

/// `Camera3DMotionTemplate` (`three-d.ts:453-461`). The blur is part of the
/// template: clicking a card is a complete look, not a pose change.
pub struct MotionTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub from: Camera3DProperties,
    pub to: Camera3DProperties,
    pub blur: fn() -> Camera3DBlur,
}

/// `MOTION_TEMPLATES` (`three-d.ts:476-598`), in order.
pub static MOTION_TEMPLATES: &[MotionTemplate] = &[
    MotionTemplate {
        id: "glide-across",
        name: "Glide across",
        from: pose(Camera3DProperties {
            tilt_x: -46.65,
            tilt_y: 42.49,
            rotate_y: -20.,
            rotate_x: -1.,
            zoom: 1.785,
            fov: 24.,
            pan_x: 0.673,
            pan_y: -0.133,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            tilt_x: -46.65,
            tilt_y: 42.49,
            rotate_y: -20.,
            rotate_x: -1.,
            zoom: 1.785,
            fov: 24.,
            pan_x: 0.054,
            pan_y: -0.31,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "drift-down",
        name: "Drift down",
        from: pose(Camera3DProperties {
            zoom: 0.8,
            pan_x: 0.536,
            pan_y: -0.452,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            zoom: 0.8,
            pan_x: 0.544,
            pan_y: 0.5,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "rising-sweep",
        name: "Rising sweep",
        from: pose(Camera3DProperties {
            tilt_x: -57.83,
            tilt_y: -8.7,
            rotate_y: -16.,
            zoom: 1.51,
            fov: 29.,
            pan_x: -0.634,
            pan_y: -0.082,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            tilt_x: -46.65,
            tilt_y: -7.94,
            rotate_y: -16.,
            zoom: 1.51,
            fov: 25.,
            pan_x: -0.613,
            pan_y: -0.268,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "pull-back",
        name: "Pull back",
        from: pose(Camera3DProperties {
            rotate_x: -14.,
            zoom: 0.715,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            rotate_x: -14.,
            zoom: 2.1,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "top-down",
        name: "Top down",
        from: pose(Camera3DProperties {
            tilt_x: 24.8,
            tilt_y: 17.04,
            rotate_y: 18.,
            rotate_x: -40.,
            zoom: 0.5,
            fov: 60.,
            pan_x: -0.065,
            pan_y: -0.195,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            tilt_x: 34.19,
            tilt_y: 15.28,
            rotate_y: 9.,
            rotate_x: -40.,
            zoom: 0.5,
            fov: 60.,
            pan_x: -0.217,
            pan_y: -0.476,
            ..DEFAULT_POSE
        }),
        // Looking down at the plane wants a wider, softer band than the rest.
        blur: overhead_blur,
    },
    MotionTemplate {
        id: "tilt-away",
        name: "Tilt away",
        from: pose(Camera3DProperties {
            rotate_x: -5.,
            zoom: 0.5,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            rotate_x: -21.,
            zoom: 0.6,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "unfold",
        name: "Unfold",
        from: pose(Camera3DProperties {
            rotate_x: -42.96,
            zoom: 2.05,
            fov: 31.,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            rotate_x: -12.01,
            zoom: 2.,
            fov: 31.,
            pan_y: -0.179,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
    MotionTemplate {
        id: "slide-by",
        name: "Slide by",
        from: pose(Camera3DProperties {
            tilt_x: -30.29,
            tilt_y: 60.,
            rotate_y: -24.,
            rotate_x: -39.,
            zoom: 1.99,
            fov: 13.,
            pan_x: 0.238,
            pan_y: 0.135,
            ..DEFAULT_POSE
        }),
        to: pose(Camera3DProperties {
            tilt_x: -30.29,
            tilt_y: 60.,
            rotate_y: -24.,
            rotate_x: -39.,
            zoom: 1.99,
            fov: 13.,
            pan_x: -0.204,
            pan_y: 0.039,
            ..DEFAULT_POSE
        }),
        blur: showcase_blur,
    },
];

/// `anglePresetMotion` (`three-d.ts:427-436`): an angle preset read as a
/// motion template -- open on the named pose, drift to the end one.
pub fn angle_preset_motion(preset: &AnglePreset) -> MotionTemplate {
    MotionTemplate {
        id: preset.id,
        name: preset.name,
        from: preset.values,
        to: preset.drift,
        blur: preset.blur,
    }
}

/// `matchAnglePreset` (`three-d.ts:446-454`). Half a slider step is the
/// tightest a pose can be "the same as" a preset and still be reachable.
pub fn match_angle_preset(poseation: &Camera3DProperties) -> Option<&'static str> {
    ANGLE_PRESETS
        .iter()
        .find(|preset| {
            ANGLE_PRESET_KEYS.iter().all(|key| {
                let epsilon = f64::from(key.limits().2 / 2.).max(1e-4);
                (key.read(poseation) - key.read(&preset.values)).abs() <= epsilon
            })
        })
        .map(|preset| preset.id)
}

/// `applyMotionTemplate` (`three-d.ts`): the whole camera animation replaced,
/// blur included, on the linear easing every template is authored against.
pub fn apply_motion_template(segment: &mut Camera3DSegment, template: &MotionTemplate) {
    segment.blur = (template.blur)();
    let (_, _, out, into) = MOTION_EASINGS[0];
    set_motion(segment, &template.from, &template.to, (out, into));
}

/// One shot of a scene: a weighted share of the range, with its own move and
/// defocus (`Camera3DSceneShot`, `three-d.ts:672-680`).
pub struct SceneShot {
    pub weight: f64,
    pub from: Camera3DProperties,
    pub to: Camera3DProperties,
    pub blur: fn() -> Camera3DBlur,
}

pub struct Camera3DScene {
    pub id: &'static str,
    pub name: &'static str,
    pub shots: &'static [SceneShot],
}

struct Camera3DSection<'a> {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    summary: Option<&'a str>,
}

/// The showcase's third shot has its own defocus, authored inline.
fn showcase_push_blur() -> Camera3DBlur {
    Camera3DBlur {
        mode: Camera3DBlurMode::Radial,
        strength: 19.,
        falloff: 0.67,
        focus_x: 0.37,
        focus_y: 0.52,
        focus_size: 0.4,
        angle: 0.,
        dir_position: 0.5,
        bokeh: true,
    }
}

/// `CAMERA3D_SCENES` (`three-d.ts:705-795`). "Product tour" and "Punch in" are
/// spelled in the source as `templateShot(...)` over the two catalogues above;
/// the poses are therefore the same values, written out here.
pub static CAMERA3D_SCENES: &[Camera3DScene] = &[
    Camera3DScene {
        id: "showcase",
        name: "Showcase",
        // Transcribed verbatim from the hand-built reference project: a tight
        // close-up truck, a fold-down overhead sweep, then a long push in.
        shots: &[
            SceneShot {
                weight: 0.27,
                from: pose(Camera3DProperties {
                    tilt_x: 26.,
                    tilt_y: -22.,
                    roll: 1.,
                    zoom: 0.8,
                    pan_x: -0.3,
                    pan_y: -0.4,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    tilt_x: 26.,
                    tilt_y: -27.,
                    roll: 1.,
                    zoom: 0.8,
                    pan_x: -0.36,
                    pan_y: -0.4,
                    ..DEFAULT_POSE
                }),
                blur: detail_blur,
            },
            SceneShot {
                weight: 0.25,
                from: pose(Camera3DProperties {
                    tilt_x: 24.8,
                    tilt_y: 17.04,
                    rotate_x: -40.,
                    rotate_y: 18.,
                    fov: 60.,
                    zoom: 0.5,
                    pan_x: -0.065,
                    pan_y: -0.195,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    tilt_x: 34.19,
                    tilt_y: 15.28,
                    rotate_x: -40.,
                    rotate_y: 9.,
                    fov: 60.,
                    zoom: 0.5,
                    pan_x: -0.217,
                    pan_y: -0.476,
                    ..DEFAULT_POSE
                }),
                blur: overhead_blur,
            },
            SceneShot {
                weight: 0.48,
                from: pose(Camera3DProperties {
                    rotate_x: -14.,
                    zoom: 0.715,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    rotate_x: -14.,
                    zoom: 1.6,
                    ..DEFAULT_POSE
                }),
                blur: showcase_push_blur,
            },
        ],
    },
    Camera3DScene {
        id: "product-tour",
        name: "Product tour",
        // Reveal, orbit, settle: `unfold`, `perspective`, `center`.
        shots: &[
            SceneShot {
                weight: 0.3,
                from: pose(Camera3DProperties {
                    rotate_x: -42.96,
                    zoom: 2.05,
                    fov: 31.,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    rotate_x: -12.01,
                    zoom: 2.,
                    fov: 31.,
                    pan_y: -0.179,
                    ..DEFAULT_POSE
                }),
                blur: showcase_blur,
            },
            SceneShot {
                weight: 0.3,
                from: pose(Camera3DProperties {
                    tilt_x: -28.,
                    tilt_y: 26.,
                    roll: 5.,
                    zoom: 1.59,
                    pan_x: 0.37,
                    pan_y: -0.15,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    tilt_x: -28.,
                    tilt_y: 18.,
                    roll: 5.,
                    zoom: 1.53,
                    pan_x: 0.37,
                    pan_y: -0.15,
                    ..DEFAULT_POSE
                }),
                blur: showcase_blur,
            },
            SceneShot {
                weight: 0.4,
                from: pose(Camera3DProperties {
                    zoom: 2.,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    zoom: 2.25,
                    ..DEFAULT_POSE
                }),
                blur: showcase_blur,
            },
        ],
    },
    Camera3DScene {
        id: "punch-in",
        name: "Punch in",
        // Push in, hold on the detail, then release: `spotlight`, `close-up`,
        // `pull-back`.
        shots: &[
            SceneShot {
                weight: 0.3,
                from: pose(Camera3DProperties {
                    zoom: 1.35,
                    pan_x: 0.39,
                    pan_y: -0.4,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    zoom: 1.22,
                    pan_x: 0.39,
                    pan_y: -0.34,
                    ..DEFAULT_POSE
                }),
                blur: showcase_blur,
            },
            SceneShot {
                weight: 0.3,
                from: pose(Camera3DProperties {
                    tilt_x: 26.,
                    tilt_y: -22.,
                    roll: 1.,
                    zoom: 0.8,
                    pan_x: -0.3,
                    pan_y: -0.4,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    tilt_x: 26.,
                    tilt_y: -27.,
                    roll: 1.,
                    zoom: 0.8,
                    pan_x: -0.36,
                    pan_y: -0.4,
                    ..DEFAULT_POSE
                }),
                blur: detail_blur,
            },
            SceneShot {
                weight: 0.4,
                from: pose(Camera3DProperties {
                    rotate_x: -14.,
                    zoom: 0.715,
                    ..DEFAULT_POSE
                }),
                to: pose(Camera3DProperties {
                    rotate_x: -14.,
                    zoom: 2.1,
                    ..DEFAULT_POSE
                }),
                blur: showcase_blur,
            },
        ],
    },
];

/// A fixed-column grid's cell width inside a segment panel's card. The 416px
/// sidebar less its `p-4`, less the card's `p-4` and 1px border, is 350px of
/// content; a grid of `n` columns with `gap` between them splits what is left.
const fn card_grid_width(columns: f32, gap: f32) -> f32 {
    (350. - gap * (columns - 1.)) / columns
}
/// `grid-cols-2 gap-2`, `grid-cols-3 gap-2`, `grid-cols-4 gap-2`,
/// `grid-cols-5 gap-1.5`.
const CARD_GRID_WIDTH_2: f32 = card_grid_width(2., 8.);
const CARD_GRID_WIDTH_3: f32 = card_grid_width(3., 8.);
const CARD_GRID_WIDTH_4: f32 = card_grid_width(4., 8.);
const CARD_GRID_WIDTH_5: f32 = card_grid_width(5., 6.);

/// The three template grids' preview heights (`ConfigSidebar.tsx:4647-4650`).
const CAMERA3D_ANGLE_PREVIEW_HEIGHT: f32 = 30.;
const CAMERA3D_TEMPLATE_PREVIEW_HEIGHT: f32 = 40.;
const CAMERA3D_SCENE_PREVIEW_HEIGHT: f32 = 48.;

/// `CAMERA3D_MIN_SHOT_DURATION` (`three-d.ts:831`): below a second a cut reads
/// as a glitch rather than an edit.
pub const CAMERA3D_MIN_SHOT_DURATION: f64 = 1.;
/// `CAMERA3D_SCENE_SNAP_FRACTION` (`three-d.ts:838`).
pub const CAMERA3D_SCENE_SNAP_FRACTION: f64 = 0.15;

/// `applySceneToRange` (`three-d.ts:860-925`): a scene laid across
/// `[start, end]` as a chain of segments.
///
/// Boundaries come from the shot weights, then each interior one looks for a
/// clip cut to sit on -- cutting the camera exactly where the footage cuts is
/// what makes a generated sequence look authored. A snap is dropped rather than
/// forced when it would push a shot under the minimum, and a range too short
/// for the whole scene simply gets its leading shots.
pub fn apply_scene_to_range(
    scene: &Camera3DScene,
    start: f64,
    end: f64,
    clip_cuts: &[f64],
) -> Vec<Camera3DSegment> {
    let length = end - start;
    if length <= 0. || !length.is_finite() || scene.shots.is_empty() {
        return Vec::new();
    }

    let keep = ((length / CAMERA3D_MIN_SHOT_DURATION).floor() as usize)
        .min(scene.shots.len())
        .max(1);
    let shots = &scene.shots[..keep];
    let total_weight: f64 = shots.iter().map(|shot| shot.weight.max(0.)).sum();
    let share = |shot: &SceneShot| {
        if total_weight > 0. {
            shot.weight.max(0.) / total_weight
        } else {
            1. / shots.len() as f64
        }
    };

    let cuts: Vec<f64> = clip_cuts
        .iter()
        .copied()
        .filter(|cut| *cut > start && *cut < end)
        .collect();
    let snap_window = length * CAMERA3D_SCENE_SNAP_FRACTION;

    let mut boundaries = vec![start];
    let mut cumulative = 0.;
    for index in 0..shots.len().saturating_sub(1) {
        cumulative += share(&shots[index]);
        // Every shot still to come needs its own minimum, so this boundary
        // lives in whatever is left once they are reserved.
        let min = boundaries[index] + CAMERA3D_MIN_SHOT_DURATION;
        let max = end - (shots.len() - 1 - index) as f64 * CAMERA3D_MIN_SHOT_DURATION;
        let weighted = (start + length * cumulative).clamp(min.min(max), max.max(min));
        let nearest = cuts
            .iter()
            .copied()
            .fold(None::<f64>, |best, cut| match best {
                Some(current) if (current - weighted).abs() <= (cut - weighted).abs() => {
                    Some(current)
                }
                _ => Some(cut),
            });
        boundaries.push(match nearest {
            Some(cut) if (cut - weighted).abs() <= snap_window && cut >= min && cut <= max => cut,
            _ => weighted,
        });
    }
    boundaries.push(end);

    shots
        .iter()
        .enumerate()
        .map(|(index, shot)| {
            let mut segment = Camera3DSegment {
                start: boundaries[index],
                end: boundaries[index + 1],
                enabled: true,
                properties: DEFAULT_POSE,
                blur: (shot.blur)(),
                tracks: Default::default(),
                transition_in: 0.,
                transition_out: 0.,
            };
            let (_, _, out, into) = MOTION_EASINGS[0];
            set_motion(&mut segment, &shot.from, &shot.to, (out, into));
            segment
        })
        .collect()
}

/// `MOTION_STILL_EPSILON` (`three-d.ts:1233`).
const MOTION_STILL_EPSILON: f64 = 1e-4;
/// `CAMERA3D_TRANSITION_LIMITS` (`three-d.ts:191`).
pub const CAMERA3D_TRANSITION_LIMITS: (f64, f64, f64) = (0., 2., 0.05);
/// `CAMERA3D_BOKEH_MAX_STRENGTH` (`three-d.ts:164`).
const CAMERA3D_BOKEH_MAX_STRENGTH: f32 = 20.;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Camera3DProperty {
    TiltX,
    TiltY,
    Roll,
    RotateX,
    RotateY,
    Fov,
    Zoom,
    PanX,
    PanY,
}

impl Camera3DProperty {
    /// `CAMERA3D_LIMITS` (`three-d.ts:142-152`).
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::TiltX => (-70., 70., 1.),
            Self::TiltY => (-60., 60., 1.),
            Self::Roll => (-180., 180., 1.),
            Self::RotateX => (-90., 90., 1.),
            Self::RotateY => (-50., 50., 1.),
            Self::Fov => (10., 100., 1.),
            Self::Zoom => (0.5, 10., 0.05),
            Self::PanX | Self::PanY => (-3., 3., 0.01),
        }
    }

    pub fn read(self, pose: &Camera3DProperties) -> f64 {
        match self {
            Self::TiltX => pose.tilt_x,
            Self::TiltY => pose.tilt_y,
            Self::Roll => pose.roll,
            Self::RotateX => pose.rotate_x,
            Self::RotateY => pose.rotate_y,
            Self::Fov => pose.fov,
            Self::Zoom => pose.zoom,
            Self::PanX => pose.pan_x,
            Self::PanY => pose.pan_y,
        }
    }

    pub fn write(self, pose: &mut Camera3DProperties, value: f64) {
        match self {
            Self::TiltX => pose.tilt_x = value,
            Self::TiltY => pose.tilt_y = value,
            Self::Roll => pose.roll = value,
            Self::RotateX => pose.rotate_x = value,
            Self::RotateY => pose.rotate_y = value,
            Self::Fov => pose.fov = value,
            Self::Zoom => pose.zoom = value,
            Self::PanX => pose.pan_x = value,
            Self::PanY => pose.pan_y = value,
        }
    }

    fn track(self, tracks: &mut cap_project::Camera3DTracks) -> &mut Vec<Camera3DKeyframe> {
        match self {
            Self::TiltX => &mut tracks.tilt_x,
            Self::TiltY => &mut tracks.tilt_y,
            Self::Roll => &mut tracks.roll,
            Self::RotateX => &mut tracks.rotate_x,
            Self::RotateY => &mut tracks.rotate_y,
            Self::Fov => &mut tracks.fov,
            Self::Zoom => &mut tracks.zoom,
            Self::PanX => &mut tracks.pan_x,
            Self::PanY => &mut tracks.pan_y,
        }
    }

    fn track_ref(self, tracks: &cap_project::Camera3DTracks) -> &[Camera3DKeyframe] {
        match self {
            Self::TiltX => &tracks.tilt_x,
            Self::TiltY => &tracks.tilt_y,
            Self::Roll => &tracks.roll,
            Self::RotateX => &tracks.rotate_x,
            Self::RotateY => &tracks.rotate_y,
            Self::Fov => &tracks.fov,
            Self::Zoom => &tracks.zoom,
            Self::PanX => &tracks.pan_x,
            Self::PanY => &tracks.pan_y,
        }
    }

    pub const ALL: [Camera3DProperty; 9] = [
        Self::TiltX,
        Self::TiltY,
        Self::Roll,
        Self::RotateX,
        Self::RotateY,
        Self::Fov,
        Self::Zoom,
        Self::PanX,
        Self::PanY,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Camera3DBlurKey {
    Strength,
    Falloff,
    FocusX,
    FocusY,
    FocusSize,
    Angle,
    DirPosition,
}

impl Camera3DBlurKey {
    /// `camera3dBlurLimit` (`three-d.ts:167-189`): bokeh caps the strength, and
    /// tilt shift narrows both the band and the angle.
    pub fn limits(self, blur: &Camera3DBlur) -> (f32, f32, f32) {
        match self {
            Self::Strength => (
                0.,
                if blur.bokeh {
                    CAMERA3D_BOKEH_MAX_STRENGTH
                } else {
                    60.
                },
                1.,
            ),
            Self::FocusSize => (
                0.,
                if blur.mode == Camera3DBlurMode::TiltShift {
                    0.6
                } else {
                    1.
                },
                0.01,
            ),
            Self::Angle => (
                0.,
                if blur.mode == Camera3DBlurMode::TiltShift {
                    180.
                } else {
                    360.
                },
                1.,
            ),
            Self::Falloff | Self::FocusX | Self::FocusY | Self::DirPosition => (0., 1., 0.01),
        }
    }

    pub fn read(self, blur: &Camera3DBlur) -> f32 {
        (match self {
            Self::Strength => blur.strength,
            Self::Falloff => blur.falloff,
            Self::FocusX => blur.focus_x,
            Self::FocusY => blur.focus_y,
            Self::FocusSize => blur.focus_size,
            Self::Angle => blur.angle,
            Self::DirPosition => blur.dir_position,
        }) as f32
    }

    pub fn write(self, blur: &mut Camera3DBlur, value: f32) {
        let value = f64::from(value);
        match self {
            Self::Strength => blur.strength = value,
            Self::Falloff => blur.falloff = value,
            Self::FocusX => blur.focus_x = value,
            Self::FocusY => blur.focus_y = value,
            Self::FocusSize => blur.focus_size = value,
            Self::Angle => blur.angle = value,
            Self::DirPosition => blur.dir_position = value,
        }
    }
}

/// `defaultCamera3DBlur()` (`three-d.ts:207-217`).
pub fn default_camera3d_blur() -> Camera3DBlur {
    Camera3DBlur {
        mode: Camera3DBlurMode::None,
        strength: 0.,
        falloff: 0.,
        focus_x: 0.37,
        focus_y: 0.5,
        focus_size: 0.5,
        angle: 0.,
        dir_position: 0.5,
        bokeh: false,
    }
}

/// `CAMERA3D_BLUR_MODE_SEEDS` (`three-d.ts:256-265`).
pub fn seed_blur_mode(blur: &mut Camera3DBlur, mode: Camera3DBlurMode) {
    blur.mode = mode;
    match mode {
        Camera3DBlurMode::None => {}
        Camera3DBlurMode::Radial => {
            blur.focus_x = 0.37;
            blur.focus_y = 0.5;
            blur.focus_size = 0.5;
        }
        Camera3DBlurMode::Directional => {
            blur.dir_position = 0.5;
            blur.angle = 0.;
        }
        Camera3DBlurMode::TiltShift => {
            blur.focus_size = 0.1;
            blur.focus_y = 0.5;
            blur.angle = 45.;
        }
    }
}

// ---------------------------------------------------------------------------
// The 3D motion model, ported
// ---------------------------------------------------------------------------

/// `sampleTrack` at the two ends only. A segment is one move -- a start pose
/// and an end pose -- and `getStartPose` / `getEndPose` (`three-d.ts:1237-1242`)
/// are the two samples the panel reads. Every track this editor writes holds
/// exactly two keyframes, so the sample is the first or last value; a richer
/// hand-keyed track flattens onto its own ends, which is what the source's
/// `setMotion` comment says happens on first edit.
pub fn start_pose(segment: &Camera3DSegment) -> Camera3DProperties {
    let mut pose = segment.properties;
    for property in Camera3DProperty::ALL {
        if let Some(first) = property.track_ref(&segment.tracks).first() {
            property.write(&mut pose, first.value);
        }
    }
    pose
}

pub fn evaluate_pose(segment: &Camera3DSegment, local_time: f64) -> Camera3DProperties {
    let start = start_pose(segment);
    let end = end_pose(segment);
    let duration = (segment.end - segment.start).max(0.0001);
    let t = (local_time / duration).clamp(0., 1.);
    let lerp = |a: f64, b: f64| a + (b - a) * t;
    Camera3DProperties {
        tilt_x: lerp(start.tilt_x, end.tilt_x),
        tilt_y: lerp(start.tilt_y, end.tilt_y),
        roll: lerp(start.roll, end.roll),
        rotate_x: lerp(start.rotate_x, end.rotate_x),
        rotate_y: lerp(start.rotate_y, end.rotate_y),
        fov: lerp(start.fov, end.fov),
        zoom: lerp(start.zoom, end.zoom),
        pan_x: lerp(start.pan_x, end.pan_x),
        pan_y: lerp(start.pan_y, end.pan_y),
    }
}

pub fn end_pose(segment: &Camera3DSegment) -> Camera3DProperties {
    let mut pose = segment.properties;
    for property in Camera3DProperty::ALL {
        if let Some(last) = property.track_ref(&segment.tracks).last() {
            property.write(&mut pose, last.value);
        }
    }
    pose
}

/// `camera3DPosesEqual` (`three-d.ts:1244-1250`).
pub fn poses_equal(a: &Camera3DProperties, b: &Camera3DProperties) -> bool {
    Camera3DProperty::ALL
        .iter()
        .all(|property| (property.read(a) - property.read(b)).abs() < MOTION_STILL_EPSILON)
}

/// `setMotion` (`three-d.ts:1268-1290`): write the pose pair into the
/// per-property tracks the renderer reads. A property that does not move keeps
/// no keyframes at all, so a still shot stores as a plain base pose.
pub fn set_motion(
    segment: &mut Camera3DSegment,
    start: &Camera3DProperties,
    end: &Camera3DProperties,
    easing: ([f64; 2], [f64; 2]),
) {
    let length = (segment.end - segment.start).max(0.);
    for property in Camera3DProperty::ALL {
        let from = property.read(start);
        let to = property.read(end);
        property.write(&mut segment.properties, from);
        let track = property.track(&mut segment.tracks);
        if (from - to).abs() < MOTION_STILL_EPSILON {
            track.clear();
            continue;
        }
        *track = vec![
            Camera3DKeyframe {
                time: 0.,
                value: from,
                out_easing: Some(easing.0),
                in_easing: None,
            },
            Camera3DKeyframe {
                time: length,
                value: to,
                out_easing: None,
                in_easing: Some(easing.1),
            },
        ];
    }
}

/// `getMotionEasing` (`three-d.ts:1306-1322`): read the curve back off the
/// first animated camera track. Anything unrecognised reads as Linear.
pub fn motion_easing(segment: &Camera3DSegment) -> usize {
    const EPSILON: f64 = 1e-3;
    let matches =
        |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() <= EPSILON && (a[1] - b[1]).abs() <= EPSILON;
    for property in Camera3DProperty::ALL {
        let track = property.track_ref(&segment.tracks);
        if track.len() < 2 {
            continue;
        }
        let out = track[0].out_easing.unwrap_or([0., 0.]);
        let into = track[track.len() - 1].in_easing.unwrap_or([1., 1.]);
        return MOTION_EASINGS
            .iter()
            .position(|(_, _, easing_out, easing_in)| {
                matches(*easing_out, out) && matches(*easing_in, into)
            })
            .unwrap_or(0);
    }
    0
}

/// `flipCamera3DSegment` (`three-d.ts:608-641`).
pub fn flip_segment(segment: &mut Camera3DSegment, horizontal: bool) {
    let negated: [Camera3DProperty; 4] = if horizontal {
        [
            Camera3DProperty::TiltY,
            Camera3DProperty::RotateY,
            Camera3DProperty::Roll,
            Camera3DProperty::PanX,
        ]
    } else {
        [
            Camera3DProperty::TiltX,
            Camera3DProperty::RotateX,
            Camera3DProperty::Roll,
            Camera3DProperty::PanY,
        ]
    };
    for property in negated {
        let value = property.read(&segment.properties);
        property.write(&mut segment.properties, -value);
        for keyframe in property.track(&mut segment.tracks) {
            keyframe.value = -keyframe.value;
        }
    }

    if horizontal {
        segment.blur.focus_x = 1. - segment.blur.focus_x;
        for keyframe in &mut segment.tracks.blur_focus_x {
            keyframe.value = 1. - keyframe.value;
        }
    } else {
        segment.blur.focus_y = 1. - segment.blur.focus_y;
        for keyframe in &mut segment.tracks.blur_focus_y {
            keyframe.value = 1. - keyframe.value;
        }
    }

    let mirror = |value: f64| {
        let flipped = if horizontal { 180. - value } else { -value };
        ((flipped % 360.) + 360.) % 360.
    };
    segment.blur.angle = mirror(segment.blur.angle);
    for keyframe in &mut segment.tracks.blur_angle {
        keyframe.value = mirror(keyframe.value);
    }
}

// ---------------------------------------------------------------------------
// Mask effect encoding
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskEffect {
    Blur,
    Pixelate,
}

/// `normalizeMaskEffectAmount` (`masks.ts:52-62`).
fn normalize_mask_amount(amount: f64) -> f64 {
    let contract = mask_effect_contract();
    if !amount.is_finite() || amount <= 0. {
        return contract.default_amount;
    }
    amount.clamp(contract.min_amount, contract.max_amount)
}

/// `encodeMaskEffect` (`masks.ts:64-70`): blur is stored above an offset so an
/// older build reads it as strong pixelation and the masked content stays
/// private.
pub fn encode_mask_effect(effect: MaskEffect, amount: f64) -> f64 {
    let amount = normalize_mask_amount(amount);
    match effect {
        MaskEffect::Blur => mask_effect_contract().blur_encoding_offset + amount,
        MaskEffect::Pixelate => amount,
    }
}

/// `getMaskEffect` (`masks.ts:72-73`).
pub fn mask_effect(segment: &MaskSegment) -> MaskEffect {
    if segment.pixelation >= mask_effect_contract().blur_encoding_offset {
        MaskEffect::Blur
    } else {
        MaskEffect::Pixelate
    }
}

/// `getMaskEffectAmount` (`masks.ts:75-83`).
pub fn mask_effect_amount(segment: &MaskSegment) -> f64 {
    let contract = mask_effect_contract();
    let stored = if segment.pixelation.is_finite() {
        segment.pixelation
    } else {
        contract.default_amount
    };
    let decoded = match mask_effect(segment) {
        MaskEffect::Blur => stored - contract.blur_encoding_offset,
        MaskEffect::Pixelate => stored,
    };
    normalize_mask_amount(decoded)
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

/// Every slider a segment panel draws. The segment index rides on
/// [`SliderKey::Panel`] rather than in here, because a multi-select draws one
/// panel per segment and each row needs its own track rect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelSlider {
    Image(ImageProperty),
    StyleCameraOnlyPadding,
    ZoomAmount,
    /// The multi-zoom panel's single Amount slider, which writes every selected
    /// segment at once.
    ZoomAmountAll,

    TextLayoutTransition,
    TextFontSize,
    TextLineHeight,
    TextLetterSpacing,
    TextOpacity,
    TextShadow,
    TextAnimInDuration,
    TextAnimOutDuration,

    AudioVolume,
    AudioFadeIn,
    AudioFadeOut,

    KeyboardFade,

    MaskAmount,
    MaskDarkness,
    MaskFade,

    SceneTransitionIn,
    SceneTransitionOut,
    SceneScreenZoom,
    SceneCameraZoom,

    Camera3DPose(Camera3DProperty),
    Camera3DBlur(Camera3DBlurKey),
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

/// Every text field the sidebar can show that is not an `RgbInput`. Created on
/// the first frame that draws it, because `TextInputState` needs a `&mut
/// Window` and the sidebar's render chain is threaded with `&self`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FieldKey {
    StyleName(usize),
    ImageName(usize),
    StyleCrop(usize, u8),
    /// `HexColorInput`s, which live on the sidebar's `ColorTarget` map and are
    /// listed here only so a tab can name one.
    CaptionColor,
    CaptionBackground,
    CaptionHighlight,
    KeyboardColor,
    KeyboardBackground,

    /// The multi-line `<textarea>`s.
    TextContent(usize),
    CaptionText(usize),
    /// Single-line names and labels.
    AudioName(usize),
    KeyboardText(usize),
    /// `<Input type="number">` boxes.
    CaptionStart(usize),
    CaptionEnd(usize),
    KeyboardStart(usize),
    KeyboardEnd(usize),
    /// Kobalte `NumberField`s.
    Camera3DEaseIn(usize),
    Camera3DEaseOut(usize),
    SyncOffset(usize, OffsetKind),
    /// The crop dialog's four `BoundInput`s (`Editor.tsx:1199-1216`). They do
    /// not edit the project at all -- they drive the open cropper, which is
    /// why they are the one key whose value comes from outside
    /// `project.timeline`.
    Crop(crate::editor_crop::CropField),
}

impl FieldKey {
    /// Which of the five hex fields this key is, if any.
    pub fn color_target(self) -> Option<ColorTarget> {
        Some(match self {
            Self::CaptionColor => ColorTarget::CaptionColor,
            Self::CaptionBackground => ColorTarget::CaptionBackground,
            Self::CaptionHighlight => ColorTarget::CaptionHighlight,
            Self::KeyboardColor => ColorTarget::KeyboardColor,
            Self::KeyboardBackground => ColorTarget::KeyboardBackground,
            _ => return None,
        })
    }

    fn multi_line(self) -> bool {
        matches!(self, Self::TextContent(_) | Self::CaptionText(_))
    }
}

impl EditorWindow {
    pub(crate) fn field(&self, key: FieldKey) -> Option<&Entity<ui::TextInputState>> {
        self.fields.get(&key)
    }

    /// Create the field on first sight and subscribe to it.
    pub(crate) fn ensure_field(
        &mut self,
        key: FieldKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.fields.contains_key(&key) {
            return;
        }
        let input = cx.new(|cx| {
            if key.multi_line() {
                ui::TextInputState::multi_line(window, cx)
            } else {
                ui::TextInputState::single_line(window, cx)
            }
        });
        self.push_text_subscription(cx.subscribe_in(
            &input,
            window,
            move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_field_event(key, event, window, cx)
            },
        ));
        self.fields.insert(key, input);
    }

    /// The `createWritableMemo` half: re-derive a field's text whenever the
    /// value moves under it (an undo, a preset, a timeline drag), but never
    /// while it has focus. Runs from `render`, like `sync_hex_inputs`, because
    /// the focus test needs a `&Window`.
    pub(crate) fn sync_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (key, input) in self.fields.clone() {
            if input.read(cx).focus_handle().is_focused(window) {
                continue;
            }
            let Some(value) = self.field_value(key) else {
                continue;
            };
            if input.read(cx).text() != value {
                input.update(cx, |input, cx| input.set_text(value, cx));
            }
        }
    }

    /// What a field should read when it is not being typed into.
    fn field_value(&self, key: FieldKey) -> Option<String> {
        // The crop boxes read the open cropper, not the project: their value
        // is `crop()[props.field]`, i.e. `realBounds` (`Editor.tsx:1182`).
        if let FieldKey::Crop(field) = key {
            let state = self.crop.as_ref()?;
            return Some(ui::format_number(field.read(state.real())));
        }
        let timeline = self.project.timeline.as_ref()?;
        Some(match key {
            FieldKey::StyleName(index) => timeline.style_segments.get(index)?.name.clone(),
            FieldKey::ImageName(index) => timeline.image_segments.get(index)?.name.clone(),
            FieldKey::StyleCrop(index, axis) => {
                let background = timeline
                    .style_segments
                    .get(index)?
                    .overrides
                    .background
                    .as_ref()?;
                let (width, height) = self.display_resolution()?;
                let crop = background.crop.clone().unwrap_or(cap_project::Crop {
                    position: XY::new(0, 0),
                    size: XY::new(width, height),
                });
                match axis {
                    0 => crop.position.x,
                    1 => crop.position.y,
                    2 => crop.size.x,
                    _ => crop.size.y,
                }
                .to_string()
            }
            FieldKey::TextContent(index) => timeline.text_segments.get(index)?.content.clone(),
            FieldKey::CaptionText(index) => timeline.caption_segments.get(index)?.text.clone(),
            FieldKey::AudioName(index) => timeline
                .audio_segments
                .get(index)?
                .name
                .clone()
                .unwrap_or_default(),
            FieldKey::KeyboardText(index) => {
                timeline.keyboard_segments.get(index)?.display_text.clone()
            }
            // `value={props.segment.start.toFixed(2)}` on all four.
            FieldKey::CaptionStart(index) => {
                format!("{:.2}", timeline.caption_segments.get(index)?.start)
            }
            FieldKey::CaptionEnd(index) => {
                format!("{:.2}", timeline.caption_segments.get(index)?.end)
            }
            FieldKey::KeyboardStart(index) => {
                format!("{:.2}", timeline.keyboard_segments.get(index)?.start)
            }
            FieldKey::KeyboardEnd(index) => {
                format!("{:.2}", timeline.keyboard_segments.get(index)?.end)
            }
            FieldKey::Camera3DEaseIn(index) => {
                ui::format_number(timeline.camera3d_segments.get(index)?.transition_in)
            }
            FieldKey::Camera3DEaseOut(index) => {
                ui::format_number(timeline.camera3d_segments.get(index)?.transition_out)
            }
            // `Math.round((props.value ?? 0) * 1000)` -- the offset field is in
            // milliseconds (`:6182`).
            FieldKey::SyncOffset(clip, kind) => {
                let offset = self
                    .project
                    .clips
                    .iter()
                    .find(|item| item.index as usize == clip)
                    .map_or(0., |item| kind.read(&item.offsets));
                ui::format_number(f64::from((offset * 1000.).round()))
            }
            _ => return None,
        })
    }

    /// A live keystroke in a segment field.
    ///
    /// **Why the history bracket.** Each keystroke is its own `setProject` in
    /// the source, so each is its own undo entry there. Here a typing run is
    /// bracketed by `history.pause()` / `resume()` and lands as **one** entry,
    /// which is the [colour panel's](crate::editor_sidebar) contract applied to
    /// the same kind of gesture -- and it has to be, because `ui::TextInput`
    /// carries its own field-scoped Cmd-Z (it is a real field, not an
    /// append-only stand-in), so character-level undo already exists inside the
    /// box. Without the bracket, Cmd-Z with the field blurred would walk back
    /// one character at a time through a paragraph.
    fn on_field_event(
        &mut self,
        key: FieldKey,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                self.begin_field_edit(key);
                self.commit_field(key, false, window, cx);
            }
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                self.commit_field(key, true, window, cx);
                self.end_field_edit(cx);
                let focus = self.focus_handle_for_menu();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => {
                self.commit_field(key, true, window, cx);
                self.end_field_edit(cx);
            }
        }
    }

    fn begin_field_edit(&mut self, key: FieldKey) {
        // The crop boxes never write the project, and a bracket held open by a
        // focused box would swallow Save's single history entry.
        if matches!(key, FieldKey::Crop(_)) {
            return;
        }
        if self.field_editing == Some(key) {
            return;
        }
        // A different field taking over closes the previous bracket first.
        if self.field_editing.is_some() {
            let config = self.project.clone();
            self.history.resume(&config);
        }
        self.history.pause();
        self.field_editing = Some(key);
    }

    pub(crate) fn end_field_edit(&mut self, cx: &mut Context<Self>) {
        if self.field_editing.take().is_some() {
            let config = self.project.clone();
            self.history.resume(&config);
            cx.notify();
        }
    }

    fn commit_field(
        &mut self,
        key: FieldKey,
        final_commit: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(input) = self.field(key).cloned() else {
            return;
        };
        let text = input.read(cx).text().to_string();
        match key {
            FieldKey::StyleName(index) | FieldKey::ImageName(index) => {
                let style = matches!(key, FieldKey::StyleName(_));
                self.edit_project("segment-name", window, cx, move |project| {
                    let Some(timeline) = project.timeline.as_mut() else {
                        return false;
                    };
                    let name = if style {
                        timeline
                            .style_segments
                            .get_mut(index)
                            .map(|segment| &mut segment.name)
                    } else {
                        timeline
                            .image_segments
                            .get_mut(index)
                            .map(|segment| &mut segment.name)
                    };
                    let Some(name) = name else {
                        return false;
                    };
                    if *name == text {
                        return false;
                    }
                    *name = text;
                    true
                });
            }
            FieldKey::StyleCrop(index, axis) => {
                if !final_commit {
                    return;
                }
                let Some(value) = ui::parse_number(&text).filter(|value| value.is_finite()) else {
                    return;
                };
                let Some((width, height)) = self.display_resolution() else {
                    return;
                };
                self.edit_style_segment("style-crop", index, window, cx, move |segment| {
                    let Some(background) = segment.overrides.background.as_mut() else {
                        return false;
                    };
                    let crop = background.crop.get_or_insert(cap_project::Crop {
                        position: XY::new(0, 0),
                        size: XY::new(width, height),
                    });
                    let value = value.max(0.) as u32;
                    match axis {
                        0 => crop.position.x = value.min(width.saturating_sub(1)),
                        1 => crop.position.y = value.min(height.saturating_sub(1)),
                        2 => crop.size.x = value.max(1),
                        _ => crop.size.y = value.max(1),
                    }
                    crop.size.x = crop
                        .size
                        .x
                        .min(width.saturating_sub(crop.position.x))
                        .max(1);
                    crop.size.y = crop
                        .size
                        .y
                        .min(height.saturating_sub(crop.position.y))
                        .max(1);
                    true
                });
            }
            // `onRawValueChange={(v) => cropperRef?.setCropProperty(field, v)}`
            // -- per keystroke, straight into the cropper, no project write
            // and so no history entry (`Editor.tsx:1186`).
            FieldKey::Crop(field) => {
                let Some(value) = ui::parse_number(&text) else {
                    return;
                };
                if let Some(state) = self.crop.as_mut() {
                    state.set_property(field, value);
                }
                self.publish_crop_preview();
                cx.notify();
            }
            FieldKey::TextContent(index) => {
                self.edit_text_segment("text-content", index, window, cx, move |segment| {
                    if segment.content == text {
                        return false;
                    }
                    segment.content = text;
                    true
                });
            }
            FieldKey::CaptionText(index) => {
                self.edit_caption_segment("caption-text", index, window, cx, move |segment| {
                    if segment.text == text {
                        return false;
                    }
                    segment.text = text;
                    true
                });
            }
            FieldKey::AudioName(index) => {
                self.edit_audio_segment("audio-name", index, window, cx, move |segment| {
                    if segment.name.as_deref() == Some(text.as_str()) {
                        return false;
                    }
                    segment.name = Some(text);
                    true
                });
            }
            FieldKey::KeyboardText(index) => {
                self.edit_keyboard_segment("keyboard-text", index, window, cx, move |segment| {
                    if segment.display_text == text {
                        return false;
                    }
                    segment.display_text = text;
                    true
                });
            }
            // The four `<Input type="number">` boxes commit `onChange`, which
            // in Solid is the *change* event -- blur or Enter, not every
            // keystroke (`:4280-4290`). So they only write on a final commit.
            FieldKey::CaptionStart(index) | FieldKey::CaptionEnd(index) => {
                if !final_commit {
                    return;
                }
                let Some(value) = ui::parse_number(&text) else {
                    return;
                };
                let start = matches!(key, FieldKey::CaptionStart(_));
                self.edit_caption_segment("caption-timing", index, window, cx, move |segment| {
                    if start {
                        segment.start = value;
                    } else {
                        segment.end = value;
                    }
                    true
                });
            }
            FieldKey::KeyboardStart(index) | FieldKey::KeyboardEnd(index) => {
                if !final_commit {
                    return;
                }
                let Some(value) = ui::parse_number(&text) else {
                    return;
                };
                let start = matches!(key, FieldKey::KeyboardStart(_));
                self.edit_keyboard_segment("keyboard-timing", index, window, cx, move |segment| {
                    if start {
                        segment.start = value;
                    } else {
                        segment.end = value;
                    }
                    true
                });
            }
            // Kobalte's `NumberField` fires `onRawValueChange` per keystroke,
            // and its `onBlur` falls back to 0 for anything unparseable.
            FieldKey::Camera3DEaseIn(index) | FieldKey::Camera3DEaseOut(index) => {
                let (min, max, _) = CAMERA3D_TRANSITION_LIMITS;
                let value = match ui::parse_number(&text) {
                    Some(value) => value.clamp(min, max),
                    None if final_commit => 0.,
                    None => return,
                };
                let ease_in = matches!(key, FieldKey::Camera3DEaseIn(_));
                self.edit_camera3d_segment("camera3d-ease", index, window, cx, move |segment| {
                    if ease_in {
                        if (segment.transition_in - value).abs() < f64::EPSILON {
                            return false;
                        }
                        segment.transition_in = value;
                    } else {
                        if (segment.transition_out - value).abs() < f64::EPSILON {
                            return false;
                        }
                        segment.transition_out = value;
                    }
                    true
                });
            }
            FieldKey::SyncOffset(clip, kind) => {
                let value = match ui::parse_number(&text) {
                    Some(value) => value,
                    None if final_commit => 0.,
                    None => return,
                };
                self.set_clip_offset(clip, kind, value, window, cx);
            }
            _ => {}
        }
    }

    /// `setOffset` (`:6090-6110`): find or create the clip's entry, write the
    /// offset **in seconds**, and clear the auto-calculated flag.
    pub(crate) fn set_clip_offset(
        &mut self,
        clip: usize,
        kind: OffsetKind,
        milliseconds: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !milliseconds.is_finite() {
            return;
        }
        self.edit_project("clip-offset", window, cx, move |project| {
            let entry = match project
                .clips
                .iter_mut()
                .position(|item| item.index as usize == clip)
            {
                Some(position) => &mut project.clips[position],
                None => {
                    project.clips.push(cap_project::ClipConfiguration {
                        index: clip as u32,
                        ..Default::default()
                    });
                    project.clips.last_mut().expect("just pushed")
                }
            };
            let next = (milliseconds / 1000.) as f32;
            if (kind.read(&entry.offsets) - next).abs() < f32::EPSILON
                && !entry.offsets_auto_calculated
            {
                return false;
            }
            kind.write(&mut entry.offsets, next);
            entry.offsets_auto_calculated = false;
            true
        });
    }
}

// ---------------------------------------------------------------------------
// Per-track edit helpers
// ---------------------------------------------------------------------------

macro_rules! segment_editor {
    ($name:ident, $track:ident, $ty:ty) => {
        impl EditorWindow {
            pub(crate) fn $name(
                &mut self,
                reason: &'static str,
                index: usize,
                window: &mut Window,
                cx: &mut Context<Self>,
                change: impl FnOnce(&mut $ty) -> bool,
            ) {
                self.edit_project(reason, window, cx, move |project| {
                    let Some(timeline) = project.timeline.as_mut() else {
                        return false;
                    };
                    let Some(segment) = timeline.$track.get_mut(index) else {
                        return false;
                    };
                    change(segment)
                });
            }
        }
    };
}

segment_editor!(edit_text_segment, text_segments, TextSegment);
segment_editor!(
    edit_style_segment,
    style_segments,
    cap_project::StyleSegment
);
segment_editor!(
    edit_image_segment,
    image_segments,
    cap_project::ImageSegment
);
segment_editor!(edit_audio_segment, audio_segments, AudioTrackSegment);

impl EditorWindow {
    /// The captions editor is hand-written where its siblings use the macro:
    /// after the track-segment change, the edit is routed back onto the
    /// source-time caption master (`updateSelectedCaption`,
    /// `CaptionsTab.tsx:257-315`) so the re-derivation that follows every
    /// clip edit cannot revert it.
    pub(crate) fn edit_caption_segment(
        &mut self,
        reason: &'static str,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut CaptionTrackSegment) -> bool,
    ) {
        let recording_durations = self
            .summary()
            .map(|summary| summary.clip_display_durations.clone())
            .unwrap_or_default();
        self.edit_project(reason, window, cx, move |project| {
            let Some(timeline) = project.timeline.as_mut() else {
                return false;
            };
            let Some(segment) = timeline.caption_segments.get_mut(index) else {
                return false;
            };
            if !change(segment) {
                return false;
            }
            crate::transcription::write_caption_edit_to_source(
                project,
                index,
                &recording_durations,
            );
            true
        });
    }
}
segment_editor!(
    edit_keyboard_segment,
    keyboard_segments,
    KeyboardTrackSegment
);
segment_editor!(edit_mask_segment, mask_segments, MaskSegment);
segment_editor!(edit_scene_segment, scene_segments, SceneSegment);
segment_editor!(edit_zoom_segment, zoom_segments, ZoomSegment);
segment_editor!(edit_camera3d_segment, camera3d_segments, Camera3DSegment);

// ---------------------------------------------------------------------------
// Slider dispatch
// ---------------------------------------------------------------------------

impl EditorWindow {
    fn timeline(&self) -> Option<&TimelineConfiguration> {
        self.project.timeline.as_ref()
    }

    pub(crate) fn panel_slider_limits(&self, slider: PanelSlider, index: usize) -> (f32, f32, f32) {
        match slider {
            PanelSlider::Image(property) => property.limits(),
            PanelSlider::StyleCameraOnlyPadding => (0., 40., 1.),
            // `minValue={1} maxValue={4.5} step={0.001}` (`:5601-5603`).
            PanelSlider::ZoomAmount | PanelSlider::ZoomAmountAll => (1., 4.5, 0.001),
            PanelSlider::TextLayoutTransition => (0.1, 1.5, 0.05),
            PanelSlider::TextFontSize => (TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX, 1.),
            PanelSlider::TextLineHeight => (0.8, 2., 0.05),
            PanelSlider::TextLetterSpacing => (-2., 20., 0.5),
            PanelSlider::TextOpacity | PanelSlider::TextShadow => (0., 1., 0.01),
            PanelSlider::TextAnimInDuration | PanelSlider::TextAnimOutDuration => (0., 3., 0.05),
            PanelSlider::AudioVolume => (MIN_VOLUME_DB, MAX_VOLUME_DB, 1.),
            // `maxValue={fadeMax()}` -- `Math.max(0.1, end - start)`
            // (`:4023`).
            PanelSlider::AudioFadeIn | PanelSlider::AudioFadeOut => {
                let duration = self
                    .timeline()
                    .and_then(|timeline| timeline.audio_segments.get(index))
                    .map_or(0., |segment| (segment.end - segment.start).max(0.));
                (0., (duration.max(0.1)) as f32, 0.05)
            }
            PanelSlider::KeyboardFade => (0., 50., 1.),
            // `minValue={4} maxValue={80} step={1}` (`:4479-4481`).
            PanelSlider::MaskAmount => (4., 80., 1.),
            PanelSlider::MaskDarkness | PanelSlider::MaskFade => (0., 1., 0.01),
            PanelSlider::SceneTransitionIn | PanelSlider::SceneTransitionOut => (0., 2., 0.05),
            PanelSlider::SceneScreenZoom | PanelSlider::SceneCameraZoom => (100., 300., 1.),
            PanelSlider::Camera3DPose(property) => property.limits(),
            PanelSlider::Camera3DBlur(key) => {
                let blur = self
                    .timeline()
                    .and_then(|timeline| timeline.camera3d_segments.get(index))
                    .map(|segment| segment.blur)
                    .unwrap_or_else(default_camera3d_blur);
                key.limits(&blur)
            }
        }
    }

    pub(crate) fn panel_slider_value(&self, slider: PanelSlider, index: usize) -> f32 {
        let Some(timeline) = self.timeline() else {
            return 0.;
        };
        match slider {
            PanelSlider::Image(property) => timeline
                .image_segments
                .get(index)
                .map_or(0., |segment| property.read(segment)),
            PanelSlider::StyleCameraOnlyPadding => timeline
                .style_segments
                .get(index)
                .and_then(|segment| segment.overrides.camera_only_padding)
                .unwrap_or(0.) as f32,
            PanelSlider::ZoomAmount => timeline
                .zoom_segments
                .get(index)
                .map_or(1., |segment| segment.amount as f32),
            // `sharedAmount() ?? averageAmount()` (`:5919`).
            PanelSlider::ZoomAmountAll => {
                let indices = self.zoom_selection_indices();
                let amounts: Vec<f64> = indices
                    .iter()
                    .filter_map(|index| timeline.zoom_segments.get(*index))
                    .map(|segment| segment.amount)
                    .collect();
                if amounts.is_empty() {
                    return 1.;
                }
                let first = amounts[0];
                if amounts.iter().all(|value| *value == first) {
                    first as f32
                } else {
                    (amounts.iter().sum::<f64>() / amounts.len() as f64) as f32
                }
            }
            PanelSlider::TextLayoutTransition
            | PanelSlider::TextFontSize
            | PanelSlider::TextLineHeight
            | PanelSlider::TextLetterSpacing
            | PanelSlider::TextOpacity
            | PanelSlider::TextShadow
            | PanelSlider::TextAnimInDuration
            | PanelSlider::TextAnimOutDuration => {
                let Some(segment) = timeline.text_segments.get(index) else {
                    return 0.;
                };
                let (min, max, _) = self.panel_slider_limits(slider, index);
                let raw = match slider {
                    PanelSlider::TextLayoutTransition => segment.layout_transition as f32,
                    PanelSlider::TextFontSize => segment.font_size,
                    PanelSlider::TextLineHeight => segment.line_height,
                    PanelSlider::TextLetterSpacing => segment.letter_spacing,
                    PanelSlider::TextOpacity => segment.opacity,
                    PanelSlider::TextShadow => segment.shadow,
                    PanelSlider::TextAnimInDuration => segment.animation_in_duration as f32,
                    _ => segment.animation_out_duration as f32,
                };
                // Every text row reads through `clampNumber`.
                raw.clamp(min, max)
            }
            PanelSlider::AudioVolume | PanelSlider::AudioFadeIn | PanelSlider::AudioFadeOut => {
                let Some(segment) = timeline.audio_segments.get(index) else {
                    return 0.;
                };
                let (min, max, _) = self.panel_slider_limits(slider, index);
                match slider {
                    PanelSlider::AudioVolume => segment.volume_db.clamp(min, max),
                    PanelSlider::AudioFadeIn => (segment.fade_in as f32).clamp(min, max),
                    _ => (segment.fade_out as f32).clamp(min, max),
                }
            }
            // `(fadeDurationOverride ?? 0.15) * 100` (`:4218`).
            PanelSlider::KeyboardFade => timeline
                .keyboard_segments
                .get(index)
                .map_or(15., |segment| {
                    segment.fade_duration_override.unwrap_or(0.15) * 100.
                }),
            PanelSlider::MaskAmount => timeline
                .mask_segments
                .get(index)
                .map_or(4., |segment| mask_effect_amount(segment) as f32),
            PanelSlider::MaskDarkness => timeline
                .mask_segments
                .get(index)
                .map_or(0., |segment| segment.darkness as f32),
            PanelSlider::MaskFade => timeline
                .mask_segments
                .get(index)
                .map_or(0.15, |segment| segment.fade_duration as f32),
            PanelSlider::SceneTransitionIn => timeline
                .scene_segments
                .get(index)
                .map_or(0.3, |segment| segment.transition_in as f32),
            PanelSlider::SceneTransitionOut => timeline
                .scene_segments
                .get(index)
                .map_or(0.3, |segment| segment.transition_out as f32),
            // `split().screenZoom * 100` (`:6449`).
            PanelSlider::SceneScreenZoom => {
                timeline.scene_segments.get(index).map_or(100., |segment| {
                    (segment.split_layout.unwrap_or_default().screen_zoom * 100.) as f32
                })
            }
            PanelSlider::SceneCameraZoom => {
                timeline.scene_segments.get(index).map_or(100., |segment| {
                    (segment.split_layout.unwrap_or_default().camera_zoom * 100.) as f32
                })
            }
            PanelSlider::Camera3DPose(property) => {
                timeline.camera3d_segments.get(index).map_or(0., |segment| {
                    let pose = if self.sidebar.editing_end_pose {
                        end_pose(segment)
                    } else {
                        start_pose(segment)
                    };
                    property.read(&pose) as f32
                })
            }
            PanelSlider::Camera3DBlur(key) => timeline
                .camera3d_segments
                .get(index)
                .map_or(0., |segment| key.read(&segment.blur)),
        }
    }

    pub(crate) fn apply_panel_slider(
        &mut self,
        slider: PanelSlider,
        index: usize,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match slider {
            PanelSlider::Image(property) => {
                self.edit_image_segment("image-transform", index, window, cx, move |segment| {
                    property.write(segment, value);
                    true
                })
            }
            PanelSlider::StyleCameraOnlyPadding => {
                self.edit_style_segment("camera-only-padding", index, window, cx, move |segment| {
                    segment.overrides.camera_only_padding = Some(f64::from(value.clamp(0., 40.)));
                    true
                })
            }
            PanelSlider::ZoomAmount => {
                self.edit_zoom_segment("zoom-amount", index, window, cx, move |segment| {
                    segment.amount = f64::from(value);
                    true
                })
            }
            // `setAllAmounts` (`:5929-5933`): one batch across the selection.
            PanelSlider::ZoomAmountAll => {
                let indices = self.zoom_selection_indices();
                self.edit_project("zoom-amount-all", window, cx, move |project| {
                    let Some(timeline) = project.timeline.as_mut() else {
                        return false;
                    };
                    let mut changed = false;
                    for index in indices {
                        if let Some(segment) = timeline.zoom_segments.get_mut(index) {
                            segment.amount = f64::from(value);
                            changed = true;
                        }
                    }
                    changed
                });
            }
            PanelSlider::TextLayoutTransition
            | PanelSlider::TextFontSize
            | PanelSlider::TextLineHeight
            | PanelSlider::TextLetterSpacing
            | PanelSlider::TextOpacity
            | PanelSlider::TextShadow => {
                self.edit_text_segment("text-slider", index, window, cx, move |segment| {
                    match slider {
                        PanelSlider::TextLayoutTransition => {
                            segment.layout_transition = f64::from(value.clamp(0.1, 1.5))
                        }
                        PanelSlider::TextFontSize => {
                            // The box scales with the font, top edge fixed
                            // (`:3800-3818`).
                            let next = value.clamp(TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX);
                            let previous = if segment.font_size == 0. {
                                48.
                            } else {
                                segment.font_size
                            };
                            let scale = f64::from(next / previous);
                            segment.font_size = next;
                            let top = segment.center.y - segment.size.y / 2.;
                            segment.size.x = (segment.size.x * scale).min(1.);
                            segment.size.y *= scale;
                            segment.center.y = top + segment.size.y / 2.;
                        }
                        PanelSlider::TextLineHeight => segment.line_height = value.clamp(0.8, 2.),
                        PanelSlider::TextLetterSpacing => {
                            segment.letter_spacing = value.clamp(-2., 20.)
                        }
                        PanelSlider::TextOpacity => segment.opacity = value.clamp(0., 1.),
                        _ => segment.shadow = value.clamp(0., 1.),
                    }
                    true
                })
            }
            // `setAnimationDuration` (`:3644-3656`): the legacy symmetric
            // `fadeDuration` tracks the slower edge so a project opened in an
            // old build still fades sensibly.
            PanelSlider::TextAnimInDuration | PanelSlider::TextAnimOutDuration => {
                let value = f64::from(value.clamp(0., 3.));
                let is_in = slider == PanelSlider::TextAnimInDuration;
                self.edit_text_segment("text-animation", index, window, cx, move |segment| {
                    if is_in {
                        segment.animation_in_duration = value;
                    } else {
                        segment.animation_out_duration = value;
                    }
                    segment.fade_duration = segment
                        .animation_in_duration
                        .max(segment.animation_out_duration);
                    true
                })
            }
            PanelSlider::AudioVolume | PanelSlider::AudioFadeIn | PanelSlider::AudioFadeOut => {
                self.edit_audio_segment("audio-slider", index, window, cx, move |segment| {
                    let duration = (segment.end - segment.start).max(0.);
                    match slider {
                        PanelSlider::AudioVolume => {
                            segment.volume_db = value.clamp(MIN_VOLUME_DB, MAX_VOLUME_DB)
                        }
                        // The *write* clamps to the real duration, not to the
                        // slider's `max(0.1, ..)` floor (`:4110`).
                        PanelSlider::AudioFadeIn => {
                            segment.fade_in = f64::from(value).clamp(0., duration)
                        }
                        _ => segment.fade_out = f64::from(value).clamp(0., duration),
                    }
                    true
                })
            }
            PanelSlider::KeyboardFade => {
                self.edit_keyboard_segment("keyboard-fade", index, window, cx, move |segment| {
                    segment.fade_duration_override = Some(value / 100.);
                    true
                })
            }
            // `setMaskEffectAmount` (`:4388-4393`): re-encode, and reset the
            // opacity and intensity keyframes the old model used.
            PanelSlider::MaskAmount => {
                self.edit_mask_segment("mask-amount", index, window, cx, move |segment| {
                    let effect = mask_effect(segment);
                    segment.pixelation = encode_mask_effect(effect, f64::from(value));
                    segment.opacity = 1.;
                    segment.keyframes.intensity.clear();
                    true
                })
            }
            PanelSlider::MaskDarkness | PanelSlider::MaskFade => {
                self.edit_mask_segment("mask-slider", index, window, cx, move |segment| {
                    if slider == PanelSlider::MaskDarkness {
                        segment.darkness = f64::from(value);
                    } else {
                        segment.fade_duration = f64::from(value);
                    }
                    true
                })
            }
            PanelSlider::SceneTransitionIn | PanelSlider::SceneTransitionOut => self
                .edit_scene_segment("scene-transition", index, window, cx, move |segment| {
                    if slider == PanelSlider::SceneTransitionIn {
                        segment.transition_in = f64::from(value);
                    } else {
                        segment.transition_out = f64::from(value);
                    }
                    true
                }),
            PanelSlider::SceneScreenZoom | PanelSlider::SceneCameraZoom => {
                self.edit_scene_segment("scene-zoom", index, window, cx, move |segment| {
                    let mut split = segment.split_layout.unwrap_or_default();
                    if slider == PanelSlider::SceneScreenZoom {
                        split.screen_zoom = f64::from(value) / 100.;
                    } else {
                        split.camera_zoom = f64::from(value) / 100.;
                    }
                    segment.split_layout = Some(split);
                    true
                })
            }
            // `setPoseProperty` -> `writeSelectedPose` (`:4944-4955`): a camera
            // edit on a still shot moves *both* ends, so dialling in a hold
            // never turns into an unrequested move.
            PanelSlider::Camera3DPose(property) => {
                let editing_end = self.sidebar.editing_end_pose;
                self.edit_camera3d_segment("camera3d-pose", index, window, cx, move |segment| {
                    let start = start_pose(segment);
                    let end = end_pose(segment);
                    let still = poses_equal(&start, &end);
                    let mut selected = if editing_end { end } else { start };
                    property.write(&mut selected, f64::from(value));
                    let easing_index = motion_easing(segment);
                    let (_, _, out, into) = MOTION_EASINGS[easing_index];
                    if still {
                        set_motion(segment, &selected, &selected, (out, into));
                    } else if editing_end {
                        set_motion(segment, &start, &selected, (out, into));
                    } else {
                        set_motion(segment, &selected, &end, (out, into));
                    }
                    true
                })
            }
            PanelSlider::Camera3DBlur(key) => {
                self.edit_camera3d_segment("camera3d-blur", index, window, cx, move |segment| {
                    key.write(&mut segment.blur, value);
                    true
                })
            }
        }
    }

    /// The zoom selection's indices, sorted -- the multi panel's `props.segments`
    /// order.
    fn zoom_selection_indices(&self) -> Vec<usize> {
        let mut indices = self
            .sidebar_selection()
            .filter(|selection| selection.track == TrackKind::Zoom)
            .map(|selection| selection.indices.clone())
            .unwrap_or_default();
        indices.sort_unstable();
        indices
    }
}

// ---------------------------------------------------------------------------
// Panel menus
// ---------------------------------------------------------------------------

impl EditorWindow {
    pub(crate) fn panel_menu_items(&self, kind: SidebarMenu, index: usize) -> Vec<ui::MenuItem> {
        let Some(timeline) = self.timeline() else {
            return Vec::new();
        };
        match kind {
            // `FontPicker`'s option list: the three generics, then every
            // installed family (`FontPicker.tsx:25-28`).
            SidebarMenu::TextFontFamily(_) => {
                let current = timeline
                    .text_segments
                    .get(index)
                    .map_or_else(String::new, |segment| segment.font_family.clone());
                font_picker_options()
                    .into_iter()
                    .map(|(value, label)| ui::MenuItem::new(label, value == current))
                    .collect()
            }
            SidebarMenu::TextWeight(_) => {
                let current = timeline
                    .text_segments
                    .get(index)
                    .map_or(700., |segment| segment.font_weight);
                TEXT_SEGMENT_WEIGHTS
                    .iter()
                    .map(|(weight, label)| {
                        ui::MenuItem::new(*label, (*weight - current).abs() < f32::EPSILON)
                    })
                    .collect()
            }
            SidebarMenu::TextAnimationIn(_) | SidebarMenu::TextAnimationOut(_) => {
                let segment = timeline.text_segments.get(index);
                let current = segment.map_or(TextAnimation::Fade, |segment| {
                    if matches!(kind, SidebarMenu::TextAnimationIn(_)) {
                        segment.animation_in
                    } else {
                        segment.animation_out
                    }
                });
                TEXT_ANIMATIONS
                    .iter()
                    .map(|(animation, label)| ui::MenuItem::new(*label, *animation == current))
                    .collect()
            }
            SidebarMenu::Camera3DBlurMode(_) => {
                let current = timeline
                    .camera3d_segments
                    .get(index)
                    .map_or(Camera3DBlurMode::None, |segment| segment.blur.mode);
                CAMERA3D_BLUR_MODES
                    .iter()
                    .map(|(mode, label)| ui::MenuItem::new(*label, *mode == current))
                    .collect()
            }
            SidebarMenu::Camera3DEasing(_) => {
                let current = timeline
                    .camera3d_segments
                    .get(index)
                    .map_or(0, motion_easing);
                MOTION_EASINGS
                    .iter()
                    .enumerate()
                    .map(|(index, (_, label, _, _))| ui::MenuItem::new(*label, index == current))
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    pub(crate) fn choose_panel_menu(
        &mut self,
        kind: SidebarMenu,
        segment: usize,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            SidebarMenu::TextFontFamily(_) => {
                let options = font_picker_options();
                let Some((family, _)) = options.get(index) else {
                    return;
                };
                let family = family.clone();
                self.edit_text_segment("text-font-family", segment, window, cx, move |segment| {
                    if segment.font_family == family {
                        return false;
                    }
                    segment.font_family = family;
                    true
                });
            }
            SidebarMenu::TextWeight(_) => {
                let Some((weight, _)) = TEXT_SEGMENT_WEIGHTS.get(index) else {
                    return;
                };
                let weight = *weight;
                self.edit_text_segment("text-weight", segment, window, cx, move |segment| {
                    segment.font_weight = weight;
                    true
                });
            }
            SidebarMenu::TextAnimationIn(_) | SidebarMenu::TextAnimationOut(_) => {
                let Some((animation, _)) = TEXT_ANIMATIONS.get(index) else {
                    return;
                };
                let animation = *animation;
                let is_in = matches!(kind, SidebarMenu::TextAnimationIn(_));
                self.edit_text_segment("text-animation", segment, window, cx, move |target| {
                    if is_in {
                        target.animation_in = animation;
                    } else {
                        target.animation_out = animation;
                    }
                    true
                });
            }
            SidebarMenu::Camera3DBlurMode(_) => {
                let Some((mode, _)) = CAMERA3D_BLUR_MODES.get(index) else {
                    return;
                };
                let mode = *mode;
                self.edit_camera3d_segment("camera3d-blur-mode", segment, window, cx, move |s| {
                    if s.blur.mode == mode {
                        return false;
                    }
                    seed_blur_mode(&mut s.blur, mode);
                    true
                });
            }
            SidebarMenu::Camera3DEasing(_) => {
                self.set_camera3d_easing(segment, index, window, cx);
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Position pads
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// A press on a pad: pause the history for the whole gesture, then apply
    /// the point the press itself landed on (`:6250-6262`).
    pub(crate) fn pad_mouse_down(
        &mut self,
        key: PadKey,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar.pad_drag.is_none() {
            self.history.pause();
        }
        self.sidebar.pad_drag = Some(key);
        self.pad_mouse_move(event.position, window, cx);
    }

    pub(crate) fn pad_mouse_move(
        &mut self,
        position: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = self.sidebar.pad_drag else {
            return;
        };
        let Some(bounds) = self.sidebar.pad_bounds_for(key) else {
            return;
        };
        let Some((x, y)) = ui::pad_position(position, bounds) else {
            return;
        };
        self.apply_pad(key, x, y, window, cx);
    }

    pub(crate) fn pad_mouse_up(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.pad_drag.take().is_some() {
            let config = self.project.clone();
            self.history.resume(&config);
            cx.notify();
        }
    }

    pub(crate) fn pad_dragging(&self) -> bool {
        self.sidebar.pad_drag.is_some()
    }

    fn apply_pad(
        &mut self,
        key: PadKey,
        x: f64,
        y: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match key {
            PadKey::SceneScreen(index) | PadKey::SceneCamera(index) => {
                let screen = matches!(key, PadKey::SceneScreen(_));
                self.edit_scene_segment("scene-position", index, window, cx, move |segment| {
                    let mut split = segment.split_layout.unwrap_or_default();
                    let point = XY::new(x, y);
                    if screen {
                        split.screen_position = point;
                    } else {
                        split.camera_position = point;
                    }
                    segment.split_layout = Some(split);
                    true
                })
            }
            PadKey::ZoomManual(index) => {
                self.edit_zoom_segment("zoom-position", index, window, cx, move |segment| {
                    segment.mode = ZoomMode::Manual {
                        x: x as f32,
                        y: y as f32,
                    };
                    true
                })
            }
            // `setAllManualPositions` (`:5952-5958`).
            PadKey::ZoomMulti => {
                let indices = self.zoom_selection_indices();
                self.edit_project("zoom-position-all", window, cx, move |project| {
                    let Some(timeline) = project.timeline.as_mut() else {
                        return false;
                    };
                    let mut changed = false;
                    for index in indices {
                        if let Some(segment) = timeline.zoom_segments.get_mut(index) {
                            segment.mode = ZoomMode::Manual {
                                x: x as f32,
                                y: y as f32,
                            };
                            changed = true;
                        }
                    }
                    changed
                });
            }
        }
    }

    fn pad_value(&self, key: PadKey) -> (f64, f64) {
        let Some(timeline) = self.timeline() else {
            return (0.5, 0.5);
        };
        match key {
            PadKey::SceneScreen(index) | PadKey::SceneCamera(index) => {
                let split = timeline
                    .scene_segments
                    .get(index)
                    .and_then(|segment| segment.split_layout)
                    .unwrap_or_default();
                let point = if matches!(key, PadKey::SceneScreen(_)) {
                    split.screen_position
                } else {
                    split.camera_position
                };
                (point.x, point.y)
            }
            PadKey::ZoomManual(index) => match timeline.zoom_segments.get(index).map(|s| &s.mode) {
                Some(ZoomMode::Manual { x, y }) => (f64::from(*x), f64::from(*y)),
                _ => (0.5, 0.5),
            },
            // `averageManualPosition` (`:5926-5935`).
            PadKey::ZoomMulti => {
                let positions: Vec<(f64, f64)> = self
                    .zoom_selection_indices()
                    .iter()
                    .filter_map(|index| timeline.zoom_segments.get(*index))
                    .map(|segment| match &segment.mode {
                        ZoomMode::Manual { x, y } => (f64::from(*x), f64::from(*y)),
                        ZoomMode::Auto => (0.5, 0.5),
                    })
                    .collect();
                if positions.is_empty() {
                    return (0.5, 0.5);
                }
                let count = positions.len() as f64;
                (
                    positions.iter().map(|p| p.0).sum::<f64>() / count,
                    positions.iter().map(|p| p.1).sum::<f64>() / count,
                )
            }
        }
    }

    fn render_pad(&self, key: PadKey, cx: &mut Context<Self>) -> AnyElement {
        let (x, y) = self.pad_value(key);
        ui::PositionPad::plain(
            &self.theme,
            SharedString::from(format!("pad-{key:?}")),
            x,
            y,
            self.sidebar.pad(key),
        )
        .on_press(
            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                this.pad_mouse_down(key, event, window, cx);
            }),
        )
        .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// The selection panel region (`:1077-1093`): `custom-scroll p-4 top-16
    /// left-0 right-0 bottom-0 text-[0.875rem] space-y-4`.
    ///
    /// Seven of the eight tracks draw the shared header and then one bordered
    /// card per selected segment (`p-4 rounded-lg border border-gray-200`); the
    /// scene panel is the exception in both directions -- a single selection
    /// draws `SceneSegmentConfig` bare, with its own two-button row, and a
    /// multi-selection draws the header **alone**, which is the source's own
    /// unfinished state and is reproduced rather than invented over.
    pub(crate) fn render_segment_panel(
        &self,
        selection: &Selection,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let Some(timeline) = self.timeline() else {
            return div().into_any_element();
        };

        // `.map(...).filter(item => item.segment !== undefined)` -- an index
        // the config no longer has is dropped, and an empty result clears the
        // selection (handled by `apply_history`).
        let count = |length: usize| {
            let mut indices: Vec<usize> = selection
                .indices
                .iter()
                .copied()
                .filter(|index| *index < length)
                .collect();
            indices.sort_unstable();
            indices
        };

        let body: AnyElement = match selection.track {
            TrackKind::Style => self.stacked_panel(
                "style",
                "style",
                count(timeline.style_segments.len()),
                cx,
                |this, index, cx| this.render_style_panel(index, cx),
            ),
            TrackKind::Image => self.stacked_panel(
                "image",
                "image",
                count(timeline.image_segments.len()),
                cx,
                |this, index, cx| this.render_image_panel(index, cx),
            ),
            TrackKind::Zoom => {
                let indices = count(timeline.zoom_segments.len());
                let total = timeline.zoom_segments.len();
                let selected = indices.len();
                let header = ui::SelectionHeader::plain(
                    &theme,
                    "panel-zoom",
                    ui::zoom_selection_label(selected, total),
                )
                .on_done(cx.listener(|this, _, _window, cx| this.set_selection(None, cx)))
                .on_delete(
                    cx.listener(|this, _, window, cx| this.delete_selected_segments(window, cx)),
                )
                // `<Show when={segments.length < totalZoomSegments()}>`
                .when(selected < total, |header| {
                    header.on_select_all(cx.listener(move |this, _, _window, cx| {
                        this.set_selection(
                            Some(Selection {
                                track: TrackKind::Zoom,
                                indices: (0..total).collect(),
                            }),
                            cx,
                        );
                    }))
                });

                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .child(header)
                    .child(if indices.len() == 1 {
                        self.panel_card(self.render_zoom_panel(indices[0], cx))
                    } else {
                        self.render_zoom_multi_panel(&indices, cx)
                    })
                    .into_any_element()
            }
            TrackKind::Text => self.stacked_panel(
                "text",
                "text",
                count(timeline.text_segments.len()),
                cx,
                |this, index, cx| this.render_text_panel(index, cx),
            ),
            TrackKind::Caption => self.stacked_panel(
                "caption",
                "caption",
                count(timeline.caption_segments.len()),
                cx,
                |this, index, cx| this.render_caption_panel(index, cx),
            ),
            TrackKind::Audio => self.stacked_panel(
                "audio",
                "audio",
                count(timeline.audio_segments.len()),
                cx,
                |this, index, cx| this.render_audio_panel(index, cx),
            ),
            TrackKind::Mask => self.stacked_panel(
                "mask",
                "mask",
                count(timeline.mask_segments.len()),
                cx,
                |this, index, cx| this.render_mask_panel(index, cx),
            ),
            TrackKind::Keyboard => self.stacked_panel(
                "keyboard",
                "keyboard",
                count(timeline.keyboard_segments.len()),
                cx,
                |this, index, cx| this.render_keyboard_panel(index, cx),
            ),
            // `<Show when={segments.length === 1 && segments[0]}>` -- a
            // multi-selection of 3D segments draws the header and nothing else
            // (`:1652-1665`).
            TrackKind::ThreeD => {
                let indices = count(timeline.camera3d_segments.len());
                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .child(self.panel_header("3d", "3D", indices.len(), cx))
                    .children(
                        (indices.len() == 1)
                            .then(|| self.panel_card(self.render_camera3d_panel(indices[0], cx))),
                    )
                    .into_any_element()
            }
            TrackKind::Scene => {
                let indices = count(timeline.scene_segments.len());
                if indices.len() == 1 {
                    // The single-segment case draws its own header inside the
                    // panel and has no per-segment card.
                    self.render_scene_panel(indices[0], cx)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(16.))
                        .child(self.panel_header("scene", "scene", indices.len(), cx))
                        .into_any_element()
                }
            }
            // A clip selection never reaches here -- `sidebarSelection()`
            // filters it out.
            TrackKind::Clip => div().into_any_element(),
        };

        div()
            .id("sidebar-selection")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.sidebar.scroll)
            .p(px(16.))
            .gap(px(16.))
            .text_size(px(14.))
            .child(body)
            .into_any_element()
    }

    /// The shared Done / count / Delete row.
    fn panel_header(
        &self,
        id: &'static str,
        noun: &'static str,
        count: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        ui::SelectionHeader::plain(
            &self.theme,
            SharedString::from(format!("panel-{id}")),
            ui::selection_label(noun, count),
        )
        .on_done(cx.listener(|this, _, _window, cx| this.set_selection(None, cx)))
        .on_delete(cx.listener(|this, _, window, cx| this.delete_selected_segments(window, cx)))
        .into_any_element()
    }

    /// `<div class="p-4 rounded-lg border border-gray-200">` -- the wrapper
    /// every per-segment panel sits in.
    fn panel_card(&self, content: AnyElement) -> AnyElement {
        div()
            .p(px(16.))
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(self.theme.gray_200_legacy))
            .child(content)
            .into_any_element()
    }

    fn stacked_panel(
        &self,
        id: &'static str,
        noun: &'static str,
        indices: Vec<usize>,
        cx: &mut Context<Self>,
        mut render: impl FnMut(&Self, usize, &mut Context<Self>) -> AnyElement,
    ) -> AnyElement {
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(self.panel_header(id, noun, indices.len(), cx));
        for index in indices {
            let content = render(self, index, cx);
            column = column.child(self.panel_card(content));
        }
        column.into_any_element()
    }

    /// `projectActions.delete*Segments(indices)` -- the same per-track delete
    /// the timeline's own Backspace runs, which E4 already owns, so the panel's
    /// Delete and the key press cannot diverge.
    fn delete_selected_segments(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_selection(window, cx);
    }

    // -- Zoom ---------------------------------------------------------------

    /// `ZoomSegmentConfig` (`:5577-5881`).
    fn render_zoom_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let manual = self
            .timeline()
            .and_then(|timeline| timeline.zoom_segments.get(index))
            .is_some_and(|segment| matches!(segment.mode, ZoomMode::Manual { .. }));

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, SharedString::from(format!("Zoom {}", index + 1)))
                    .icon("icons/search.svg")
                    .child(self.slider(SliderKey::Panel(PanelSlider::ZoomAmount, index), "x", cx)),
            )
            .child(
                ui::Field::plain(&theme, "Zoom Mode")
                    .icon("icons/settings.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            .child(self.zoom_mode_tabs(
                                manual,
                                cx,
                                move |this, want_manual, window, cx| {
                                    this.set_zoom_mode(index, want_manual, window, cx);
                                },
                            ))
                            .child(self.zoom_mode_helper(manual, cx))
                            .children(
                                manual.then(|| self.render_pad(PadKey::ZoomManual(index), cx)),
                            ),
                    ),
            )
            .into_any_element()
    }

    /// `ZoomMultiSegmentConfig` (`:5882-6080`): one set of controls that writes
    /// every selected segment, with a "Mixed" badge when they disagree.
    fn render_zoom_multi_panel(&self, indices: &[usize], cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(timeline) = self.timeline() else {
            return div().into_any_element();
        };
        let segments: Vec<&ZoomSegment> = indices
            .iter()
            .filter_map(|index| timeline.zoom_segments.get(*index))
            .collect();
        let amounts: Vec<f64> = segments.iter().map(|segment| segment.amount).collect();
        let mixed_amount = amounts
            .first()
            .is_some_and(|first| amounts.iter().any(|value| value != first));
        let modes: Vec<bool> = segments
            .iter()
            .map(|segment| matches!(segment.mode, ZoomMode::Manual { .. }))
            .collect();
        let shared_mode = modes
            .first()
            .copied()
            .filter(|first| modes.iter().all(|value| value == first));
        let mixed_mode = shared_mode.is_none();
        let manual = shared_mode.unwrap_or(false);
        let positions_mixed = {
            let first = segments.first().map(|segment| match &segment.mode {
                ZoomMode::Manual { x, y } => (*x, *y),
                ZoomMode::Auto => (0.5, 0.5),
            });
            first.is_some_and(|first| {
                segments.iter().any(|segment| {
                    let point = match &segment.mode {
                        ZoomMode::Manual { x, y } => (*x, *y),
                        ZoomMode::Auto => (0.5, 0.5),
                    };
                    point != first
                })
            })
        };

        let mixed_badge = |label: &'static str| {
            div()
                .px(px(6.))
                .py(px(2.))
                .rounded_full()
                .bg(Hsla::from(theme.gray_3))
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(theme.gray_11))
                .child(label)
                .into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                // `<div class="flex flex-col gap-6 p-4 rounded-lg border border-gray-200">`
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .p(px(16.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_200_legacy))
                    .child({
                        let mut field = ui::Field::plain(&theme, "Zoom Amount")
                            .icon("icons/search.svg")
                            .child(self.slider(
                                SliderKey::Panel(PanelSlider::ZoomAmountAll, 0),
                                "x",
                                cx,
                            ));
                        if mixed_amount {
                            field = field.value(mixed_badge("Mixed"));
                        }
                        field
                    })
                    .child({
                        let mut field = ui::Field::plain(&theme, "Zoom Mode")
                            .icon("icons/settings.svg")
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(16.))
                                    .child(self.zoom_mode_tabs(
                                        manual && !mixed_mode,
                                        cx,
                                        |this, want_manual, window, cx| {
                                            this.set_all_zoom_modes(want_manual, window, cx);
                                        },
                                    ))
                                    .children(
                                        (!mixed_mode).then(|| self.zoom_mode_helper(manual, cx)),
                                    )
                                    .children((manual && !mixed_mode).then(|| {
                                        div()
                                            .flex()
                                            .flex_col()
                                            .gap(px(6.))
                                            .child(self.render_pad(PadKey::ZoomMulti, cx))
                                            .children(positions_mixed.then(|| {
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(Hsla::from(theme.gray_10))
                                                    .child(
                                                        "Segments zoom into different spots. Drag \
                                                         to move them all to the same one.",
                                                    )
                                                    .into_any_element()
                                            }))
                                            .into_any_element()
                                    })),
                            );
                        if mixed_mode {
                            field = field.value(mixed_badge("Mixed"));
                        }
                        field
                    }),
            )
            // The per-segment preview grid (`:6046-6068`) is a decoded frame per
            // card; see the README's zoom-preview deviation. The remove-from-
            // selection affordance it carries is reproduced as a plain row.
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children(indices.iter().map(|index| {
                        let index = *index;
                        div()
                            .id(SharedString::from(format!("zoom-multi-{index}")))
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .p(px(10.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(Hsla::from(theme.gray_4))
                            .bg(Hsla::from(theme.gray_3))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child(SharedString::from(format!("Zoom {}", index + 1))),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("zoom-multi-remove-{index}")))
                                    .flex()
                                    .justify_center()
                                    .items_center()
                                    .size(px(20.))
                                    .rounded_full()
                                    .bg(Hsla::from(theme.gray_5))
                                    .child(
                                        svg()
                                            .path("icons/x.svg")
                                            .size(px(12.))
                                            .text_color(Hsla::from(theme.gray_11)),
                                    )
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        this.remove_from_zoom_selection(index, cx);
                                    })),
                            )
                    })),
            )
            .into_any_element()
    }

    /// The Auto / Manual tab strip (`:5619-5645`). Auto is disabled without
    /// custom cursor capture; there is no general-settings store read in this
    /// window, so the note below it is the one the source shows when it is off.
    fn zoom_mode_tabs(
        &self,
        manual: bool,
        cx: &mut Context<Self>,
        choose: impl Fn(&mut Self, bool, &mut Window, &mut Context<Self>) + 'static + Clone,
    ) -> AnyElement {
        let theme = self.theme;
        // `disabled={!generalSettings.data?.custom_cursor_capture2}` on the
        // Auto trigger (`:5633`, and `:6008` on the multi panel): auto zoom
        // follows the recorded cursor, which the studio recorder only writes
        // with custom cursor capture on. The setting is the shared Tauri
        // store's, read once when the editor opens.
        let auto_locked = !self.cursor_capture;
        let tab = |label: &'static str,
                   id: &'static str,
                   selected: bool,
                   want_manual: bool,
                   locked: bool| {
            let choose = choose.clone();
            div()
                .id(id)
                .flex_1()
                .flex()
                .justify_center()
                .py(px(10.))
                .rounded(px(9.6))
                .text_color(if selected {
                    Hsla::from(theme.gray_12)
                } else {
                    Hsla::from(theme.gray_11)
                })
                .when(locked, |this| this.opacity(0.5))
                .when(selected, |this| this.bg(Hsla::from(theme.gray_3)))
                .child(label)
                .when(!locked, |this| {
                    this.on_click(cx.listener(move |this, _, window, cx| {
                        choose(this, want_manual, window, cx);
                    }))
                })
        };

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_12))
                    .p(px(1.))
                    .child(tab("Auto", "zoom-mode-auto", !manual, false, auto_locked))
                    .child(tab("Manual", "zoom-mode-manual", manual, true, false)),
            )
            // The explainer under the tabs (`:5648-5653`, `:6024-6029`).
            .children(auto_locked.then(|| {
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child(
                        "Auto mode needs cursor capture. Enable \"Custom cursor capture \
                         (Studio)\" in Settings \u{2192} General.",
                    )
            }))
            .into_any_element()
    }

    /// `ZoomModeHelper` (`ZoomModeHelper.tsx`): a collapsible "How does it
    /// work?" with an animated illustration. The illustration's cursor path is
    /// a CSS keyframe animation, which this rev has no hook for, so the card
    /// draws the two static viewports the animation moves between.
    fn zoom_mode_helper(&self, manual: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let state = self.sidebar.section(PanelSection::ZoomHelper);
        let open = state.is_open();

        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("zoom-mode-helper")
                    .flex()
                    .flex_row()
                    .gap(px(6.))
                    .items_center()
                    .w_full()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_11))
                    .cursor_pointer()
                    .child(
                        svg()
                            .path("icons/info.svg")
                            .size(px(14.))
                            .text_color(Hsla::from(theme.gray_11)),
                    )
                    .child("How does it work?")
                    .child(
                        div().ml_auto().child(
                            svg()
                                .path(if open {
                                    "icons/chevron-down.svg"
                                } else {
                                    "icons/chevron-right.svg"
                                })
                                .size(px(14.))
                                .text_color(Hsla::from(theme.gray_11)),
                        ),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.sidebar.section(PanelSection::ZoomHelper).toggle();
                        this.animate_collapsibles(window, cx);
                    })),
            )
            .child(collapsible(
                &state,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .pt(px(8.))
                    .child(
                        div()
                            .relative()
                            .w_full()
                            .h(px(88.))
                            .rounded(px(8.))
                            .overflow_hidden()
                            .border_1()
                            .border_color(Hsla::from(theme.gray_4))
                            .bg(Hsla::from(theme.gray_3))
                            .child(
                                div()
                                    .absolute()
                                    .left(gpui::relative(if manual { 0.5 } else { 0.26 }))
                                    .top(gpui::relative(if manual { 0.5 } else { 0.36 }))
                                    .ml(px(-80.))
                                    .mt(px(-24.))
                                    .w(px(160.))
                                    .h(px(48.))
                                    .rounded(px(6.))
                                    .border_2()
                                    .border_color(crate::editor_sidebar::with_alpha(
                                        theme.blue_9,
                                        0.6,
                                    ))
                                    .bg(crate::editor_sidebar::with_alpha(theme.blue_9, 0.1)),
                            )
                            .child(
                                div()
                                    .absolute()
                                    .left(gpui::relative(0.26))
                                    .top(gpui::relative(0.36))
                                    .child(
                                        svg()
                                            .path("icons/cursor.svg")
                                            .size(px(14.))
                                            .text_color(Hsla::from(theme.gray_12)),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(if manual {
                                "Manual zoom stays on a fixed spot you pick below."
                            } else {
                                "Automatic zoom follows your cursor around the screen."
                            }),
                    )
                    .into_any_element(),
            ))
            .into_any_element()
    }

    fn set_zoom_mode(
        &mut self,
        index: usize,
        manual: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // `states.manual` keeps the last manual point for the session; a
        // segment coming from auto gets the centred default (`:5586-5590`).
        self.edit_zoom_segment("zoom-mode", index, window, cx, move |segment| {
            let next = if manual {
                match segment.mode {
                    ZoomMode::Manual { .. } => return false,
                    ZoomMode::Auto => ZoomMode::Manual { x: 0.5, y: 0.5 },
                }
            } else {
                if matches!(segment.mode, ZoomMode::Auto) {
                    return false;
                }
                ZoomMode::Auto
            };
            segment.mode = next;
            true
        });
    }

    /// `setAllModes` (`:5937-5950`): switching to manual keeps each segment's
    /// existing focal point; only segments coming from auto get the centre.
    fn set_all_zoom_modes(&mut self, manual: bool, window: &mut Window, cx: &mut Context<Self>) {
        let indices = self.zoom_selection_indices();
        self.edit_project("zoom-mode-all", window, cx, move |project| {
            let Some(timeline) = project.timeline.as_mut() else {
                return false;
            };
            let mut changed = false;
            for index in indices {
                let Some(segment) = timeline.zoom_segments.get_mut(index) else {
                    continue;
                };
                if manual {
                    if matches!(segment.mode, ZoomMode::Auto) {
                        segment.mode = ZoomMode::Manual { x: 0.5, y: 0.5 };
                        changed = true;
                    }
                } else if !matches!(segment.mode, ZoomMode::Auto) {
                    segment.mode = ZoomMode::Auto;
                    changed = true;
                }
            }
            changed
        });
    }

    /// `removeFromSelection` (`:5960-5970`).
    fn remove_from_zoom_selection(&mut self, index: usize, cx: &mut Context<Self>) {
        let remaining: Vec<usize> = self
            .zoom_selection_indices()
            .into_iter()
            .filter(|candidate| *candidate != index)
            .collect();
        let selection = (!remaining.is_empty()).then_some(Selection {
            track: TrackKind::Zoom,
            indices: remaining,
        });
        self.set_selection(selection, cx);
    }
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `HexColorInput` (`text-style.tsx:82-163`): a swatch that opens the
    /// system colour picker, and a text box that commits live at six digits.
    /// Both halves are the background tab's `RgbInput` behaviour, against a
    /// `#RRGGBB` string instead of an `[u8; 3]`.
    pub(crate) fn render_hex_field(
        &self,
        key: FieldKey,
        value: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(target) = key.color_target() else {
            return div().into_any_element();
        };
        self.render_color_input(target, value, cx)
    }

    pub(crate) fn render_color_input(
        &self,
        target: ColorTarget,
        value: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let rgb = crate::editor_sidebar::hex_to_rgb(value)
            .map(|rgba| [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16])
            .unwrap_or([255, 255, 255]);

        let mut row = div().flex().flex_row().items_center().gap(px(12.)).child(
            div()
                .id(SharedString::from(format!("swatch-{target:?}")))
                // `size-[2rem] rounded-[0.5rem]` with an inset 1px ring.
                .size(px(32.))
                .flex_none()
                .rounded(px(8.))
                .bg(crate::editor_sidebar::color_to_hsla(rgb))
                .border_1()
                .border_color(crate::editor_sidebar::preview_border_color(rgb))
                .on_click(
                    cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                        this.open_color_panel_for(target, event.position(), window, cx);
                    }),
                ),
        );

        if let Some(input) = self.hex_input(target) {
            row = row.child(
                div().flex_1().min_w_0().child(
                    ui::TextInput::plain(
                        &theme,
                        SharedString::from(format!("hex-{target:?}")),
                        input,
                    )
                    .flex(true)
                    // `px-3 py-2 rounded-lg`
                    .padding_x(px(12.))
                    .height(px(36.))
                    .text_size(px(14.))
                    .bg(Hsla::from(theme.gray_2))
                    .border(Hsla::from(theme.gray_3)),
                ),
            );
        }
        row.into_any_element()
    }

    /// One of the sidebar's plain text boxes: `px-3 py-2 rounded-lg border
    /// border-gray-3 bg-gray-2 text-gray-12`.
    pub(crate) fn render_field_input(&self, key: FieldKey, height: Option<f32>) -> AnyElement {
        let theme = self.theme;
        let Some(input) = self.field(key) else {
            return div().into_any_element();
        };
        let mut field =
            ui::TextInput::plain(&theme, SharedString::from(format!("field-{key:?}")), input)
                .flex(true)
                .padding_x(px(12.))
                .text_size(px(14.))
                .bg(Hsla::from(theme.gray_2))
                .border(Hsla::from(theme.gray_3));
        // A `<textarea>` measures its own height; a single-line box is `h-9`.
        field = match height {
            // `min-h-[80px]` / `min-h-[96px]` on the two textareas.
            Some(height) => field.height(px(height)).padding_y(px(8.)),
            None => field.height(px(36.)),
        };
        div().flex().w_full().child(field).into_any_element()
    }

    /// A Kobalte `NumberField.Input`: `w-20 p-1.5 border rounded-lg bg-gray-1`,
    /// with an optional unit label beside it.
    pub(crate) fn render_number_field(
        &self,
        key: FieldKey,
        unit: &'static str,
        width: f32,
    ) -> AnyElement {
        let theme = self.theme;
        let Some(input) = self.field(key) else {
            return div().into_any_element();
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .child(
                ui::TextInput::plain(&theme, SharedString::from(format!("number-{key:?}")), input)
                    .width(px(width))
                    .padding_x(px(6.))
                    .height(px(30.))
                    .text_size(px(14.))
                    .bg(Hsla::from(theme.gray_1))
                    .border(Hsla::from(theme.gray_12)),
            )
            .children((!unit.is_empty()).then(|| {
                div()
                    .text_color(Hsla::from(theme.gray_11))
                    .child(unit)
                    .into_any_element()
            }))
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// The six remaining panels
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `TextSegmentConfig` (`:3613-4000`).
    /// `Templates` (`ConfigSidebar.tsx:3746-3762`) over `TextPresetCard`
    /// (`:3534-3588`): a two-column grid of `h-16` cards on a
    /// `linear-gradient(135deg, #17181c, #2a2c33)`, each showing its sample in
    /// the preset's own family, weight, slant and tracking, with the name in
    /// `text-[10px] text-white/50` pinned to the bottom. The card in force
    /// takes `border-blue-9 ring-1 ring-blue-9`.
    fn render_text_presets(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let installed = installed_fonts();
        let active = self
            .timeline()
            .and_then(|timeline| timeline.text_segments.get(index))
            .and_then(|segment| match_text_preset(segment, installed));

        // `grid-cols-2 gap-2`: gpui has no grid, so the rows are explicit and
        // each cell is `flex_1`, which is what a two-column grid of equal
        // fractions resolves to.
        let card = |preset: &'static TextPreset, cx: &mut Context<Self>| {
            let style = &preset.style;
            let selected = active == Some(preset.id);
            let id = preset.id;
            // `font-size: clamp(11, fontSize * 0.22, 24)`.
            let sample_size = (style.font_size * 0.22).clamp(11., 24.);
            div()
                .id(SharedString::from(format!("text-preset-{index}-{id}")))
                // Explicit, not `flex_1` -- see `card_grid_width`.
                .w(px(CARD_GRID_WIDTH_2))
                .flex_none()
                .h(px(64.))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .relative()
                .overflow_hidden()
                .rounded(px(8.))
                .px(px(8.))
                .pb(px(12.))
                .bg(gpui::linear_gradient(
                    135.,
                    gpui::linear_color_stop(gpui::rgb(0x17181c), 0.),
                    gpui::linear_color_stop(gpui::rgb(0x2a2c33), 1.),
                ))
                .border_1()
                .border_color(if selected {
                    Hsla::from(theme.blue_9)
                } else {
                    Hsla::from(theme.gray_3)
                })
                .when(selected, |this| {
                    this.border_2().border_color(Hsla::from(theme.blue_9))
                })
                .child(
                    div()
                        .max_w_full()
                        .overflow_hidden()
                        .text_size(px(sample_size))
                        .text_color(gpui::white())
                        .font_family(preset_font_family(style.font_stack, installed))
                        .font_weight(gpui::FontWeight(style.font_weight))
                        .when(style.italic, |this| this.italic())
                        .child(preset.sample),
                )
                .child(
                    div()
                        .absolute()
                        .bottom(px(4.))
                        .text_size(px(10.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(crate::editor_sidebar::with_alpha(gpui::white(), 0.5))
                        .child(preset.name),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.apply_text_preset_to(index, id, window, cx);
                }))
                .into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(TEXT_PRESETS.chunks(2).map(|row| {
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .children(row.iter().map(|preset| card(preset, cx)))
            }))
            .into_any_element()
    }

    /// One preset applied, as one history entry.
    fn apply_text_preset_to(
        &mut self,
        index: usize,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(preset) = TEXT_PRESETS.iter().find(|preset| preset.id == id) else {
            return;
        };
        let installed = installed_fonts();
        self.edit_text_segment("text-preset", index, window, cx, move |segment| {
            apply_text_preset(segment, preset, installed);
            true
        });
    }

    fn render_text_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.text_segments.get(index))
        else {
            return div().into_any_element();
        };
        let layout = segment.layout;
        let align = segment.align;
        let italic = segment.italic;
        let enabled = segment.enabled;
        let color = segment.color.clone();
        let background_color = segment.background_color.clone();
        let background_enabled = background_color.is_some();
        let family = segment.font_family.clone();
        let weight_label = TEXT_SEGMENT_WEIGHTS
            .iter()
            .find(|(weight, _)| (*weight - segment.font_weight).abs() < f32::EPSILON)
            .map_or_else(
                || SharedString::from(format!("Custom ({})", segment.font_weight)),
                |(_, label)| SharedString::from(*label),
            );
        let animation_in = segment.animation_in;
        let animation_out = segment.animation_out;
        let in_label = TEXT_ANIMATIONS
            .iter()
            .find(|(animation, _)| *animation == animation_in)
            .map_or("Fade", |(_, label)| *label);
        let out_label = TEXT_ANIMATIONS
            .iter()
            .find(|(animation, _)| *animation == animation_out)
            .map_or("Fade", |(_, label)| *label);

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Field::plain(&theme, SharedString::from(format!("Text {}", index + 1)))
                    .icon("icons/type.svg")
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(div().flex_1().min_w_0().child(
                                self.render_field_input(FieldKey::TextContent(index), Some(80.)),
                            ))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child("Enabled"),
                                    )
                                    .child(
                                        ui::Toggle::plain(
                                            &theme,
                                            SharedString::from(format!("text-enabled-{index}")),
                                            enabled,
                                        )
                                        .on_click(
                                            cx.listener(move |this, _, window, cx| {
                                                this.edit_text_segment(
                                                    "text-enabled",
                                                    index,
                                                    window,
                                                    cx,
                                                    move |segment| {
                                                        segment.enabled = !enabled;
                                                        true
                                                    },
                                                );
                                            }),
                                        ),
                                    ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Layout")
                    .icon("icons/box-select.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                self.icon_toggle_row(
                                    SharedString::from(format!("text-layout-{index}")),
                                    TEXT_LAYOUTS
                                        .iter()
                                        .map(|(value, label, icon)| {
                                            (*icon, Some(*label), *value == layout)
                                        })
                                        .collect(),
                                    cx.listener(move |this, choice: &usize, window, cx| {
                                        let Some((value, ..)) = TEXT_LAYOUTS.get(*choice) else {
                                            return;
                                        };
                                        let value = *value;
                                        this.edit_text_segment(
                                            "text-layout",
                                            index,
                                            window,
                                            cx,
                                            move |segment| {
                                                if segment.layout == value {
                                                    return false;
                                                }
                                                segment.layout = value;
                                                // A takeover layout implies where
                                                // the text belongs (`:3672-3677`).
                                                if value == TextLayout::Fullscreen {
                                                    segment.center = XY::new(0.5, 0.5);
                                                }
                                                true
                                            },
                                        );
                                    }),
                                ),
                            )
                            .children((layout == TextLayout::Fullscreen).then(|| {
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .child(
                                        "Pauses the video while the text is shown, then resumes \
                                         where it left off.",
                                    )
                                    .into_any_element()
                            }))
                            .children((layout != TextLayout::Overlay).then(|| {
                                self.labelled_small(
                                    "Screen transition",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextLayoutTransition, index),
                                        "s",
                                        cx,
                                    )
                                    .into_any_element(),
                                )
                            })),
                    ),
            )
            // `Templates` (`:3746-3762`): eight `TextPresetCard`s in a
            // `grid-cols-2`, each drawing its sample in the preset's own family,
            // weight and tracking.
            .child(
                ui::Field::plain(&theme, "Templates")
                    .icon("icons/sparkles.svg")
                    .child(self.render_text_presets(index, cx)),
            )
            .child(
                ui::Field::plain(&theme, "Font")
                    .icon("icons/type.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            // `<FontPicker />` (`:3764-3771`).
                            .child(self.menu_select_owned(
                                SidebarMenu::TextFontFamily(index),
                                SharedString::from(format!("text-font-{index}")),
                                SharedString::from(font_family_label(&family)),
                                cx,
                            ))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(div().flex_1().min_w_0().child(self.menu_select(
                                        SidebarMenu::TextWeight(index),
                                        "text-weight",
                                        weight_label,
                                        cx,
                                    )))
                                    .child(
                                        div()
                                            .id(SharedString::from(format!("text-italic-{index}")))
                                            .flex()
                                            .justify_center()
                                            .items_center()
                                            .size(px(36.))
                                            .flex_none()
                                            .rounded(px(6.))
                                            .border_1()
                                            .border_color(if italic {
                                                Hsla::from(theme.blue_9)
                                            } else {
                                                Hsla::from(theme.gray_3)
                                            })
                                            .when(italic, |this| {
                                                this.bg(crate::editor_sidebar::with_alpha(
                                                    theme.blue_9,
                                                    0.1,
                                                ))
                                            })
                                            .when(!italic, |this| this.bg(Hsla::from(theme.gray_2)))
                                            .child(
                                                svg()
                                                    .path("icons/italic.svg")
                                                    .size(px(16.))
                                                    .text_color(if italic {
                                                        Hsla::from(theme.blue_9)
                                                    } else {
                                                        Hsla::from(theme.gray_11)
                                                    }),
                                            )
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.edit_text_segment(
                                                    "text-italic",
                                                    index,
                                                    window,
                                                    cx,
                                                    move |segment| {
                                                        segment.italic = !italic;
                                                        true
                                                    },
                                                );
                                            })),
                                    ),
                            )
                            .child(
                                self.labelled_small(
                                    "Size",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextFontSize, index),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Layout")
                    .icon("icons/align-center.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                self.icon_toggle_row(
                                    SharedString::from(format!("text-align-{index}")),
                                    TEXT_ALIGNS
                                        .iter()
                                        .map(|(value, icon)| (*icon, None, *value == align))
                                        .collect(),
                                    cx.listener(move |this, choice: &usize, window, cx| {
                                        let Some((value, _)) = TEXT_ALIGNS.get(*choice) else {
                                            return;
                                        };
                                        let value = *value;
                                        this.edit_text_segment(
                                            "text-align",
                                            index,
                                            window,
                                            cx,
                                            move |segment| {
                                                segment.align = value;
                                                true
                                            },
                                        );
                                    }),
                                ),
                            )
                            .child(
                                self.labelled_small(
                                    "Line height",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextLineHeight, index),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            )
                            .child(
                                self.labelled_small(
                                    "Letter spacing",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextLetterSpacing, index),
                                        "px",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Color")
                    .icon("icons/palette.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.render_color_input(
                                ColorTarget::TextColor(index),
                                &color,
                                cx,
                            ))
                            .child(
                                self.labelled_small(
                                    "Background",
                                    ui::Toggle::plain(
                                        &theme,
                                        SharedString::from(format!(
                                            "text-background-enabled-{index}"
                                        )),
                                        background_enabled,
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.edit_text_segment(
                                            "text-background",
                                            index,
                                            window,
                                            cx,
                                            move |segment| {
                                                segment.background_color = if background_enabled {
                                                    None
                                                } else {
                                                    Some("#000000".to_string())
                                                };
                                                true
                                            },
                                        );
                                    }))
                                    .into_any_element(),
                                ),
                            )
                            .when_some(background_color, |this, background_color| {
                                this.child(self.render_color_input(
                                    ColorTarget::TextBackground(index),
                                    &background_color,
                                    cx,
                                ))
                            })
                            .child(
                                self.labelled_small(
                                    "Opacity",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextOpacity, index),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            )
                            .child(
                                self.labelled_small(
                                    "Shadow",
                                    self.slider(
                                        SliderKey::Panel(PanelSlider::TextShadow, index),
                                        "",
                                        cx,
                                    )
                                    .into_any_element(),
                                ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Animation")
                    .icon("icons/timer.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child("In"),
                                    )
                                    .child(self.menu_select(
                                        SidebarMenu::TextAnimationIn(index),
                                        "text-anim-in",
                                        in_label,
                                        cx,
                                    ))
                                    .children((animation_in != TextAnimation::None).then(|| {
                                        self.slider(
                                            SliderKey::Panel(
                                                PanelSlider::TextAnimInDuration,
                                                index,
                                            ),
                                            "s",
                                            cx,
                                        )
                                        .into_any_element()
                                    })),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child("Out"),
                                    )
                                    .child(self.menu_select(
                                        SidebarMenu::TextAnimationOut(index),
                                        "text-anim-out",
                                        out_label,
                                        cx,
                                    ))
                                    .children((animation_out != TextAnimation::None).then(|| {
                                        self.slider(
                                            SliderKey::Panel(
                                                PanelSlider::TextAnimOutDuration,
                                                index,
                                            ),
                                            "s",
                                            cx,
                                        )
                                        .into_any_element()
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }

    /// The `grid gap-1 rounded-lg border bg-gray-2 p-1` icon strips the text
    /// panel uses twice: layout (with labels) and alignment (icons only).
    fn icon_toggle_row(
        &self,
        id: SharedString,
        items: Vec<(&'static str, Option<&'static str>, bool)>,
        on_select: impl Fn(&usize, &mut Window, &mut gpui::App) + 'static,
    ) -> AnyElement {
        let theme = self.theme;
        let handler = std::rc::Rc::new(on_select);

        div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .p(px(4.))
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_2))
            .children(
                items
                    .into_iter()
                    .enumerate()
                    .map(|(index, (icon, label, selected))| {
                        let handler = handler.clone();
                        div()
                            .id(SharedString::from(format!("{id}-{index}")))
                            .flex_1()
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .gap(px(4.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .when(selected, |this| this.bg(Hsla::from(theme.gray_5)))
                            .text_color(if selected {
                                Hsla::from(theme.gray_12)
                            } else {
                                Hsla::from(theme.gray_10)
                            })
                            .child(svg().path(icon).size(px(16.)).text_color(if selected {
                                Hsla::from(theme.gray_12)
                            } else {
                                Hsla::from(theme.gray_10)
                            }))
                            .children(label.map(|label| {
                                div()
                                    .text_size(px(9.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(label)
                            }))
                            .on_click(move |_, window, cx| handler(&index, window, cx))
                    }),
            )
            .into_any_element()
    }

    /// `CaptionSegmentConfig` (`:4231-4341`).
    fn render_caption_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.caption_segments.get(index))
        else {
            return div().into_any_element();
        };
        let (start, end) = (segment.start, segment.end);

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Field::plain(&theme, SharedString::from(format!("Caption {}", index + 1)))
                    .icon("icons/message-bubble.svg")
                    .child(self.render_field_input(FieldKey::CaptionText(index), Some(96.))),
            )
            .child(self.timing_field(
                FieldKey::CaptionStart(index),
                FieldKey::CaptionEnd(index),
                start,
                end,
                cx,
            ))
            .into_any_element()
    }

    /// `KeyboardSegmentConfig` (`:4133-4230`).
    fn render_keyboard_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.keyboard_segments.get(index))
        else {
            return div().into_any_element();
        };
        let (start, end) = (segment.start, segment.end);

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Field::plain(
                    &theme,
                    SharedString::from(format!("Keyboard {}", index + 1)),
                )
                .icon("icons/keyboard.svg")
                .child(self.render_field_input(FieldKey::KeyboardText(index), None)),
            )
            .child(self.timing_field(
                FieldKey::KeyboardStart(index),
                FieldKey::KeyboardEnd(index),
                start,
                end,
                cx,
            ))
            .child(
                ui::Field::plain(&theme, "Fade Duration")
                    .icon("icons/timer.svg")
                    .child(self.slider(SliderKey::Panel(PanelSlider::KeyboardFade, index), "", cx)),
            )
            .into_any_element()
    }

    /// The Start / to / End card both timing panels draw (`:4149-4200`,
    /// `:4256-4330`).
    fn timing_field(
        &self,
        start_key: FieldKey,
        end_key: FieldKey,
        start: f64,
        end: f64,
        _cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let box_for = |label: &'static str, time: f64, key: FieldKey| {
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(10.))
                .rounded(px(8.))
                .border_1()
                .border_color(Hsla::from(theme.gray_3))
                .bg(crate::editor_sidebar::with_alpha(theme.gray_1, 0.8))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_between()
                        .items_center()
                        .text_size(px(10.))
                        .text_color(Hsla::from(theme.gray_10))
                        .child(label)
                        .child(SharedString::from(format_time(time))),
                )
                .child(self.render_field_input(key, None))
        };

        ui::Field::plain(&theme, "Timing")
            .icon("icons/timer.svg")
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .bg(crate::editor_sidebar::with_alpha(theme.gray_2, 0.7))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.))
                            .items_start()
                            .child(box_for("Start", start, start_key))
                            .child(
                                div()
                                    .pt(px(40.))
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.gray_10))
                                    .child("to"),
                            )
                            .child(box_for("End", end, end_key)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .justify_between()
                            .items_center()
                            .px(px(12.))
                            .py(px(8.))
                            .rounded(px(8.))
                            .bg(crate::editor_sidebar::with_alpha(theme.gray_1, 0.7))
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child("Duration")
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(SharedString::from(format!(
                                        "{:.2}s",
                                        (end - start).max(0.)
                                    ))),
                            ),
                    ),
            )
            .into_any_element()
    }

    /// `AudioSegmentConfig` (`:4001-4132`).
    fn render_audio_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.audio_segments.get(index))
        else {
            return div().into_any_element();
        };
        let enabled = segment.enabled;
        let name = segment
            .name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Audio".to_string());

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Field::plain(&theme, SharedString::from(format!("Audio {}", index + 1)))
                    .icon("icons/music.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            // The "Tap to change track" row opens the audio
                            // library panel, which is not part of this rev --
                            // see the README's deviation.
                            .child(
                                div()
                                    .id(SharedString::from(format!("audio-replace-{index}")))
                                    .flex()
                                    .flex_row()
                                    .gap(px(12.))
                                    .items_center()
                                    .p(px(8.))
                                    .w_full()
                                    .rounded(px(12.))
                                    .border_1()
                                    .border_color(Hsla::from(theme.gray_3))
                                    .bg(Hsla::from(theme.gray_2))
                                    .cursor_pointer()
                                    .tab_index(0)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_audio_replace(index, cx);
                                    }))
                                    .child(
                                        div()
                                            .size(px(40.))
                                            .flex_none()
                                            .rounded(px(8.))
                                            .bg(TrackKind::Audio.color()),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .flex_1()
                                            .min_w_0()
                                            .child(
                                                div()
                                                    .text_size(px(14.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .truncate()
                                                    .text_color(Hsla::from(theme.gray_12))
                                                    .child(SharedString::from(name)),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(Hsla::from(theme.gray_10))
                                                    .child("Tap to change track"),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_row()
                                            .gap(px(4.))
                                            .items_center()
                                            .px(px(8.))
                                            .h(px(28.))
                                            .flex_none()
                                            .rounded(px(8.))
                                            .border_1()
                                            .border_color(Hsla::from(theme.gray_3))
                                            .bg(Hsla::from(theme.gray_1))
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(Hsla::from(theme.gray_11))
                                            .opacity(0.5)
                                            .child(
                                                svg()
                                                    .path("icons/refresh-cw.svg")
                                                    .size(px(14.))
                                                    .text_color(Hsla::from(theme.gray_11)),
                                            )
                                            .child("Change"),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(12.))
                                    .items_center()
                                    .child(div().flex_1().min_w_0().child(
                                        self.render_field_input(FieldKey::AudioName(index), None),
                                    ))
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .items_center()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(Hsla::from(theme.gray_11))
                                                    .child("Enabled"),
                                            )
                                            .child(
                                                ui::Toggle::plain(
                                                    &theme,
                                                    SharedString::from(format!(
                                                        "audio-enabled-{index}"
                                                    )),
                                                    enabled,
                                                )
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.edit_audio_segment(
                                                            "audio-enabled",
                                                            index,
                                                            window,
                                                            cx,
                                                            move |segment| {
                                                                segment.enabled = !enabled;
                                                                true
                                                            },
                                                        );
                                                    },
                                                )),
                                            ),
                                    ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Volume")
                    .icon("icons/volume-2.svg")
                    .child(self.slider(
                        SliderKey::Panel(PanelSlider::AudioVolume, index),
                        "db",
                        cx,
                    )),
            )
            .child(
                ui::Field::plain(&theme, "Fade In")
                    .icon("icons/timer.svg")
                    .child(self.slider(SliderKey::Panel(PanelSlider::AudioFadeIn, index), "s", cx)),
            )
            .child(
                ui::Field::plain(&theme, "Fade Out")
                    .icon("icons/timer.svg")
                    .child(self.slider(
                        SliderKey::Panel(PanelSlider::AudioFadeOut, index),
                        "s",
                        cx,
                    )),
            )
            .into_any_element()
    }

    /// `MaskSegmentConfig` (`:4342-4520`).
    fn render_mask_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.mask_segments.get(index))
        else {
            return div().into_any_element();
        };
        let sensitive = matches!(segment.mask_type, MaskKind::Sensitive);
        let enabled = segment.enabled;
        let effect = mask_effect(segment);

        let mut panel = div().flex().flex_col().gap(px(16.)).child(
            ui::Field::plain(&theme, SharedString::from(format!("Mask {}", index + 1)))
                .icon("icons/box-select.svg")
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(16.))
                        .child(div().flex_1().min_w_0().child(self.radio_row(
                            SharedString::from(format!("mask-kind-{index}")),
                            vec![("Sensitive", sensitive), ("Highlight", !sensitive)],
                            cx.listener(move |this, choice: &usize, window, cx| {
                                let want_sensitive = *choice == 0;
                                this.edit_mask_segment(
                                    "mask-kind",
                                    index,
                                    window,
                                    cx,
                                    move |segment| {
                                        segment.mask_type = if want_sensitive {
                                            MaskKind::Sensitive
                                        } else {
                                            MaskKind::Highlight
                                        };
                                        // The two kinds seed different
                                        // defaults (`:4408-4416`).
                                        if want_sensitive {
                                            segment.feather = 0.1;
                                            segment.fade_duration = 0.;
                                        } else {
                                            segment.feather = 0.;
                                            segment.opacity = 1.;
                                        }
                                        true
                                    },
                                );
                            }),
                        )))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .child("Enabled"),
                                )
                                .child(
                                    ui::Toggle::plain(
                                        &theme,
                                        SharedString::from(format!("mask-enabled-{index}")),
                                        enabled,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            this.edit_mask_segment(
                                                "mask-enabled",
                                                index,
                                                window,
                                                cx,
                                                move |segment| {
                                                    segment.enabled = !enabled;
                                                    true
                                                },
                                            );
                                        },
                                    )),
                                ),
                        ),
                ),
        );

        if sensitive {
            panel = panel
                .child(
                    ui::Field::plain(&theme, "Effect")
                        .icon("icons/eye-off.svg")
                        .child(self.radio_row(
                            SharedString::from(format!("mask-effect-{index}")),
                            vec![
                                ("Blur", effect == MaskEffect::Blur),
                                ("Pixelate", effect == MaskEffect::Pixelate),
                            ],
                            cx.listener(move |this, choice: &usize, window, cx| {
                                let next = if *choice == 0 {
                                    MaskEffect::Blur
                                } else {
                                    MaskEffect::Pixelate
                                };
                                this.edit_mask_segment(
                                    "mask-effect",
                                    index,
                                    window,
                                    cx,
                                    move |segment| {
                                        let amount = mask_effect_amount(segment);
                                        segment.pixelation = encode_mask_effect(next, amount);
                                        segment.opacity = 1.;
                                        segment.keyframes.intensity.clear();
                                        true
                                    },
                                );
                            }),
                        )),
                )
                .child(
                    ui::Field::plain(
                        &theme,
                        if effect == MaskEffect::Blur {
                            "Blur"
                        } else {
                            "Pixel Size"
                        },
                    )
                    .icon(if effect == MaskEffect::Blur {
                        "icons/wind.svg"
                    } else {
                        "icons/grid.svg"
                    })
                    .child(self.slider(
                        SliderKey::Panel(PanelSlider::MaskAmount, index),
                        "px",
                        cx,
                    )),
                );
        } else {
            panel = panel
                .child(
                    ui::Field::plain(&theme, "Outside Darkness")
                        .icon("icons/moon.svg")
                        .child(self.slider(
                            SliderKey::Panel(PanelSlider::MaskDarkness, index),
                            "",
                            cx,
                        )),
                )
                .child(
                    ui::Field::plain(&theme, "Fade Duration")
                        .icon("icons/timer.svg")
                        .child(self.slider(
                            SliderKey::Panel(PanelSlider::MaskFade, index),
                            "s",
                            cx,
                        )),
                );
        }

        panel.into_any_element()
    }

    /// The `grid grid-cols-2 gap-2` radio pair the mask panel uses twice.
    fn radio_row(
        &self,
        id: SharedString,
        items: Vec<(&'static str, bool)>,
        on_select: impl Fn(&usize, &mut Window, &mut gpui::App) + 'static,
    ) -> AnyElement {
        let theme = self.theme;
        let handler = std::rc::Rc::new(on_select);
        div()
            .flex()
            .flex_row()
            .gap(px(8.))
            .children(
                items
                    .into_iter()
                    .enumerate()
                    .map(|(index, (label, checked))| {
                        let handler = handler.clone();
                        div()
                            .id(SharedString::from(format!("{id}-{index}")))
                            .flex_1()
                            .rounded(px(8.))
                            .border_1()
                            .border_color(if checked {
                                Hsla::from(theme.blue_8)
                            } else {
                                Hsla::from(theme.gray_3)
                            })
                            .when(checked, |this| {
                                this.bg(crate::editor_sidebar::with_alpha(theme.blue_3, 0.4))
                            })
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.))
                                    .p(px(8.))
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(
                                        div()
                                            .size(px(16.))
                                            .flex_none()
                                            .rounded_full()
                                            .border_1()
                                            .border_color(if checked {
                                                Hsla::from(theme.blue_9)
                                            } else {
                                                Hsla::from(theme.gray_7)
                                            })
                                            .when(checked, |this| {
                                                this.bg(Hsla::from(theme.blue_9))
                                            }),
                                    )
                                    .child(label),
                            )
                            .on_click(move |_, window, cx| handler(&index, window, cx))
                    }),
            )
            .into_any_element()
    }
}

/// `formatTime` -- the `M:SS` clock the timing cards print.
fn format_time(seconds: f64) -> String {
    let seconds = seconds.max(0.);
    let minutes = (seconds / 60.).floor() as u32;
    let rest = seconds - f64::from(minutes) * 60.;
    format!("{minutes}:{rest:04.1}")
}

impl EditorWindow {
    /// `SceneSegmentConfig` (`:6293-6495`). It draws its **own** header -- Done
    /// and Delete with no count -- because a scene selection of one is the only
    /// panel the source renders bare.
    fn render_scene_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.scene_segments.get(index))
        else {
            return div().into_any_element();
        };
        let mode = segment.mode;
        let split_mode = matches!(mode, SceneMode::SplitScreen | SceneMode::Floating);
        let has_camera = self.summary().is_some_and(|summary| summary.has_camera);
        let description = SCENE_MODES
            .iter()
            .find(|(candidate, ..)| {
                std::mem::discriminant(candidate) == std::mem::discriminant(&mode)
            })
            .map_or("Shows both screen and camera", |(_, _, _, text)| *text);

        let mut panel = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                // The panel's own two-button row (`:6326-6344`).
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .child(
                        ui::EditorButton::plain(&theme, "scene-done")
                            .left_icon("icons/check.svg")
                            .label("Done")
                            .on_click(
                                cx.listener(|this, _, _window, cx| this.set_selection(None, cx)),
                            ),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "scene-delete")
                            .danger(&theme)
                            .left_icon("icons/trash.svg")
                            .label("Delete")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.delete_selected_segments(window, cx)
                            })),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Camera Layout")
                    .icon("icons/layout.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            // `grid grid-cols-2 gap-2`
                            .child(div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                                SCENE_MODES.iter().enumerate().map(
                                    |(choice, (value, label, icon, _))| {
                                        let selected = std::mem::discriminant(value)
                                            == std::mem::discriminant(&mode);
                                        // Split and Floating need a camera.
                                        let disabled = !has_camera
                                            && matches!(
                                                value,
                                                SceneMode::SplitScreen | SceneMode::Floating
                                            );
                                        div()
                                            .id(SharedString::from(format!("scene-mode-{choice}")))
                                            .w(px(187.))
                                            .flex()
                                            .flex_row()
                                            .gap(px(6.))
                                            .justify_center()
                                            .items_center()
                                            .py(px(10.))
                                            .px(px(8.))
                                            .rounded(px(10.))
                                            .border_1()
                                            .border_color(if selected {
                                                Hsla::from(theme.gray_3)
                                            } else {
                                                gpui::transparent_black()
                                            })
                                            .when(selected, |this| {
                                                this.bg(Hsla::from(theme.gray_3))
                                            })
                                            .when(disabled, |this| this.opacity(0.4))
                                            .text_size(px(12.))
                                            .text_color(if selected {
                                                Hsla::from(theme.gray_12)
                                            } else {
                                                Hsla::from(theme.gray_11)
                                            })
                                            .child(svg().path(*icon).size(px(14.)).text_color(
                                                if selected {
                                                    Hsla::from(theme.gray_12)
                                                } else {
                                                    Hsla::from(theme.gray_11)
                                                },
                                            ))
                                            .child(*label)
                                            .when(!disabled, |this| {
                                                this.on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.set_scene_mode(
                                                            index, choice, window, cx,
                                                        );
                                                    },
                                                ))
                                            })
                                    },
                                ),
                            ))
                            .child(
                                div()
                                    .p(px(10.))
                                    .rounded(px(6.))
                                    .bg(Hsla::from(theme.gray_2))
                                    .border_1()
                                    .border_color(Hsla::from(theme.gray_3))
                                    .child(
                                        div()
                                            .w_full()
                                            .text_size(px(12.))
                                            .text_center()
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child(description),
                                    ),
                            ),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Transition")
                    .icon("icons/timer.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(ui::Subfield::plain(&theme, "In").child(
                                div().flex_1().min_w_0().ml(px(16.)).child(self.slider_flex(
                                    SliderKey::Panel(PanelSlider::SceneTransitionIn, index),
                                    "s2",
                                    cx,
                                )),
                            ))
                            .child(ui::Subfield::plain(&theme, "Out").child(
                                div().flex_1().min_w_0().ml(px(16.)).child(self.slider_flex(
                                    SliderKey::Panel(PanelSlider::SceneTransitionOut, index),
                                    "s2",
                                    cx,
                                )),
                            )),
                    ),
            );

        if split_mode {
            panel = panel
                .child(dashed_divider(Hsla::from(theme.gray_5)))
                .child(
                    ui::Field::plain(&theme, "Screen Zoom")
                        .icon("icons/enlarge.svg")
                        .child(self.slider(
                            SliderKey::Panel(PanelSlider::SceneScreenZoom, index),
                            "",
                            cx,
                        )),
                )
                .child(
                    ui::Field::plain(&theme, "Screen Position")
                        .icon("icons/move.svg")
                        .child(self.render_pad(PadKey::SceneScreen(index), cx)),
                )
                .child(dashed_divider(Hsla::from(theme.gray_5)))
                .child(
                    ui::Field::plain(&theme, "Camera Zoom")
                        .icon("icons/enlarge.svg")
                        .child(self.slider(
                            SliderKey::Panel(PanelSlider::SceneCameraZoom, index),
                            "",
                            cx,
                        )),
                )
                .child(
                    ui::Field::plain(&theme, "Camera Position")
                        .icon("icons/move.svg")
                        .child(self.render_pad(PadKey::SceneCamera(index), cx)),
                );
        }

        panel.into_any_element()
    }

    fn set_scene_mode(
        &mut self,
        index: usize,
        choice: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((mode, ..)) = SCENE_MODES.get(choice) else {
            return;
        };
        let mode = *mode;
        self.edit_scene_segment("scene-mode", index, window, cx, move |segment| {
            segment.mode = mode;
            // Seed identity overrides so a new split segment renders and the
            // fine-tune controls have values to bind to (`:6361-6371`).
            if matches!(mode, SceneMode::SplitScreen | SceneMode::Floating)
                && segment.split_layout.is_none()
            {
                segment.split_layout = Some(SplitLayout::default());
            }
            true
        });
    }

    /// The 3D panel's `Templates` field (`:5091-5170`): three grids over the
    /// same card -- a `Camera3DPosePreview` and a name -- at three column
    /// counts. The scene cards carry a shot-count pill; the angle presets carry
    /// the blue ring when the shot **opens** on that pose, which is what keeps
    /// the ring still while the end pose is being edited (`:4973`).
    fn render_camera3d_templates(
        &self,
        index: usize,
        start: &Camera3DProperties,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let active_angle = match_angle_preset(start);

        // `Camera3DPosePreview` is a CSS-3D plane under a `perspective`; this
        // rev has no transform, so every card shows the flat plate it would
        // fold. See the README's deviation.
        let plate = move |height: f32| {
            div()
                .w_full()
                .h(px(height))
                .rounded(px(6.))
                .bg(Hsla::from(theme.gray_3))
                .p(px(4.))
                .child(
                    div()
                        .size_full()
                        .rounded(px(3.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_6))
                        .bg(Hsla::from(if theme.is_dark() {
                            theme.gray_5
                        } else {
                            theme.gray_1
                        })),
                )
        };

        // `class="flex flex-col gap-1 p-1 rounded-lg border"`, blue-ringed when
        // selected, `hover:border-gray-7` otherwise.
        let card = move |id: SharedString,
                         name: &'static str,
                         width: f32,
                         height: f32,
                         selected: bool,
                         pill: Option<SharedString>| {
            div()
                .id(id)
                // An explicit width, not `flex_1`: a flex item that has to be
                // measured intrinsically makes taffy shape the label once per
                // sizing probe, and sixteen cards of that is 40ms a frame --
                // enough to drop the player from 59.8fps to 19. The grid is
                // fixed-column anyway, so the width is arithmetic.
                .w(px(width))
                .flex_none()
                .flex()
                .flex_col()
                .gap(px(4.))
                .p(px(4.))
                .rounded(px(8.))
                .border_1()
                .border_color(if selected {
                    Hsla::from(theme.blue_9)
                } else {
                    Hsla::from(theme.gray_4)
                })
                .when(!selected, |this| {
                    this.hover(|style| style.border_color(Hsla::from(theme.gray_7)))
                })
                .child(
                    div()
                        .relative()
                        .child(plate(height))
                        .children(pill.map(|pill| {
                            div()
                                .absolute()
                                .top(px(4.))
                                .right(px(4.))
                                .rounded(px(3.))
                                .px(px(3.))
                                .text_size(px(9.))
                                .bg(crate::editor_sidebar::with_alpha(
                                    if theme.is_dark() {
                                        theme.gray_2
                                    } else {
                                        theme.gray_1
                                    },
                                    0.8,
                                ))
                                .text_color(Hsla::from(theme.gray_11))
                                .child(pill)
                        })),
                )
                .child(
                    div()
                        .w_full()
                        .text_size(px(10.))
                        .text_center()
                        .text_color(Hsla::from(theme.gray_11))
                        .child(name),
                )
        };

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            // `grid-cols-3 gap-2` -- the scenes.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .children(CAMERA3D_SCENES.iter().map(|scene| {
                        let shots = scene.shots.len();
                        let id = scene.id;
                        card(
                            SharedString::from(format!("c3d-scene-{index}-{id}")),
                            scene.name,
                            CARD_GRID_WIDTH_3,
                            CAMERA3D_SCENE_PREVIEW_HEIGHT,
                            false,
                            Some(SharedString::from(format!(
                                "{shots} {}",
                                if shots == 1 { "shot" } else { "shots" }
                            ))),
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.apply_camera3d_scene(index, id, window, cx);
                            },
                        ))
                    })),
            )
            // `grid-cols-5 gap-1.5` -- the angle presets.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(6.))
                    .children(ANGLE_PRESETS.iter().map(|preset| {
                        let id = preset.id;
                        card(
                            SharedString::from(format!("c3d-angle-{index}-{id}")),
                            preset.name,
                            CARD_GRID_WIDTH_5,
                            CAMERA3D_ANGLE_PREVIEW_HEIGHT,
                            active_angle == Some(id),
                            None,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.apply_camera3d_angle(index, id, window, cx);
                            },
                        ))
                    })),
            )
            // `grid-cols-4 gap-2` -- the motion templates, two rows of four.
            .children(MOTION_TEMPLATES.chunks(4).map(|row| {
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .children(row.iter().map(|template| {
                        let id = template.id;
                        card(
                            SharedString::from(format!("c3d-template-{index}-{id}")),
                            template.name,
                            CARD_GRID_WIDTH_4,
                            CAMERA3D_TEMPLATE_PREVIEW_HEIGHT,
                            false,
                            None,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.apply_camera3d_template(index, id, window, cx);
                            },
                        ))
                    }))
            }))
            .into_any_element()
    }

    /// `applyTemplate` (`:4983-4993`): the whole camera animation replaced, as
    /// one history entry, with the playhead returned to the segment's start so
    /// the result plays from its first pose.
    fn apply_camera3d_template(
        &mut self,
        index: usize,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(template) = MOTION_TEMPLATES.iter().find(|t| t.id == id) else {
            return;
        };
        self.write_camera3d_template(index, template, window, cx);
    }

    /// `applyAnglePreset` (`:4997-4998`): the preset read as a motion template.
    fn apply_camera3d_angle(
        &mut self,
        index: usize,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(preset) = ANGLE_PRESETS.iter().find(|p| p.id == id) else {
            return;
        };
        let template = angle_preset_motion(preset);
        self.write_camera3d_template(index, &template, window, cx);
    }

    fn write_camera3d_template(
        &mut self,
        index: usize,
        template: &MotionTemplate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let template = MotionTemplate {
            id: template.id,
            name: template.name,
            from: template.from,
            to: template.to,
            blur: template.blur,
        };
        let start = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .map(|segment| segment.start);
        self.edit_camera3d_segment("camera3d-template", index, window, cx, move |segment| {
            apply_motion_template(segment, &template);
            true
        });
        // `setEditingEnd(false)` and the playhead back to the first pose.
        self.sidebar.editing_end_pose = false;
        if let Some(start) = start {
            self.seek_to_time(start, cx);
        }
        cx.notify();
    }

    /// `projectActions.applyCamera3DScene` (`ED/context.ts:700-731`): the one
    /// segment replaced by the scene's whole chain of shots, and the selection
    /// moved onto every segment it generated.
    fn apply_camera3d_scene(
        &mut self,
        index: usize,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(scene) = CAMERA3D_SCENES.iter().find(|scene| scene.id == id) else {
            return;
        };
        let Some((start, end)) = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .map(|segment| (segment.start, segment.end))
        else {
            return;
        };
        // `camera3DClipCuts(start, end)` (`ED/context.ts:444-460`): every clip
        // boundary inside the range, in output time.
        let cuts: Vec<f64> = self.timeline().map_or_else(Vec::new, |timeline| {
            let offsets = crate::editor_timeline::clip_timeline_offsets(timeline);
            timeline
                .segments
                .iter()
                .enumerate()
                .flat_map(|(clip, segment)| {
                    let base = offsets.get(clip).copied().unwrap_or_default();
                    [base, base + segment.duration()]
                })
                .filter(|cut| *cut > start && *cut < end)
                .collect()
        });

        let generated = apply_scene_to_range(scene, start, end, &cuts);
        if generated.is_empty() {
            return;
        }
        let count = generated.len();
        self.edit_project("camera3d-scene", window, cx, move |project| {
            let Some(timeline) = project.timeline.as_mut() else {
                return false;
            };
            if index >= timeline.camera3d_segments.len() {
                return false;
            }
            timeline
                .camera3d_segments
                .splice(index..index + 1, generated);
            timeline
                .camera3d_segments
                .sort_by(|a, b| a.start.total_cmp(&b.start));
            true
        });
        self.sidebar.editing_end_pose = false;
        self.set_selection(
            Some(Selection {
                track: TrackKind::ThreeD,
                indices: (index..index + count).collect(),
            }),
            cx,
        );
        self.seek_to_time(start, cx);
        cx.notify();
    }

    /// `Camera3DSegmentConfig` (`:4882-5435`).
    fn render_camera3d_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
        else {
            return div().into_any_element();
        };
        let start = start_pose(segment);
        let end = end_pose(segment);
        let still = poses_equal(&start, &end);
        let editing_end = self.sidebar.editing_end_pose;
        let blur = segment.blur;
        let blur_label = CAMERA3D_BLUR_MODES
            .iter()
            .find(|(mode, _)| *mode == blur.mode)
            .map_or("None", |(_, label)| *label);
        let easing_index = motion_easing(segment);
        let easing_label = MOTION_EASINGS[easing_index].1;
        // `blurSummary()` (`:5010-5018`).
        let blur_summary = if blur.mode == Camera3DBlurMode::None {
            "Off".to_string()
        } else {
            format!("{blur_label} {}", blur.strength.round())
        };

        let camera_section = self.sidebar.section(PanelSection::Camera3DCamera);
        let blur_section = self.sidebar.section(PanelSection::Camera3DBlur);
        let advanced_section = self.sidebar.section(PanelSection::Camera3DAdvanced);

        let templates = self.render_camera3d_templates(index, &start, cx);
        let pose_card = |label: &'static str, is_end: bool| {
            let selected = editing_end == is_end;
            div()
                .id(SharedString::from(format!("camera3d-pose-{label}")))
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(4.))
                .p(px(4.))
                .rounded(px(8.))
                .border_1()
                .border_color(if selected {
                    Hsla::from(theme.blue_9)
                } else {
                    Hsla::from(theme.gray_4)
                })
                // `Camera3DPosePreview` is a CSS-3D plane under a `perspective`
                // -- no transform in this rev, so the card shows the flat plate
                // it would fold. See the README's deviation.
                .child(
                    div()
                        .w_full()
                        .h(px(56.))
                        .rounded(px(6.))
                        .bg(Hsla::from(theme.gray_3))
                        .p(px(6.))
                        .child(
                            div()
                                .size_full()
                                .rounded(px(3.))
                                .border_1()
                                .border_color(Hsla::from(theme.gray_6))
                                .bg(Hsla::from(if theme.is_dark() {
                                    theme.gray_5
                                } else {
                                    theme.gray_1
                                })),
                        ),
                )
                .child(
                    div()
                        .w_full()
                        .text_size(px(10.))
                        .text_center()
                        .text_color(Hsla::from(theme.gray_11))
                        .child(label),
                )
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.select_camera3d_pose(index, is_end, cx);
                }))
        };

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            // `Templates` (`:5091-5170`). Scenes lead: one click lays a whole
            // chained sequence over this segment's range, where the two rows
            // below author a single shot.
            .child(
                ui::Field::plain(&theme, "Templates")
                    .icon("icons/rotate-3d.svg")
                    .child(templates),
            )
            .child(
                ui::Field::plain(&theme, "Motion")
                    .icon("icons/move-right.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(8.))
                                    .items_center()
                                    .child(pose_card("Start", false))
                                    .child(
                                        ui::EditorButton::plain(&theme, "camera3d-swap")
                                            .left_icon("icons/arrow-left-right.svg")
                                            .tooltip(&theme, "Swap start and end")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.swap_camera3d_poses(index, window, cx);
                                            })),
                                    )
                                    .child(pose_card("End", true)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(4.))
                                    .items_center()
                                    .child(
                                        ui::EditorButton::plain(&theme, "camera3d-flip-h")
                                            .left_icon("icons/flip-horizontal-2.svg")
                                            .tooltip(&theme, "Flip horizontal")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.flip_camera3d(index, true, window, cx);
                                            })),
                                    )
                                    .child(
                                        ui::EditorButton::plain(&theme, "camera3d-flip-v")
                                            .left_icon("icons/flip-vertical-2.svg")
                                            .tooltip(&theme, "Flip vertical")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.flip_camera3d(index, false, window, cx);
                                            })),
                                    )
                                    .child(if still {
                                        div()
                                            .text_size(px(11.))
                                            .text_color(Hsla::from(theme.gray_10))
                                            .child(
                                                "Pick a template or edit the end pose to add \
                                                 motion",
                                            )
                                            .into_any_element()
                                    } else {
                                        div()
                                            .id("camera3d-still")
                                            .text_size(px(11.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .cursor_pointer()
                                            .child("Still shot")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.make_camera3d_still(index, window, cx);
                                            }))
                                            .into_any_element()
                                    }),
                            ),
                    ),
            )
            .child(
                self.camera3d_section(
                    Camera3DSection {
                        id: "camera3d-camera",
                        name: "Camera",
                        icon: "icons/video.svg",
                        summary: Some(if editing_end {
                            "End pose"
                        } else {
                            "Start pose"
                        }),
                    },
                    PanelSection::Camera3DCamera,
                    &camera_section,
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .children(CAMERA3D_POSE_SLIDERS.map(|(property, label, unit, icon)| {
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .gap(px(6.))
                                        .items_center()
                                        .text_size(px(12.))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .child(
                                            svg()
                                                .path(icon)
                                                .size(px(16.))
                                                .text_color(Hsla::from(theme.gray_11)),
                                        )
                                        .child(label),
                                )
                                .child(self.slider(
                                    SliderKey::Panel(PanelSlider::Camera3DPose(property), index),
                                    unit,
                                    cx,
                                ))
                                .into_any_element()
                        }))
                        .child(
                            ui::EditorButton::plain(&theme, "camera3d-reset")
                                .left_icon("icons/rotate-ccw.svg")
                                .label("Reset camera")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.reset_camera3d_pose(index, window, cx);
                                })),
                        )
                        .into_any_element(),
                    cx,
                ),
            )
            .child(
                self.camera3d_section(
                    Camera3DSection {
                        id: "camera3d-blur",
                        name: "Blur",
                        icon: "icons/wind.svg",
                        summary: Some(&blur_summary),
                    },
                    PanelSection::Camera3DBlur,
                    &blur_section,
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(
                            ui::Subfield::plain(&theme, "Mode").child(div().w(px(160.)).child(
                                self.menu_select(
                                    SidebarMenu::Camera3DBlurMode(index),
                                    "camera3d-blur-mode",
                                    blur_label,
                                    cx,
                                ),
                            )),
                        )
                        .children(if blur.mode == Camera3DBlurMode::None {
                            vec![
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Pick a mode to blur everything outside the focus area.")
                                    .into_any_element(),
                            ]
                        } else {
                            let mut rows: Vec<AnyElement> = camera3d_blur_sliders(blur.mode)
                                .iter()
                                .map(|(key, label)| {
                                    self.labelled_small(
                                        label,
                                        self.slider(
                                            SliderKey::Panel(
                                                PanelSlider::Camera3DBlur(*key),
                                                index,
                                            ),
                                            if *key == Camera3DBlurKey::Angle {
                                                "deg"
                                            } else {
                                                ""
                                            },
                                            cx,
                                        )
                                        .into_any_element(),
                                    )
                                })
                                .collect();
                            rows.push(
                                ui::Subfield::plain(&theme, "Bokeh")
                                    .child(
                                        ui::Toggle::plain(
                                            &theme,
                                            SharedString::from(format!("camera3d-bokeh-{index}")),
                                            blur.bokeh,
                                        )
                                        .on_click(
                                            cx.listener(move |this, _, window, cx| {
                                                this.set_camera3d_bokeh(index, window, cx);
                                            }),
                                        ),
                                    )
                                    .into_any_element(),
                            );
                            rows.push(
                                ui::EditorButton::plain(&theme, "camera3d-blur-reset")
                                    .left_icon("icons/rotate-ccw.svg")
                                    .label("Turn blur off")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.edit_camera3d_segment(
                                            "camera3d-blur-reset",
                                            index,
                                            window,
                                            cx,
                                            |segment| {
                                                segment.blur = default_camera3d_blur();
                                                true
                                            },
                                        );
                                    }))
                                    .into_any_element(),
                            );
                            rows
                        })
                        .into_any_element(),
                    cx,
                ),
            )
            .child(
                self.camera3d_section(
                    Camera3DSection {
                        id: "camera3d-advanced",
                        name: "Advanced",
                        icon: "icons/timer.svg",
                        summary: None,
                    },
                    PanelSection::Camera3DAdvanced,
                    &advanced_section,
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(
                            ui::Subfield::plain(&theme, "Motion style").child(
                                div()
                                    .w(px(160.))
                                    // A still shot has no span to shape and nowhere
                                    // to store a curve, so the picker is disabled
                                    // (`:5357-5360`).
                                    .when(still, |this| this.opacity(0.5))
                                    .child(if still {
                                        ui::Select::plain(&theme, "camera3d-easing", easing_label)
                                            .stretch_label()
                                            .disabled(true)
                                            .into_any_element()
                                    } else {
                                        self.easing_select(index, easing_index, cx)
                                    }),
                            ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .justify_between()
                                        .items_center()
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(Hsla::from(theme.gray_11))
                                                .child("Ease in"),
                                        )
                                        .child(self.render_number_field(
                                            FieldKey::Camera3DEaseIn(index),
                                            "s",
                                            80.,
                                        )),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .justify_between()
                                        .items_center()
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(Hsla::from(theme.gray_11))
                                                .child("Ease out"),
                                        )
                                        .child(self.render_number_field(
                                            FieldKey::Camera3DEaseOut(index),
                                            "s",
                                            80.,
                                        )),
                                ),
                        )
                        .into_any_element(),
                    cx,
                ),
            )
            .into_any_element()
    }

    /// `Camera3DSection` (`:4660-4688`): a `Field`-rhythm header that folds
    /// away, with an optional summary on the right.
    fn camera3d_section(
        &self,
        header: Camera3DSection<'_>,
        key: PanelSection,
        state: &ui::CollapsibleState,
        content: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Camera3DSection {
            id,
            name,
            icon,
            summary,
        } = header;
        let theme = self.theme;
        let open = state.is_open();
        let summary = summary.map(|summary| SharedString::from(summary.to_string()));

        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(id)
                    .flex()
                    .flex_row()
                    .gap(px(6.))
                    .items_center()
                    .w_full()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_12))
                    .cursor_pointer()
                    .child(
                        svg()
                            .path(icon)
                            .size(px(16.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    .child(name)
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .flex_row()
                            .gap(px(6.))
                            .items_center()
                            .text_size(px(12.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(Hsla::from(theme.gray_10))
                            .children(summary)
                            .child(
                                svg()
                                    .path(if open {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    })
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.gray_10)),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.sidebar.section(key).toggle();
                        this.animate_collapsibles(window, cx);
                    })),
            )
            .child(collapsible(
                state,
                div().pt(px(16.)).child(content).into_any_element(),
            ))
            .into_any_element()
    }

    fn easing_select(&self, index: usize, current: usize, cx: &mut Context<Self>) -> AnyElement {
        self.menu_select(
            SidebarMenu::Camera3DEasing(index),
            "camera3d-easing",
            MOTION_EASINGS[current].1,
            cx,
        )
    }

    /// `selectPose` (`:4933-4937`): flip the card **and** park the playhead on
    /// the pose being edited, which is what makes the canvas show it.
    fn select_camera3d_pose(&mut self, index: usize, end: bool, cx: &mut Context<Self>) {
        self.sidebar.editing_end_pose = end;
        if let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
        {
            // The end pose is sampled a hair inside the segment so the playhead
            // stays on this segment rather than falling into the next.
            let time = if end {
                (segment.end - 0.01).max(segment.start)
            } else {
                segment.start
            };
            self.seek_to_time(time, cx);
        }
        cx.notify();
    }

    fn swap_camera3d_poses(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_camera3d_segment("camera3d-swap", index, window, cx, |segment| {
            let start = start_pose(segment);
            let end = end_pose(segment);
            let easing = MOTION_EASINGS[motion_easing(segment)];
            set_motion(segment, &end, &start, (easing.2, easing.3));
            true
        });
    }

    fn make_camera3d_still(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_camera3d_segment("camera3d-still", index, window, cx, |segment| {
            let start = start_pose(segment);
            let easing = MOTION_EASINGS[motion_easing(segment)];
            set_motion(segment, &start, &start, (easing.2, easing.3));
            true
        });
    }

    fn reset_camera3d_pose(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let editing_end = self.sidebar.editing_end_pose;
        self.edit_camera3d_segment("camera3d-reset", index, window, cx, move |segment| {
            let start = start_pose(segment);
            let end = end_pose(segment);
            let still = poses_equal(&start, &end);
            let easing = MOTION_EASINGS[motion_easing(segment)];
            let pose = CAMERA3D_RESET_POSE;
            if still {
                set_motion(segment, &pose, &pose, (easing.2, easing.3));
            } else if editing_end {
                set_motion(segment, &start, &pose, (easing.2, easing.3));
            } else {
                set_motion(segment, &pose, &end, (easing.2, easing.3));
            }
            true
        });
    }

    fn flip_camera3d(
        &mut self,
        index: usize,
        horizontal: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_camera3d_segment("camera3d-flip", index, window, cx, move |segment| {
            flip_segment(segment, horizontal);
            true
        });
    }

    fn set_camera3d_bokeh(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_camera3d_segment("camera3d-bokeh", index, window, cx, |segment| {
            let next = !segment.blur.bokeh;
            segment.blur.bokeh = next;
            // The bokeh kernel tops out at 20, so the strength comes down with
            // the slider's new ceiling (`:5054-5060`).
            if next {
                segment.blur.strength = segment
                    .blur
                    .strength
                    .min(f64::from(CAMERA3D_BOKEH_MAX_STRENGTH));
            }
            true
        });
    }

    fn set_camera3d_easing(
        &mut self,
        index: usize,
        easing: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((_, _, out, into)) = MOTION_EASINGS.get(easing).copied() else {
            return;
        };
        self.edit_camera3d_segment("camera3d-easing", index, window, cx, move |segment| {
            let start = start_pose(segment);
            let end = end_pose(segment);
            set_motion(segment, &start, &end, (out, into));
            true
        });
    }
}

impl EditorWindow {
    /// Every text field the frame about to be built will draw.
    ///
    /// Creating one needs `&mut Window`, and the sidebar's render chain is
    /// threaded with `&self`, so the set is computed here from the same state
    /// the render reads and the fields are created (and re-synced) before the
    /// tree is built. Called once per frame from `Render::render`, next to
    /// `sync_hex_inputs`.
    pub(crate) fn prepare_sidebar_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut fields: Vec<FieldKey> = Vec::new();
        let mut colors: Vec<ColorTarget> = Vec::new();

        // The crop dialog's four `BoundInput`s, while it is open. Created up
        // front rather than pushed onto `fields`, because the match below
        // bails early when the project has no timeline and the dialog is
        // independent of it.
        if self.crop.is_some() {
            use crate::editor_crop::CropField;
            for field in [
                CropField::Width,
                CropField::Height,
                CropField::X,
                CropField::Y,
            ] {
                self.ensure_field(FieldKey::Crop(field), window, cx);
            }
        }

        match self.sidebar_selection().cloned() {
            Some(selection) => {
                // The text panel needs the installed families for its font
                // picker and for matching the active preset; the enumeration
                // is slow, so it starts here and lands on a later frame.
                if selection.track == TrackKind::Text {
                    warm_installed_fonts();
                }
                let Some(timeline) = self.timeline() else {
                    return;
                };
                let indices = |length: usize| -> Vec<usize> {
                    selection
                        .indices
                        .iter()
                        .copied()
                        .filter(|index| *index < length)
                        .collect()
                };
                match selection.track {
                    TrackKind::Style => {
                        for index in indices(timeline.style_segments.len()) {
                            fields.push(FieldKey::StyleName(index));
                            if timeline.style_segments[index]
                                .overrides
                                .background
                                .is_some()
                            {
                                for axis in 0..4 {
                                    fields.push(FieldKey::StyleCrop(index, axis));
                                }
                            }
                        }
                    }
                    TrackKind::Image => {
                        for index in indices(timeline.image_segments.len()) {
                            fields.push(FieldKey::ImageName(index));
                        }
                    }
                    TrackKind::Text => {
                        for index in indices(timeline.text_segments.len()) {
                            fields.push(FieldKey::TextContent(index));
                            colors.push(ColorTarget::TextColor(index));
                            if timeline.text_segments[index].background_color.is_some() {
                                colors.push(ColorTarget::TextBackground(index));
                            }
                        }
                    }
                    TrackKind::Caption => {
                        for index in indices(timeline.caption_segments.len()) {
                            fields.push(FieldKey::CaptionText(index));
                            fields.push(FieldKey::CaptionStart(index));
                            fields.push(FieldKey::CaptionEnd(index));
                        }
                    }
                    TrackKind::Audio => {
                        for index in indices(timeline.audio_segments.len()) {
                            fields.push(FieldKey::AudioName(index));
                        }
                    }
                    TrackKind::Keyboard => {
                        for index in indices(timeline.keyboard_segments.len()) {
                            fields.push(FieldKey::KeyboardText(index));
                            fields.push(FieldKey::KeyboardStart(index));
                            fields.push(FieldKey::KeyboardEnd(index));
                        }
                    }
                    TrackKind::ThreeD => {
                        let selected = indices(timeline.camera3d_segments.len());
                        if selected.len() == 1 {
                            fields.push(FieldKey::Camera3DEaseIn(selected[0]));
                            fields.push(FieldKey::Camera3DEaseOut(selected[0]));
                        }
                    }
                    _ => {}
                }
            }
            None => match self.sidebar.tab {
                crate::editor_sidebar::SidebarTab::Captions => colors.extend([
                    ColorTarget::CaptionColor,
                    ColorTarget::CaptionBackground,
                    ColorTarget::CaptionHighlight,
                ]),
                crate::editor_sidebar::SidebarTab::Keyboard => {
                    colors.extend([ColorTarget::KeyboardColor, ColorTarget::KeyboardBackground])
                }
                crate::editor_sidebar::SidebarTab::Audio => {
                    if let Some(summary) = self.summary() {
                        let clips = summary.recording_clips.max(1);
                        let (system, mic, camera) = (
                            summary.has_system_audio,
                            summary.has_microphone,
                            summary.has_camera,
                        );
                        for clip in 0..clips {
                            if system {
                                fields.push(FieldKey::SyncOffset(clip, OffsetKind::SystemAudio));
                            }
                            if mic {
                                fields.push(FieldKey::SyncOffset(clip, OffsetKind::Mic));
                            }
                            if camera {
                                fields.push(FieldKey::SyncOffset(clip, OffsetKind::Camera));
                            }
                        }
                    }
                }
                _ => {}
            },
        }

        for key in fields {
            self.ensure_field(key, window, cx);
        }
        for target in colors {
            self.ensure_hex_input(target, window, cx);
        }
        self.sync_fields(window, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera3d(start: f64, end: f64) -> Camera3DSegment {
        Camera3DSegment {
            start,
            end,
            enabled: true,
            properties: Camera3DProperties::default(),
            blur: default_camera3d_blur(),
            tracks: Default::default(),
            transition_in: 0.,
            transition_out: 0.,
        }
    }

    #[test]
    fn a_still_shot_stores_no_keyframes() {
        let mut segment = camera3d(0., 4.);
        let pose = Camera3DProperties {
            zoom: 3.,
            ..Camera3DProperties::default()
        };
        set_motion(&mut segment, &pose, &pose, ([0., 0.], [1., 1.]));
        assert!(segment.tracks.zoom.is_empty());
        assert_eq!(segment.properties.zoom, 3.);
        assert!(poses_equal(&start_pose(&segment), &end_pose(&segment)));
    }

    #[test]
    fn a_move_stores_two_keyframes_at_the_segments_own_length() {
        let mut segment = camera3d(2., 6.5);
        let start = Camera3DProperties::default();
        let end = Camera3DProperties {
            tilt_x: 12.,
            ..Camera3DProperties::default()
        };
        set_motion(&mut segment, &start, &end, ([0.65, 0.], [0.35, 1.]));
        assert_eq!(segment.tracks.tilt_x.len(), 2);
        assert_eq!(segment.tracks.tilt_x[0].time, 0.);
        assert!((segment.tracks.tilt_x[1].time - 4.5).abs() < 1e-9);
        // Everything that did not move keeps no track at all.
        assert!(segment.tracks.roll.is_empty());
        // The two ends read back as the poses that were written.
        assert!((start_pose(&segment).tilt_x - 0.).abs() < 1e-9);
        assert!((end_pose(&segment).tilt_x - 12.).abs() < 1e-9);
        // And the curve reads back as Smooth.
        assert_eq!(motion_easing(&segment), 1);
    }

    #[test]
    fn a_horizontal_flip_conjugates_the_camera_by_the_mirror() {
        let mut segment = camera3d(0., 3.);
        segment.properties.tilt_y = 20.;
        segment.properties.pan_x = 0.4;
        segment.properties.roll = 10.;
        segment.blur.focus_x = 0.25;
        segment.blur.angle = 30.;
        flip_segment(&mut segment, true);
        assert_eq!(segment.properties.tilt_y, -20.);
        assert_eq!(segment.properties.pan_x, -0.4);
        assert_eq!(segment.properties.roll, -10.);
        assert!((segment.blur.focus_x - 0.75).abs() < 1e-9);
        assert!((segment.blur.angle - 150.).abs() < 1e-9);
    }

    #[test]
    fn the_blur_limits_narrow_with_the_mode_and_the_bokeh_flag() {
        let mut blur = default_camera3d_blur();
        assert_eq!(Camera3DBlurKey::Strength.limits(&blur), (0., 60., 1.));
        blur.bokeh = true;
        assert_eq!(Camera3DBlurKey::Strength.limits(&blur), (0., 20., 1.));
        blur.mode = Camera3DBlurMode::TiltShift;
        assert_eq!(Camera3DBlurKey::FocusSize.limits(&blur), (0., 0.6, 0.01));
        assert_eq!(Camera3DBlurKey::Angle.limits(&blur), (0., 180., 1.));
    }

    #[test]
    fn changing_the_blur_mode_seeds_its_own_parameters() {
        let mut blur = default_camera3d_blur();
        seed_blur_mode(&mut blur, Camera3DBlurMode::TiltShift);
        assert_eq!(blur.focus_size, 0.1);
        assert_eq!(blur.angle, 45.);
        seed_blur_mode(&mut blur, Camera3DBlurMode::Radial);
        assert_eq!(blur.focus_x, 0.37);
        assert_eq!(blur.focus_size, 0.5);
    }

    #[test]
    fn the_mask_effect_round_trips_through_its_encoding() {
        let contract = mask_effect_contract();
        let blurred = encode_mask_effect(MaskEffect::Blur, 24.);
        assert!(blurred >= contract.blur_encoding_offset);
        let mut segment = mask(blurred);
        assert_eq!(mask_effect(&segment), MaskEffect::Blur);
        assert!((mask_effect_amount(&segment) - 24.).abs() < 1e-9);

        segment.pixelation = encode_mask_effect(MaskEffect::Pixelate, 12.);
        assert_eq!(mask_effect(&segment), MaskEffect::Pixelate);
        assert!((mask_effect_amount(&segment) - 12.).abs() < 1e-9);

        // Out-of-range amounts clamp to the contract rather than escaping.
        let clamped = encode_mask_effect(MaskEffect::Pixelate, 9999.);
        assert!((clamped - contract.max_amount).abs() < 1e-9);
    }

    fn mask(pixelation: f64) -> MaskSegment {
        MaskSegment {
            start: 0.,
            end: 1.,
            track: 0,
            enabled: true,
            mask_type: MaskKind::Sensitive,
            center: XY::new(0.5, 0.5),
            size: XY::new(0.3, 0.3),
            feather: 0.1,
            opacity: 1.,
            pixelation,
            darkness: 0.5,
            fade_duration: 0.,
            keyframes: Default::default(),
        }
    }

    #[test]
    fn the_camera3d_limits_match_the_source() {
        assert_eq!(Camera3DProperty::Roll.limits(), (-180., 180., 1.));
        assert_eq!(Camera3DProperty::Zoom.limits(), (0.5, 10., 0.05));
        assert_eq!(Camera3DProperty::PanX.limits(), (-3., 3., 0.01));
        assert_eq!(CAMERA3D_TRANSITION_LIMITS, (0., 2., 0.05));
        assert_eq!(CAMERA3D_RESET_POSE.fov, 24.);
        assert_eq!(CAMERA3D_RESET_POSE.zoom, 4.5);
    }

    #[test]
    fn the_timing_cards_print_the_source_clock() {
        assert_eq!(format_time(0.), "0:00.0");
        assert_eq!(format_time(9.25), "0:09.2");
        assert_eq!(format_time(75.5), "1:15.5");
    }

    // -- Text presets ------------------------------------------------------

    /// A brand-new text segment. `TextSegment` has no `Default` -- every field
    /// but the two times carries a serde default instead -- so this builds one
    /// the way loading a config does, which is also exactly what the timeline's
    /// "add text" writes.
    fn text_segment() -> TextSegment {
        serde_json::from_value(serde_json::json!({ "start": 0.0, "end": 2.0 })).unwrap()
    }

    #[test]
    fn the_preset_catalogue_matches_the_source() {
        let ids: Vec<_> = TEXT_PRESETS.iter().map(|preset| preset.id).collect();
        assert_eq!(
            ids,
            [
                "title",
                "subtitle",
                "lower-third",
                "kicker",
                "stat",
                "quote",
                "code",
                "typewriter"
            ]
        );
        // Only "lower-third" implies placement (`text-presets.ts:71`).
        let placed: Vec<_> = TEXT_PRESETS
            .iter()
            .filter(|preset| preset.center.is_some())
            .map(|preset| preset.id)
            .collect();
        assert_eq!(placed, ["lower-third"]);
        // Every stack ends in a generic, which is what makes `pick_font_family`
        // total.
        for preset in TEXT_PRESETS {
            let last = preset.style.font_stack.last().copied().unwrap();
            assert!(
                matches!(last, "sans-serif" | "serif" | "monospace"),
                "{} ends in {last}",
                preset.id
            );
        }
    }

    #[test]
    fn a_font_stack_takes_the_first_installed_family_then_the_generic() {
        let installed = vec!["Inter".to_string(), "Georgia".to_string()];
        // "Helvetica Neue" and "Segoe UI" are not installed, "Inter" is.
        assert_eq!(pick_font_family(SANS_STACK, &installed), "Inter");
        assert_eq!(pick_font_family(SERIF_STACK, &installed), "Georgia");
        // Nothing in the mono stack is installed, so the generic wins -- and a
        // generic short-circuits even if a later family *is* installed.
        assert_eq!(pick_font_family(MONO_STACK, &installed), "monospace");
        assert_eq!(pick_font_family(SANS_STACK, &[]), "sans-serif");
        // Case-insensitive, like the source's lower-cased Set.
        assert_eq!(
            pick_font_family(SERIF_STACK, &["georgia".to_string()]),
            "Georgia"
        );
    }

    #[test]
    fn applying_a_preset_scales_the_box_about_its_top_edge() {
        let mut segment = text_segment();
        // The defaults: 48px type in a 0.35 x 0.2 box centred at 0.5, 0.5.
        assert_eq!(segment.font_size, 48.);
        let top_edge = segment.center.y - segment.size.y / 2.;

        let title = &TEXT_PRESETS[0];
        apply_text_preset(&mut segment, title, &[]);

        // 96 / 48 = 2x.
        assert!((segment.size.x - 0.7).abs() < 1e-9);
        assert!((segment.size.y - 0.4).abs() < 1e-9);
        // The top edge did not move; the centre dropped by half the growth.
        assert!((segment.center.y - segment.size.y / 2. - top_edge).abs() < 1e-9);
        assert!((segment.center.y - 0.6).abs() < 1e-9);
        // `size.x` clamps at 1 (`text-presets.ts:224`).
        assert_eq!(segment.font_size, 96.);
        assert_eq!(segment.font_weight, 700.);
        assert_eq!(segment.align, TextAlign::Center);
        assert_eq!(segment.animation_in, TextAnimation::SlideUp);
        // `fadeDuration` is the larger of the two animation durations.
        assert!((segment.fade_duration - 0.35).abs() < 1e-9);
        // Content and colour are the user's, untouched.
        assert_eq!(segment.content, text_segment().content);
        assert_eq!(segment.color, text_segment().color);
    }

    #[test]
    fn the_box_width_clamps_at_the_whole_frame() {
        let mut segment = text_segment();
        segment.size.x = 0.8;
        // "Big Stat" is 160px against the 48px default: a 3.33x scale.
        apply_text_preset(&mut segment, &TEXT_PRESETS[4], &[]);
        assert_eq!(segment.size.x, 1.);
    }

    #[test]
    fn a_placing_preset_moves_the_box_and_the_others_do_not() {
        let mut segment = text_segment();
        segment.center = XY { x: 0.3, y: 0.4 };
        apply_text_preset(&mut segment, &TEXT_PRESETS[1], &[]);
        // Subtitle keeps x, and only shifts y by the box growth.
        assert!((segment.center.x - 0.3).abs() < 1e-9);

        let mut segment = text_segment();
        apply_text_preset(&mut segment, &TEXT_PRESETS[2], &[]);
        assert!((segment.center.x - 0.22).abs() < 1e-9);
        assert!((segment.center.y - 0.85).abs() < 1e-9);
    }

    #[test]
    fn a_segment_matches_the_preset_it_was_just_given() {
        let installed = vec!["Inter".to_string()];
        for preset in TEXT_PRESETS {
            let mut segment = text_segment();
            apply_text_preset(&mut segment, preset, &installed);
            assert_eq!(
                match_text_preset(&segment, &installed),
                Some(preset.id),
                "{} did not match itself",
                preset.id
            );
        }
        // A default segment is not any of them.
        assert_eq!(match_text_preset(&text_segment(), &installed), None);
        // One field off the style and the match is gone -- content is *not*
        // one of those fields.
        let mut segment = text_segment();
        apply_text_preset(&mut segment, &TEXT_PRESETS[0], &installed);
        segment.content = "anything else".into();
        assert_eq!(match_text_preset(&segment, &installed), Some("title"));
        segment.letter_spacing += 0.5;
        assert_eq!(match_text_preset(&segment, &installed), None);
    }

    // -- 3D templates ------------------------------------------------------

    #[test]
    fn the_template_catalogues_match_the_source() {
        let angles: Vec<_> = ANGLE_PRESETS.iter().map(|preset| preset.id).collect();
        assert_eq!(
            angles,
            [
                "spotlight",
                "perspective",
                "center",
                "low-angle",
                "close-up"
            ]
        );
        let motions: Vec<_> = MOTION_TEMPLATES.iter().map(|t| t.id).collect();
        assert_eq!(
            motions,
            [
                "glide-across",
                "drift-down",
                "rising-sweep",
                "pull-back",
                "top-down",
                "tilt-away",
                "unfold",
                "slide-by"
            ]
        );
        let scenes: Vec<_> = CAMERA3D_SCENES.iter().map(|s| s.id).collect();
        assert_eq!(scenes, ["showcase", "product-tour", "punch-in"]);
        // Every scene's shot weights sum to 1, which is what makes the
        // renormalisation in `apply_scene_to_range` a no-op for a full scene.
        for scene in CAMERA3D_SCENES {
            let total: f64 = scene.shots.iter().map(|shot| shot.weight).sum();
            assert!((total - 1.).abs() < 1e-9, "{} sums to {total}", scene.id);
        }
    }

    #[test]
    fn an_angle_preset_matches_its_own_opening_pose() {
        for preset in ANGLE_PRESETS {
            assert_eq!(
                match_angle_preset(&preset.values),
                Some(preset.id),
                "{} did not match itself",
                preset.id
            );
        }
        // The reset pose is none of them.
        assert_eq!(match_angle_preset(&CAMERA3D_RESET_POSE), None);
        // `rotateX` / `rotateY` are the fold, not the angle: changing one
        // leaves the preset matched (`CAMERA3D_ANGLE_PRESET_KEYS`).
        let mut pose = ANGLE_PRESETS[0].values;
        pose.rotate_x = -30.;
        assert_eq!(match_angle_preset(&pose), Some("spotlight"));
        // Half a slider step is the tolerance; a whole step is not.
        pose = ANGLE_PRESETS[2].values;
        pose.zoom += f64::from(Camera3DProperty::Zoom.limits().2) / 2.;
        assert_eq!(match_angle_preset(&pose), Some("center"));
        pose.zoom += f64::from(Camera3DProperty::Zoom.limits().2);
        assert_eq!(match_angle_preset(&pose), None);
    }

    #[test]
    fn a_scene_fills_its_range_by_shot_weight() {
        let scene = &CAMERA3D_SCENES[0];
        let shots = apply_scene_to_range(scene, 0., 10., &[]);
        assert_eq!(shots.len(), 3);
        assert!((shots[0].start - 0.).abs() < 1e-9);
        assert!((shots[2].end - 10.).abs() < 1e-9);
        // 0.27 / 0.25 / 0.48 of ten seconds, and no gaps.
        assert!((shots[0].end - 2.7).abs() < 1e-9);
        assert!((shots[1].end - 5.2).abs() < 1e-9);
        for pair in shots.windows(2) {
            assert!((pair[1].start - pair[0].end).abs() < 1e-9);
        }
        // The move is stored as keyframes, not just a static pose.
        assert!(
            Camera3DProperty::ALL
                .iter()
                .any(|property| !property.track_ref(&shots[0].tracks).is_empty()),
            "the first shot stored no motion"
        );
    }

    #[test]
    fn a_short_range_gets_only_the_shots_that_fit() {
        // Two seconds cannot hold three one-second shots.
        let shots = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 2.5, &[]);
        assert_eq!(shots.len(), 2);
        assert!((shots[1].end - 2.5).abs() < 1e-9);
        // Under one second there is nowhere to cut, so it is a single shot.
        let shots = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 0.6, &[]);
        assert_eq!(shots.len(), 1);
        // A zero-length range writes nothing at all.
        assert!(apply_scene_to_range(&CAMERA3D_SCENES[0], 3., 3., &[]).is_empty());
    }

    #[test]
    fn a_boundary_snaps_to_a_nearby_clip_cut_but_not_a_far_one() {
        // The first boundary of a ten-second showcase falls at 2.7.
        let window = 10. * CAMERA3D_SCENE_SNAP_FRACTION; // 1.5s
        let near = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 10., &[3.4]);
        assert!((near[0].end - 3.4).abs() < 1e-9, "should snap to the cut");
        // Just outside the window, and it does not move.
        let far = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 10., &[2.7 + window + 0.1]);
        assert!((far[0].end - 2.7).abs() < 1e-9, "should not snap");
        // A cut outside the range is ignored entirely.
        let outside = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 10., &[-1., 12.]);
        assert!((outside[0].end - 2.7).abs() < 1e-9);
        // A snap that would starve a later shot is dropped: 9.5 leaves under a
        // second for the two shots after it.
        let starved = apply_scene_to_range(&CAMERA3D_SCENES[0], 0., 10., &[9.5]);
        assert!((starved[0].end - 2.7).abs() < 1e-9);
    }

    #[test]
    fn a_motion_template_writes_its_own_blur_and_a_real_move() {
        let mut segment = camera3d(0., 4.);
        let template = &MOTION_TEMPLATES[4]; // "Top down", the one with its own blur.
        apply_motion_template(&mut segment, template);
        assert_eq!(segment.blur.mode, Camera3DBlurMode::Radial);
        assert!((segment.blur.focus_size - 0.55).abs() < 1e-6);
        assert!(!poses_equal(&start_pose(&segment), &end_pose(&segment)));
        assert!((start_pose(&segment).tilt_x - 24.8).abs() < 1e-9);
        assert!((end_pose(&segment).tilt_x - 34.19).abs() < 1e-9);
        // An angle preset read as a template opens on the named pose, so the
        // ring lands back on it.
        let mut segment = camera3d(0., 4.);
        apply_motion_template(&mut segment, &angle_preset_motion(&ANGLE_PRESETS[1]));
        assert_eq!(
            match_angle_preset(&start_pose(&segment)),
            Some("perspective")
        );
    }

    #[test]
    fn the_font_picker_lists_the_generics_first() {
        let options = font_picker_options();
        assert_eq!(options[0], ("sans-serif".into(), "System Sans".into()));
        assert_eq!(options[1], ("serif".into(), "System Serif".into()));
        assert_eq!(options[2], ("monospace".into(), "System Mono".into()));
        // The label shown for a stored value: generics get their friendly
        // name, a real family is its own name (`utils/fonts.ts:27-32`).
        assert_eq!(font_family_label("serif"), "System Serif");
        assert_eq!(font_family_label("Georgia"), "Georgia");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageProperty {
    X,
    Y,
    Width,
    Height,
    Opacity,
    Rotation,
    Rounding,
}

impl ImageProperty {
    fn label(self) -> &'static str {
        match self {
            Self::X => "Position X",
            Self::Y => "Position Y",
            Self::Width => "Width",
            Self::Height => "Height",
            Self::Opacity => "Opacity",
            Self::Rotation => "Rotation",
            Self::Rounding => "Rounding",
        }
    }
    fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::X | Self::Y => (-50., 150., 1.),
            Self::Width | Self::Height => (1., 200., 1.),
            Self::Rotation => (-180., 180., 1.),
            _ => (0., 100., 1.),
        }
    }
    fn read(self, segment: &cap_project::ImageSegment) -> f32 {
        match self {
            Self::X => (segment.center.x * 100.) as f32,
            Self::Y => (segment.center.y * 100.) as f32,
            Self::Width => (segment.size.x * 100.) as f32,
            Self::Height => (segment.size.y * 100.) as f32,
            Self::Opacity => segment.opacity * 100.,
            Self::Rotation => segment.rotation,
            Self::Rounding => segment.rounding,
        }
    }
    fn write(self, segment: &mut cap_project::ImageSegment, value: f32) {
        if !value.is_finite() {
            return;
        }
        let (min, max, _) = self.limits();
        let value = value.clamp(min, max);
        match self {
            Self::X => segment.center.x = f64::from(value) / 100.,
            Self::Y => segment.center.y = f64::from(value) / 100.,
            Self::Width => {
                let width = f64::from(value) / 100.;
                if segment.lock_aspect && segment.size.x > 0. {
                    segment.size.y *= width / segment.size.x;
                }
                segment.size.x = width;
            }
            Self::Height => {
                let height = f64::from(value) / 100.;
                if segment.lock_aspect && segment.size.y > 0. {
                    segment.size.x *= height / segment.size.y;
                }
                segment.size.y = height;
            }
            Self::Opacity => segment.opacity = value / 100.,
            Self::Rotation => segment.rotation = value,
            Self::Rounding => segment.rounding = value,
        }
    }
}

impl EditorWindow {
    fn render_image_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.image_segments.get(index))
        else {
            return div().into_any_element();
        };
        let mut panel = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(self.labelled_small(
                "Name",
                self.render_field_input(FieldKey::ImageName(index), None),
            ));
        panel = panel
            .child(
                div()
                    .text_size(px(12.))
                    .child("Drag the image in the canvas to move it. Drag a corner to resize."),
            )
            .child(
                ui::Button::plain(
                    &self.theme,
                    SharedString::from(format!("replace-image-{index}")),
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Md,
                )
                .label("Replace image")
                .disabled(self.sidebar.picking_image)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.replace_timeline_image(index, window, cx)
                })),
            );
        if self
            .sidebar
            .image_asset_status
            .as_ref()
            .is_some_and(|(path, present)| path == &segment.path && !present)
        {
            panel = panel.child(div().text_size(px(12.)).child("Image file is missing. Replace it to restore this segment while keeping its timing and transforms."));
        }
        if let Some(error) = &self.sidebar.image_import_error {
            panel = panel.child(div().text_size(px(12.)).child(error.clone()));
        }
        for (key, label, value) in [
            (0, "Enabled", segment.enabled),
            (1, "Lock aspect ratio", segment.lock_aspect),
            (2, "Flip horizontally", segment.flip_x),
            (3, "Flip vertically", segment.flip_y),
        ] {
            panel = panel.child(
                ui::Subfield::plain(&self.theme, label).child(
                    ui::Toggle::plain(
                        &self.theme,
                        SharedString::from(format!("image-{index}-{key}")),
                        value,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_image_segment("image-toggle", index, window, cx, move |segment| {
                            match key {
                                0 => segment.enabled = !value,
                                1 => segment.lock_aspect = !value,
                                2 => segment.flip_x = !value,
                                _ => segment.flip_y = !value,
                            };
                            true
                        })
                    })),
                ),
            );
        }
        for property in [
            ImageProperty::X,
            ImageProperty::Y,
            ImageProperty::Width,
            ImageProperty::Height,
            ImageProperty::Rotation,
            ImageProperty::Rounding,
            ImageProperty::Opacity,
        ] {
            panel = panel.child(
                self.labelled_small(
                    property.label(),
                    self.slider(
                        SliderKey::Panel(PanelSlider::Image(property), index),
                        if property == ImageProperty::Rotation {
                            "°"
                        } else {
                            "%"
                        },
                        cx,
                    )
                    .into_any_element(),
                ),
            );
        }
        panel.into_any_element()
    }

    fn render_style_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        use crate::editor_sidebar::StyleGroup;
        let Some(segment) = self
            .timeline()
            .and_then(|timeline| timeline.style_segments.get(index))
        else {
            return div().into_any_element();
        };
        let enabled = segment.enabled;
        let mut panel = div().flex().flex_col().gap(px(16.))
            .child(div().text_size(px(12.)).child("Overrides apply only during this segment. Enable a group to copy its global settings."))
            .child(self.labelled_small("Name", self.render_field_input(FieldKey::StyleName(index), None)))
            .child(ui::Subfield::plain(&self.theme,"Enabled").child(ui::Toggle::plain(&self.theme,SharedString::from(format!("style-enabled-{index}")),enabled).on_click(cx.listener(move |this,_,window,cx| this.edit_style_segment("style-enabled",index,window,cx,move |segment| { segment.enabled = !enabled; true })))));
        for (group, active) in [
            (
                StyleGroup::Background,
                segment.overrides.background.is_some(),
            ),
            (StyleGroup::Camera, segment.overrides.camera.is_some()),
            (StyleGroup::Cursor, segment.overrides.cursor.is_some()),
        ] {
            panel = panel.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        ui::Subfield::plain(&self.theme, group.label()).child(
                            ui::Toggle::plain(
                                &self.theme,
                                SharedString::from(format!("style-{index}-{group:?}")),
                                active,
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.edit_project(
                                        "style-override",
                                        window,
                                        cx,
                                        move |project| {
                                            let Some(segment) =
                                                project.timeline.as_mut().and_then(|timeline| {
                                                    timeline.style_segments.get_mut(index)
                                                })
                                            else {
                                                return false;
                                            };
                                            match group {
                                                StyleGroup::Background => {
                                                    segment.overrides.background = (!active)
                                                        .then(|| project.background.clone())
                                                }
                                                StyleGroup::Camera => {
                                                    segment.overrides.camera =
                                                        (!active).then(|| project.camera.clone())
                                                }
                                                StyleGroup::Cursor => {
                                                    segment.overrides.cursor =
                                                        (!active).then(|| project.cursor.clone())
                                                }
                                            }
                                            true
                                        },
                                    );
                                },
                            )),
                        ),
                    )
                    .children(active.then(|| {
                        div()
                            .id(SharedString::from(format!("style-edit-{index}-{group:?}")))
                            .cursor_pointer()
                            .px(px(12.))
                            .py(px(8.))
                            .rounded(px(6.))
                            .bg(Hsla::from(self.theme.gray_3))
                            .child(format!("Edit {}", group.label()))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open_style_group(index, group, window, cx)
                            }))
                    })),
            );
        }
        if segment.overrides.background.is_some() {
            let mut crop = div().flex().flex_col().gap(px(8.)).child(
                div()
                    .text_size(px(12.))
                    .child("Screen crop (source pixels)"),
            );
            for (axis, label) in [(0, "Left"), (1, "Top"), (2, "Width"), (3, "Height")] {
                crop = crop.child(self.labelled_small(
                    label,
                    self.render_number_field(FieldKey::StyleCrop(index, axis), "px", 80.),
                ));
            }
            crop = crop.child(
                div()
                    .id(SharedString::from(format!("style-crop-reset-{index}")))
                    .cursor_pointer()
                    .child("Reset crop")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_style_segment(
                            "style-crop-reset",
                            index,
                            window,
                            cx,
                            move |segment| {
                                if let Some(background) = segment.overrides.background.as_mut() {
                                    background.crop = None;
                                    true
                                } else {
                                    false
                                }
                            },
                        )
                    })),
            );
            panel = panel.child(crop);
        }
        let padding = segment.overrides.camera_only_padding.is_some();
        panel = panel.child(
            ui::Subfield::plain(&self.theme, "Camera Only background").child(
                ui::Toggle::plain(
                    &self.theme,
                    SharedString::from(format!("style-camera-only-{index}")),
                    padding,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_style_segment(
                        "camera-only-background",
                        index,
                        window,
                        cx,
                        move |segment| {
                            segment.overrides.camera_only_padding = (!padding).then_some(10.);
                            true
                        },
                    )
                })),
            ),
        );
        if padding {
            panel = panel
                .child(
                    self.labelled_small(
                        "Camera Only padding",
                        self.slider(
                            SliderKey::Panel(PanelSlider::StyleCameraOnlyPadding, index),
                            "%",
                            cx,
                        )
                        .into_any_element(),
                    ),
                )
                .child(div().text_size(px(11.)).child(
                    "Use a Camera Only scene. Padding reveals the background around the camera.",
                ));
        }
        panel.into_any_element()
    }
}
