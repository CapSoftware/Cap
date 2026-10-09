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
    SceneSegment, SplitLayout, TextAlign, TextAnimation, TextBackgroundStyle, TextLayout,
    TextSegment, TimelineConfiguration, XY, ZoomMode, ZoomSegment, mask_effect_contract,
};
use gpui::{
    AnyElement, AppContext, Context, Entity, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseDownEvent, ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_edits::Selection,
    editor_sidebar::{
        ColorTarget, PadKey, PanelSection, SliderKey, collapsible, dashed_divider, with_alpha,
    },
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

/// `TEXT_ANIMATION_OPTIONS` (`text-style.tsx:52-62`), in the renderer's own
/// variant order.
pub const TEXT_ANIMATIONS: [(TextAnimation, &str); 14] = [
    (TextAnimation::None, "None"),
    (TextAnimation::Fade, "Fade"),
    (TextAnimation::SlideUp, "Slide up"),
    (TextAnimation::SlideDown, "Slide down"),
    (TextAnimation::SlideLeft, "Slide left"),
    (TextAnimation::SlideRight, "Slide right"),
    (TextAnimation::Pop, "Pop"),
    (TextAnimation::Zoom, "Zoom"),
    (TextAnimation::Bounce, "Bounce"),
    (TextAnimation::Wipe, "Wipe"),
    (TextAnimation::Words, "Words"),
    (TextAnimation::Letters, "Letters"),
    (TextAnimation::Tracking, "Tracking"),
    (TextAnimation::Typewriter, "Typewriter"),
];

/// `TEXT_BACKGROUND_STYLE_OPTIONS` (`text-style.tsx`). The panel's segmented
/// control shows a fourth "None" ahead of these, which is `backgroundColor`
/// cleared rather than a style of its own.
pub const TEXT_BACKGROUND_STYLES: [(TextBackgroundStyle, &str); 3] = [
    (TextBackgroundStyle::Box, "Box"),
    (TextBackgroundStyle::Pill, "Pill"),
    (TextBackgroundStyle::Highlight, "Highlight"),
];

/// `TEXT_LAYOUT_OPTIONS` (`:3583-3590`): the renderer also has `splitLeft` /
/// `splitRight`, and the source deliberately exposes only these two.
pub const TEXT_LAYOUTS: [(TextLayout, &str); 2] = [
    (TextLayout::Overlay, "Overlay"),
    (TextLayout::Fullscreen, "Fullscreen"),
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

/// `TextPresetStyle` (`text-presets.ts:3-16`). Every field here is written by
/// [`apply_text_preset`], so a preset resets the look whole rather than
/// layering onto whatever the segment carried before.
pub struct TextPresetStyle {
    pub font_stack: &'static [&'static str],
    pub font_size: f32,
    pub font_weight: f32,
    pub italic: bool,
    pub uppercase: bool,
    pub align: TextAlign,
    pub letter_spacing: f32,
    pub line_height: f32,
    pub shadow: f32,
    pub glow: f32,
    pub stroke_width: f32,
    pub stroke_color: &'static str,
    pub background_style: TextBackgroundStyle,
    /// `None` is no background at all.
    pub background_color: Option<&'static str>,
    /// `None` keeps whatever colour the segment already has.
    pub color: Option<&'static str>,
    pub gradient_color: Option<&'static str>,
    pub animation_in: TextAnimation,
    pub animation_in_duration: f64,
    pub animation_out: TextAnimation,
    pub animation_out_duration: f64,
}

/// `TextPreset` (`:18-25`). `center` is only set by presets that imply
/// placement, and it is the one field that moves the box.
pub struct TextPreset {
    pub id: &'static str,
    pub group: &'static str,
    pub name: &'static str,
    pub sample: &'static str,
    pub style: TextPresetStyle,
    pub center: Option<XY<f64>>,
}

const SANS_STACK: &[&str] = &["Helvetica Neue", "Segoe UI", "Inter", "sans-serif"];
const SERIF_STACK: &[&str] = &["Georgia", "Times New Roman", "serif"];
const MONO_STACK: &[&str] = &["Menlo", "Consolas", "monospace"];

/// The Style section's chip row, in order. The row draws "All" ahead of these.
pub const TEXT_PRESET_GROUPS: [&str; 5] =
    ["Titles", "Lower thirds", "Callouts", "Statements", "Code"];

/// The style every preset that does not draw an outline still carries.
const PRESET_STROKE: &str = "#000000";

/// `TEXT_PRESETS` (`text-presets.ts`), in order.
pub static TEXT_PRESETS: &[TextPreset] = &[
    TextPreset {
        id: "title",
        group: "Titles",
        name: "Title",
        sample: "Introducing Cap",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 96.,
            font_weight: 700.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: -1.,
            line_height: 1.1,
            shadow: 0.35,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::SlideUp,
            animation_in_duration: 0.35,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "headline",
        group: "Titles",
        name: "Headline",
        sample: "Ship faster",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 112.,
            font_weight: 800.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: -3.,
            line_height: 1.,
            shadow: 0.3,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::Words,
            animation_in_duration: 0.6,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "cinematic",
        group: "Titles",
        name: "Cinematic",
        sample: "Chapter one",
        center: None,
        style: TextPresetStyle {
            font_stack: SERIF_STACK,
            font_size: 64.,
            font_weight: 400.,
            italic: false,
            uppercase: true,
            align: TextAlign::Center,
            letter_spacing: 12.,
            line_height: 1.2,
            shadow: 0.25,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::Tracking,
            animation_in_duration: 0.9,
            animation_out: TextAnimation::Tracking,
            animation_out_duration: 0.6,
        },
    },
    TextPreset {
        id: "gradient",
        group: "Titles",
        name: "Gradient",
        sample: "Beautiful text",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 104.,
            font_weight: 800.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: -2.,
            line_height: 1.05,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: Some("#ffffff"),
            gradient_color: Some("#b388ff"),
            animation_in: TextAnimation::Zoom,
            animation_in_duration: 0.45,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.3,
        },
    },
    TextPreset {
        id: "lower-third",
        group: "Lower thirds",
        name: "Lower third",
        sample: "Richie McIlroy",
        center: Some(XY { x: 0.22, y: 0.85 }),
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 40.,
            font_weight: 600.,
            italic: false,
            uppercase: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.25,
            shadow: 0.4,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::SlideRight,
            animation_in_duration: 0.35,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "name-tag",
        group: "Lower thirds",
        name: "Name tag",
        sample: "Richie \u{b7} Founder",
        center: Some(XY { x: 0.2, y: 0.86 }),
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 32.,
            font_weight: 600.,
            italic: false,
            uppercase: false,
            align: TextAlign::Left,
            letter_spacing: 0.5,
            line_height: 1.2,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Pill,
            background_color: Some("#000000"),
            color: Some("#ffffff"),
            gradient_color: None,
            animation_in: TextAnimation::SlideRight,
            animation_in_duration: 0.3,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "caption",
        group: "Lower thirds",
        name: "Caption",
        sample: "Recorded with Cap",
        center: Some(XY { x: 0.5, y: 0.88 }),
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 34.,
            font_weight: 500.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: 0.,
            line_height: 1.3,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: Some("#000000"),
            color: Some("#ffffff"),
            gradient_color: None,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.25,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "kicker",
        group: "Callouts",
        name: "Kicker",
        sample: "New feature",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 26.,
            font_weight: 700.,
            italic: false,
            uppercase: true,
            align: TextAlign::Center,
            letter_spacing: 6.,
            line_height: 1.2,
            shadow: 0.2,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.2,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "label",
        group: "Callouts",
        name: "Label",
        sample: "Pro tip",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 28.,
            font_weight: 600.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: 0.3,
            line_height: 1.2,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Pill,
            background_color: Some("#007aff"),
            color: Some("#ffffff"),
            gradient_color: None,
            animation_in: TextAnimation::Pop,
            animation_in_duration: 0.3,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "highlight",
        group: "Callouts",
        name: "Highlight",
        sample: "the important part",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 56.,
            font_weight: 700.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: 0.,
            line_height: 1.25,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Highlight,
            background_color: Some("#ffe14d"),
            color: Some("#111111"),
            gradient_color: None,
            animation_in: TextAnimation::Wipe,
            animation_in_duration: 0.5,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "sticker",
        group: "Callouts",
        name: "Sticker",
        sample: "Boom!",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 88.,
            font_weight: 900.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: -1.,
            line_height: 1.1,
            shadow: 0.3,
            glow: 0.,
            stroke_width: 8.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: Some("#ffffff"),
            gradient_color: None,
            animation_in: TextAnimation::Bounce,
            animation_in_duration: 0.5,
            animation_out: TextAnimation::Pop,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "neon",
        group: "Callouts",
        name: "Neon",
        sample: "Glow up",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 84.,
            font_weight: 700.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: 1.,
            line_height: 1.1,
            shadow: 0.,
            glow: 1.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: Some("#7df9ff"),
            gradient_color: None,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.5,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.4,
        },
    },
    TextPreset {
        id: "stat",
        group: "Statements",
        name: "Big stat",
        sample: "128%",
        center: None,
        style: TextPresetStyle {
            font_stack: SANS_STACK,
            font_size: 160.,
            font_weight: 800.,
            italic: false,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: -2.,
            line_height: 1.,
            shadow: 0.3,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::Pop,
            animation_in_duration: 0.4,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.25,
        },
    },
    TextPreset {
        id: "quote",
        group: "Statements",
        name: "Quote",
        sample: "\u{201c}Make it feel effortless\u{201d}",
        center: None,
        style: TextPresetStyle {
            font_stack: SERIF_STACK,
            font_size: 56.,
            font_weight: 500.,
            italic: true,
            uppercase: false,
            align: TextAlign::Center,
            letter_spacing: 0.,
            line_height: 1.35,
            shadow: 0.2,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
            animation_in: TextAnimation::Words,
            animation_in_duration: 0.8,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.3,
        },
    },
    TextPreset {
        id: "code",
        group: "Code",
        name: "Code",
        sample: "$ cap record",
        center: None,
        style: TextPresetStyle {
            font_stack: MONO_STACK,
            font_size: 36.,
            font_weight: 400.,
            italic: false,
            uppercase: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.4,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: Some("#0f1115"),
            color: Some("#e6edf3"),
            gradient_color: None,
            animation_in: TextAnimation::Fade,
            animation_in_duration: 0.2,
            animation_out: TextAnimation::Fade,
            animation_out_duration: 0.2,
        },
    },
    TextPreset {
        id: "typewriter",
        group: "Code",
        name: "Typewriter",
        sample: "typing it out\u{2026}",
        center: None,
        style: TextPresetStyle {
            font_stack: MONO_STACK,
            font_size: 44.,
            font_weight: 500.,
            italic: false,
            uppercase: false,
            align: TextAlign::Left,
            letter_spacing: 0.,
            line_height: 1.3,
            shadow: 0.,
            glow: 0.,
            stroke_width: 0.,
            stroke_color: PRESET_STROKE,
            background_style: TextBackgroundStyle::Box,
            background_color: None,
            color: None,
            gradient_color: None,
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

/// `applyTextPreset` (`text-presets.ts:205-238`). Timing stays the user's, and
/// so does the content unless it is still the placeholder a new segment is
/// born with; the box is scaled with the font change about its **top** edge,
/// exactly as the Size slider does.
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
    segment.uppercase = style.uppercase;
    segment.align = style.align;
    segment.letter_spacing = style.letter_spacing;
    segment.line_height = style.line_height;
    segment.opacity = 1.;
    segment.shadow = style.shadow;
    segment.glow = style.glow;
    segment.stroke_width = style.stroke_width;
    segment.stroke_color = style.stroke_color.to_string();
    segment.background_style = style.background_style;
    segment.background_color = style.background_color.map(str::to_string);
    segment.gradient_color = style.gradient_color.map(str::to_string);
    if let Some(color) = style.color {
        segment.color = color.to_string();
    }
    segment.animation_in = style.animation_in;
    segment.animation_out = style.animation_out;
    segment.animation_in_duration = style.animation_in_duration;
    segment.animation_out_duration = style.animation_out_duration;
    segment.fade_duration = style
        .animation_in_duration
        .max(style.animation_out_duration);
    if matches!(segment.content.trim(), "" | "Text") {
        segment.content = preset.sample.to_string();
    }
    if let Some(center) = preset.center {
        segment.center = center;
    }
}

/// `matchTextPreset` (`text-presets.ts:240-265`): which preset, if any, the
/// segment currently *is*. Everything but font size, colour, content, timing
/// and position has to agree, with the source's own 0.011 tolerance on the
/// float fields; `stroke_color` only counts when the preset draws an outline.
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
                && segment.uppercase == style.uppercase
                && segment.align == style.align
                && near(segment.letter_spacing.into(), style.letter_spacing.into())
                && near(segment.line_height.into(), style.line_height.into())
                && near(segment.shadow.into(), style.shadow.into())
                && near(segment.glow.into(), style.glow.into())
                && near(segment.stroke_width.into(), style.stroke_width.into())
                && (style.stroke_width <= 0. || segment.stroke_color == style.stroke_color)
                && segment.background_style == style.background_style
                && segment.background_color.as_deref() == style.background_color
                && segment.gradient_color.as_deref() == style.gradient_color
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
/// `grid-cols-2 gap-2`.
const CARD_GRID_WIDTH_2: f32 = card_grid_width(2., 8.);
/// `grid-cols-3 gap-1.5`.
const CARD_GRID_WIDTH_3: f32 = card_grid_width(3., 6.);

// -- The 3D shot panel's geometry -------------------------------------------
// This panel draws its own groups rather than sitting in the shared card, so
// its content is the sidebar less the scroll body's `p-4`.

/// The panel's content column.
const CAMERA3D_PANEL_WIDTH: f32 = crate::editor_window::SIDEBAR_WIDTH - 32.;
/// Every group's inner padding.
const CAMERA3D_GROUP_PADDING: f32 = 12.;
/// What is left inside a group, its hairline and padding removed.
const CAMERA3D_GROUP_WIDTH: f32 = CAMERA3D_PANEL_WIDTH - 2. - CAMERA3D_GROUP_PADDING * 2.;
/// Four Look tiles to a row, 8px apart, with a pixel of slack.
const CAMERA3D_LOOK_TILE: f32 = (CAMERA3D_GROUP_WIDTH - 24. - 4.) / 4.;
/// The tiles' 4:3 thumbnails.
const CAMERA3D_LOOK_THUMB: f32 = CAMERA3D_LOOK_TILE * 0.75;
/// Three sequence cards to a row.
const CAMERA3D_SEQUENCE_CARD: f32 = (CAMERA3D_GROUP_WIDTH - 16. - 3.) / 3.;
/// The orbit pad.
const CAMERA3D_ORBIT_PAD: f32 = 132.;
/// The pose strip's two cards: half the group each, less the swap between
/// them, at 4:3.
const CAMERA3D_POSE_CARD: f32 = (CAMERA3D_GROUP_WIDTH - 24. - 16.) / 2.;
const CAMERA3D_POSE_CARD_HEIGHT: f32 = CAMERA3D_POSE_CARD * 0.75;
/// The panel's compact slider rows: the sidebar's own 96px label column does
/// not fit beside the pad.
const CAMERA3D_ROW_LABEL: f32 = 62.;
const CAMERA3D_ROW_VALUE: f32 = 42.;

/// The Look tiles' and orbit pad's backdrop. The plate drawn on it stands for
/// the recording rather than for the chrome, so it stays light in both
/// appearances -- these are the mock's own values.
fn camera3d_thumb_bg(dark: bool) -> Hsla {
    Hsla::from(gpui::rgb(if dark { 0x26262b } else { 0xdcdce2 }))
}
const CAMERA3D_PLATE: u32 = 0xffffff;
const CAMERA3D_PLATE_DARK: u32 = 0xf2f2f4;
const CAMERA3D_PLATE_LINE: u32 = 0xb8b8c2;
/// What the Depth blur toggle seeds when it is switched on.
const CAMERA3D_DEFAULT_BLUR_STRENGTH: f64 = 18.;
const CAMERA3D_DEFAULT_BLUR_FALLOFF: f64 = 0.7;

/// The Focus segmented control: the three real modes, in the order the source
/// lists them. "None" is the toggle, not an option.
const CAMERA3D_FOCUS_MODES: [(Camera3DBlurMode, &str); 3] = [
    (Camera3DBlurMode::Radial, "Radial"),
    (Camera3DBlurMode::Directional, "Directional"),
    (Camera3DBlurMode::TiltShift, "Tilt shift"),
];

// ---------------------------------------------------------------------------
// Seeking to a pose, and the Auto scene's shot pool
// ---------------------------------------------------------------------------

/// The first whole frame at or after `time`.
///
/// The renderer quantises a seek by flooring it onto a frame, so seeking to a
/// shot's own `start` lands on the frame *before* the shot whenever the start
/// is not on a frame boundary -- and the player then shows the previous scene
/// instead of the move that was just clicked.
fn camera3d_frame_at_or_after(time: f64, fps: u32) -> f64 {
    let fps = f64::from(fps.max(1));
    ((time * fps - 1e-6).ceil() / fps).max(0.)
}

/// The last whole frame that still belongs to a shot ending at `end`.
fn camera3d_frame_before(end: f64, fps: u32) -> f64 {
    let fps = f64::from(fps.max(1));
    (((end - 1e-3) * fps).floor() / fps).max(0.)
}

/// `camera3DPoseSeekTime`: where the playhead goes to show one end of a shot.
///
/// The end pose is the last frame inside the shot rather than its boundary,
/// which belongs to whatever comes next; it never lands before the start
/// frame, so a shot shorter than a frame still shows its own pose.
pub fn camera3d_pose_seek_time(segment: &Camera3DSegment, end: bool, fps: u32) -> f64 {
    let start_frame = camera3d_frame_at_or_after(segment.start, fps);
    if !end {
        return start_frame;
    }
    camera3d_frame_before(segment.end, fps).max(start_frame)
}

/// How many shots the Auto scene picker offers.
pub const AUTO_CAMERA3D_MAX_SHOTS: usize = 6;

/// `maxAutoCamera3DShots`: a recording only holds so many shots at the one
/// second below which a cut reads as a glitch.
pub fn max_auto_camera3d_shots(total: f64) -> usize {
    if !total.is_finite() || total <= 0. {
        return 0;
    }
    ((total / CAMERA3D_MIN_SHOT_DURATION).floor() as usize).min(AUTO_CAMERA3D_MAX_SHOTS)
}

/// `AUTO_SHOT_POOL`: the three authored scenes' nine shots, in scene order,
/// re-weighted equally -- the picker's Nth scene is the first N of these, so
/// asking for one more shot keeps the ones already there and adds to them.
pub fn auto_camera3d_shots(count: usize) -> Vec<SceneShot> {
    CAMERA3D_SCENES
        .iter()
        .flat_map(|scene| scene.shots.iter())
        .take(count)
        .map(|shot| SceneShot {
            weight: 1.,
            from: shot.from,
            to: shot.to,
            blur: shot.blur,
        })
        .collect()
}

/// `autoCamera3DScene(count)` laid across a range: one shot is the opening
/// move over the whole thing, and anything more is the pool cut on the clips.
pub fn auto_camera3d_layout(
    count: usize,
    start: f64,
    end: f64,
    clip_cuts: &[f64],
) -> Vec<Camera3DSegment> {
    if end <= start || !(end - start).is_finite() || count == 0 {
        return Vec::new();
    }
    if count == 1 {
        return vec![new_camera3d_shot(start, end)];
    }
    apply_camera3d_shots_to_range(&auto_camera3d_shots(count), start, end, clip_cuts)
}

/// One stroke of the drawn plate: its points in plate space, and the ink it
/// takes -- `None` being the plate's own fill.
type Camera3DPlateShape = (&'static [(f32, f32)], Option<u32>);

/// The plate's four corners in plate space, in order.
const CAMERA3D_PLATE_CORNERS: [(f32, f32); 4] = [(-1., 1.), (1., 1.), (1., -1.), (-1., -1.)];

/// How much a pose's projected plate has to shrink to stay inside its tile,
/// and the pose to draw it with.
///
/// A pose close enough to push the plate's far corners through the camera
/// projects as a bowtie rather than a card -- true to the renderer, useless as
/// a picture. Those are drawn from further back instead: the orientation the
/// tile is there to show survives, and the fit normalises the size away
/// anyway.
fn camera3d_plate_fit(pose: &Camera3DProperties) -> Option<(Camera3DProperties, f32)> {
    let mut preview = *pose;
    for step in 0..10 {
        // A plate whose far corner runs off to several frame widths is a
        // sliver once it is scaled to fit, so those pull back too.
        if let Some(extent) =
            camera3d_plate_extent(&preview).filter(|extent| *extent <= 1.2 || step == 9)
        {
            // 0.44 leaves a hair of margin inside the tile. A plate that fits
            // keeps its true size, so a distant pose reads as distant -- but a
            // pose that had to be pulled back is normalised, or the tile would
            // report a distance nobody asked for.
            let scale = if extent > 0.44 || step > 0 {
                0.44 / extent
            } else {
                1.
            };
            return Some((preview, scale));
        }
        preview.zoom *= 1.4;
    }
    None
}

/// The plate's half-extent in view space, or `None` when it does not project
/// as a plain convex quad -- which is what a pose close enough to push its far
/// corners through the camera does.
fn camera3d_plate_extent(pose: &Camera3DProperties) -> Option<f32> {
    let mut corners = [(0_f32, 0_f32); 4];
    let mut extent = 0_f32;
    for (index, (x, y)) in CAMERA3D_PLATE_CORNERS.into_iter().enumerate() {
        let (px, py) = camera3d_projected_point(pose, x, y)?;
        corners[index] = (px, py);
        extent = extent.max((px - 0.5).abs()).max((py - 0.5).abs());
    }
    if !extent.is_finite() {
        return None;
    }
    let mut sign = 0_f32;
    for index in 0..4 {
        let (ax, ay) = corners[index];
        let (bx, by) = corners[(index + 1) % 4];
        let (cx, cy) = corners[(index + 2) % 4];
        let cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
        if cross.abs() < 1e-6 {
            return None;
        }
        if sign == 0. {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return None;
        }
    }
    (extent > 0.).then_some(extent)
}

/// One plate-space point, projected and then fitted about the frame centre.
fn camera3d_plate_point(pose: &Camera3DProperties, fit: f32, x: f32, y: f32) -> Option<(f32, f32)> {
    let (px, py) = camera3d_projected_point(pose, x, y)?;
    Some((0.5 + (px - 0.5) * fit, 0.5 + (py - 0.5) * fit))
}

/// Where the orbit pad's dot sits for a pose: `tiltY` across, `tiltX` up, each
/// linear across its own `CAMERA3D_LIMITS` range with the centre on zero.
fn camera3d_orbit_point(pose: &Camera3DProperties) -> (f32, f32) {
    let axis = |property: Camera3DProperty| {
        let (min, max, _) = property.limits();
        let span = f64::from(max - min);
        if span <= 0. {
            return 0.5_f32;
        }
        (((property.read(pose) - f64::from(min)) / span) as f32).clamp(0., 1.)
    };
    // Positive tilt X is the camera looking down, which belongs at the top.
    (
        axis(Camera3DProperty::TiltY),
        1. - axis(Camera3DProperty::TiltX),
    )
}

/// The inverse: a point on the pad back onto the two tilts.
fn camera3d_orbit_tilts(x: f64, y: f64) -> (f64, f64) {
    let axis = |property: Camera3DProperty, fraction: f64| {
        let (min, max, _) = property.limits();
        f64::from(min) + fraction.clamp(0., 1.) * f64::from(max - min)
    };
    (
        axis(Camera3DProperty::TiltX, 1. - y),
        axis(Camera3DProperty::TiltY, x),
    )
}

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
    apply_camera3d_shots_to_range(scene.shots, start, end, clip_cuts)
}

/// The same, over a shot list that is not one of the three authored scenes --
/// which is what the Auto scene picker builds.
pub fn apply_camera3d_shots_to_range(
    shots: &[SceneShot],
    start: f64,
    end: f64,
    clip_cuts: &[f64],
) -> Vec<Camera3DSegment> {
    let length = end - start;
    if length <= 0. || !length.is_finite() || shots.is_empty() {
        return Vec::new();
    }

    let keep = ((length / CAMERA3D_MIN_SHOT_DURATION).floor() as usize)
        .min(shots.len())
        .max(1);
    let shots = &shots[..keep];
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

// ---------------------------------------------------------------------------
// Shots: placement, look matching, labels
// ---------------------------------------------------------------------------

/// `DEFAULT_SHOT_DURATION`: the length a new 3D shot opens at.
pub const CAMERA3D_DEFAULT_SHOT_DURATION: f64 = 4.;

/// The move a brand-new shot is born with, and what the ghost calls it.
pub const CAMERA3D_DEFAULT_LOOK: &str = "glide-across";
pub const CAMERA3D_DEFAULT_LOOK_NAME: &str = "Glide across";

/// Where a new shot lands, given the shots already on the track.
///
/// A click in free space starts the shot there and runs it for `duration`,
/// shortened to whatever the gap holds and slid left when the gap's tail is
/// too short. A click **inside** an existing shot is not a no-op -- it takes
/// the next free gap after that shot, then the first free gap anywhere. Only a
/// track with no gap at least [`CAMERA3D_MIN_SHOT_DURATION`] long returns
/// `None`, which is the one case the caller reports rather than silently
/// swallowing.
pub fn place_camera3d_shot(
    existing: &[(f64, f64)],
    time: f64,
    duration: f64,
    total: f64,
) -> Option<(f64, f64)> {
    if ![time, duration, total]
        .iter()
        .all(|value| value.is_finite())
        || duration <= 0.
        || total <= 0.
    {
        return None;
    }
    let minimum = CAMERA3D_MIN_SHOT_DURATION.min(total);

    // The occupied spans, clamped to the timeline, sorted and merged, so an
    // overlapping pair cannot hand out a gap that is really inside a shot.
    let mut taken: Vec<(f64, f64)> = existing
        .iter()
        .copied()
        .filter(|(start, end)| start.is_finite() && end.is_finite() && end > start && *end > 0.)
        .map(|(start, end)| (start.max(0.), end.min(total)))
        .filter(|(start, end)| end > start)
        .collect();
    taken.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut occupied: Vec<(f64, f64)> = Vec::with_capacity(taken.len());
    for (start, end) in taken {
        match occupied.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => occupied.push((start, end)),
        }
    }

    let mut gaps: Vec<(f64, f64)> = Vec::new();
    let mut cursor = 0.;
    for &(start, end) in &occupied {
        if start - cursor >= minimum {
            gaps.push((cursor, start));
        }
        cursor = cursor.max(end);
    }
    if total - cursor >= minimum {
        gaps.push((cursor, total));
    }

    let time = time.clamp(0., total);
    let (gap_start, gap_end) = gaps
        .iter()
        .copied()
        .find(|(start, end)| time >= *start && time < *end)
        .or_else(|| gaps.iter().copied().find(|(start, _)| *start >= time))
        .or_else(|| gaps.first().copied())?;

    // A gap the click did not land in is filled from its own start.
    let anchor = if time >= gap_start && time < gap_end {
        time
    } else {
        gap_start
    };
    let mut start = anchor;
    let mut end = (start + duration).min(gap_end);
    // Only a tail too short to read as a shot slides the start back.
    if end - start < minimum {
        start = (gap_end - minimum).max(gap_start);
        end = gap_end;
    }
    (end - start >= minimum).then_some((start, end))
}

/// A new shot: the default segment with the opening move already on it, so
/// what lands on the timeline is a complete look rather than a still frame.
pub fn new_camera3d_shot(start: f64, end: f64) -> Camera3DSegment {
    let mut segment = crate::editor_edits::default_camera3d_segment(start, end);
    if let Some(template) = MOTION_TEMPLATES
        .iter()
        .find(|template| template.id == CAMERA3D_DEFAULT_LOOK)
    {
        apply_motion_template(&mut segment, template);
    }
    segment.transition_in = 0.;
    segment.transition_out = 0.;
    segment
}

/// Which half of the Look grid a look belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookKind {
    Move,
    Angle,
}

/// One entry of the Look grid, resolved back from a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Look {
    pub kind: LookKind,
    pub id: &'static str,
    pub name: &'static str,
}

/// Half a slider step -- the tightest two poses can differ and still be "the
/// same pose", which is the tolerance `matchAnglePreset` is written against.
fn camera3d_poses_match(a: &Camera3DProperties, b: &Camera3DProperties) -> bool {
    Camera3DProperty::ALL.iter().all(|property| {
        let epsilon = f64::from(property.limits().2 / 2.).max(1e-4);
        (property.read(a) - property.read(b)).abs() <= epsilon
    })
}

/// `matchCamera3DLook`: which Look tile, if any, this shot is sitting on.
///
/// Both ends have to match, because the grid's ring means "clicking this tile
/// would change nothing" -- and a template writes both. Blur is not part of
/// the comparison: a shot whose defocus was dialled in by hand is still the
/// move it was given.
pub fn match_camera3d_look(segment: &Camera3DSegment) -> Option<Look> {
    let start = start_pose(segment);
    let end = end_pose(segment);
    MOTION_TEMPLATES
        .iter()
        .find(|template| {
            camera3d_poses_match(&start, &template.from) && camera3d_poses_match(&end, &template.to)
        })
        .map(|template| Look {
            kind: LookKind::Move,
            id: template.id,
            name: template.name,
        })
        .or_else(|| {
            ANGLE_PRESETS
                .iter()
                .find(|preset| {
                    camera3d_poses_match(&start, &preset.values)
                        && camera3d_poses_match(&end, &preset.drift)
                })
                .map(|preset| Look {
                    kind: LookKind::Angle,
                    id: preset.id,
                    name: preset.name,
                })
        })
}

/// What the timeline box and the panel header call this shot.
pub fn camera3d_shot_label(segment: &Camera3DSegment) -> &'static str {
    if let Some(look) = match_camera3d_look(segment) {
        return look.name;
    }
    if poses_equal(&start_pose(segment), &end_pose(segment)) {
        "Still shot"
    } else {
        "Custom move"
    }
}

/// The Look tiles' little plate, projected through the pose's own homography.
///
/// `x` / `y` are in the plate's own [-1, 1] space; the result is the point in
/// [0, 1] view space to paint it at, or `None` when the pose folds the plate
/// through the camera and there is nothing to draw.
pub fn camera3d_projected_point(pose: &Camera3DProperties, x: f32, y: f32) -> Option<(f32, f32)> {
    let projection = cap_rendering::camera3d::camera3d_inverse_homography(pose, 16.0 / 9.0, None)?;
    let [[a, b, c], [d, e, f], [g, h, i]] = projection.inverse_rows;
    let x = x * projection.half_extents.0;
    let y = y * projection.half_extents.1;
    let w = (d * h - e * g) * x + (b * g - a * h) * y + a * e - b * d;
    if w.abs() < 0.00001 {
        return None;
    }
    let px = ((e * i - f * h) * x + (c * h - b * i) * y + b * f - c * e) / w;
    let py = ((f * g - d * i) * x + (a * i - c * g) * y + c * d - a * f) / w;
    (px.is_finite() && py.is_finite()).then_some(((px + 1.0) / 2.0, (1.0 - py) / 2.0))
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
    TextStroke,
    TextGlow,
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
    /// The 3D shot's `transitionIn` / `transitionOut`, in seconds.
    Camera3DTransitionIn,
    Camera3DTransitionOut,
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
            PanelSlider::TextOpacity | PanelSlider::TextShadow | PanelSlider::TextGlow => {
                (0., 1., 0.01)
            }
            PanelSlider::TextStroke => (0., 12., 0.5),
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
            PanelSlider::Camera3DTransitionIn | PanelSlider::Camera3DTransitionOut => {
                let (min, max, step) = CAMERA3D_TRANSITION_LIMITS;
                (min as f32, max as f32, step as f32)
            }
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
            | PanelSlider::TextStroke
            | PanelSlider::TextGlow
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
                    PanelSlider::TextStroke => segment.stroke_width,
                    PanelSlider::TextGlow => segment.glow,
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
            PanelSlider::Camera3DTransitionIn | PanelSlider::Camera3DTransitionOut => {
                timeline.camera3d_segments.get(index).map_or(0., |segment| {
                    if slider == PanelSlider::Camera3DTransitionIn {
                        segment.transition_in as f32
                    } else {
                        segment.transition_out as f32
                    }
                })
            }
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
            | PanelSlider::TextShadow
            | PanelSlider::TextStroke
            | PanelSlider::TextGlow => {
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
                        PanelSlider::TextStroke => segment.stroke_width = value.clamp(0., 12.),
                        PanelSlider::TextGlow => segment.glow = value.clamp(0., 1.),
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
            PanelSlider::Camera3DTransitionIn | PanelSlider::Camera3DTransitionOut => self
                .edit_camera3d_segment("camera3d-ease", index, window, cx, move |segment| {
                    let value = f64::from(value);
                    if slider == PanelSlider::Camera3DTransitionIn {
                        segment.transition_in = value;
                    } else {
                        segment.transition_out = value;
                    }
                    true
                }),
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
            // The 3D orbit pad. A still shot moves both ends together, the
            // same rule the pose sliders follow.
            PadKey::Camera3DOrbit(index) => {
                let editing_end = self.sidebar.editing_end_pose;
                let (tilt_x, tilt_y) = camera3d_orbit_tilts(x, y);
                self.edit_camera3d_segment("camera3d-orbit", index, window, cx, move |segment| {
                    let start = start_pose(segment);
                    let end = end_pose(segment);
                    let still = poses_equal(&start, &end);
                    let mut selected = if still || !editing_end { start } else { end };
                    selected.tilt_x = tilt_x;
                    selected.tilt_y = tilt_y;
                    let (_, _, out, into) = MOTION_EASINGS[motion_easing(segment)];
                    if still {
                        set_motion(segment, &selected, &selected, (out, into));
                    } else if editing_end {
                        set_motion(segment, &start, &selected, (out, into));
                    } else {
                        set_motion(segment, &selected, &end, (out, into));
                    }
                    true
                });
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
            // The orbit pad draws its own dot from the pose being edited; this
            // is only the value the shared drag layer reads back.
            PadKey::Camera3DOrbit(index) => timeline
                .camera3d_segments
                .get(index)
                .map(|segment| {
                    let pose = if self.sidebar.editing_end_pose {
                        end_pose(segment)
                    } else {
                        start_pose(segment)
                    };
                    let (x, y) = camera3d_orbit_point(&pose);
                    (f64::from(x), f64::from(y))
                })
                .unwrap_or((0.5, 0.5)),
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
            // One shot draws the whole panel, header included -- it carries
            // `Play shot`, which the shared header has no room for. A
            // multi-selection keeps the shared header and nothing else.
            TrackKind::ThreeD => {
                let indices = count(timeline.camera3d_segments.len());
                if indices.len() == 1 {
                    self.render_camera3d_panel(indices[0], cx)
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(16.))
                        .child(self.panel_header("3d", "3D", indices.len(), cx))
                        .into_any_element()
                }
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
            .pt(px(14.))
            .px(px(16.))
            .pb(px(16.))
            .gap(px(14.))
            .text_size(px(13.))
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
            .border_color(Hsla::from(self.theme.editor.line))
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
            .gap(px(14.))
            .child(self.slider_field(
                SharedString::from(format!("Zoom {}", index + 1)),
                SliderKey::Panel(PanelSlider::ZoomAmount, index),
                "x",
                cx,
            ))
            .child(
                ui::Field::section(&theme, "Zoom Mode").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(14.))
                        .child(self.zoom_mode_tabs(
                            manual,
                            cx,
                            move |this, want_manual, window, cx| {
                                this.set_zoom_mode(index, want_manual, window, cx);
                            },
                        ))
                        .child(self.zoom_mode_helper(manual, cx))
                        .children(manual.then(|| self.render_pad(PadKey::ZoomManual(index), cx))),
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
                    .gap(px(14.))
                    .p(px(16.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.editor.line))
                    .child({
                        let mut field = self.slider_field(
                            "Zoom Amount",
                            SliderKey::Panel(PanelSlider::ZoomAmountAll, 0),
                            "x",
                            cx,
                        );
                        if mixed_amount {
                            field = field.value(mixed_badge("Mixed"));
                        }
                        field
                    })
                    .child({
                        let mut field = ui::Field::section(&theme, "Zoom Mode").child(
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
                                .children((!mixed_mode).then(|| self.zoom_mode_helper(manual, cx)))
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
                    // `h-[30px] rounded-[7px] border-0 bg-ed-ctl px-2 text-[12px]`
                    .padding_x(px(8.))
                    .height(px(30.))
                    .radius(px(7.))
                    .text_size(px(12.))
                    .bg(Hsla::from(theme.editor.ctl))
                    .border(gpui::transparent_black())
                    .text_color(Hsla::from(theme.editor.text_1))
                    .caret_color(Hsla::from(theme.editor.accent)),
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
                .border(Hsla::from(theme.editor.line));
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

/// A stored `#RRGGBB` as a paintable colour.
fn hex_color(hex: &str) -> Option<Hsla> {
    crate::editor_sidebar::hex_to_rgb(hex).map(|rgba| {
        crate::editor_sidebar::color_to_hsla([
            u16::from(rgba[0]),
            u16::from(rgba[1]),
            u16::from(rgba[2]),
        ])
    })
}

/// What an Animation tile draws above its label. The Solid panel replays a
/// 0.6s CSS keyframe of the real effect on hover; gpui has no transitions, so
/// each effect gets one static depiction built from plain text and hairlines,
/// spelled the same way in both apps.
fn text_animation_depiction(animation: TextAnimation, color: Hsla, accent: Hsla) -> AnyElement {
    let faint = with_alpha(color, 0.35);
    let row = || {
        div()
            .flex()
            .flex_row()
            .items_center()
            .h(px(20.))
            .text_size(px(13.))
            .font_weight(FontWeight::SEMIBOLD)
    };
    match animation {
        TextAnimation::None => row().child("Aa").into_any_element(),
        TextAnimation::Fade => row()
            .text_color(with_alpha(color, 0.45))
            .child("Aa")
            .into_any_element(),
        TextAnimation::SlideUp => row()
            .gap(px(2.))
            .child("Aa")
            .child("\u{2191}")
            .into_any_element(),
        TextAnimation::SlideDown => row()
            .gap(px(2.))
            .child("Aa")
            .child("\u{2193}")
            .into_any_element(),
        TextAnimation::SlideLeft => row()
            .gap(px(2.))
            .child("\u{2190}")
            .child("Aa")
            .into_any_element(),
        TextAnimation::SlideRight => row()
            .gap(px(2.))
            .child("Aa")
            .child("\u{2192}")
            .into_any_element(),
        TextAnimation::Pop => row().text_size(px(15.)).child("Aa").into_any_element(),
        TextAnimation::Zoom => row().text_size(px(11.)).child("Aa").into_any_element(),
        TextAnimation::Bounce => div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .h(px(20.))
            .gap(px(2.))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Aa"),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(14.))
                    .h(px(1.5))
                    .bg(with_alpha(color, 0.4)),
            )
            .into_any_element(),
        TextAnimation::Wipe => row()
            .gap(px(2.))
            .child("A")
            .child(div().flex_none().w(px(1.)).h(px(12.)).bg(color))
            .child(div().text_color(faint).child("a"))
            .into_any_element(),
        TextAnimation::Words => row()
            .gap(px(3.))
            .child("Aa")
            .child(div().text_color(faint).child("Bb"))
            .into_any_element(),
        TextAnimation::Letters => row()
            .child("A")
            .child(div().text_color(faint).child("a"))
            .into_any_element(),
        TextAnimation::Tracking => row().gap(px(4.)).child("A").child("a").into_any_element(),
        TextAnimation::Typewriter => row()
            .gap(px(1.))
            .child("Aa")
            .child(div().text_color(accent).child("\u{258f}"))
            .into_any_element(),
    }
}

// ---------------------------------------------------------------------------
// The six remaining panels
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// The Style section's preset grid.
    ///
    /// A card draws the preset's family, weight, slant, case and colour, plus
    /// the background span with its box / pill / highlight radius. The stroke,
    /// gradient, glow and shadow the renderer applies have no gpui equivalent
    /// on a text run, and gpui's text system exposes no letter spacing, so a
    /// card leaves all five out -- the panel's own controls below still show
    /// them.
    fn render_text_presets(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let installed = installed_fonts();
        let group = self.sidebar.text_style_group;
        let active = self
            .timeline()
            .and_then(|timeline| timeline.text_segments.get(index))
            .and_then(|segment| match_text_preset(segment, installed));

        let chip = |slot: usize, label: &'static str, cx: &mut Context<Self>| {
            let selected = group == slot;
            div()
                .id(SharedString::from(format!(
                    "text-style-group-{index}-{slot}"
                )))
                .flex()
                .flex_none()
                .items_center()
                .h(px(22.))
                .px(px(6.))
                .rounded_full()
                .text_size(px(11.))
                .font_weight(FontWeight::MEDIUM)
                .when(selected, |this| {
                    this.bg(Hsla::from(theme.editor.ctl_active))
                        .text_color(Hsla::from(theme.editor.text_1))
                })
                .when(!selected, |this| {
                    this.text_color(Hsla::from(theme.editor.text_2))
                        .hover(|style| style.text_color(Hsla::from(theme.editor.text_1)))
                })
                .child(label)
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.sidebar.text_style_group = slot;
                    cx.notify();
                }))
        };

        // `grid-cols-2 gap-2`: gpui has no grid, so the rows are explicit and
        // each cell takes the fixed width a two-column grid resolves to.
        let card = |preset: &'static TextPreset, cx: &mut Context<Self>| {
            let style = &preset.style;
            let selected = active == Some(preset.id);
            let id = preset.id;
            let sample_size = (style.font_size * 0.2).clamp(11., 22.);
            let sample_color = style.color.and_then(hex_color).unwrap_or_else(gpui::white);
            let sample_text: SharedString = if style.uppercase {
                SharedString::from(preset.sample.to_uppercase())
            } else {
                SharedString::from(preset.sample)
            };
            let run = div()
                .max_w_full()
                .overflow_hidden()
                .whitespace_nowrap()
                .truncate()
                .text_size(px(sample_size))
                .text_color(sample_color)
                .font_family(preset_font_family(style.font_stack, installed))
                .font_weight(gpui::FontWeight(style.font_weight))
                .when(style.italic, |this| this.italic())
                .child(sample_text);
            let sample = match style.background_color.and_then(hex_color) {
                // `0.15em 0.4em` with the style's radius; highlight is the
                // tighter marker, `0 0.25em`.
                Some(background) => {
                    let (radius, pad_x, pad_y) = match style.background_style {
                        TextBackgroundStyle::Box => (sample_size * 0.2, sample_size * 0.4, 0.15),
                        TextBackgroundStyle::Pill => (sample_size, sample_size * 0.5, 0.15),
                        TextBackgroundStyle::Highlight => {
                            (sample_size * 0.15, sample_size * 0.25, 0.)
                        }
                    };
                    div()
                        .flex()
                        .max_w_full()
                        .overflow_hidden()
                        .rounded(px(radius))
                        .bg(background)
                        .px(px(pad_x))
                        .py(px(pad_y * sample_size))
                        .child(run)
                        .into_any_element()
                }
                None => run.into_any_element(),
            };

            div()
                .id(SharedString::from(format!("text-preset-{index}-{id}")))
                .w(px(CARD_GRID_WIDTH_2))
                .flex_none()
                .h(px(68.))
                .flex()
                .items_center()
                .justify_center()
                .relative()
                .overflow_hidden()
                .rounded(px(10.))
                .px(px(8.))
                .pb(px(12.))
                .bg(gpui::linear_gradient(
                    160.,
                    gpui::linear_color_stop(gpui::rgb(0x1e1f26), 0.),
                    gpui::linear_color_stop(gpui::rgb(0x2c2d36), 1.),
                ))
                .border_1()
                .border_color(Hsla::from(theme.editor.line))
                .when(!selected, |this| {
                    this.hover(|style| style.border_color(Hsla::from(theme.editor.line_strong)))
                })
                .when(selected, |this| {
                    this.border_2()
                        .border_color(Hsla::from(theme.editor.accent))
                })
                .child(sample)
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(6.))
                        .text_center()
                        .text_size(px(10.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(with_alpha(gpui::white(), 0.55))
                        .child(preset.name),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.apply_text_preset_to(index, id, window, cx);
                }))
                .into_any_element()
        };

        let shown: Vec<&'static TextPreset> = TEXT_PRESETS
            .iter()
            .filter(|preset| group == 0 || TEXT_PRESET_GROUPS.get(group - 1) == Some(&preset.group))
            .collect();

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .id(SharedString::from(format!("text-style-groups-{index}")))
                    .flex()
                    .flex_row()
                    .gap(px(4.))
                    .flex_wrap()
                    .child(chip(0, "All", cx))
                    .children(
                        TEXT_PRESET_GROUPS
                            .iter()
                            .enumerate()
                            .map(|(slot, label)| chip(slot + 1, label, cx)),
                    ),
            )
            .children(shown.chunks(2).map(|row| {
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

    /// The Text section's textarea: `min-h-[72px] rounded-[9px] bg-ed-ctl`
    /// with an accent caret, which is not the shared field box's look.
    fn render_text_content_input(&self, index: usize) -> AnyElement {
        let theme = self.theme;
        let Some(input) = self.field(FieldKey::TextContent(index)) else {
            return div().into_any_element();
        };
        div()
            .flex()
            .w_full()
            .child(
                ui::TextInput::plain(
                    &theme,
                    SharedString::from(format!("text-content-{index}")),
                    input,
                )
                .flex(true)
                .height(px(72.))
                .padding_x(px(12.))
                .padding_y(px(8.))
                .radius(px(9.))
                .text_size(px(13.))
                .line_height(px(18.))
                .bg(Hsla::from(theme.editor.ctl))
                .border(gpui::transparent_black())
                .text_color(Hsla::from(theme.editor.text_1))
                .caret_color(Hsla::from(theme.editor.accent))
                .placeholder_color(Hsla::from(theme.editor.text_3)),
            )
            .into_any_element()
    }

    /// One of the Text section's two case chips.
    fn text_case_chip(
        &self,
        id: SharedString,
        label: &'static str,
        italic: bool,
        selected: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .h(px(28.))
            .px(px(10.))
            .rounded(px(7.))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .when(italic, |this| this.italic())
            .when(selected, |this| {
                this.bg(with_alpha(theme.editor.accent, 0.12))
                    .text_color(Hsla::from(theme.editor.accent))
            })
            .when(!selected, |this| {
                this.bg(Hsla::from(theme.editor.ctl))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .hover(|style| {
                        style
                            .bg(Hsla::from(theme.editor.ctl_hover))
                            .text_color(Hsla::from(theme.editor.text_1))
                    })
            })
            .child(label)
            .on_click(on_click)
            .into_any_element()
    }

    /// The Animation section's tile grid, for whichever edge is in force.
    fn render_text_animation_tiles(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let is_out = self.sidebar.text_anim_edge;
        let current = self
            .timeline()
            .and_then(|timeline| timeline.text_segments.get(index))
            .map_or(TextAnimation::Fade, |segment| {
                if is_out {
                    segment.animation_out
                } else {
                    segment.animation_in
                }
            });
        let accent = Hsla::from(theme.editor.accent);

        let tile = |slot: usize,
                    animation: TextAnimation,
                    label: &'static str,
                    cx: &mut Context<Self>| {
            let selected = animation == current;
            let color = if selected {
                accent
            } else {
                Hsla::from(theme.editor.text_2)
            };
            div()
                .id(SharedString::from(format!("text-anim-{index}-{slot}")))
                .w(px(CARD_GRID_WIDTH_3))
                .flex_none()
                .h(px(52.))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .rounded(px(9.))
                .border_1()
                .border_color(if selected {
                    with_alpha(theme.editor.accent, 0.4)
                } else {
                    gpui::transparent_black()
                })
                .bg(if selected {
                    with_alpha(theme.editor.accent, 0.12)
                } else {
                    Hsla::from(theme.editor.ctl)
                })
                .text_color(color)
                .when(!selected, |this| {
                    this.hover(|style| style.bg(Hsla::from(theme.editor.ctl_hover)))
                })
                .child(text_animation_depiction(animation, color, accent))
                .child(
                    div()
                        .text_size(px(10.5))
                        .font_weight(FontWeight::MEDIUM)
                        .child(label),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_text_segment("text-animation", index, window, cx, move |segment| {
                        if is_out {
                            if segment.animation_out == animation {
                                return false;
                            }
                            segment.animation_out = animation;
                        } else {
                            if segment.animation_in == animation {
                                return false;
                            }
                            segment.animation_in = animation;
                        }
                        true
                    });
                }))
        };

        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(TEXT_ANIMATIONS.chunks(3).enumerate().map(|(row, entries)| {
                div()
                    .flex()
                    .flex_row()
                    .gap(px(6.))
                    .children(
                        entries
                            .iter()
                            .enumerate()
                            .map(|(column, (animation, label))| {
                                tile(row * 3 + column, *animation, label, cx)
                            }),
                    )
            }))
            .into_any_element()
    }

    /// `TextSegmentConfig` (`:3613-4000`), rebuilt as the six sections of the
    /// text-track spec: Text, Style, Font, Look, Animation, Layout.
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
        let uppercase = segment.uppercase;
        let enabled = segment.enabled;
        let color = segment.color.clone();
        let background_color = segment.background_color.clone();
        let background_style = segment.background_style;
        let gradient_color = segment.gradient_color.clone();
        let stroke_color = segment.stroke_color.clone();
        let stroke_width = segment.stroke_width;
        let family = segment.font_family.clone();
        let weight_label = TEXT_SEGMENT_WEIGHTS
            .iter()
            .find(|(weight, _)| (*weight - segment.font_weight).abs() < f32::EPSILON)
            .map_or_else(
                || SharedString::from(format!("Custom ({})", segment.font_weight)),
                |(_, label)| SharedString::from(*label),
            );
        let is_out = self.sidebar.text_anim_edge;
        let edge_animation = if is_out {
            segment.animation_out
        } else {
            segment.animation_in
        };
        let background_slot = if background_color.is_some() {
            TEXT_BACKGROUND_STYLES
                .iter()
                .position(|(style, _)| *style == background_style)
                .map_or(1, |slot| slot + 1)
        } else {
            0
        };

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            // -- A. Text ---------------------------------------------------
            .child(
                ui::Field::section(&theme, SharedString::from(format!("Text {}", index + 1)))
                    .value(
                        ui::Toggle::plain(
                            &theme,
                            SharedString::from(format!("text-enabled-{index}")),
                            enabled,
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
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
                        }))
                        .into_any_element(),
                    )
                    .child(self.render_text_content_input(index))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .child(self.text_case_chip(
                                SharedString::from(format!("text-italic-{index}")),
                                "I",
                                true,
                                italic,
                                cx.listener(move |this, _, window, cx| {
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
                                }),
                            ))
                            .child(self.text_case_chip(
                                SharedString::from(format!("text-uppercase-{index}")),
                                "AA",
                                false,
                                uppercase,
                                cx.listener(move |this, _, window, cx| {
                                    this.edit_text_segment(
                                        "text-uppercase",
                                        index,
                                        window,
                                        cx,
                                        move |segment| {
                                            segment.uppercase = !uppercase;
                                            true
                                        },
                                    );
                                }),
                            ))
                            .child(
                                div().ml_auto().child(
                                    ui::SegmentedControl::editor(
                                        &theme,
                                        SharedString::from(format!("text-align-{index}")),
                                        TEXT_ALIGNS
                                            .iter()
                                            .map(|(value, icon)| {
                                                ui::SegmentOption::icon(*icon, *value == align)
                                            })
                                            .collect(),
                                    )
                                    .on_select(cx.listener(
                                        move |this, choice: &usize, window, cx| {
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
                                        },
                                    )),
                                ),
                            ),
                    ),
            )
            // -- B. Style --------------------------------------------------
            .child(ui::Field::section(&theme, "Style").child(self.render_text_presets(index, cx)))
            // -- C. Font ---------------------------------------------------
            .child(
                ui::Field::section(&theme, "Font").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(self.menu_select_owned(
                            SidebarMenu::TextFontFamily(index),
                            SharedString::from(format!("text-font-{index}")),
                            SharedString::from(font_family_label(&family)),
                            cx,
                        ))
                        .child(self.menu_select(
                            SidebarMenu::TextWeight(index),
                            "text-weight",
                            weight_label,
                            cx,
                        ))
                        .child(self.slider_field(
                            "Size",
                            SliderKey::Panel(PanelSlider::TextFontSize, index),
                            "int",
                            cx,
                        ))
                        .child(self.slider_field(
                            "Line height",
                            SliderKey::Panel(PanelSlider::TextLineHeight, index),
                            "",
                            cx,
                        ))
                        .child(self.slider_field(
                            "Letter spacing",
                            SliderKey::Panel(PanelSlider::TextLetterSpacing, index),
                            "px",
                            cx,
                        )),
                ),
            )
            // -- D. Look ---------------------------------------------------
            .child(
                ui::Field::section(&theme, "Look").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            ui::Field::stacked(&theme, "Color").child(self.render_color_input(
                                ColorTarget::TextColor(index),
                                &color,
                                cx,
                            )),
                        )
                        .child(
                            ui::Field::inline(&theme, "Gradient").child(
                                ui::Toggle::plain(
                                    &theme,
                                    SharedString::from(format!("text-gradient-{index}")),
                                    gradient_color.is_some(),
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.edit_text_segment(
                                            "text-gradient",
                                            index,
                                            window,
                                            cx,
                                            move |segment| {
                                                segment.gradient_color =
                                                    match segment.gradient_color.is_some() {
                                                        true => None,
                                                        false => Some("#7c9cff".to_string()),
                                                    };
                                                true
                                            },
                                        );
                                    },
                                )),
                            ),
                        )
                        .children(gradient_color.map(|gradient| {
                            self.render_color_input(ColorTarget::TextGradient(index), &gradient, cx)
                        }))
                        .child(
                            ui::Field::stacked(&theme, "Background").child(
                                ui::SegmentedControl::editor(
                                    &theme,
                                    SharedString::from(format!("text-background-{index}")),
                                    std::iter::once(ui::SegmentOption::new(
                                        "None",
                                        background_slot == 0,
                                    ))
                                    .chain(TEXT_BACKGROUND_STYLES.iter().enumerate().map(
                                        |(slot, (_, label))| {
                                            ui::SegmentOption::new(
                                                *label,
                                                background_slot == slot + 1,
                                            )
                                        },
                                    ))
                                    .collect(),
                                )
                                .stretch()
                                .on_select(cx.listener(
                                    move |this, choice: &usize, window, cx| {
                                        let style = choice
                                            .checked_sub(1)
                                            .and_then(|slot| TEXT_BACKGROUND_STYLES.get(slot))
                                            .map(|(style, _)| *style);
                                        this.edit_text_segment(
                                            "text-background",
                                            index,
                                            window,
                                            cx,
                                            move |segment| match style {
                                                None => {
                                                    if segment.background_color.is_none() {
                                                        return false;
                                                    }
                                                    segment.background_color = None;
                                                    true
                                                }
                                                Some(style) => {
                                                    segment.background_style = style;
                                                    if segment.background_color.is_none() {
                                                        segment.background_color =
                                                            Some("#000000".to_string());
                                                    }
                                                    true
                                                }
                                            },
                                        );
                                    },
                                )),
                            ),
                        )
                        .children(background_color.map(|background| {
                            self.render_color_input(
                                ColorTarget::TextBackground(index),
                                &background,
                                cx,
                            )
                        }))
                        .child(self.slider_field(
                            "Outline",
                            SliderKey::Panel(PanelSlider::TextStroke, index),
                            "px",
                            cx,
                        ))
                        .children((stroke_width > 0.).then(|| {
                            self.render_color_input(
                                ColorTarget::TextStroke(index),
                                &stroke_color,
                                cx,
                            )
                        }))
                        .child(self.slider_field(
                            "Shadow",
                            SliderKey::Panel(PanelSlider::TextShadow, index),
                            "x100%",
                            cx,
                        ))
                        .child(self.slider_field(
                            "Glow",
                            SliderKey::Panel(PanelSlider::TextGlow, index),
                            "x100%",
                            cx,
                        ))
                        .child(self.slider_field(
                            "Opacity",
                            SliderKey::Panel(PanelSlider::TextOpacity, index),
                            "x100%",
                            cx,
                        )),
                ),
            )
            // -- E. Animation ----------------------------------------------
            .child(
                ui::Field::section(&theme, "Animation")
                    .value(
                        ui::SegmentedControl::editor(
                            &theme,
                            SharedString::from(format!("text-anim-edge-{index}")),
                            vec![
                                ui::SegmentOption::new("In", !is_out),
                                ui::SegmentOption::new("Out", is_out),
                            ],
                        )
                        .on_select(cx.listener(move |this, choice: &usize, _window, cx| {
                            this.sidebar.text_anim_edge = *choice == 1;
                            cx.notify();
                        }))
                        .into_any_element(),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(self.render_text_animation_tiles(index, cx))
                            .children((edge_animation != TextAnimation::None).then(|| {
                                self.slider_field(
                                    "Duration",
                                    SliderKey::Panel(
                                        if is_out {
                                            PanelSlider::TextAnimOutDuration
                                        } else {
                                            PanelSlider::TextAnimInDuration
                                        },
                                        index,
                                    ),
                                    "secs",
                                    cx,
                                )
                                .into_any_element()
                            })),
                    ),
            )
            // -- F. Layout -------------------------------------------------
            .child(
                ui::Field::section(&theme, "Layout").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            ui::SegmentedControl::editor(
                                &theme,
                                SharedString::from(format!("text-layout-{index}")),
                                TEXT_LAYOUTS
                                    .iter()
                                    .map(|(value, label)| {
                                        ui::SegmentOption::new(*label, *value == layout)
                                    })
                                    .collect(),
                            )
                            .stretch()
                            .on_select(cx.listener(
                                move |this, choice: &usize, window, cx| {
                                    let Some((value, _)) = TEXT_LAYOUTS.get(*choice) else {
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
                                            // A takeover layout implies where the
                                            // text belongs (`:3672-3677`).
                                            if value == TextLayout::Fullscreen {
                                                segment.center = XY::new(0.5, 0.5);
                                            }
                                            true
                                        },
                                    );
                                },
                            )),
                        )
                        .children((layout == TextLayout::Fullscreen).then(|| {
                            div()
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.editor.text_3))
                                .child(
                                    "Pauses the video while the text is shown, then resumes \
                                     where it left off.",
                                )
                                .into_any_element()
                        }))
                        .children((layout != TextLayout::Overlay).then(|| {
                            self.slider_field(
                                "Screen transition",
                                SliderKey::Panel(PanelSlider::TextLayoutTransition, index),
                                "secs",
                                cx,
                            )
                            .into_any_element()
                        })),
                ),
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
                ui::Field::section(&theme, SharedString::from(format!("Caption {}", index + 1)))
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
                ui::Field::section(
                    &theme,
                    SharedString::from(format!("Keyboard {}", index + 1)),
                )
                .child(self.render_field_input(FieldKey::KeyboardText(index), None)),
            )
            .child(self.timing_field(
                FieldKey::KeyboardStart(index),
                FieldKey::KeyboardEnd(index),
                start,
                end,
                cx,
            ))
            .child(self.slider_field(
                "Fade Duration",
                SliderKey::Panel(PanelSlider::KeyboardFade, index),
                "",
                cx,
            ))
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
                .border_color(Hsla::from(theme.editor.line))
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

        ui::Field::section(&theme, "Timing")
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.editor.line))
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
                ui::Field::section(&theme, SharedString::from(format!("Audio {}", index + 1)))
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
                                    .border_color(Hsla::from(theme.editor.line))
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
                                            .border_color(Hsla::from(theme.editor.line))
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
            .child(self.slider_field(
                "Volume",
                SliderKey::Panel(PanelSlider::AudioVolume, index),
                "db",
                cx,
            ))
            .child(self.slider_field(
                "Fade In",
                SliderKey::Panel(PanelSlider::AudioFadeIn, index),
                "s",
                cx,
            ))
            .child(self.slider_field(
                "Fade Out",
                SliderKey::Panel(PanelSlider::AudioFadeOut, index),
                "s",
                cx,
            ))
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
            ui::Field::section(&theme, SharedString::from(format!("Mask {}", index + 1))).child(
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
                .child(ui::Field::section(&theme, "Effect").child(self.radio_row(
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
                        this.edit_mask_segment("mask-effect", index, window, cx, move |segment| {
                            let amount = mask_effect_amount(segment);
                            segment.pixelation = encode_mask_effect(next, amount);
                            segment.opacity = 1.;
                            segment.keyframes.intensity.clear();
                            true
                        });
                    }),
                )))
                .child(self.slider_field(
                    if effect == MaskEffect::Blur {
                        "Blur"
                    } else {
                        "Pixel Size"
                    },
                    SliderKey::Panel(PanelSlider::MaskAmount, index),
                    "px",
                    cx,
                ));
        } else {
            panel = panel
                .child(self.slider_field(
                    "Outside Darkness",
                    SliderKey::Panel(PanelSlider::MaskDarkness, index),
                    "",
                    cx,
                ))
                .child(self.slider_field(
                    "Fade Duration",
                    SliderKey::Panel(PanelSlider::MaskFade, index),
                    "s",
                    cx,
                ));
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
                ui::Field::section(&theme, "Camera Layout").child(
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
                                        .when(selected, |this| this.bg(Hsla::from(theme.gray_3)))
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
                                                    this.set_scene_mode(index, choice, window, cx);
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
                                .border_color(Hsla::from(theme.editor.line))
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
                ui::Field::section(&theme, "Transition").child(
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
                .child(dashed_divider(Hsla::from(theme.editor.line)))
                .child(self.slider_field(
                    "Screen Zoom",
                    SliderKey::Panel(PanelSlider::SceneScreenZoom, index),
                    "",
                    cx,
                ))
                .child(
                    ui::Field::stacked(&theme, "Screen Position")
                        .child(self.render_pad(PadKey::SceneScreen(index), cx)),
                )
                .child(dashed_divider(Hsla::from(theme.editor.line)))
                .child(self.slider_field(
                    "Camera Zoom",
                    SliderKey::Panel(PanelSlider::SceneCameraZoom, index),
                    "",
                    cx,
                ))
                .child(
                    ui::Field::stacked(&theme, "Camera Position")
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

    /// One Look tile's thumbnail, or the orbit pad's live card: the plate the
    /// pose folds, drawn through the renderer's own homography.
    ///
    /// The projection is the real one, so a tile shows the shot's actual
    /// framing -- but a pose that pushes the plate past the frame would draw
    /// nothing recognisable, so anything larger than the tile shrinks about the
    /// frame centre until it fits. A distant pose keeps its true, smaller size,
    /// which is what makes "Pull back" read as pulled back.
    fn camera3d_plate(pose: Camera3DProperties, stroke: f32, dark: bool) -> impl IntoElement {
        gpui::canvas(
            |bounds, _, _| bounds,
            move |_, bounds, window, _| {
                let Some((pose, fit)) = camera3d_plate_fit(&pose) else {
                    return;
                };
                // The 16:9 frame, centred in whatever box the tile gave us.
                let width =
                    f32::from(bounds.size.width).min(f32::from(bounds.size.height) * 16. / 9.);
                let height = width * 9. / 16.;
                let origin_x =
                    f32::from(bounds.origin.x) + (f32::from(bounds.size.width) - width) / 2.;
                let origin_y =
                    f32::from(bounds.origin.y) + (f32::from(bounds.size.height) - height) / 2.;

                let shapes: &[Camera3DPlateShape] = &[
                    (&[(-1., 1.), (1., 1.), (1., -1.), (-1., -1.)], None),
                    (&[(-0.8, 0.56), (0.4, 0.56)], Some(CAMERA3D_PLATE_LINE)),
                    (&[(-0.8, 0.12), (0.7, 0.12)], Some(CAMERA3D_PLATE_LINE)),
                    (
                        &[(-0.8, -0.32), (-0.1, -0.32)],
                        Some(crate::editor_timeline::track_color::THREE_D),
                    ),
                ];
                for &(points, ink) in shapes {
                    let mut path = match ink {
                        None => gpui::PathBuilder::fill(),
                        Some(_) => gpui::PathBuilder::stroke(px(stroke)),
                    };
                    let mut valid = true;
                    for (index, &(x, y)) in points.iter().enumerate() {
                        let Some((x, y)) = camera3d_plate_point(&pose, fit, x, y) else {
                            valid = false;
                            break;
                        };
                        let point =
                            gpui::point(px(origin_x + width * x), px(origin_y + height * y));
                        if index == 0 {
                            path.move_to(point);
                        } else {
                            path.line_to(point);
                        }
                    }
                    if ink.is_none() {
                        path.close();
                    }
                    if valid && let Ok(path) = path.build() {
                        window.paint_path(
                            path,
                            Hsla::from(gpui::rgb(ink.unwrap_or(if dark {
                                CAMERA3D_PLATE_DARK
                            } else {
                                CAMERA3D_PLATE
                            }))),
                        );
                    }
                }
            },
        )
        .size_full()
    }

    /// The Look grid's tile: the plate, the arrow badge a move carries, and the
    /// name under it. Selected is a 2px accent ring, which is the panel's only
    /// "this is what you have" mark.
    fn render_camera3d_look(
        &self,
        index: usize,
        look: &MotionTemplate,
        kind: LookKind,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let id = look.id;
        let name = look.name;
        let pose = look.from;
        div()
            .id(SharedString::from(format!("c3d-look-{index}-{id}")))
            .w(px(CAMERA3D_LOOK_TILE))
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(5.))
            .cursor_pointer()
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(CAMERA3D_LOOK_THUMB))
                    .rounded(px(8.))
                    .overflow_hidden()
                    .bg(camera3d_thumb_bg(theme.is_dark()))
                    .border_2()
                    .border_color(if selected {
                        Hsla::from(theme.editor.accent)
                    } else {
                        gpui::transparent_black()
                    })
                    .child(Self::camera3d_plate(pose, 2., theme.is_dark()))
                    .when(kind == LookKind::Move, |this| {
                        this.child(
                            div()
                                .absolute()
                                .right(px(4.))
                                .bottom(px(4.))
                                .px(px(3.))
                                .h(px(13.))
                                .flex()
                                .items_center()
                                .rounded(px(4.))
                                .bg(crate::editor_sidebar::with_alpha(theme.editor.card, 0.85))
                                .child(
                                    svg()
                                        .path("icons/move-right.svg")
                                        .size(px(9.))
                                        .text_color(Hsla::from(theme.editor.text_2)),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .w_full()
                    .text_center()
                    .text_size(px(11.))
                    .truncate()
                    .when(selected, |this| this.font_weight(FontWeight::MEDIUM))
                    .text_color(Hsla::from(if selected {
                        theme.editor.text_1
                    } else {
                        theme.editor.text_2
                    }))
                    .child(name),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.apply_camera3d_look(index, kind, id, window, cx);
            }))
            .into_any_element()
    }

    /// The Look group: `Moves | Angles` over a four-column grid, then the three
    /// sequences.
    fn render_camera3d_looks(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let angles = self.sidebar.camera3d_angles;
        let matched = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .and_then(match_camera3d_look);

        let looks: Vec<AnyElement> = if angles {
            ANGLE_PRESETS
                .iter()
                .map(|preset| {
                    let selected = matched
                        .is_some_and(|look| look.kind == LookKind::Angle && look.id == preset.id);
                    self.render_camera3d_look(
                        index,
                        &angle_preset_motion(preset),
                        LookKind::Angle,
                        selected,
                        cx,
                    )
                })
                .collect()
        } else {
            MOTION_TEMPLATES
                .iter()
                .map(|template| {
                    let selected = matched
                        .is_some_and(|look| look.kind == LookKind::Move && look.id == template.id);
                    self.render_camera3d_look(index, template, LookKind::Move, selected, cx)
                })
                .collect()
        };

        let grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(8.))
            .children(looks);

        let sequences =
            div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .children(CAMERA3D_SCENES.iter().map(|scene| {
                    let id = scene.id;
                    let shots = scene.shots.len();
                    div()
                        .id(SharedString::from(format!("c3d-seq-{index}-{id}")))
                        .w(px(CAMERA3D_SEQUENCE_CARD))
                        .flex_none()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .px(px(10.))
                        .py(px(8.))
                        .rounded(px(8.))
                        .bg(Hsla::from(theme.editor.ctl))
                        .cursor_pointer()
                        .hover(|style| style.bg(Hsla::from(theme.editor.ctl_hover)))
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.editor.text_1))
                                .truncate()
                                .child(scene.name),
                        )
                        .child(
                            div()
                                .text_size(px(10.))
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(format!("{shots} shots")),
                        )
                        .child(div().flex().flex_row().gap(px(3.)).pt(px(3.)).children(
                            (0..shots).map(|_| {
                                div().h(px(4.)).flex_1().rounded(px(2.)).bg(with_alpha(
                                    gpui::rgb(crate::editor_timeline::track_color::THREE_D),
                                    0.7,
                                ))
                            }),
                        ))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.apply_camera3d_scene(index, id, window, cx);
                        }))
                }));

        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                self.camera3d_group_label("Look").child(
                    ui::SegmentedControl::editor(
                        &theme,
                        "camera3d-look-tab",
                        vec![
                            ui::SegmentOption::new("Moves", !angles),
                            ui::SegmentOption::new("Angles", angles),
                        ],
                    )
                    .text_size(px(11.))
                    .item_height(px(21.))
                    .item_padding(px(9.), px(0.))
                    .on_select(cx.listener(|this, choice: &usize, _, cx| {
                        this.sidebar.camera3d_angles = *choice == 1;
                        cx.notify();
                    })),
                ),
            )
            .child(grid)
            .child(sequences)
            .into_any_element()
    }

    /// The Camera group's orbit pad: `tiltY` across, `tiltX` up, with the pose
    /// being edited drawn inside it.
    fn render_camera3d_orbit(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let pose = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .map(|segment| {
                if self.sidebar.editing_end_pose {
                    end_pose(segment)
                } else {
                    start_pose(segment)
                }
            })
            .unwrap_or(DEFAULT_POSE);
        let (x, y) = camera3d_orbit_point(&pose);
        let key = PadKey::Camera3DOrbit(index);
        let cell = self.sidebar.pad(key);
        let line = Hsla::from(theme.editor.line_strong);

        div()
            .id(SharedString::from(format!("c3d-orbit-{index}")))
            .relative()
            .size(px(CAMERA3D_ORBIT_PAD))
            .flex_none()
            .overflow_hidden()
            .rounded(px(10.))
            .bg(camera3d_thumb_bg(theme.is_dark()))
            .cursor(gpui::CursorStyle::Crosshair)
            .child(
                gpui::canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
            )
            // The 3x3 rule of thirds, which is what makes the drag read as an
            // orbit rather than a scrub.
            .children([1_u8, 2].map(|step| {
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(gpui::relative(f32::from(step) / 3.))
                    .w(px(1.))
                    .bg(line)
            }))
            .children([1_u8, 2].map(|step| {
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(gpui::relative(f32::from(step) / 3.))
                    .h(px(1.))
                    .bg(line)
            }))
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .p(px(14.))
                    .child(Self::camera3d_plate(pose, 3., theme.is_dark())),
            )
            .child(
                div()
                    .absolute()
                    .left(gpui::relative(x))
                    .top(gpui::relative(y))
                    .ml(px(-6.))
                    .mt(px(-6.))
                    .size(px(12.))
                    .rounded_full()
                    .bg(Hsla::from(theme.editor.accent))
                    .border_2()
                    .border_color(camera3d_thumb_bg(theme.is_dark())),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(6.))
                    .text_center()
                    .text_size(px(10.))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .child("Drag to orbit"),
            )
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    // Double-click puts the camera back on axis, the way the
                    // canvas pads reset their point.
                    if event.click_count >= 2 {
                        this.reset_camera3d_tilt(index, window, cx);
                        return;
                    }
                    this.pad_mouse_down(PadKey::Camera3DOrbit(index), event, window, cx);
                }),
            )
            .into_any_element()
    }

    /// A group's 12px/500 label row, with whatever control sits beside it.
    fn camera3d_group_label(&self, name: &'static str) -> gpui::Div {
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .min_h(px(22.))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(Hsla::from(self.theme.editor.text_2))
            .child(div().flex_none().child(name))
            .child(div().flex_1())
    }

    /// The hairline box every group sits in.
    fn camera3d_group(&self, content: AnyElement) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .p(px(CAMERA3D_GROUP_PADDING))
            .rounded(px(10.))
            .border_1()
            .border_color(Hsla::from(self.theme.editor.line))
            .child(content)
            .into_any_element()
    }

    /// One compact `label | slider | value` row. The sidebar's own inline row
    /// reserves 96px for the label, which the Camera group's 214px column
    /// cannot spare.
    fn camera3d_slider_row(
        &self,
        label: &'static str,
        slider: SliderKey,
        unit: &'static str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let value = crate::editor_sidebar::format_slider_value(self.slider_value(slider), unit);
        div()
            .flex()
            .flex_row()
            .items_center()
            .h(px(32.))
            .gap(px(8.))
            .text_size(px(12.))
            .text_color(Hsla::from(theme.editor.text_2))
            .child(div().w(px(CAMERA3D_ROW_LABEL)).flex_none().child(label))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(self.slider_flex(slider, unit, cx)),
            )
            .child(
                div()
                    .w(px(CAMERA3D_ROW_VALUE))
                    .flex_none()
                    .text_right()
                    .child(value),
            )
            .into_any_element()
    }

    /// A 24px icon action on a group's own label row.
    fn camera3d_action(
        &self,
        id: &'static str,
        icon: &'static str,
        label: Option<&'static str>,
        tooltip: &'static str,
        active: bool,
    ) -> ui::EditorButton {
        let theme = self.theme;
        let mut button = ui::EditorButton::plain(&theme, id)
            .left_icon(icon)
            .icon_size(px(13.))
            .height(px(24.))
            .padding_x(px(7.))
            .pressed(active)
            .tooltip(&theme, tooltip);
        if let Some(label) = label {
            button = button.label(label).text_size(px(11.));
        }
        button
    }

    /// One half of the pose strip: the pose as the camera sees it, its clock
    /// time under it, and the two marks that say which pose is being edited
    /// and which one the playhead is on.
    #[allow(clippy::too_many_arguments)]
    fn render_camera3d_pose_card(
        &self,
        index: usize,
        end: bool,
        pose: Camera3DProperties,
        time: f64,
        editing: bool,
        at_playhead: bool,
        still: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        // A still shot's end is not a second pose to look at, so it reads as
        // the hold it is.
        let dim = still && end;
        let caption = if dim {
            "End \u{b7} same as start".to_string()
        } else {
            format!(
                "{} \u{b7} {}",
                if end { "End" } else { "Start" },
                format_time(time)
            )
        };

        div()
            .id(SharedString::from(format!(
                "c3d-pose-{index}-{}",
                if end { "end" } else { "start" }
            )))
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(5.))
            .cursor_pointer()
            .child(
                div()
                    .w_full()
                    .h(px(CAMERA3D_POSE_CARD_HEIGHT))
                    .rounded(px(9.))
                    .overflow_hidden()
                    .bg(camera3d_thumb_bg(theme.is_dark()))
                    .border_2()
                    .border_color(if editing {
                        Hsla::from(theme.editor.accent)
                    } else {
                        gpui::transparent_black()
                    })
                    .when(dim, |this| this.opacity(0.55))
                    .child(Self::camera3d_plate(pose, 2.5, theme.is_dark())),
            )
            .child(
                div()
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(5.))
                    .text_size(px(11.))
                    .when(editing, |this| this.font_weight(FontWeight::MEDIUM))
                    .text_color(Hsla::from(if editing {
                        theme.editor.text_1
                    } else {
                        theme.editor.text_2
                    }))
                    // The playhead's own mark: this is the pose on screen.
                    .when(at_playhead, |this| {
                        this.child(
                            div()
                                .size(px(5.))
                                .flex_none()
                                .rounded_full()
                                .bg(Hsla::from(theme.editor.accent)),
                        )
                    })
                    .child(div().min_w_0().truncate().child(caption)),
            )
            .on_click(cx.listener(move |this, _, _window, cx| {
                this.select_camera3d_pose(index, end, cx);
            }))
            .into_any_element()
    }

    /// The Camera group's pose strip: the two ends of the shot, side by side,
    /// with the swap between them and the still-shot switch under.
    ///
    /// This is what replaced the `Start | End` segmented control: two words
    /// asked the user to hold the whole move in their head, where two pictures
    /// just show it.
    fn render_camera3d_pose_strip(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
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
        let fps = crate::editor_window::EDITOR_PREVIEW_FPS;
        let start_time = camera3d_pose_seek_time(segment, false, fps);
        let end_time = camera3d_pose_seek_time(segment, true, fps);
        // "The playhead is on this pose" is a frame's tolerance, which is as
        // close as a seek can land.
        let on = |time: f64| (self.playhead_time() - time).abs() < 1. / f64::from(fps.max(1));

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(8.))
                    .child(self.render_camera3d_pose_card(
                        index,
                        false,
                        start,
                        segment.start,
                        !editing_end,
                        on(start_time),
                        still,
                        cx,
                    ))
                    .child(
                        div()
                            .flex_none()
                            .h(px(CAMERA3D_POSE_CARD_HEIGHT))
                            .flex()
                            .items_center()
                            .child(
                                self.camera3d_action(
                                    "camera3d-swap",
                                    "icons/arrow-left-right.svg",
                                    None,
                                    if still {
                                        "Nothing to swap on a still shot"
                                    } else {
                                        "Swap start and end"
                                    },
                                    false,
                                )
                                .disabled(still)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.swap_camera3d_poses(index, window, cx);
                                    },
                                )),
                            ),
                    )
                    .child(self.render_camera3d_pose_card(
                        index,
                        true,
                        end,
                        segment.end,
                        editing_end,
                        on(end_time) && !still,
                        still,
                        cx,
                    )),
            )
            .child(
                div().flex().flex_row().items_center().gap(px(6.)).child(
                    self.camera3d_action(
                        "camera3d-still",
                        "icons/pause.svg",
                        Some("Still shot"),
                        if still {
                            "Already a still shot"
                        } else {
                            "Hold the opening pose for the whole shot"
                        },
                        still,
                    )
                    .disabled(still)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.make_camera3d_still(index, window, cx);
                    })),
                ),
            )
            .into_any_element()
    }

    /// The Auto scene row, above the Look group: how many shots the whole
    /// track should be, as six pills. Hovering one shows the layout on the
    /// lane; pressing one commits it.
    fn render_camera3d_auto_row(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let count = self
            .timeline()
            .map_or(0, |timeline| timeline.camera3d_segments.len());
        let maximum = max_auto_camera3d_shots(self.total_duration());

        self.camera3d_group(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_none()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child("Auto scene"),
                )
                .child(div().flex_1())
                .child(self.render_camera3d_count_pills("panel", count, maximum, cx))
                .id("camera3d-auto-row")
                .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                .tooltip(move |_window, cx| {
                    ui::Tooltip::new(&theme, "Rebuilds every 3D shot on the track").view(cx)
                })
                .into_any_element(),
        )
    }

    /// The `1 2 3 4 5 6` pills the picker and the panel share. `selected` is
    /// the count the track already is; anything past `maximum` has nowhere to
    /// fit and is disabled.
    pub(crate) fn render_camera3d_count_pills(
        &self,
        id: &'static str,
        selected: usize,
        maximum: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .children((1..=AUTO_CAMERA3D_MAX_SHOTS).map(|count| {
                let available = count <= maximum;
                let active = count == selected;
                div()
                    .id(SharedString::from(format!("c3d-count-{id}-{count}")))
                    .w(px(24.))
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .when(active, |this| {
                        this.bg(Hsla::from(theme.editor.accent))
                            .text_color(gpui::white())
                    })
                    .when(!active, |this| {
                        this.bg(Hsla::from(theme.editor.ctl))
                            .text_color(Hsla::from(theme.editor.text_2))
                    })
                    .when(!available, |this| this.opacity(0.35))
                    .when(available && !active, |this| {
                        this.cursor_pointer()
                            .hover(|style| style.bg(Hsla::from(theme.editor.ctl_hover)))
                    })
                    .when(available, |this| {
                        this.on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            this.hover_camera3d_count(hovered.then_some(count), cx);
                        }))
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.apply_auto_camera3d_scene(count, window, cx);
                            },
                        ))
                    })
                    .child(format!("{count}"))
            }))
            .into_any_element()
    }

    /// `Camera3DSegmentConfig`, rebuilt: Look, Camera, Depth blur, and one
    /// drill for the timing controls nobody opens twice.
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
        let blur = segment.blur;
        let blur_on = blur.mode != Camera3DBlurMode::None;
        let easing_index = motion_easing(segment);
        let easing_label = MOTION_EASINGS[easing_index].1;
        let duration = segment.end - segment.start;
        let look = camera3d_shot_label(segment);
        let advanced = self.sidebar.section(PanelSection::Camera3DAdvanced);
        let tune = self.sidebar.section(PanelSection::Camera3DBlurTune);

        // -- header ---------------------------------------------------------
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .child(
                ui::EditorButton::plain(&theme, "camera3d-done")
                    .left_icon("icons/check.svg")
                    .label("Done")
                    .text_size(px(12.))
                    .on_click(cx.listener(|this, _, _window, cx| this.set_selection(None, cx))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .child(format!("3D shot \u{b7} {look} \u{b7} {duration:.1}s")),
            )
            .child(
                ui::EditorButton::plain(&theme, "camera3d-play-shot")
                    .left_icon("icons/play.svg")
                    .icon_size(px(12.))
                    .label("Play shot")
                    .text_size(px(12.))
                    .tooltip(&theme, "Play this shot")
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.play_camera3d_shot(index, cx);
                    })),
            )
            .child(
                ui::EditorButton::plain(&theme, "camera3d-delete")
                    .danger(&theme)
                    .left_icon("icons/trash.svg")
                    .icon_size(px(13.))
                    .label("Delete")
                    .text_size(px(12.))
                    .tooltip(&theme, "Delete this shot")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.delete_selection(window, cx);
                    })),
            );

        // -- Camera ----------------------------------------------------------
        let camera = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .min_h(px(24.))
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child("Camera"),
                    )
                    .child(div().flex_1())
                    .child(
                        self.camera3d_action(
                            "camera3d-flip-h",
                            "icons/flip-horizontal-2.svg",
                            None,
                            "Flip horizontally",
                            false,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.flip_camera3d(index, true, window, cx);
                            },
                        )),
                    )
                    .child(
                        self.camera3d_action(
                            "camera3d-flip-v",
                            "icons/flip-vertical-2.svg",
                            None,
                            "Flip vertically",
                            false,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.flip_camera3d(index, false, window, cx);
                            },
                        )),
                    ),
            )
            .child(self.render_camera3d_pose_strip(index, cx))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.))
                    .child(self.render_camera3d_orbit(index, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(self.camera3d_slider_row(
                                "Distance",
                                SliderKey::Panel(
                                    PanelSlider::Camera3DPose(Camera3DProperty::Zoom),
                                    index,
                                ),
                                "",
                                cx,
                            ))
                            .child(self.camera3d_slider_row(
                                "Roll",
                                SliderKey::Panel(
                                    PanelSlider::Camera3DPose(Camera3DProperty::Roll),
                                    index,
                                ),
                                "deg",
                                cx,
                            ))
                            .child(self.camera3d_slider_row(
                                "Shift X",
                                SliderKey::Panel(
                                    PanelSlider::Camera3DPose(Camera3DProperty::PanX),
                                    index,
                                ),
                                "",
                                cx,
                            ))
                            .child(self.camera3d_slider_row(
                                "Shift Y",
                                SliderKey::Panel(
                                    PanelSlider::Camera3DPose(Camera3DProperty::PanY),
                                    index,
                                ),
                                "",
                                cx,
                            )),
                    ),
            );

        // -- Depth blur -------------------------------------------------------
        let mut depth = div().flex().flex_col().gap(px(6.)).child(
            self.camera3d_group_label("Depth blur").child(
                ui::Toggle::plain(
                    &theme,
                    SharedString::from(format!("camera3d-blur-{index}")),
                    blur_on,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.toggle_camera3d_blur(index, window, cx);
                })),
            ),
        );
        if blur_on {
            depth = depth
                .child(self.camera3d_slider_row(
                    "Amount",
                    SliderKey::Panel(PanelSlider::Camera3DBlur(Camera3DBlurKey::Strength), index),
                    "int",
                    cx,
                ))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .h(px(32.))
                        .gap(px(8.))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child(div().w(px(CAMERA3D_ROW_LABEL)).flex_none().child("Focus"))
                        .child(
                            div().flex_1().min_w_0().child(
                                ui::SegmentedControl::editor(
                                    &theme,
                                    "camera3d-blur-mode-tab",
                                    CAMERA3D_FOCUS_MODES
                                        .iter()
                                        .map(|(mode, label)| {
                                            ui::SegmentOption::new(*label, blur.mode == *mode)
                                        })
                                        .collect(),
                                )
                                .text_size(px(11.))
                                .item_height(px(22.))
                                .item_padding(px(6.), px(0.))
                                .stretch()
                                .on_select(cx.listener(
                                    move |this, choice: &usize, window, cx| {
                                        let Some((mode, _)) = CAMERA3D_FOCUS_MODES.get(*choice)
                                        else {
                                            return;
                                        };
                                        this.set_camera3d_blur_mode(index, *mode, window, cx);
                                    },
                                )),
                            ),
                        ),
                )
                .child(crate::editor_sidebar::disclosure_row(
                    &theme,
                    "camera3d-blur-tune",
                    "Fine-tune",
                    tune.is_open(),
                    cx.listener(|this, _, window, cx| {
                        this.sidebar
                            .section(PanelSection::Camera3DBlurTune)
                            .toggle();
                        this.animate_collapsibles(window, cx);
                    }),
                ))
                .child(collapsible(
                    &tune,
                    div()
                        .flex()
                        .flex_col()
                        .children(
                            camera3d_blur_sliders(blur.mode)
                                .iter()
                                .filter(|(key, _)| *key != Camera3DBlurKey::Strength)
                                .map(|(key, label)| {
                                    self.camera3d_slider_row(
                                        label,
                                        SliderKey::Panel(PanelSlider::Camera3DBlur(*key), index),
                                        if *key == Camera3DBlurKey::Angle {
                                            "deg"
                                        } else {
                                            ""
                                        },
                                        cx,
                                    )
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .h(px(32.))
                                .gap(px(8.))
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(div().w(px(CAMERA3D_ROW_LABEL)).flex_none().child("Bokeh"))
                                .child(div().flex_1())
                                .child(
                                    ui::Toggle::plain(
                                        &theme,
                                        SharedString::from(format!("camera3d-bokeh-{index}")),
                                        blur.bokeh,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            this.set_camera3d_bokeh(index, window, cx);
                                        },
                                    )),
                                ),
                        )
                        .into_any_element(),
                ));
        }

        // -- Timing & advanced -------------------------------------------------
        let timing = div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("camera3d-advanced")
                    .flex()
                    .flex_row()
                    .items_center()
                    .h(px(34.))
                    .px(px(CAMERA3D_GROUP_PADDING))
                    .gap(px(8.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(Hsla::from(theme.editor.line))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.editor.text_1))
                    .child("Timing & advanced")
                    .child(div().flex_1())
                    .child(
                        div()
                            .font_weight(FontWeight::NORMAL)
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child(format!(
                                "{easing_label} \u{b7} Lens {}",
                                start.fov.round() as i32
                            )),
                    )
                    .child(
                        svg()
                            .path(if advanced.is_open() {
                                "icons/chevron-down.svg"
                            } else {
                                "icons/chevron-right.svg"
                            })
                            .size(px(13.))
                            .flex_none()
                            .text_color(Hsla::from(theme.editor.text_3)),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.sidebar
                            .section(PanelSection::Camera3DAdvanced)
                            .toggle();
                        this.animate_collapsibles(window, cx);
                    })),
            )
            .child(collapsible(
                &advanced,
                div()
                    .pt(px(10.))
                    .px(px(CAMERA3D_GROUP_PADDING))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        ui::Subfield::plain(&theme, "Motion style").child(
                            div()
                                .w(px(150.))
                                // A still shot has no span to shape and nowhere
                                // to store a curve (`:5357-5360`).
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
                    .child(self.camera3d_slider_row(
                        "Ease in",
                        SliderKey::Panel(PanelSlider::Camera3DTransitionIn, index),
                        "secs",
                        cx,
                    ))
                    .child(self.camera3d_slider_row(
                        "Ease out",
                        SliderKey::Panel(PanelSlider::Camera3DTransitionOut, index),
                        "secs",
                        cx,
                    ))
                    .child(self.camera3d_slider_row(
                        "Lens",
                        SliderKey::Panel(PanelSlider::Camera3DPose(Camera3DProperty::Fov), index),
                        "deg",
                        cx,
                    ))
                    .child(self.camera3d_slider_row(
                        "Rotate X",
                        SliderKey::Panel(
                            PanelSlider::Camera3DPose(Camera3DProperty::RotateX),
                            index,
                        ),
                        "deg",
                        cx,
                    ))
                    .child(self.camera3d_slider_row(
                        "Rotate Y",
                        SliderKey::Panel(
                            PanelSlider::Camera3DPose(Camera3DProperty::RotateY),
                            index,
                        ),
                        "deg",
                        cx,
                    ))
                    .child(
                        div().pt(px(4.)).pb(px(4.)).child(
                            ui::EditorButton::plain(&theme, "camera3d-reset")
                                .left_icon("icons/rotate-ccw.svg")
                                .label("Reset camera")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.reset_camera3d_pose(index, window, cx);
                                })),
                        ),
                    )
                    .into_any_element(),
            ));

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(header)
            .child(self.render_camera3d_auto_row(cx))
            .child(self.camera3d_group(self.render_camera3d_looks(index, cx)))
            .child(self.camera3d_group(camera.into_any_element()))
            .child(self.camera3d_group(depth.into_any_element()))
            .child(timing)
            .into_any_element()
    }

    /// Clicking a Look tile: the whole camera animation replaced, as one
    /// history entry, with the playhead back on the shot's first pose so the
    /// result plays from what the tile showed.
    fn apply_camera3d_look(
        &mut self,
        index: usize,
        kind: LookKind,
        id: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The grid stays on the half the click came from, so the ring lands
        // back under the tile that was just pressed.
        self.sidebar.camera3d_angles = kind == LookKind::Angle;
        match kind {
            LookKind::Move => self.apply_camera3d_template(index, id, window, cx),
            LookKind::Angle => self.apply_camera3d_angle(index, id, window, cx),
        }
    }

    /// `applyTemplate` (`:4983-4993`).
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
        self.edit_camera3d_segment("camera3d-template", index, window, cx, move |segment| {
            apply_motion_template(segment, &template);
            true
        });
        // `setEditingEnd(false)` and the playhead back to the first pose.
        self.sidebar.editing_end_pose = false;
        self.seek_camera3d_pose(index, false, cx);
        cx.notify();
    }

    /// `projectActions.applyCamera3DScene`: this one shot replaced by the
    /// sequence's whole chain.
    ///
    /// Two departures from the source, both of which the old behaviour got
    /// wrong: the chain is clamped to the shot it replaced, so a rounding
    /// error can never push a generated shot over a neighbour, and only the
    /// **first** shot ends up selected -- multi-selecting all three closed the
    /// panel the moment the sequence was applied.
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
        // `camera3DClipCuts(start, end)`: every clip boundary inside the range.
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

        let mut generated = apply_scene_to_range(scene, start, end, &cuts);
        for shot in &mut generated {
            shot.start = shot.start.clamp(start, end);
            shot.end = shot.end.clamp(shot.start, end);
        }
        generated.retain(|shot| shot.end > shot.start);
        if generated.is_empty() {
            return;
        }
        let first = generated[0].start;
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
        let selected = self
            .timeline()
            .and_then(|timeline| {
                timeline
                    .camera3d_segments
                    .iter()
                    .position(|segment| segment.start == first)
            })
            .unwrap_or(index);
        self.set_selection(Some(Selection::single(TrackKind::ThreeD, selected)), cx);
        self.seek_camera3d_pose(selected, false, cx);
        cx.notify();
    }

    /// The Depth blur toggle: on seeds a radial defocus, off keeps every other
    /// scalar so turning it back on restores what was dialled in.
    fn toggle_camera3d_blur(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_camera3d_segment("camera3d-blur-toggle", index, window, cx, |segment| {
            if segment.blur.mode == Camera3DBlurMode::None {
                seed_blur_mode(&mut segment.blur, Camera3DBlurMode::Radial);
                if segment.blur.strength <= 0. {
                    segment.blur.strength = CAMERA3D_DEFAULT_BLUR_STRENGTH;
                }
                if segment.blur.falloff <= 0. {
                    segment.blur.falloff = CAMERA3D_DEFAULT_BLUR_FALLOFF;
                }
            } else {
                segment.blur.mode = Camera3DBlurMode::None;
            }
            true
        });
    }

    fn set_camera3d_blur_mode(
        &mut self,
        index: usize,
        mode: Camera3DBlurMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_camera3d_segment("camera3d-blur-mode", index, window, cx, move |segment| {
            if segment.blur.mode == mode {
                return false;
            }
            seed_blur_mode(&mut segment.blur, mode);
            true
        });
    }

    /// Double-clicking the orbit pad: the camera back on axis, both ends of a
    /// still shot together.
    fn reset_camera3d_tilt(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let editing_end = self.sidebar.editing_end_pose;
        self.edit_camera3d_segment("camera3d-orbit", index, window, cx, move |segment| {
            let start = start_pose(segment);
            let end = end_pose(segment);
            let still = poses_equal(&start, &end);
            let easing = MOTION_EASINGS[motion_easing(segment)];
            let level = |mut pose: Camera3DProperties| {
                pose.tilt_x = 0.;
                pose.tilt_y = 0.;
                pose
            };
            if still {
                let pose = level(start);
                set_motion(segment, &pose, &pose, (easing.2, easing.3));
            } else if editing_end {
                set_motion(segment, &start, &level(end), (easing.2, easing.3));
            } else {
                set_motion(segment, &level(start), &end, (easing.2, easing.3));
            }
            true
        });
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
    /// Park the playhead on one end of a shot, on the frame the renderer will
    /// actually draw for it.
    pub(crate) fn seek_camera3d_pose(&mut self, index: usize, end: bool, cx: &mut Context<Self>) {
        let Some(time) = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .map(|segment| {
                camera3d_pose_seek_time(segment, end, crate::editor_window::EDITOR_PREVIEW_FPS)
            })
        else {
            return;
        };
        self.seek_to_time(time, cx);
    }

    /// The timeline's own pose dots, which reach the same action the strip's
    /// cards do.
    pub(crate) fn select_camera3d_pose_from_timeline(
        &mut self,
        index: usize,
        end: bool,
        cx: &mut Context<Self>,
    ) {
        self.select_camera3d_pose(index, end, cx);
    }

    fn select_camera3d_pose(&mut self, index: usize, end: bool, cx: &mut Context<Self>) {
        self.sidebar.editing_end_pose = end;
        if let Some(time) = self
            .timeline()
            .and_then(|timeline| timeline.camera3d_segments.get(index))
            .map(|segment| {
                camera3d_pose_seek_time(segment, end, crate::editor_window::EDITOR_PREVIEW_FPS)
            })
        {
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
                            let segment = &timeline.text_segments[index];
                            fields.push(FieldKey::TextContent(index));
                            colors.push(ColorTarget::TextColor(index));
                            if segment.background_color.is_some() {
                                colors.push(ColorTarget::TextBackground(index));
                            }
                            if segment.gradient_color.is_some() {
                                colors.push(ColorTarget::TextGradient(index));
                            }
                            if segment.stroke_width > 0. {
                                colors.push(ColorTarget::TextStroke(index));
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

    /// A preset by id, so a test never has to track the table's order.
    fn preset(id: &str) -> &'static TextPreset {
        TEXT_PRESETS
            .iter()
            .find(|preset| preset.id == id)
            .unwrap_or_else(|| panic!("no preset {id}"))
    }

    #[test]
    fn the_preset_catalogue_matches_the_source() {
        let ids: Vec<_> = TEXT_PRESETS.iter().map(|preset| preset.id).collect();
        assert_eq!(
            ids,
            [
                "title",
                "headline",
                "cinematic",
                "gradient",
                "lower-third",
                "name-tag",
                "caption",
                "kicker",
                "label",
                "highlight",
                "sticker",
                "neon",
                "stat",
                "quote",
                "code",
                "typewriter"
            ]
        );
        // Only the three lower-third presets imply placement.
        let placed: Vec<_> = TEXT_PRESETS
            .iter()
            .filter(|preset| preset.center.is_some())
            .map(|preset| preset.id)
            .collect();
        assert_eq!(placed, ["lower-third", "name-tag", "caption"]);
        for preset in TEXT_PRESETS {
            // Every stack ends in a generic, which is what makes
            // `pick_font_family` total.
            let last = preset.style.font_stack.last().copied().unwrap();
            assert!(
                matches!(last, "sans-serif" | "serif" | "monospace"),
                "{} ends in {last}",
                preset.id
            );
            // Every preset is reachable from a chip.
            assert!(
                TEXT_PRESET_GROUPS.contains(&preset.group),
                "{} is in {}",
                preset.id,
                preset.group
            );
        }
    }

    #[test]
    fn the_animation_catalogue_is_the_renderers_own_order() {
        let labels: Vec<_> = TEXT_ANIMATIONS.iter().map(|(_, label)| *label).collect();
        assert_eq!(
            labels,
            [
                "None",
                "Fade",
                "Slide up",
                "Slide down",
                "Slide left",
                "Slide right",
                "Pop",
                "Zoom",
                "Bounce",
                "Wipe",
                "Words",
                "Letters",
                "Tracking",
                "Typewriter"
            ]
        );
        assert_eq!(TEXT_ANIMATIONS[0].0, TextAnimation::None);
        assert_eq!(TEXT_BACKGROUND_STYLES.len(), 3);
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

        apply_text_preset(&mut segment, preset("title"), &[]);

        // 96 / 48 = 2x.
        assert!((segment.size.x - 0.7).abs() < 1e-9);
        assert!((segment.size.y - 0.4).abs() < 1e-9);
        // The top edge did not move; the centre dropped by half the growth.
        assert!((segment.center.y - segment.size.y / 2. - top_edge).abs() < 1e-9);
        assert!((segment.center.y - 0.6).abs() < 1e-9);
        assert_eq!(segment.font_size, 96.);
        assert_eq!(segment.font_weight, 700.);
        assert_eq!(segment.align, TextAlign::Center);
        assert_eq!(segment.animation_in, TextAnimation::SlideUp);
        // `fadeDuration` is the larger of the two animation durations.
        assert!((segment.fade_duration - 0.35).abs() < 1e-9);
        assert_eq!(segment.opacity, 1.);
        // A preset with no colour of its own leaves the segment's alone.
        assert_eq!(segment.color, text_segment().color);
    }

    #[test]
    fn a_preset_resets_every_style_field_it_owns() {
        let mut segment = text_segment();
        apply_text_preset(&mut segment, preset("sticker"), &[]);
        assert_eq!(segment.stroke_width, 8.);
        assert_eq!(segment.stroke_color, "#000000");
        assert_eq!(segment.color, "#ffffff");
        assert_eq!(segment.background_color, None);

        apply_text_preset(&mut segment, preset("name-tag"), &[]);
        // The outline the previous preset set is gone, not layered under.
        assert_eq!(segment.stroke_width, 0.);
        assert_eq!(segment.background_style, TextBackgroundStyle::Pill);
        assert_eq!(segment.background_color.as_deref(), Some("#000000"));
        assert_eq!(segment.gradient_color, None);

        apply_text_preset(&mut segment, preset("gradient"), &[]);
        assert_eq!(segment.background_color, None);
        assert_eq!(segment.gradient_color.as_deref(), Some("#b388ff"));

        apply_text_preset(&mut segment, preset("cinematic"), &[]);
        assert!(segment.uppercase);
        assert_eq!(segment.animation_out, TextAnimation::Tracking);
    }

    #[test]
    fn a_preset_adopts_its_sample_only_while_the_content_is_the_placeholder() {
        let mut segment = text_segment();
        assert_eq!(segment.content, "Text");
        apply_text_preset(&mut segment, preset("title"), &[]);
        assert_eq!(segment.content, "Introducing Cap");

        // An empty box counts as untouched too.
        let mut segment = text_segment();
        segment.content = String::new();
        apply_text_preset(&mut segment, preset("stat"), &[]);
        assert_eq!(segment.content, "128%");

        // Anything the user typed survives.
        let mut segment = text_segment();
        segment.content = "Shipping today".to_string();
        apply_text_preset(&mut segment, preset("title"), &[]);
        assert_eq!(segment.content, "Shipping today");
    }

    #[test]
    fn the_box_width_clamps_at_the_whole_frame() {
        let mut segment = text_segment();
        segment.size.x = 0.8;
        // "Big stat" is 160px against the 48px default: a 3.33x scale.
        apply_text_preset(&mut segment, preset("stat"), &[]);
        assert_eq!(segment.size.x, 1.);
    }

    #[test]
    fn a_placing_preset_moves_the_box_and_the_others_do_not() {
        let mut segment = text_segment();
        segment.center = XY { x: 0.3, y: 0.4 };
        apply_text_preset(&mut segment, preset("headline"), &[]);
        // Headline keeps x, and only shifts y by the box growth.
        assert!((segment.center.x - 0.3).abs() < 1e-9);

        let mut segment = text_segment();
        apply_text_preset(&mut segment, preset("lower-third"), &[]);
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
        // Content, font size, colour and position are *not* compared.
        let mut segment = text_segment();
        apply_text_preset(&mut segment, preset("title"), &installed);
        segment.content = "anything else".into();
        segment.font_size = 42.;
        segment.color = "#ff0000".into();
        segment.center = XY { x: 0.1, y: 0.1 };
        assert_eq!(match_text_preset(&segment, &installed), Some("title"));
        segment.letter_spacing += 0.5;
        assert_eq!(match_text_preset(&segment, &installed), None);
    }

    #[test]
    fn the_new_look_fields_are_part_of_the_preset_match() {
        let installed = vec!["Inter".to_string()];
        let mut segment = text_segment();
        apply_text_preset(&mut segment, preset("caption"), &installed);
        assert_eq!(match_text_preset(&segment, &installed), Some("caption"));

        segment.background_color = None;
        assert_eq!(match_text_preset(&segment, &installed), None);

        apply_text_preset(&mut segment, preset("caption"), &installed);
        segment.uppercase = true;
        assert_eq!(match_text_preset(&segment, &installed), None);

        apply_text_preset(&mut segment, preset("caption"), &installed);
        segment.gradient_color = Some("#b388ff".to_string());
        assert_eq!(match_text_preset(&segment, &installed), None);

        // `stroke_color` only counts once there is an outline to colour.
        apply_text_preset(&mut segment, preset("caption"), &installed);
        segment.stroke_color = "#ff00ff".to_string();
        assert_eq!(match_text_preset(&segment, &installed), Some("caption"));
        apply_text_preset(&mut segment, preset("sticker"), &installed);
        segment.stroke_color = "#ff00ff".to_string();
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
    fn half_a_slider_step_is_how_close_a_pose_has_to_be() {
        // The tolerance `matchAnglePreset` was written against, now the one
        // `match_camera3d_look` compares both ends with.
        let mut pose = ANGLE_PRESETS[2].values;
        assert!(camera3d_poses_match(&pose, &ANGLE_PRESETS[2].values));
        pose.zoom += f64::from(Camera3DProperty::Zoom.limits().2) / 2.;
        assert!(camera3d_poses_match(&pose, &ANGLE_PRESETS[2].values));
        pose.zoom += f64::from(Camera3DProperty::Zoom.limits().2);
        assert!(!camera3d_poses_match(&pose, &ANGLE_PRESETS[2].values));
        // The reset pose is none of the presets.
        assert!(
            !ANGLE_PRESETS
                .iter()
                .any(|preset| camera3d_poses_match(&CAMERA3D_RESET_POSE, &preset.values))
        );
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
            match_camera3d_look(&segment).map(|look| look.id),
            Some("perspective")
        );
    }

    // -- 3D shots ----------------------------------------------------------

    #[test]
    fn a_shot_starts_where_the_click_landed_and_stops_at_the_gap() {
        // An empty track: the shot opens at the click and runs its default.
        assert_eq!(
            place_camera3d_shot(&[], 4., CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((4., 8.))
        );
        // The gap's tail is shorter than the default, so the shot shortens
        // rather than moving.
        assert_eq!(
            place_camera3d_shot(&[(8., 12.)], 6., CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((6., 8.))
        );
        // Under a second left in front of the next shot: the start slides back
        // just far enough, rather than the click being refused.
        assert_eq!(
            place_camera3d_shot(&[(8., 12.)], 7.6, CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((7., 8.))
        );
        // And it clamps to the timeline's own end.
        assert_eq!(
            place_camera3d_shot(&[], 28., CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((28., 30.))
        );
        // The caller's list is never touched.
        let existing = [(8., 12.)];
        let before = existing;
        let _ = place_camera3d_shot(&existing, 6., CAMERA3D_DEFAULT_SHOT_DURATION, 30.);
        assert_eq!(existing, before);
    }

    #[test]
    fn a_click_inside_a_shot_takes_the_next_free_gap() {
        // Richie's second scene: the playhead sat inside the first shot and the
        // old `scene_range` returned None. The gap after it is the answer.
        let existing = [(0., 6.), (10., 14.)];
        assert_eq!(
            place_camera3d_shot(&existing, 3., CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((6., 10.))
        );
        // With nothing after it, the first free gap anywhere.
        assert_eq!(
            place_camera3d_shot(&[(0., 4.), (6., 20.)], 10., 4., 20.),
            Some((4., 6.))
        );
        // A track with no gap at least a second long is the only refusal.
        assert_eq!(place_camera3d_shot(&[(0., 20.)], 10., 4., 20.), None);
        assert_eq!(
            place_camera3d_shot(&[(0., 9.5), (10., 20.)], 9.6, 4., 20.),
            None
        );
        // As are the degenerate inputs.
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(place_camera3d_shot(&[], value, 4., 20.).is_none());
            assert!(place_camera3d_shot(&[], 0., value, 20.).is_none());
            assert!(place_camera3d_shot(&[], 0., 4., value).is_none());
        }
        assert!(place_camera3d_shot(&[], 0., 0., 20.).is_none());
        assert!(place_camera3d_shot(&[], 0., 4., 0.).is_none());
    }

    #[test]
    fn a_new_shot_carries_the_opening_move() {
        let shot = new_camera3d_shot(2., 6.);
        assert_eq!((shot.start, shot.end), (2., 6.));
        assert_eq!(shot.transition_in, 0.);
        assert_eq!(shot.transition_out, 0.);
        assert_eq!(
            match_camera3d_look(&shot).map(|look| look.id),
            Some("glide-across")
        );
        assert_eq!(camera3d_shot_label(&shot), "Glide across");
    }

    #[test]
    fn every_look_matches_the_shot_it_was_just_applied_to() {
        for template in MOTION_TEMPLATES {
            let mut segment = camera3d(0., 4.);
            apply_motion_template(&mut segment, template);
            assert_eq!(
                match_camera3d_look(&segment),
                Some(Look {
                    kind: LookKind::Move,
                    id: template.id,
                    name: template.name
                }),
                "{} did not match itself",
                template.id
            );
        }
        for preset in ANGLE_PRESETS {
            let mut segment = camera3d(0., 4.);
            apply_motion_template(&mut segment, &angle_preset_motion(preset));
            assert_eq!(
                match_camera3d_look(&segment),
                Some(Look {
                    kind: LookKind::Angle,
                    id: preset.id,
                    name: preset.name
                }),
                "{} did not match itself",
                preset.id
            );
        }
        // Thirteen looks in the grid, and every one of them is reachable.
        assert_eq!(MOTION_TEMPLATES.len() + ANGLE_PRESETS.len(), 13);
    }

    #[test]
    fn a_hand_flown_shot_is_a_custom_move_and_a_held_one_is_a_still() {
        let mut segment = camera3d(0., 4.);
        apply_motion_template(&mut segment, &MOTION_TEMPLATES[0]);
        // One end nudged well past the tolerance and the tile lets go.
        let start = start_pose(&segment);
        let mut end = end_pose(&segment);
        end.roll += 30.;
        set_motion(&mut segment, &start, &end, ([0., 0.], [1., 1.]));
        assert_eq!(match_camera3d_look(&segment), None);
        assert_eq!(camera3d_shot_label(&segment), "Custom move");

        set_motion(&mut segment, &start, &start, ([0., 0.], [1., 1.]));
        assert_eq!(camera3d_shot_label(&segment), "Still shot");
    }

    #[test]
    fn a_pose_seeks_to_a_frame_inside_its_own_shot() {
        // The renderer floors a seek onto a frame, so a shot starting between
        // two frames used to show the one before it -- the previous scene.
        let segment = camera3d(3.025, 5.83);
        assert!((camera3d_pose_seek_time(&segment, false, 30) - 91. / 30.).abs() < 1e-9);
        assert!((camera3d_pose_seek_time(&segment, true, 30) - 5.8).abs() < 1e-9);
        // Both ends stay inside the shot.
        assert!(camera3d_pose_seek_time(&segment, false, 30) >= segment.start);
        assert!(camera3d_pose_seek_time(&segment, true, 30) < segment.end);

        // A start already on a frame does not jump forward a frame.
        let aligned = camera3d(3., 6.);
        assert!((camera3d_pose_seek_time(&aligned, false, 30) - 3.).abs() < 1e-9);
        assert!((camera3d_pose_seek_time(&aligned, true, 30) - (6. - 1. / 30.)).abs() < 1e-9);

        // A shot shorter than a frame still shows its own opening pose.
        let sliver = camera3d(2.0, 2.01);
        assert_eq!(
            camera3d_pose_seek_time(&sliver, true, 30),
            camera3d_pose_seek_time(&sliver, false, 30)
        );
    }

    #[test]
    fn a_sequence_stays_inside_the_shot_it_replaces() {
        // The panel replaces one shot with the whole chain, so the chain has
        // to live entirely inside that shot's box or it would overlap the
        // neighbours on either side.
        let neighbours = [(0., 6.), (18., 24.)];
        let (start, end) = (6., 18.);
        for scene in CAMERA3D_SCENES {
            for cuts in [vec![], vec![9.5, 13.]] {
                let shots = apply_scene_to_range(scene, start, end, &cuts);
                assert!(!shots.is_empty(), "{} generated nothing", scene.id);
                assert!((shots[0].start - start).abs() < 1e-9);
                assert!((shots[shots.len() - 1].end - end).abs() < 1e-9);
                for pair in shots.windows(2) {
                    assert!((pair[1].start - pair[0].end).abs() < 1e-9);
                }
                for shot in &shots {
                    assert!(shot.end - shot.start >= CAMERA3D_MIN_SHOT_DURATION - 1e-9);
                    for (other_start, other_end) in neighbours {
                        assert!(
                            shot.end <= other_start + 1e-9 || shot.start >= other_end - 1e-9,
                            "{} overlapped a neighbour",
                            scene.id
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_look_thumbnails_project_every_pose_in_the_grid() {
        for template in MOTION_TEMPLATES {
            for pose in [&template.from, &template.to] {
                assert!(
                    camera3d_projected_point(pose, -1., 1.).is_some(),
                    "{} projects nothing",
                    template.id
                );
            }
        }
        for preset in ANGLE_PRESETS {
            assert!(camera3d_projected_point(&preset.values, 0., 0.).is_some());
        }
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
    Opacity,
    Rotation,
    Rounding,
}

impl ImageProperty {
    fn label(self) -> &'static str {
        match self {
            Self::Opacity => "Opacity",
            Self::Rotation => "Rotation",
            Self::Rounding => "Rounding",
        }
    }
    fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Rotation => (-180., 180., 1.),
            _ => (0., 100., 1.),
        }
    }
    fn read(self, segment: &cap_project::ImageSegment) -> f32 {
        match self {
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
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(self.theme.gray_4))
                    .bg(Hsla::from(self.theme.gray_2))
                    .p(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(svg().path("icons/move.svg").size(px(16.)))
                            .child("Arrange on canvas"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(self.theme.gray_10))
                            .child("Drag the image to move it. Pull a corner to resize, or use the rotation control below to turn it."),
                    )
                    .child(
                        ui::Button::plain(
                            &self.theme,
                            SharedString::from(format!("center-image-{index}")),
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .icon("icons/move.svg")
                        .label("Center on canvas")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.edit_image_segment(
                                "image-center",
                                index,
                                window,
                                cx,
                                |segment| {
                                    segment.center = XY::new(0.5, 0.5);
                                    true
                                },
                            );
                        })),
                    ),
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
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(svg().path(group.icon()).size(px(14.)))
                                    .child(format!("Edit {}", group.label())),
                            )
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
