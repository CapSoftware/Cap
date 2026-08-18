//! The config sidebar: the shell, and the Background tab at 1:1.
//!
//! `ConfigSidebar.tsx` is 6500 lines and really twenty small panels in a
//! trenchcoat. This module is its shell -- the live six-tab rail, the scroll
//! body, and the selection routing that swaps a segment's panel in over the top
//! of the tab content -- plus the whole of the first tab
//! (`ConfigSidebar.tsx:2185-2976`). The rest of the sidebar lives next door and
//! comes back through this module's rail and routing:
//!
//! | module | what it draws |
//! |---|---|
//! | [`crate::editor_tabs`] | Camera, Audio, Cursor, Keyboard, Captions |
//! | [`crate::editor_color`] | `ColorCorrectionSection`, once per target |
//! | [`crate::editor_panels`] | the eight segment panels, and the shared fields |
//!
//! Those three reach back in here for the pieces the whole sidebar shares: one
//! [`SliderKey`] table and one drag handler for every slider in the pane, one
//! [`ColorTarget`] enum over both colour-storage shapes, the [`PadKey`] and
//! [`PanelSection`] maps, and the collapsible / dashed-divider primitives.
//!
//! Every control here writes a real `ProjectConfiguration` key path through the
//! **same** path a timeline edit takes -- [`EditorWindow::project_changed`]:
//! history, then `project_config` + `preview_tx` so the picture follows the
//! change, then the 250ms debounced `ProjectConfiguration::write`. Nothing in
//! this module writes to disk itself.
//!
//! Three things needed native code, and all three are the shipping behaviour
//! rather than an approximation of it:
//!
//! - the **colour panel** is what `<input type="color">` opens on macOS
//!   (`color-utils.tsx:50-64`), so this opens the same `NSColorPanel` and
//!   drains its `changeColor:` action off a channel;
//! - the **image picker** is `<input type="file">`, i.e. `NSOpenPanel`;
//! - **"Import desktop background"** is `commands.importCurrentDesktopBackground`,
//!   which is `NSWorkspace`'s `desktopImageURLForScreen:` plus a `sips`
//!   re-encode (`src-tauri/src/recording.rs:181-208, 437-472`).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use cap_project::{
    BackgroundSource, BorderConfiguration, Color, CornerStyle, DisplayNotch, NotchConfiguration,
    ProjectConfiguration, ShadowConfiguration,
};
use gpui::{
    AnyElement, Bounds, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseDownEvent,
    MouseMoveEvent, ParentElement, Pixels, RenderImage, SharedString, StatefulInteractiveElement,
    Styled, StyledImage, Window, canvas, div, img, linear_color_stop, linear_gradient,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_color::{GradeSlider, GradeTarget},
    editor_panels::PanelSlider,
    editor_tabs::{AudioSlider, CameraSlider, CaptionSlider, CursorSlider, KeyboardSlider},
    editor_timeline::TrackKind,
    editor_window::EditorWindow,
    library,
    ui::{self, CollapsibleState, SliderTrack},
};

// ---------------------------------------------------------------------------
// The catalogue: every constant the background section reads
// ---------------------------------------------------------------------------

/// `WALLPAPER_NAMES` (`ConfigSidebar.tsx:279-338`), in order. The id is also
/// the path under `assets/backgrounds`, minus the `.jpg`.
pub const WALLPAPER_NAMES: [&str; 53] = [
    "macOS/tahoe-dusk-min",
    "macOS/tahoe-dawn-min",
    "macOS/tahoe-day-min",
    "macOS/tahoe-night-min",
    "macOS/tahoe-dark",
    "macOS/tahoe-light",
    "macOS/sequoia-dark",
    "macOS/sequoia-light",
    "macOS/sonoma-clouds",
    "macOS/sonoma-dark",
    "macOS/sonoma-evening",
    "macOS/sonoma-fromabove",
    "macOS/sonoma-horizon",
    "macOS/sonoma-light",
    "macOS/sonoma-river",
    "macOS/ventura-dark",
    "macOS/ventura-semi-dark",
    "macOS/ventura",
    "blue/1",
    "blue/2",
    "blue/3",
    "blue/4",
    "blue/5",
    "blue/6",
    "purple/1",
    "purple/2",
    "purple/3",
    "purple/4",
    "purple/5",
    "purple/6",
    "cities/liverpool",
    "cities/santorini",
    "cities/miami",
    "cities/monaco",
    "cities/london",
    "cities/rome",
    "cities/sf",
    "cities/nyc",
    "dark/1",
    "dark/2",
    "dark/3",
    "dark/4",
    "dark/5",
    "dark/6",
    "orange/1",
    "orange/2",
    "orange/3",
    "orange/4",
    "orange/5",
    "orange/6",
    "orange/7",
    "orange/8",
    "orange/9",
];

/// `BACKGROUND_THEMES` (`:404-411`) -- the wallpaper grid's sub-tabs, in the
/// object's own key order, which is the order they render in.
pub const BACKGROUND_THEMES: [(&str, &str); 6] = [
    ("macOS", "macOS"),
    ("dark", "Dark"),
    ("blue", "Blue"),
    ("cities", "Cities"),
    ("purple", "Purple"),
    ("orange", "Orange"),
];

/// `BACKGROUND_COLORS` (`:259-277`). The last one is transparent and renders as
/// a checkerboard rather than a swatch.
pub const BACKGROUND_COLORS: [&str; 17] = [
    "#FF0000",
    "#FF4500",
    "#FF8C00",
    "#FFD700",
    "#FFFF00",
    "#ADFF2F",
    "#32CD32",
    "#008000",
    "#00CED1",
    "#4785FF",
    "#0000FF",
    "#4B0082",
    "#800080",
    "#A9A9A9",
    "#FFFFFF",
    "#000000",
    "#00000000",
];

/// `GRADIENT_PRESETS` (`GradientEditor.tsx:18-37`).
pub const GRADIENT_PRESETS: [([u16; 3], [u16; 3]); 18] = [
    ([15, 52, 67], [52, 232, 158]),
    ([34, 193, 195], [253, 187, 45]),
    ([29, 253, 251], [195, 29, 253]),
    ([69, 104, 220], [176, 106, 179]),
    ([106, 130, 251], [252, 92, 125]),
    ([131, 58, 180], [253, 29, 29]),
    ([249, 212, 35], [255, 78, 80]),
    ([255, 94, 0], [255, 42, 104]),
    ([255, 0, 150], [0, 204, 255]),
    ([0, 242, 96], [5, 117, 230]),
    ([238, 205, 163], [239, 98, 159]),
    ([44, 62, 80], [52, 152, 219]),
    ([168, 239, 255], [238, 205, 163]),
    ([74, 0, 224], [143, 0, 255]),
    ([252, 74, 26], [247, 183, 51]),
    ([0, 255, 255], [255, 20, 147]),
    ([255, 127, 0], [255, 255, 0]),
    ([255, 0, 255], [0, 255, 0]),
];

/// `projectConfig.ts:15-16`.
pub const DEFAULT_GRADIENT_FROM: Color = [71, 133, 255];
pub const DEFAULT_GRADIENT_TO: Color = [255, 71, 102];
/// `projectConfig.ts:18-19`.
pub const DEFAULT_BACKGROUND_PADDING: f64 = 10.;
pub const DEFAULT_BACKGROUND_ROUNDING: f64 = 7.5;
/// `GradientEditor.tsx:39-40`.
pub const DEFAULT_NOISE_SCALE: f32 = 3.;
/// `BACKGROUND_IMAGE_EXTENSIONS` (`:250-257`).
pub const BACKGROUND_IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
/// `CURRENT_DESKTOP_BACKGROUND_BASENAME` (`:350`, and `recording.rs:91`).
pub const CURRENT_DESKTOP_BACKGROUND_BASENAME: &str = "current-desktop-background";
/// `recording.rs:92-93`.
const DESKTOP_BACKGROUND_MAX_DIMENSION: u32 = 2560;
const DESKTOP_BACKGROUND_JPEG_QUALITY: u8 = 82;

/// The sidebar's fallback border/shadow objects. The UI's numbers, **not**
/// `BorderConfiguration::default()`'s -- the Rust default is white at 80 %, the
/// sidebar seeds black at 50 % (`ConfigSidebar.tsx:2715-2720`), and the two
/// have always disagreed. Reproduced as the UI has it, because that is what a
/// user who touches these sliders gets today.
const UI_BORDER_FALLBACK: BorderConfiguration = BorderConfiguration {
    enabled: false,
    width: 5.0,
    color: [0, 0, 0],
    opacity: 50.0,
};

/// `{size: 50, opacity: 18, blur: 50}` (`:2905-2909`), against
/// `ShadowConfiguration::default()`'s `{14.4, 68.1, 3.8}`. Same disagreement.
const UI_SHADOW_FALLBACK: ShadowConfiguration = ShadowConfiguration {
    size: 50.,
    opacity: 18.,
    blur: 50.,
};

/// `UNPLACED_NOTCH` (`:342-347`) -- "use the recording's own measurements", so
/// an untouched slider stays `None` rather than writing its displayed value.
const UNPLACED_NOTCH: NotchConfiguration = NotchConfiguration {
    enabled: false,
    x: None,
    width: None,
    height: None,
};

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

/// The six tabs of the rail (`:596-621`). `hotkeys` is commented out at `:620`
/// and its dead `KTabs.Content` still exists at `:1053-1061`; it is not a tab
/// here either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarTab {
    Background,
    Camera,
    Audio,
    Cursor,
    Keyboard,
    Captions,
}

impl SidebarTab {
    pub const ALL: [SidebarTab; 6] = [
        Self::Background,
        Self::Camera,
        Self::Audio,
        Self::Cursor,
        Self::Keyboard,
        Self::Captions,
    ];

    pub fn icon(self) -> &'static str {
        match self {
            Self::Background => "icons/image.svg",
            Self::Camera => "icons/camera.svg",
            Self::Audio => "icons/audio-on.svg",
            Self::Cursor => "icons/cursor.svg",
            Self::Keyboard => "icons/keyboard.svg",
            Self::Captions => "icons/message-bubble.svg",
        }
    }

    /// The tab's own name. Used by the timeline's own logging and by the tests
    /// that pin the rail's order; the rail itself is icon-only.
    #[allow(dead_code)]
    pub fn label(self) -> &'static str {
        match self {
            Self::Background => "Background",
            Self::Camera => "Camera",
            Self::Audio => "Audio",
            Self::Cursor => "Cursor",
            Self::Keyboard => "Keyboard",
            Self::Captions => "Captions",
        }
    }
}

/// `BackgroundSourceTab` (`:218-227`): the five real source types plus
/// `desktop`, which is a wallpaper source whose path is the imported desktop
/// picture, and `none`, which is not a source at all but padding and rounding
/// both at zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceTab {
    Desktop,
    Wallpaper,
    Image,
    Color,
    Gradient,
    None,
}

impl SourceTab {
    /// `BACKGROUND_SOURCES_ROW_ONE` / `_TWO` (`:236-246`).
    pub const ROWS: [[SourceTab; 3]; 2] = [
        [Self::Desktop, Self::Wallpaper, Self::Image],
        [Self::Color, Self::Gradient, Self::None],
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Desktop => "Desktop",
            Self::Wallpaper => "Wallpaper",
            Self::Image => "Image",
            Self::Color => "Color",
            Self::Gradient => "Gradient",
            Self::None => "None",
        }
    }
}

/// `isCurrentDesktopBackgroundPath` (`:365-373`).
pub fn is_current_desktop_background_path(path: Option<&str>) -> bool {
    let Some(path) = path else { return false };
    let Some(name) = path.rsplit(['/', '\\']).next() else {
        return false;
    };
    name.starts_with(&format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}."))
        || name.starts_with(&format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-"))
}

/// `projectBackgroundSourceTab` (`:1788-1798`): the source's own type, except
/// that a wallpaper pointing at the imported desktop picture reads as
/// `desktop`.
pub fn source_tab_for(source: &BackgroundSource) -> SourceTab {
    match source {
        BackgroundSource::Wallpaper { path } => {
            if is_current_desktop_background_path(path.as_deref()) {
                SourceTab::Desktop
            } else {
                SourceTab::Wallpaper
            }
        }
        BackgroundSource::Image { .. } => SourceTab::Image,
        BackgroundSource::Color { .. } => SourceTab::Color,
        BackgroundSource::Gradient { .. } => SourceTab::Gradient,
    }
}

/// `isNoneBackground()` (`:1776-1777`).
pub fn is_none_background(config: &ProjectConfiguration) -> bool {
    config.background.padding == 0. && config.background.rounding == 0.
}

/// The tab the panel opens on: "None" wins over the underlying source, and it
/// is sticky -- nudging padding out of zero must not swap the panel back and
/// move the very slider being dragged (`:1804-1811`).
pub fn initial_source_tab(config: &ProjectConfiguration) -> SourceTab {
    if is_none_background(config) {
        SourceTab::None
    } else {
        source_tab_for(&config.background.source)
    }
}

/// `notchXMax()` (`:1771-1775`): `1 - clamp(width, 0, 1)`.
pub fn notch_x_max(width: f64) -> f64 {
    1. - width.clamp(0., 1.)
}

/// `hexToRgb` (`utils/hex-color.ts:38-51`) -- 3/4/6/8 digits, `#` optional,
/// alpha defaulting to 255.
pub fn hex_to_rgb(hex: &str) -> Option<[u8; 4]> {
    let normalized = normalize_hex(hex)?;
    let raw = &normalized[1..];
    let component = |start: usize| u8::from_str_radix(&raw[start..start + 2], 16).ok();
    Some([
        component(0)?,
        component(2)?,
        component(4)?,
        if raw.len() == 8 { component(6)? } else { 255 },
    ])
}

/// `normalizeHexColor` (`hex-color.ts:1-21`).
pub fn normalize_hex(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match raw.len() {
        3 | 4 => Some(format!(
            "#{}",
            raw.chars()
                .flat_map(|c| [c, c])
                .collect::<String>()
                .to_uppercase()
        )),
        6 | 8 => Some(format!("#{}", raw.to_uppercase())),
        _ => None,
    }
}

/// `getHexColorDigitCount` (`hex-color.ts:23-32`): how many hex digits a
/// half-typed field holds, which is what decides whether the field commits
/// live rather than waiting for Enter or blur.
///
/// This is the `onInput` gate: `EditorWindow::on_hex_event` commits only at 6
/// or 8 digits, which is what stops `#4` from being read as a colour halfway
/// through typing `#4785FF`.
pub fn hex_digit_count(value: &str) -> usize {
    let trimmed = value.trim();
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return 0;
    }
    raw.len()
}

/// `rgbToHex` (`color-utils.tsx:11-16`).
pub fn rgb_to_hex(rgb: Color) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

/// `getColorPreviewBorderColor`: `color-mix(in srgb, <color> 82%, black)` --
/// a computed darker ring so a light swatch does not vanish against a light
/// page (`color-utils.tsx:7-9`).
pub fn preview_border_color(rgb: Color) -> Hsla {
    let mix = |channel: u16| ((f32::from(channel) * 0.82).round() as u8) as f32 / 255.;
    Hsla::from(gpui::Rgba {
        r: mix(rgb[0]),
        g: mix(rgb[1]),
        b: mix(rgb[2]),
        a: 1.,
    })
}

pub fn color_to_hsla(rgb: Color) -> Hsla {
    Hsla::from(gpui::Rgba {
        r: f32::from(rgb[0].min(255)) / 255.,
        g: f32::from(rgb[1].min(255)) / 255.,
        b: f32::from(rgb[2].min(255)) / 255.,
        a: 1.,
    })
}

/// The wallpaper ids of one theme, in catalogue order -- `filteredWallpapers`
/// is `wallpapers().filter(wp => wp.id.startsWith(currentTab))` (`:1975-1978`).
pub fn wallpapers_for_theme(theme: &str) -> Vec<&'static str> {
    WALLPAPER_NAMES
        .iter()
        .copied()
        .filter(|id| id.starts_with(theme))
        .collect()
}

/// Where the bundled wallpapers live.
///
/// **They are not embedded, and cannot be**: selecting one writes an *absolute
/// filesystem path* into `background.source.path`, which `cap-rendering` then
/// opens (`layers/background.rs`) -- so the file has to exist on disk for the
/// picture to render at all, in this app and in the shipping one. Embedding the
/// 25 MB of JPEGs would add 25 MB to the binary *and* still need them written
/// back out somewhere. So this resolves the same files
/// `resolveResource("assets/backgrounds/<id>.jpg")` does, preferring an
/// installed Cap.app (whose paths are byte-identical to what the shipping app
/// would write) and falling back to the repository the dev build runs from.
pub fn wallpaper_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CAP_GPUI_WALLPAPERS_DIR") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }

    let mut candidates = Vec::with_capacity(3);
    if let Ok(executable) = std::env::current_exe()
        && let Some(contents) = executable.parent().and_then(Path::parent)
    {
        candidates.push(contents.join("Resources/assets/backgrounds"));
    }
    candidates.push(PathBuf::from(
        "/Applications/Cap.app/Contents/Resources/assets/backgrounds",
    ));
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../desktop/src-tauri/assets/backgrounds")
            .clean(),
    );
    candidates.into_iter().find(|path| path.is_dir())
}

/// `PathBuf::canonicalize` fails on a path that does not exist, and a `..`
/// segment left in place reads badly in a log line, so the `../` is folded
/// here instead.
trait Clean {
    fn clean(self) -> PathBuf;
}

impl Clean for PathBuf {
    fn clean(self) -> PathBuf {
        let mut out = PathBuf::new();
        for component in self.components() {
            match component {
                std::path::Component::ParentDir => {
                    out.pop();
                }
                std::path::Component::CurDir => {}
                other => out.push(other),
            }
        }
        out
    }
}

pub fn wallpaper_path(id: &str) -> Option<PathBuf> {
    let path = wallpaper_dir()?.join(format!("{id}.jpg"));
    path.is_file().then_some(path)
}

/// Which catalogue wallpaper a stored path is, if any. The stored value is an
/// absolute path, and `selectedWallpaper` matches it by `path.includes(w.id)`
/// (`:1885`).
pub fn wallpaper_id_for_path(path: &str) -> Option<&'static str> {
    WALLPAPER_NAMES.iter().copied().find(|id| path.contains(id))
}

/// Which gradient preset a pair of stops is, by exact RGB match
/// (`GradientEditor.tsx:260-268`).
pub fn gradient_preset_index(from: Color, to: Color) -> Option<usize> {
    GRADIENT_PRESETS
        .iter()
        .position(|(preset_from, preset_to)| *preset_from == from && *preset_to == to)
}

/// The noise overlay's `baseFrequency`: `0.3 + ((100 - scale) / 100) * 1.2`,
/// to three decimals (`GradientEditor.tsx:84-87`).
pub fn noise_base_frequency(scale: f32) -> f32 {
    ((0.3 + ((100. - scale) / 100.) * 1.2) * 1000.).round() / 1000.
}

/// `noiseOpacity`: `intensity / 100 * 0.25` (`:89-91`).
pub fn noise_opacity(intensity: f32) -> f32 {
    (intensity / 100.) * 0.25
}

/// The preview's grain, as close as this rev gets to an SVG `feTurbulence`.
///
/// The source overlays the gradient with `<feTurbulence type="fractalNoise"
/// numOctaves="4" stitchTiles="stitch">` desaturated by `feColorMatrix`, at
/// `mix-blend-mode: overlay` and the computed opacity
/// (`GradientEditor.tsx:105-128`). gpui has no filter primitives and no blend
/// modes, so this generates the equivalent fractal value noise into an image
/// and paints it at the same opacity over the same box. What differs, exactly:
/// Perlin-style gradient noise becomes value noise (a different grain
/// *character* at the same frequency), and `overlay` becomes source-over (the
/// grain lightens and darkens less selectively). The **rendered** frame's grain
/// is not affected either way -- `cap-rendering` applies `noise_intensity` /
/// `noise_scale` itself (`layers/background.rs:251-299`), so the player shows
/// the real thing.
fn noise_texture(width: u32, height: u32, base_frequency: f32) -> Arc<RenderImage> {
    let mut rgba = image::RgbaImage::new(width.max(1), height.max(1));
    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let value = fractal_noise(x as f32 * base_frequency, y as f32 * base_frequency, 0);
        let alpha = fractal_noise(x as f32 * base_frequency, y as f32 * base_frequency, 7);
        let level = (value.clamp(0., 1.) * 255.) as u8;
        // BGRA, gpui's atlas order.
        *pixel = image::Rgba([level, level, level, (alpha.clamp(0., 1.) * 255.) as u8]);
    }
    Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
        rgba
    )]))
}

/// Four octaves, each twice the frequency and half the amplitude -- what
/// `numOctaves="4"` means.
fn fractal_noise(x: f32, y: f32, seed: u32) -> f32 {
    fractal_noise_octaves(x, y, seed, 4)
}

/// The same, at whatever `numOctaves` the call site's `feTurbulence` declares.
/// The colour-grade previews' grain is `numOctaves="2"`
/// (`colorCorrection.ts:56`).
pub(crate) fn fractal_noise_octaves(x: f32, y: f32, seed: u32, octaves: u32) -> f32 {
    let (mut value, mut amplitude, mut total, mut frequency) = (0., 1., 0., 1.);
    for octave in 0..octaves {
        value += amplitude * value_noise(x * frequency, y * frequency, seed + octave);
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.;
    }
    value / total
}

fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    // Smoothstep, as the spec's interpolant is smooth rather than linear.
    let (sx, sy) = (fx * fx * (3. - 2. * fx), fy * fy * (3. - 2. * fy));
    let (x0, y0) = (x0 as i32, y0 as i32);
    let corner = |dx: i32, dy: i32| lattice(x0 + dx, y0 + dy, seed);
    let top = corner(0, 0) + sx * (corner(1, 0) - corner(0, 0));
    let bottom = corner(0, 1) + sx * (corner(1, 1) - corner(0, 1));
    top + sy * (bottom - top)
}

fn lattice(x: i32, y: i32, seed: u32) -> f32 {
    let mut hash = (x as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((y as u32).wrapping_mul(668_265_263))
        .wrapping_add(seed.wrapping_mul(2_246_822_519));
    hash = (hash ^ (hash >> 13)).wrapping_mul(1_274_126_177);
    f32::from((hash ^ (hash >> 16)) as u16) / 65_535.
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Every slider in the background tab, so one drag handler serves all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BgSlider {
    Blur,
    Padding,
    Rounding,
    MotionBlur,
    BorderWidth,
    BorderOpacity,
    NotchWidth,
    NotchHeight,
    NotchX,
    Shadow,
    ShadowSize,
    ShadowOpacity,
    ShadowBlur,
    GradientAngle,
    GradientNoise,
    GradientGrain,
}

impl BgSlider {
    /// `minValue` / `maxValue` / `step`, per call site. `NotchX`'s maximum is
    /// `notchXMax()` and therefore not constant; it is patched in by
    /// [`EditorWindow::slider_limits`].
    fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Blur => (0., 100., 0.1),
            Self::Padding => (0., 40., 0.1),
            Self::Rounding => (0., 100., 0.1),
            Self::MotionBlur => (0., 1., 0.01),
            Self::BorderWidth => (1., 20., 0.1),
            Self::BorderOpacity => (0., 100., 0.1),
            Self::NotchWidth => (0., 0.4, 0.001),
            Self::NotchHeight => (0., 0.15, 0.001),
            Self::NotchX => (0., 1., 0.001),
            Self::Shadow | Self::ShadowSize | Self::ShadowOpacity | Self::ShadowBlur => {
                (0., 100., 0.1)
            }
            Self::GradientAngle => (0., 360., 1.),
            Self::GradientNoise => (0., 100., 1.),
            Self::GradientGrain => (1., 100., 1.),
        }
    }
}

/// Every slider in the sidebar, so one drag handler, one track table and one
/// undo bracket serve all of them.
///
/// The background tab's own set stays [`BgSlider`] -- it is the one group with
/// real side effects per arm -- and the five later tabs, the two colour grades
/// and the eight segment panels each bring their own enum. The panel arm
/// carries the **segment index** as well as the field, because a multi-select
/// draws one panel per segment and each row needs its own track rect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SliderKey {
    Bg(BgSlider),
    Grade(GradeTarget, GradeSlider),
    Camera(CameraSlider),
    Audio(AudioSlider),
    Cursor(CursorSlider),
    Caption(CaptionSlider),
    Keyboard(KeyboardSlider),
    Panel(PanelSlider, usize),
}

/// Which colour the open `NSColorPanel` is editing.
///
/// The first four are the background tab's `RgbInput`s, which store a
/// `[u8; 3]`. The rest are `HexColorInput`s (`text-style.tsx:82-163`), which
/// store a `#RRGGBB` **string** -- the same control with a different storage
/// type, so they share this enum and convert at the edges through
/// [`hex_to_rgb`] / [`rgb_to_hex`], both of which are exact for an opaque
/// colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ColorTarget {
    BackgroundColor,
    GradientFrom,
    GradientTo,
    BorderColor,
    CaptionColor,
    CaptionBackground,
    CaptionHighlight,
    KeyboardColor,
    KeyboardBackground,
    /// A text segment's colour, per segment index.
    TextColor(usize),
}

impl ColorTarget {
    /// Whether the target stores a hex string rather than an `[u8; 3]`.
    pub fn is_hex_string(self) -> bool {
        !matches!(
            self,
            Self::BackgroundColor | Self::GradientFrom | Self::GradientTo | Self::BorderColor
        )
    }
}

/// Which of the picker popover's two surfaces the pointer went down on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorPickerDrag {
    Field,
    Hue,
}

/// The sidebar's own state -- everything `ConfigSidebar`'s signals hold that is
/// not in the project config.
pub struct SidebarState {
    /// `state.selectedTab` (`:563-573`).
    pub tab: SidebarTab,
    /// `backgroundSourceTab` (`:1799-1802`).
    pub source_tab: SourceTab,
    /// `backgroundTab` -- the wallpaper grid's theme (`:1786-1787`).
    pub wallpaper_theme: usize,
    /// The scroll body's offset, so a tab switch can put it back to the top
    /// (`:647-649`).
    pub scroll: gpui::ScrollHandle,

    /// `KCollapsible open={...}` for Border and MacBook notch (both driven by
    /// their own toggle) and `ShadowSettings`' own `isOpen` signal.
    pub border_open: CollapsibleState,
    pub notch_open: CollapsibleState,
    pub shadow_open: CollapsibleState,

    /// The live slider drag and its undo bracket.
    pub slider_drag: ui::SliderDrag<SliderKey>,
    /// Each slider's track rect, written by its own prepaint canvas. Behind a
    /// `RefCell` because `render` only has `&self` and a slider that has never
    /// been drawn has to be able to claim its cell there.
    tracks: std::cell::RefCell<HashMap<SliderKey, SliderTrack>>,

    /// The `PositionPad`s' rects, same story, keyed by the pad's own id.
    pads: std::cell::RefCell<HashMap<PadKey, SliderTrack>>,
    /// The live pad drag, and whether it is holding a `history.pause()`.
    pub pad_drag: Option<PadKey>,

    /// `ColorCorrectionSection`'s `adjustOpen` signal -- one per instance, so
    /// the Background tab's and the Camera tab's open independently.
    grade_adjust: [CollapsibleState; 2],
    /// The nine preset tiles, generated once for the process. The catalogue is
    /// static, so nothing can invalidate them.
    pub(crate) grade_previews: std::cell::RefCell<HashMap<&'static str, Arc<RenderImage>>>,
    /// The camera tab's own `ShadowSettings` reveal, and the cursor tab's
    /// `KCollapsible open={!project.cursor.raw}` physics panel.
    pub camera_shadow_open: CollapsibleState,
    pub cursor_physics_open: CollapsibleState,
    /// The 3D panel's three `Camera3DSection`s and the zoom panel's helper.
    pub panel_sections: std::cell::RefCell<HashMap<PanelSection, std::rc::Rc<CollapsibleState>>>,

    /// The gradient preview's grain, cached by the grain-scale step it was
    /// generated for -- regenerating 42k pixels of noise on every frame of a
    /// slider drag would be the one expensive thing in this panel.
    noise: std::cell::RefCell<Option<(i32, Arc<RenderImage>)>>,

    /// The open `KSelect`'s menu, if any -- one slot for every select in the
    /// sidebar, the settings window's `Menu.popup()` stand-in.
    pub menu: Option<crate::editor_tabs::OpenMenu>,
    /// `selectedModel` / `selectedLanguage` on the captions tab: local UI
    /// state in the source too, not project config.
    pub caption_model: &'static str,
    pub caption_language: &'static str,
    /// `editingEnd` on the 3D panel -- which of the two poses the camera
    /// sliders point at (`ConfigSidebar.tsx:4908`).
    pub editing_end_pose: bool,

    /// The open colour picker's target, if any -- drives the swatch's blue
    /// ring while its popover is up.
    pub color_target: Option<ColorTarget>,
    /// The picker popover itself: anchor and the HSV triple being edited.
    pub color_picker: Option<crate::ui::ColorPickerSnapshot>,
    /// The live picker drag, if the pointer went down on the field or the
    /// hue rail -- drives the window-wide drag layer.
    pub color_drag: Option<ColorPickerDrag>,
    /// Whether the open picker is holding a `history.pause()`. It lives here
    /// rather than with the popover because a *second* swatch clicked while
    /// one is up replaces the popover -- and the first bracket must resume or
    /// the history would stay paused forever and swallow every later edit.
    color_paused: bool,

    /// Decoded wallpaper thumbnails, keyed by catalogue id, and the task
    /// filling them in. Same shape as Recents: the grid paints its placeholders
    /// first and each tile replaces its own as it decodes.
    wallpapers: HashMap<&'static str, Arc<RenderImage>>,
    wallpaper_task: Option<gpui::Task<()>>,
    /// The `h-48` preview for the image and desktop panes, keyed by path so a
    /// stale decode cannot land on a newer selection.
    preview: Option<(PathBuf, Arc<RenderImage>)>,
    preview_task: Option<gpui::Task<()>>,

    /// `currentDesktopBackgroundPath` (`:1783-1784`) and
    /// `importingDesktopBackground` (`:2030-2031`).
    pub desktop_background: Option<PathBuf>,
    pub importing_desktop: bool,
    /// Guards the file-picker task: `runModal` spins its own run loop and a
    /// second panel would stack on the first.
    picking_image: bool,
    picker_task: Option<gpui::Task<()>>,
}

impl SidebarState {
    pub fn new(config: &ProjectConfiguration) -> Self {
        Self {
            tab: SidebarTab::Background,
            source_tab: initial_source_tab(config),
            wallpaper_theme: 0,
            scroll: gpui::ScrollHandle::new(),
            border_open: CollapsibleState::new(
                config.background.border.as_ref().is_some_and(|b| b.enabled),
            ),
            notch_open: CollapsibleState::new(
                config.background.notch.as_ref().is_some_and(|n| n.enabled),
            ),
            shadow_open: CollapsibleState::new(false),
            slider_drag: ui::SliderDrag::new(),
            tracks: std::cell::RefCell::new(HashMap::new()),
            pads: std::cell::RefCell::new(HashMap::new()),
            pad_drag: None,
            grade_adjust: [CollapsibleState::new(false), CollapsibleState::new(false)],
            grade_previews: std::cell::RefCell::new(HashMap::new()),
            camera_shadow_open: CollapsibleState::new(false),
            cursor_physics_open: CollapsibleState::new(!config.cursor.raw),
            panel_sections: std::cell::RefCell::new(HashMap::new()),
            noise: std::cell::RefCell::new(None),
            menu: None,
            caption_model: "best",
            caption_language: "auto",
            editing_end_pose: false,
            color_target: None,
            color_picker: None,
            color_drag: None,
            color_paused: false,
            wallpapers: HashMap::new(),
            wallpaper_task: None,
            preview: None,
            preview_task: None,
            desktop_background: None,
            importing_desktop: false,
            picking_image: false,
            picker_task: None,
        }
    }

    pub(crate) fn track(&self, slider: SliderKey) -> SliderTrack {
        self.tracks.borrow_mut().entry(slider).or_default().clone()
    }

    /// The grain texture for a grain-scale value, generated once per step.
    fn noise_image(&self, scale: f32) -> Arc<RenderImage> {
        let key = scale.round() as i32;
        if let Some((cached, image)) = self.noise.borrow().as_ref()
            && *cached == key
        {
            return image.clone();
        }
        let image = noise_texture(
            GRADIENT_PREVIEW_WIDTH as u32,
            GRADIENT_PREVIEW_HEIGHT as u32,
            noise_base_frequency(scale),
        );
        *self.noise.borrow_mut() = Some((key, image.clone()));
        image
    }

    /// The stored track rect, without creating one -- the pointer maths reads
    /// this and a slider that has never been laid out simply does not move.
    fn track_bounds(&self, slider: SliderKey) -> Option<Bounds<Pixels>> {
        self.tracks
            .borrow()
            .get(&slider)
            .and_then(|cell| cell.get())
    }

    pub(crate) fn pad(&self, key: PadKey) -> SliderTrack {
        self.pads.borrow_mut().entry(key).or_default().clone()
    }

    pub(crate) fn pad_bounds_for(&self, key: PadKey) -> Option<Bounds<Pixels>> {
        self.pads.borrow().get(&key).and_then(|cell| cell.get())
    }

    pub(crate) fn grade_open(&self, target: GradeTarget) -> &CollapsibleState {
        &self.grade_adjust[usize::from(target == GradeTarget::Camera)]
    }

    pub(crate) fn set_grade_open(&self, target: GradeTarget, open: bool) {
        self.grade_adjust[usize::from(target == GradeTarget::Camera)].set_open(open);
    }

    /// A panel section's reveal state, created closed on first sight. Panel
    /// state is per-panel and transient -- `createSignal(false)` inside the
    /// component -- so it lives in a map rather than in named fields.
    pub(crate) fn section(&self, key: PanelSection) -> std::rc::Rc<CollapsibleState> {
        self.panel_sections
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| std::rc::Rc::new(CollapsibleState::new(false)))
            .clone()
    }
}

/// Every `PositionPad` the sidebar can draw. The scene panel has two per
/// segment and the multi-zoom panel one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PadKey {
    SceneScreen(usize),
    SceneCamera(usize),
    ZoomManual(usize),
    ZoomMulti,
}

/// The collapsible sections a segment panel owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelSection {
    Camera3DCamera,
    Camera3DBlur,
    Camera3DAdvanced,
    ZoomHelper,
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `sidebarSelection()` (`:577-580`): the timeline selection, **excluding
    /// clip** -- selecting a clip is a timeline-only affordance (highlight,
    /// Delete, multi-select) and must not swap the sidebar away from its tab.
    pub fn sidebar_selection(&self) -> Option<&crate::editor_edits::Selection> {
        self.selection
            .as_ref()
            .filter(|selection| selection.track != TrackKind::Clip)
    }

    /// The tab rail's click: clear any selection, then switch tab and put the
    /// scroll body back to the top (`:632-650`).
    fn select_sidebar_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = SidebarTab::ALL.get(index).copied() else {
            return;
        };
        if self.sidebar_selection().is_some() {
            self.set_selection(None, cx);
        }
        // A tab switch also dismisses whatever the previous tab had open: the
        // `KSelect` menu, and a field's history bracket.
        self.sidebar.menu = None;
        self.end_field_edit(cx);
        self.sidebar.tab = tab;
        self.sidebar.scroll.set_offset(gpui::point(px(0.), px(0.)));
        cx.notify();
        window.refresh();
    }

    /// Re-sync the source tab after a write that did not come from the tab row
    /// itself -- an undo, or the padding slider's white-canvas side effect.
    /// `createEffect(on(projectBackgroundSourceTab, ...))` with its
    /// "only when the user isn't sitting on None" guard (`:1807-1811`).
    pub(crate) fn sync_background_source_tab(&mut self) {
        if self.sidebar.source_tab != SourceTab::None {
            self.sidebar.source_tab = source_tab_for(&self.project.background.source);
        }
    }

    /// One background write, through the shared fan-out. `change` returns
    /// whether anything actually moved, so a no-op slider tick records no
    /// history entry and schedules no save.
    fn edit_background(
        &mut self,
        reason: &'static str,
        change: impl FnOnce(&mut ProjectConfiguration) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // An edit that is not the open colour panel's closes its bracket
        // first: the panel is a system window and stays up while the user
        // does other things, and an unrelated change must not be swallowed
        // into the colour's undo entry.
        if reason != "color" {
            self.end_color_history();
        }
        if !change(&mut self.project) {
            return;
        }
        self.project_changed(window, cx);
        self.note_sidebar_edit(reason);
    }

    /// One project write, through the shared fan-out, for every control
    /// outside the background tab. `change` returns whether anything actually
    /// moved, so a no-op slider tick records no history entry and schedules no
    /// save -- the same contract [`Self::edit_background`] has.
    pub(crate) fn edit_project(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut ProjectConfiguration) -> bool,
    ) {
        self.end_color_history();
        if !change(&mut self.project) {
            return;
        }
        self.project_changed(window, cx);
        self.note_project_edit(reason);
    }

    /// The same line `note_sidebar_edit` writes for the background tab, for
    /// the rest of the sidebar: one `info` record per committed edit so a
    /// scripted click's predicted value is checkable against what the running
    /// app resolved rather than against a screenshot.
    pub(crate) fn note_project_edit(&self, reason: &'static str) {
        let project = &self.project;
        tracing::info!(
            reason,
            camera = format!(
                "hide={} mirror={} shape={:?} size={:.4} rounding={:.4} shadow={:.4}",
                project.camera.hide,
                project.camera.mirror,
                project.camera.shape,
                project.camera.size,
                project.camera.rounding,
                project.camera.shadow
            ),
            audio = format!(
                "mute={} mic={:.4} system={:.4}",
                project.audio.mute, project.audio.mic_volume_db, project.audio.system_volume_db
            ),
            cursor = format!(
                "hide={} size={} style={:?} raw={}",
                project.cursor.hide,
                project.cursor.size,
                project.cursor.animation_style,
                project.cursor.raw
            ),
            grade_screen = format!("{:?}", project.color_correction.screen),
            grade_camera = format!("{:?}", project.color_correction.camera),
            selection = ?self.selection.as_ref().map(|s| (s.track, s.indices.clone())),
            undo = self.history.can_undo(),
            "sidebar edit"
        );
    }

    /// One line per committed sidebar edit, at `info`, for the same reason
    /// `note_edit` exists on the timeline side: a scripted drag's predicted
    /// value is only checkable if the number comes out of the running app.
    fn note_sidebar_edit(&self, reason: &'static str) {
        let background = &self.project.background;
        tracing::info!(
            reason,
            source = ?background.source,
            blur = format!("{:.4}", background.blur),
            padding = format!("{:.4}", background.padding),
            rounding = format!("{:.4}", background.rounding),
            shadow = format!("{:.4}", background.shadow),
            motion_blur = format!("{:.4}", self.project.screen_motion_blur),
            border = ?background.border,
            notch = ?background.notch,
            undo = self.history.can_undo(),
            "sidebar edit"
        );
    }

    /// `editorInstance.notchBase` (`lib.rs:3121-3125`): the recording's own
    /// measurements, or a 14" MacBook Pro's.
    fn notch_base(&self) -> DisplayNotch {
        self.instance
            .as_ref()
            .and_then(|instance| instance.render_constants.meta.display_notch())
            .unwrap_or(cap_project::DEFAULT_MACBOOK_NOTCH)
    }

    fn notch_value(&self, slider: BgSlider) -> f64 {
        let base = self.notch_base();
        let notch = self.project.background.notch.as_ref();
        match slider {
            BgSlider::NotchWidth => notch.and_then(|n| n.width).unwrap_or(base.width),
            BgSlider::NotchHeight => notch.and_then(|n| n.height).unwrap_or(base.height),
            BgSlider::NotchX => {
                let width = notch.and_then(|n| n.width).unwrap_or(base.width);
                notch
                    .and_then(|n| n.x)
                    .unwrap_or(base.x)
                    .min(notch_x_max(width))
            }
            _ => 0.,
        }
    }

    /// The range for any slider in the sidebar. Every arm is its own call
    /// site's `minValue` / `maxValue` / `step`.
    pub(crate) fn slider_limits(&self, slider: SliderKey) -> (f32, f32, f32) {
        match slider {
            SliderKey::Bg(slider) => self.bg_slider_limits(slider),
            SliderKey::Grade(_, slider) => slider.limits(),
            SliderKey::Camera(slider) => slider.limits(),
            SliderKey::Audio(slider) => slider.limits(),
            SliderKey::Cursor(slider) => slider.limits(),
            SliderKey::Caption(slider) => slider.limits(),
            SliderKey::Keyboard(slider) => slider.limits(),
            SliderKey::Panel(slider, index) => self.panel_slider_limits(slider, index),
        }
    }

    pub(crate) fn slider_value(&self, slider: SliderKey) -> f32 {
        match slider {
            SliderKey::Bg(slider) => self.bg_slider_value(slider),
            // Every grade slider is `Math.round(value * 100)` in the UI and
            // `v / 100` back into the config (`ColorCorrectionSection.tsx:181`).
            SliderKey::Grade(target, slider) => (slider.read(self.grade(target)) * 100.).round(),
            SliderKey::Camera(slider) => slider.read(&self.project),
            SliderKey::Audio(slider) => slider.read(&self.project),
            SliderKey::Cursor(slider) => slider.read(&self.project),
            SliderKey::Caption(slider) => slider.read(&self.project),
            SliderKey::Keyboard(slider) => slider.read(&self.project),
            SliderKey::Panel(slider, index) => self.panel_slider_value(slider, index),
        }
    }

    /// The one place a slider's value reaches the project.
    fn apply_slider(
        &mut self,
        slider: SliderKey,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match slider {
            SliderKey::Bg(slider) => self.apply_bg_slider(slider, value, window, cx),
            SliderKey::Grade(target, slider) => {
                self.set_grade_value(target, slider, value / 100., window, cx)
            }
            SliderKey::Camera(slider) => self.apply_camera_slider(slider, value, window, cx),
            SliderKey::Audio(slider) => self.apply_audio_slider(slider, value, window, cx),
            SliderKey::Cursor(slider) => self.apply_cursor_slider(slider, value, window, cx),
            SliderKey::Caption(slider) => self.apply_caption_slider(slider, value, window, cx),
            SliderKey::Keyboard(slider) => self.apply_keyboard_slider(slider, value, window, cx),
            SliderKey::Panel(slider, index) => {
                self.apply_panel_slider(slider, index, value, window, cx)
            }
        }
    }

    fn bg_slider_limits(&self, slider: BgSlider) -> (f32, f32, f32) {
        let (min, max, step) = slider.limits();
        if slider == BgSlider::NotchX {
            let width = self
                .project
                .background
                .notch
                .as_ref()
                .and_then(|n| n.width)
                .unwrap_or(self.notch_base().width);
            return (min, notch_x_max(width) as f32, step);
        }
        (min, max, step)
    }

    fn bg_slider_value(&self, slider: BgSlider) -> f32 {
        let background = &self.project.background;
        match slider {
            BgSlider::Blur => background.blur as f32,
            BgSlider::Padding => background.padding as f32,
            BgSlider::Rounding => background.rounding as f32,
            BgSlider::MotionBlur => self.project.screen_motion_blur,
            BgSlider::BorderWidth => background
                .border
                .as_ref()
                .map_or(UI_BORDER_FALLBACK.width, |b| b.width),
            BgSlider::BorderOpacity => background
                .border
                .as_ref()
                .map_or(UI_BORDER_FALLBACK.opacity, |b| b.opacity),
            BgSlider::NotchWidth | BgSlider::NotchHeight | BgSlider::NotchX => {
                self.notch_value(slider) as f32
            }
            BgSlider::Shadow => background.shadow,
            BgSlider::ShadowSize => background
                .advanced_shadow
                .as_ref()
                .map_or(UI_SHADOW_FALLBACK.size, |s| s.size),
            BgSlider::ShadowOpacity => background
                .advanced_shadow
                .as_ref()
                .map_or(UI_SHADOW_FALLBACK.opacity, |s| s.opacity),
            BgSlider::ShadowBlur => background
                .advanced_shadow
                .as_ref()
                .map_or(UI_SHADOW_FALLBACK.blur, |s| s.blur),
            BgSlider::GradientAngle => match &background.source {
                BackgroundSource::Gradient { angle, .. } => f32::from(*angle),
                _ => 90.,
            },
            BgSlider::GradientNoise => match &background.source {
                BackgroundSource::Gradient {
                    noise_intensity, ..
                } => noise_intensity.unwrap_or(0.),
                _ => 0.,
            },
            BgSlider::GradientGrain => match &background.source {
                BackgroundSource::Gradient { noise_scale, .. } => {
                    noise_scale.unwrap_or(DEFAULT_NOISE_SCALE)
                }
                _ => DEFAULT_NOISE_SCALE,
            },
        }
    }

    /// The background tab's own arms -- each one the call site's `onChange`
    /// verbatim, side effects included.
    fn apply_bg_slider(
        &mut self,
        slider: BgSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let base = self.notch_base();
        self.edit_background(
            "slider",
            |project| {
                let background = &mut project.background;
                match slider {
                    BgSlider::Blur => background.blur = f64::from(value),
                    // `setBackgroundDimension` (`:1900-1915`): revealing
                    // padding or rounding out of "None" shows a clean white
                    // canvas rather than resurrecting the hidden source.
                    BgSlider::Padding | BgSlider::Rounding => {
                        let was_none = background.padding == 0. && background.rounding == 0.;
                        if value > 0. && was_none {
                            background.source = BackgroundSource::Color {
                                value: [255, 255, 255],
                                alpha: 255,
                            };
                        }
                        if slider == BgSlider::Padding {
                            background.padding = f64::from(value);
                        } else {
                            background.rounding = f64::from(value);
                        }
                    }
                    // `:2695-2701` -- one batch, both keys.
                    BgSlider::MotionBlur => {
                        project.cursor.motion_blur = value;
                        project.screen_motion_blur = value;
                    }
                    BgSlider::BorderWidth => {
                        let mut border = background.border.clone().unwrap_or(UI_BORDER_FALLBACK);
                        border.width = value;
                        background.border = Some(border);
                    }
                    BgSlider::BorderOpacity => {
                        let mut border = background.border.clone().unwrap_or(UI_BORDER_FALLBACK);
                        border.opacity = value;
                        background.border = Some(border);
                    }
                    BgSlider::NotchWidth | BgSlider::NotchHeight | BgSlider::NotchX => {
                        let previous = background.notch.unwrap_or(UNPLACED_NOTCH);
                        let mut next = previous;
                        next.enabled = true;
                        match slider {
                            BgSlider::NotchX => {
                                let width = previous.width.unwrap_or(base.width);
                                next.x = Some(f64::from(value).min(notch_x_max(width)));
                            }
                            BgSlider::NotchHeight => next.height = Some(f64::from(value)),
                            _ => {
                                next.width = Some(f64::from(value));
                                // Resize about the centre rather than dragging
                                // the left edge along with the width
                                // (`:2873-2882`).
                                let centre = previous.x.unwrap_or(base.x)
                                    + previous.width.unwrap_or(base.width) / 2.;
                                let value = f64::from(value);
                                next.x = Some((centre - value / 2.).max(0.).min(1. - value));
                            }
                        }
                        background.notch = Some(next);
                    }
                    // `:2900-2911` -- raising the shadow above zero seeds the
                    // advanced settings if they do not exist yet.
                    BgSlider::Shadow => {
                        background.shadow = value;
                        if value > 0. && background.advanced_shadow.is_none() {
                            background.advanced_shadow = Some(UI_SHADOW_FALLBACK);
                        }
                    }
                    BgSlider::ShadowSize | BgSlider::ShadowOpacity | BgSlider::ShadowBlur => {
                        let mut shadow = background
                            .advanced_shadow
                            .clone()
                            .unwrap_or(UI_SHADOW_FALLBACK);
                        match slider {
                            BgSlider::ShadowSize => shadow.size = value,
                            BgSlider::ShadowOpacity => shadow.opacity = value,
                            _ => shadow.blur = value,
                        }
                        background.advanced_shadow = Some(shadow);
                    }
                    BgSlider::GradientAngle | BgSlider::GradientNoise | BgSlider::GradientGrain => {
                        let BackgroundSource::Gradient {
                            angle,
                            noise_intensity,
                            noise_scale,
                            ..
                        } = &mut background.source
                        else {
                            return false;
                        };
                        match slider {
                            BgSlider::GradientAngle => *angle = value.round() as u16,
                            BgSlider::GradientNoise => *noise_intensity = Some(value),
                            _ => *noise_scale = Some(value),
                        }
                    }
                }
                true
            },
            window,
            cx,
        );
    }

    /// A press on a slider: take the history pause, then apply the value the
    /// press itself landed on -- Kobalte's track jumps the thumb to the
    /// pointer on mousedown.
    fn slider_mouse_down(
        &mut self,
        slider: SliderKey,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let history = &mut self.history;
        self.sidebar.slider_drag.begin(slider, || history.pause());
        self.slider_mouse_move(event.position, window, cx);
    }

    fn slider_mouse_move(
        &mut self,
        position: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(slider) = self.sidebar.slider_drag.active() else {
            return;
        };
        let Some(bounds) = self.sidebar.track_bounds(slider) else {
            return;
        };
        let (min, max, step) = self.slider_limits(slider);
        let Some(fraction) = ui::fraction_from_x(position.x, bounds) else {
            return;
        };
        let value = ui::snap_to_step(ui::value_from_fraction(fraction, min, max), min, max, step);
        if (value - self.slider_value(slider)).abs() < f32::EPSILON {
            return;
        }
        self.apply_slider(slider, value, window, cx);
    }

    /// The release closes the undo bracket: everything the drag wrote becomes
    /// one entry.
    pub(crate) fn sidebar_mouse_up(&mut self, cx: &mut Context<Self>) {
        if !self.sidebar.slider_drag.is_active() {
            return;
        }
        let config = self.project.clone();
        let history = &mut self.history;
        self.sidebar.slider_drag.end(|| history.resume(&config));
        self.note_sidebar_edit("slider-end");
        cx.notify();
    }

    /// Whether the window has to paint the slider drag layer this frame.
    pub(crate) fn sidebar_dragging(&self) -> bool {
        self.sidebar.slider_drag.is_active()
    }

    pub(crate) fn sidebar_drag_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.slider_mouse_move(event.position, window, cx);
    }
}

// ---------------------------------------------------------------------------
// Colour panel
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// Open the in-app colour picker popover on `target`, anchored at the
    /// clicked swatch.
    ///
    /// The Solid app's `<input type="color">` opens the OS panel; this build
    /// replaces that seam with [`crate::ui::ColorPicker`] so every platform
    /// gets the same picker, parked at the swatch rather than wherever the OS
    /// left its panel. The undo contract is unchanged: the first change takes
    /// `history.pause()` and dismissing the popover resumes it, so a whole
    /// picking session is **one** undo entry, exactly as a slider drag is.
    pub(crate) fn open_color_panel_for(
        &mut self,
        target: ColorTarget,
        anchor: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A second click on the swatch whose popover is already up closes it.
        if self.sidebar.color_target == Some(target) && self.sidebar.color_picker.is_some() {
            self.close_color_picker(cx);
            return;
        }
        // A second swatch clicked while a popover is up replaces it; close
        // the previous bracket first or its pause is never matched.
        self.end_color_history();

        let initial = self.color_for(target).unwrap_or([0, 0, 0]);
        let rgb = [
            initial[0].min(255) as u8,
            initial[1].min(255) as u8,
            initial[2].min(255) as u8,
        ];
        self.sidebar.color_target = Some(target);
        self.sidebar.color_picker = Some(crate::ui::ColorPickerSnapshot::place(
            anchor,
            window.viewport_size(),
            rgb,
        ));
        self.sidebar.color_drag = None;
        self.sync_picker_hex(window, cx);
        cx.notify();
    }

    /// Dismiss the popover: close the undo bracket and drop its state.
    pub(crate) fn close_color_picker(&mut self, cx: &mut Context<Self>) {
        self.end_color_history();
        self.sidebar.color_target = None;
        self.sidebar.color_picker = None;
        self.sidebar.color_drag = None;
        cx.notify();
    }

    /// Write the picker's current colour through to the project, bracketing
    /// the whole popover session as one undo entry.
    pub(crate) fn apply_picker_color(
        &mut self,
        hue: f32,
        sat: f32,
        val: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = self.sidebar.color_target else {
            return;
        };
        if let Some(picker) = self.sidebar.color_picker.as_mut() {
            picker.hue = hue;
            picker.sat = sat;
            picker.val = val;
        }
        if !self.sidebar.color_paused {
            self.history.pause();
            self.sidebar.color_paused = true;
        }
        let rgb = crate::ui::hsv_to_rgb(hue, sat, val);
        self.set_color(
            target,
            [u16::from(rgb[0]), u16::from(rgb[1]), u16::from(rgb[2])],
            window,
            cx,
        );
        cx.notify();
    }

    /// A pointer position on the picker's field or hue rail, from the press
    /// itself or from the window-wide drag layer.
    pub(crate) fn picker_pointer(
        &mut self,
        position: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = self.sidebar.color_picker else {
            return;
        };
        match self.sidebar.color_drag {
            Some(ColorPickerDrag::Field) => {
                let (sat, val) = crate::ui::sv_from_point(picker.origin, position);
                self.apply_picker_color(picker.hue, sat, val, window, cx);
            }
            Some(ColorPickerDrag::Hue) => {
                let hue = crate::ui::hue_from_point(picker.origin, position);
                self.apply_picker_color(hue, picker.sat, picker.val, window, cx);
            }
            None => {}
        }
    }

    /// Re-derive the popover's hex field from the picker colour -- the same
    /// `createWritableMemo` contract as `sync_hex_inputs`, and skipped while
    /// the field is being typed in.
    pub(crate) fn sync_picker_hex(&mut self, window: &Window, cx: &mut Context<Self>) {
        let Some(picker) = self.sidebar.color_picker else {
            return;
        };
        let input = self.picker_hex.clone();
        if input.read(cx).focus_handle().is_focused(window) {
            return;
        }
        let hex = rgb_to_hex({
            let rgb = picker.rgb();
            [u16::from(rgb[0]), u16::from(rgb[1]), u16::from(rgb[2])]
        });
        if input.read(cx).text() != hex {
            input.update(cx, |input, cx| input.set_text(hex, cx));
        }
    }

    /// Close the colour picker's undo bracket, if it is holding one. Every
    /// dismissal goes through here, and so does a second popover opening on
    /// top of the first.
    fn end_color_history(&mut self) {
        if !std::mem::take(&mut self.sidebar.color_paused) {
            return;
        }
        let config = self.project.clone();
        self.history.resume(&config);
        self.note_sidebar_edit("color-panel");
    }

    pub(crate) fn color_for(&self, target: ColorTarget) -> Option<Color> {
        match target {
            ColorTarget::BackgroundColor => match &self.project.background.source {
                BackgroundSource::Color { value, .. } => Some(*value),
                _ => None,
            },
            ColorTarget::GradientFrom => match &self.project.background.source {
                BackgroundSource::Gradient { from, .. } => Some(*from),
                _ => None,
            },
            ColorTarget::GradientTo => match &self.project.background.source {
                BackgroundSource::Gradient { to, .. } => Some(*to),
                _ => None,
            },
            ColorTarget::BorderColor => Some(
                self.project
                    .background
                    .border
                    .as_ref()
                    .map_or(UI_BORDER_FALLBACK.color, |border| border.color),
            ),
            _ => self.hex_string_for(target).and_then(|hex| {
                hex_to_rgb(&hex).map(|rgba| [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16])
            }),
        }
    }

    /// The stored string for a `HexColorInput` target.
    pub(crate) fn hex_string_for(&self, target: ColorTarget) -> Option<String> {
        let captions = crate::editor_tabs::caption_settings(&self.project);
        let keyboard = crate::editor_tabs::keyboard_settings(&self.project);
        match target {
            ColorTarget::CaptionColor => Some(captions.color),
            ColorTarget::CaptionBackground => Some(captions.background_color),
            ColorTarget::CaptionHighlight => Some(captions.highlight_color),
            ColorTarget::KeyboardColor => Some(keyboard.color),
            ColorTarget::KeyboardBackground => Some(keyboard.background_color),
            ColorTarget::TextColor(index) => self
                .project
                .timeline
                .as_ref()
                .and_then(|timeline| timeline.text_segments.get(index))
                .map(|segment| segment.color.clone()),
            _ => None,
        }
    }

    pub(crate) fn set_color(
        &mut self,
        target: ColorTarget,
        color: Color,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if target.is_hex_string() {
            return self.set_hex_color(target, color, window, cx);
        }
        self.edit_background(
            "color",
            |project| {
                let background = &mut project.background;
                match target {
                    ColorTarget::BackgroundColor => {
                        let alpha = match &background.source {
                            BackgroundSource::Color { alpha, .. } => *alpha,
                            _ => 255,
                        };
                        background.source = BackgroundSource::Color {
                            value: color,
                            alpha,
                        };
                    }
                    ColorTarget::GradientFrom | ColorTarget::GradientTo => {
                        let BackgroundSource::Gradient { from, to, .. } = &mut background.source
                        else {
                            return false;
                        };
                        if target == ColorTarget::GradientFrom {
                            *from = color;
                        } else {
                            *to = color;
                        }
                    }
                    ColorTarget::BorderColor => {
                        let mut border = background.border.clone().unwrap_or(UI_BORDER_FALLBACK);
                        border.color = color;
                        background.border = Some(border);
                    }
                    _ => unreachable!("hex-string targets go through set_hex_color"),
                }
                true
            },
            window,
            cx,
        );
    }

    /// The hex-string half of [`Self::set_color`]. Kept separate because these
    /// targets do not live under `background`, so they take the general
    /// project fan-out rather than `edit_background`.
    pub(crate) fn set_hex_color(
        &mut self,
        target: ColorTarget,
        color: Color,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let hex = rgb_to_hex(color);
        match target {
            ColorTarget::CaptionColor => {
                self.set_caption_setting("caption-color", window, cx, move |s| s.color = hex)
            }
            ColorTarget::CaptionBackground => {
                self.set_caption_setting("caption-background-color", window, cx, move |s| {
                    s.background_color = hex
                })
            }
            ColorTarget::CaptionHighlight => {
                self.set_caption_setting("caption-highlight-color", window, cx, move |s| {
                    s.highlight_color = hex
                })
            }
            ColorTarget::KeyboardColor => {
                self.set_keyboard_setting("keyboard-color", window, cx, move |s| s.color = hex)
            }
            ColorTarget::KeyboardBackground => {
                self.set_keyboard_setting("keyboard-background-color", window, cx, move |s| {
                    s.background_color = hex
                })
            }
            ColorTarget::TextColor(index) => {
                self.edit_text_segment("text-color", index, window, cx, move |segment| {
                    if segment.color == hex {
                        return false;
                    }
                    segment.color = hex;
                    true
                })
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Files: wallpapers, images, the desktop picture
// ---------------------------------------------------------------------------

/// Decode an image for a thumbnail slot, at most `max` pixels on its longest
/// side. The same rule as `library::decode_thumbnail`: the atlas would
/// otherwise hold a multi-megapixel original per tile.
fn decode_scaled_rgba(path: &Path, max: u32) -> Option<image::RgbaImage> {
    let bytes = std::fs::read(path).ok()?;
    let format = image::guess_format(&bytes).ok()?;
    let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
    let (width, height) = (decoded.width().max(1), decoded.height().max(1));
    let scale = (max as f32 / width.max(height) as f32).min(1.);
    let target_width = ((width as f32 * scale).round() as u32).max(1);
    let target_height = ((height as f32 * scale).round() as u32).max(1);
    // Same split as `library::decode_thumbnail`: box sampling for the big
    // ratios (a 4000px wallpaper down to a 128px tile), Triangle where the
    // sizes are close enough that box would alias.
    Some(if scale <= 0.5 {
        decoded
            .thumbnail_exact(target_width, target_height)
            .into_rgba8()
    } else if scale < 1. {
        decoded
            .resize_exact(
                target_width,
                target_height,
                image::imageops::FilterType::Triangle,
            )
            .into_rgba8()
    } else {
        decoded.into_rgba8()
    })
}

/// [`decode_scaled_rgba`] in gpui's BGRA order.
fn decode_scaled(path: &Path, max: u32) -> Option<Arc<RenderImage>> {
    decode_scaled_rgba(path, max).map(library::rgba_to_render_image)
}

/// The `size-16` wallpaper tile (`:2007`), at 2x.
const WALLPAPER_TILE_MAX: u32 = 128;

/// One wallpaper tile, through the persistent cache. The bundled assets are
/// immutable in practice, so after the first-ever run every theme switch is
/// eighteen ~3KB JPEG reads instead of eighteen 4000x2500 decodes; the mtime
/// in the key still invalidates if an app update ever replaces them.
fn decode_wallpaper_thumbnail(id: &str) -> Option<Arc<RenderImage>> {
    let path = wallpaper_path(id)?;
    // Ids are catalogue paths ("macOS/tahoe-dusk-min"); flattened so the key
    // stays a file name rather than a subdirectory.
    let slot = library::CacheSlot::keyed(
        &path,
        format!(
            "wallpaper-{}-{WALLPAPER_TILE_MAX}",
            id.replace(['/', '\\'], "-")
        ),
    );
    if let Some(slot) = &slot
        && let Some(image) = slot.load()
    {
        return Some(image);
    }
    let rgba = decode_scaled_rgba(&path, WALLPAPER_TILE_MAX)?;
    if let Some(slot) = &slot {
        slot.store(&rgba);
    }
    Some(library::rgba_to_render_image(rgba))
}

/// `write_desktop_background_snapshot` (`recording.rs:437-522`): `sips` first,
/// the `image` crate as the fallback, capping the longest side at 2560 and
/// re-encoding to JPEG at quality 82. The `sips` path matters -- macOS ships
/// HEIC wallpapers the `image` crate cannot decode.
fn write_desktop_background_snapshot(source: &Path, output: &Path) -> Result<(), String> {
    let needs_downscale = image::image_dimensions(source).is_ok_and(|(width, height)| {
        width > DESKTOP_BACKGROUND_MAX_DIMENSION || height > DESKTOP_BACKGROUND_MAX_DIMENSION
    });

    let mut command = std::process::Command::new("sips");
    command
        .arg("-s")
        .arg("format")
        .arg("jpeg")
        .arg("-s")
        .arg("formatOptions")
        .arg(DESKTOP_BACKGROUND_JPEG_QUALITY.to_string());
    if needs_downscale {
        command
            .arg("-Z")
            .arg(DESKTOP_BACKGROUND_MAX_DIMENSION.to_string());
    }
    if let Ok(output_status) = command.arg(source).arg("--out").arg(output).output()
        && output_status.status.success()
    {
        return Ok(());
    }

    let decoded =
        image::open(source).map_err(|err| format!("failed to decode desktop background: {err}"))?;
    let decoded = if decoded.width() > DESKTOP_BACKGROUND_MAX_DIMENSION
        || decoded.height() > DESKTOP_BACKGROUND_MAX_DIMENSION
    {
        decoded.resize(
            DESKTOP_BACKGROUND_MAX_DIMENSION,
            DESKTOP_BACKGROUND_MAX_DIMENSION,
            image::imageops::FilterType::Triangle,
        )
    } else {
        decoded
    };
    decoded
        .to_rgb8()
        .save_with_format(output, image::ImageFormat::Jpeg)
        .map_err(|err| format!("failed to save desktop background: {err}"))
}

/// `import_current_desktop_background` (`recording.rs:181-224`).
fn import_desktop_background(project_path: &Path) -> Result<PathBuf, String> {
    let source = crate::platform::desktop_picture_path()
        .ok_or_else(|| "Current desktop background path not found".to_string())?;
    if !source.exists() {
        return Err(format!(
            "Current desktop background does not exist: {}",
            source.display()
        ));
    }

    let assets = project_path.join("assets");
    std::fs::create_dir_all(&assets)
        .map_err(|err| format!("failed to create background assets directory: {err}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let name = format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-{timestamp}.jpg");
    let output = assets.join(&name);
    let pending = assets.join(format!(
        "{CURRENT_DESKTOP_BACKGROUND_BASENAME}-{timestamp}.pending.jpg"
    ));

    let _ = std::fs::remove_file(&pending);
    if let Err(error) = write_desktop_background_snapshot(&source, &pending) {
        let _ = std::fs::remove_file(&pending);
        return Err(error);
    }
    let _ = std::fs::remove_file(&output);
    std::fs::rename(&pending, &output)
        .map_err(|err| format!("failed to store current desktop background: {err}"))?;

    // `remove_imported_desktop_background_snapshots` (`recording.rs:210-224`).
    if let Ok(entries) = std::fs::read_dir(&assets) {
        let prefix = format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-");
        for entry in entries.flatten() {
            if let Some(entry_name) = entry.file_name().to_str()
                && entry_name != name
                && entry_name.starts_with(&prefix)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Ok(output)
}

/// `findStoredCurrentDesktopBackgroundPath` (`:1849-1874`): the newest
/// `current-desktop-background-<ts>.*` in the bundle's assets dir, ignoring the
/// `.pending.` ones, then the un-timestamped legacy names.
fn stored_desktop_background(project_path: &Path) -> Option<PathBuf> {
    let assets = project_path.join("assets");
    let prefix = format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-");
    let mut newest: Option<(u128, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&assets) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || name.contains(".pending.")
                || !name.starts_with(&prefix)
            {
                continue;
            }
            let timestamp = name
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .and_then(|stem| stem.rsplit_once('-'))
                .and_then(|(_, digits)| digits.parse::<u128>().ok())
                .unwrap_or(0);
            if newest.as_ref().is_none_or(|(best, _)| timestamp > *best) {
                newest = Some((timestamp, entry.path()));
            }
        }
    }
    if let Some((_, path)) = newest {
        return Some(path);
    }
    BACKGROUND_IMAGE_EXTENSIONS
        .iter()
        .map(|extension| assets.join(format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}.{extension}")))
        .find(|path| path.exists())
}

impl EditorWindow {
    /// The sidebar's own `onMount` (`:1917-1973`): find the bundle's stored
    /// desktop-background snapshot, so the Desktop tile has something to show.
    pub(crate) fn sidebar_loaded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.project_path.clone();
        cx.spawn_in(window, async move |this, cx| {
            let stored = cx
                .background_executor()
                .spawn(async move { stored_desktop_background(&path) })
                .await;
            this.update(cx, |this, cx| {
                this.sidebar.desktop_background = stored;
                cx.notify();
            })
            .ok();
        })
        .detach();
        self.ensure_wallpapers(window, cx);
        self.ensure_preview(window, cx);
    }

    /// Decode the current theme's thumbnails, once. Runs on the background
    /// executor and lands through `notify`, never on the render path -- 18
    /// multi-megapixel JPEGs would otherwise be decoded inside a paint. The
    /// decodes fan out through `library::spawn_decode_pool` (cache hits are
    /// near-free, and a cold theme batch takes one image's latency instead of
    /// eighteen), landing in batches of whatever has finished per notify.
    fn ensure_wallpapers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let theme = BACKGROUND_THEMES[self.sidebar.wallpaper_theme].0;
        let wanted: Vec<&'static str> = wallpapers_for_theme(theme)
            .into_iter()
            .filter(|id| !self.sidebar.wallpapers.contains_key(id))
            .collect();
        if wanted.is_empty() {
            return;
        }
        self.sidebar.wallpaper_task = Some(cx.spawn_in(window, async move |this, cx| {
            let (_decodes, results) =
                library::spawn_decode_pool(cx.background_executor(), wanted, |id| {
                    decode_wallpaper_thumbnail(id).map(|image| (id, image))
                });
            while let Ok(first) = results.recv_async().await {
                let mut batch = vec![first];
                batch.extend(results.try_iter());
                if this
                    .update(cx, |this, cx| {
                        for (id, image) in batch {
                            this.sidebar.wallpapers.insert(id, image);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
    }

    /// The `h-48` preview the image and desktop panes show, decoded off the
    /// selected path.
    fn ensure_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.preview_path() else {
            self.sidebar.preview = None;
            return;
        };
        if self
            .sidebar
            .preview
            .as_ref()
            .is_some_and(|(current, _)| *current == path)
        {
            return;
        }
        let target = path.clone();
        self.sidebar.preview_task = Some(cx.spawn_in(window, async move |this, cx| {
            let decoded = {
                let target = target.clone();
                cx.background_executor()
                    .spawn(async move { decode_scaled(&target, 768) })
                    .await
            };
            let Some(image) = decoded else { return };
            this.update(cx, |this, cx| {
                this.sidebar.preview = Some((target, image));
                cx.notify();
            })
            .ok();
        }));
    }

    /// Which file the big preview should be showing: the chosen image on the
    /// image tab, the imported desktop picture on the desktop tab.
    fn preview_path(&self) -> Option<PathBuf> {
        match self.sidebar.source_tab {
            SourceTab::Image => match &self.project.background.source {
                BackgroundSource::Image { path } => path.as_ref().map(PathBuf::from),
                _ => None,
            },
            SourceTab::Desktop => self.sidebar.desktop_background.clone(),
            _ => None,
        }
    }

    /// `setWallpaperSource` (`:2012-2021`) -- one history entry, because the
    /// source's own `pause()`/`resume()` bracket the batch.
    fn set_wallpaper_source(&mut self, path: String, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_background(
            "wallpaper",
            |project| {
                project.background.source = BackgroundSource::Wallpaper { path: Some(path) };
                true
            },
            window,
            cx,
        );
        self.ensure_preview(window, cx);
    }

    /// `ensureBackgroundPresentation` (`:1891-1898`): leaving "None" seeds
    /// default padding *and* rounding; a real-to-real switch only ensures
    /// padding, so an intentionally-square background keeps rounding at 0.
    fn ensure_background_presentation(&mut self, from_none: bool) -> bool {
        let mut changed = false;
        let background = &mut self.project.background;
        if background.padding == 0. {
            background.padding = DEFAULT_BACKGROUND_PADDING;
            changed = true;
        }
        if from_none && background.rounding == 0. {
            background.rounding = DEFAULT_BACKGROUND_ROUNDING;
            changed = true;
        }
        changed
    }

    /// The source-tab row's `onChange` (`:2189-2263`), verbatim.
    fn select_source_tab(&mut self, tab: SourceTab, window: &mut Window, cx: &mut Context<Self>) {
        let from_none = self.sidebar.source_tab == SourceTab::None;
        self.sidebar.source_tab = tab;

        if tab == SourceTab::None {
            self.edit_background(
                "source-none",
                |project| {
                    project.background.padding = 0.;
                    project.background.rounding = 0.;
                    true
                },
                window,
                cx,
            );
            self.ensure_preview(window, cx);
            return;
        }

        if tab == SourceTab::Desktop {
            if let Some(path) = self.sidebar.desktop_background.clone() {
                self.ensure_background_presentation(from_none);
                self.set_wallpaper_source(path.to_string_lossy().into_owned(), window, cx);
            }
            self.ensure_preview(window, cx);
            return;
        }

        // Batched with the source write below, exactly as the source's
        // `batch()` around `ensureBackgroundPresentation` + `setProject` is.
        self.ensure_background_presentation(from_none);
        self.edit_background(
            "source",
            |project| {
                let source = &project.background.source;
                project.background.source = match tab {
                    SourceTab::Image => BackgroundSource::Image {
                        path: match source {
                            BackgroundSource::Image { path } => path.clone(),
                            _ => None,
                        },
                    },
                    SourceTab::Color => BackgroundSource::Color {
                        value: match source {
                            BackgroundSource::Color { value, .. } => *value,
                            _ => DEFAULT_GRADIENT_FROM,
                        },
                        alpha: 255,
                    },
                    SourceTab::Gradient => match source {
                        BackgroundSource::Gradient {
                            from, to, angle, ..
                        } => BackgroundSource::Gradient {
                            from: *from,
                            to: *to,
                            angle: *angle,
                            noise_intensity: None,
                            noise_scale: None,
                            animated: None,
                            animation_speed: None,
                        },
                        _ => BackgroundSource::Gradient {
                            from: DEFAULT_GRADIENT_FROM,
                            to: DEFAULT_GRADIENT_TO,
                            angle: 90,
                            noise_intensity: None,
                            noise_scale: None,
                            animated: None,
                            animation_speed: None,
                        },
                    },
                    // `wallpaper`: keep the stored path unless it is the
                    // desktop picture's, which belongs to the other tab.
                    _ => BackgroundSource::Wallpaper {
                        path: match source {
                            BackgroundSource::Wallpaper { path }
                                if !is_current_desktop_background_path(path.as_deref()) =>
                            {
                                path.clone()
                            }
                            _ => None,
                        },
                    },
                };
                true
            },
            window,
            cx,
        );
        self.ensure_wallpapers(window, cx);
        self.ensure_preview(window, cx);
    }

    /// The image pane's picker. `runModal` runs AppKit's own modal loop, so it
    /// goes through a task rather than the click's update, and the chosen file
    /// is copied into the app-data dir as `bg-<ts>-<name>` exactly as the
    /// `<input type="file">` handler does (`:2513-2541`).
    fn pick_background_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar.picking_image {
            return;
        }
        self.sidebar.picking_image = true;
        self.sidebar.picker_task = Some(cx.spawn_in(window, async move |this, cx| {
            let picked = cx
                .update(|_, _| crate::platform::open_image_panel(&BACKGROUND_IMAGE_EXTENSIONS))
                .ok()
                .flatten();

            let stored = match picked {
                Some(source) => {
                    cx.background_executor()
                        .spawn(async move {
                            let extension = source
                                .extension()
                                .and_then(|extension| extension.to_str())
                                .map(str::to_lowercase);
                            if !extension.is_some_and(|extension| {
                                BACKGROUND_IMAGE_EXTENSIONS.contains(&extension.as_str())
                            }) {
                                return Err("Invalid image file type".to_string());
                            }
                            let timestamp = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|elapsed| elapsed.as_millis())
                                .unwrap_or(0);
                            let name = source
                                .file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("image");
                            let destination =
                                crate::store::app_data_dir().join(format!("bg-{timestamp}-{name}"));
                            std::fs::copy(&source, &destination)
                                .map_err(|err| format!("Failed to save image: {err}"))?;
                            Ok(destination)
                        })
                        .await
                }
                None => Err(String::new()),
            };

            this.update_in(cx, |this, window, cx| {
                this.sidebar.picking_image = false;
                match stored {
                    Ok(path) => {
                        this.edit_background(
                            "image",
                            |project| {
                                project.background.source = BackgroundSource::Image {
                                    path: Some(path.to_string_lossy().into_owned()),
                                };
                                true
                            },
                            window,
                            cx,
                        );
                        this.ensure_preview(window, cx);
                    }
                    Err(error) if !error.is_empty() => {
                        tracing::error!("background image import failed: {error}");
                    }
                    Err(_) => {}
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// `importDesktopBackground` (`:2033-2052`).
    fn import_desktop_background(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar.importing_desktop {
            return;
        }
        self.sidebar.importing_desktop = true;
        let project_path = self.project_path.clone();
        let from_none = is_none_background(&self.project);
        cx.spawn_in(window, async move |this, cx| {
            let imported = cx
                .background_executor()
                .spawn(async move { import_desktop_background(&project_path) })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.sidebar.importing_desktop = false;
                match imported {
                    Ok(path) => {
                        this.sidebar.desktop_background = Some(path.clone());
                        this.sidebar.source_tab = SourceTab::Desktop;
                        this.ensure_background_presentation(from_none);
                        this.set_wallpaper_source(path.to_string_lossy().into_owned(), window, cx);
                    }
                    Err(error) => {
                        tracing::error!("couldn't import your desktop wallpaper: {error}");
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// The sidebar card's inner content width: 416 minus its 1px borders minus the
/// panel's `p-4`. Fixed, because the column is `w-104 min-w-104 flex-none`.
const CONTENT_WIDTH: f32 = 416. - 2. - 32.;
/// `grid grid-cols-7 gap-2`.
const WALLPAPER_COLUMNS: f32 = 7.;
const WALLPAPER_GAP: f32 = 8.;
/// The gradient preview: `h-28` over the panel's full content width.
const GRADIENT_PREVIEW_WIDTH: f32 = CONTENT_WIDTH;
const GRADIENT_PREVIEW_HEIGHT: f32 = 112.;

impl EditorWindow {
    pub(crate) fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let summary = self.summary();
        let selection = self.sidebar_selection().cloned();
        let selected_tab = self.sidebar.tab;

        // The two data-driven disabled states (`:602-604`, `:610`).
        let items = SidebarTab::ALL
            .into_iter()
            .map(|tab| {
                let disabled = match tab {
                    SidebarTab::Camera => !summary.is_some_and(|summary| summary.has_camera),
                    SidebarTab::Cursor => !summary.is_some_and(|summary| summary.has_cursor_data),
                    _ => false,
                };
                // While a selection panel is up the rail shows no selected
                // item at all: `KTabs`'s value is forced to `undefined` and
                // the indicator is hidden (`:586-592, 667-677`).
                ui::TabRailItem::new(
                    tab.icon(),
                    selection.is_none() && tab == selected_tab,
                    disabled,
                )
            })
            .collect();

        let rail = ui::TabRail::editor(&theme, "sidebar-tabs", self.panel_bg(), items)
            .height(px(crate::editor_window::SIDEBAR_TAB_BAR_HEIGHT))
            .on_select(cx.listener(|this, index: &usize, window, cx| {
                this.select_sidebar_tab(*index, window, cx);
            }));

        div()
            .ml(px(8.))
            .w(px(crate::editor_window::SIDEBAR_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .flex_none()
            .min_h_0()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .h_full()
                    .overflow_hidden()
                    .rounded(px(12.))
                    .bg(self.panel_bg())
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .child(rail)
                    .child(if self.audio_picker.is_some() {
                        self.render_audio_library(cx)
                    } else if self.camera3d_setup.is_some() {
                        self.render_camera3d_setup(cx)
                    } else {
                        match selection {
                            Some(selection) => self.render_selection_panel(&selection, cx),
                            None => self.render_tab_body(cx),
                        }
                    }),
            )
    }

    /// The scroll region (`:679-692`): `custom-scroll overflow-x-hidden
    /// overflow-y-scroll text-[0.875rem] flex-1 min-h-0`, with the tab panel's
    /// own `flex flex-col gap-6 p-4` inside it.
    fn render_tab_body(&self, cx: &mut Context<Self>) -> AnyElement {
        let content: AnyElement = match self.sidebar.tab {
            SidebarTab::Background => self.render_background_tab(cx).into_any_element(),
            SidebarTab::Camera => self.render_camera_tab(cx),
            SidebarTab::Audio => self.render_audio_tab(cx),
            SidebarTab::Cursor => self.render_cursor_tab(cx),
            SidebarTab::Keyboard => self.render_keyboard_tab(cx),
            SidebarTab::Captions => self.render_captions_tab(cx),
        };

        div()
            .id("sidebar-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_x_hidden()
            .overflow_y_scroll()
            .track_scroll(&self.sidebar.scroll)
            .text_size(px(14.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .p(px(16.))
                    .child(content),
            )
            .into_any_element()
    }

    /// The selection panel region (`:1077-1093`): `custom-scroll p-4 top-16
    /// left-0 right-0 bottom-0 text-[0.875rem] space-y-4`, entering with
    /// `animate-in slide-in-from-bottom-2 fade-in`.
    ///
    /// The routing is E5a's; what lands in it is [`crate::editor_panels`].
    fn render_selection_panel(
        &self,
        selection: &crate::editor_edits::Selection,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_segment_panel(selection, cx)
    }
}

// ---------------------------------------------------------------------------
// The Background tab
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `<KTabs.Content value="background" class="flex flex-col gap-6 p-4">`
    /// (`:2185-2974`).
    fn render_background_tab(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let background = &self.project.background;

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(self.render_source_field(cx))
            .child(
                ui::Field::plain(&theme, "Background Blur")
                    .icon("icons/bg-blur.svg")
                    .child(self.slider(SliderKey::Bg(BgSlider::Blur), "%", cx)),
            )
            // `<div class="w-full border-t border-gray-300 border-dashed" />`
            .child(dashed_divider(Hsla::from(theme.gray_300_legacy)))
            .child(
                ui::Field::plain(&theme, "Padding")
                    .icon("icons/padding.svg")
                    .child(self.slider(SliderKey::Bg(BgSlider::Padding), "%", cx))
                    // The custom screen position row, shown only once the
                    // display has been dragged on the canvas (`:2656-2667`).
                    .children(background.display_position.map(|_| {
                        div()
                            .flex()
                            .flex_row()
                            .justify_between()
                            .items_center()
                            .mt(px(12.))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Custom screen position (dragged on canvas)"),
                            )
                            .child(
                                ui::EditorButton::plain(&theme, "reset-display-position")
                                    .label("Reset")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.edit_background(
                                            "display-position",
                                            |project| {
                                                project.background.display_position = None;
                                                true
                                            },
                                            window,
                                            cx,
                                        );
                                    })),
                            )
                            .into_any_element()
                    })),
            )
            .child(
                ui::Field::plain(&theme, "Rounded Corners")
                    .icon("icons/corners.svg")
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(self.slider(SliderKey::Bg(BgSlider::Rounding), "%", cx))
                            .child(self.render_corner_style(cx)),
                    ),
            )
            .child(
                ui::Field::plain(&theme, "Motion Blur")
                    .icon("icons/wind.svg")
                    .child(self.slider(SliderKey::Bg(BgSlider::MotionBlur), "x100%", cx)),
            )
            .child(self.render_border_field(cx))
            .child(self.render_notch_field(cx))
            .child(self.render_shadow_field(cx))
            // `<ColorCorrectionSection target="screen" />` (`:2962`).
            .child(self.render_color_correction(GradeTarget::Screen, cx))
    }

    // -- Source ------------------------------------------------------------

    fn render_source_field(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let tab = self.sidebar.source_tab;

        let rows = SourceTab::ROWS.map(|row| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .children(
                    row.into_iter()
                        .map(|item| self.render_source_trigger(item, cx).into_any_element()),
                )
                .into_any_element()
        });

        ui::Field::plain(&theme, "Background Image")
            .icon("icons/image.svg")
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children(rows)
                    // `my-5 w-full border-t border-dashed border-gray-5`
                    .child(
                        div()
                            .my(px(20.))
                            .child(dashed_divider(Hsla::from(theme.gray_5))),
                    )
                    .child(match tab {
                        SourceTab::Desktop => self.render_desktop_pane(cx).into_any_element(),
                        SourceTab::Wallpaper => self.render_wallpaper_pane(cx).into_any_element(),
                        SourceTab::Image => self.render_image_pane(cx).into_any_element(),
                        SourceTab::Color => self.render_color_pane(cx).into_any_element(),
                        SourceTab::Gradient => self.render_gradient_pane(cx).into_any_element(),
                        SourceTab::None => div().into_any_element(),
                    }),
            )
    }

    /// `BackgroundSourceTrigger` (`:2116-2130`): `py-2.5 px-2 text-xs
    /// rounded-[10px] border` with a live `size-3.5` preview of what the tile
    /// would select.
    fn render_source_trigger(&self, item: SourceTab, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.sidebar.source_tab == item;

        div()
            .id(SharedString::from(format!("source-{}", item.label())))
            .flex()
            .flex_1()
            .justify_center()
            .items_center()
            .gap(px(6.))
            .py(px(10.))
            .px(px(8.))
            .rounded(px(10.))
            .border_1()
            .text_size(px(12.))
            .when(selected, |this| {
                this.border_color(Hsla::from(theme.gray_3))
                    .bg(Hsla::from(theme.gray_3))
                    .text_color(Hsla::from(theme.gray_12))
            })
            .when(!selected, |this| {
                this.border_color(gpui::transparent_black())
                    .text_color(Hsla::from(theme.gray_11))
                    .cursor_pointer()
                    .hover(|this| this.border_color(Hsla::from(theme.gray_7)))
            })
            .child(self.render_source_icon(item))
            .child(item.label())
            .on_click(cx.listener(move |this, _, window, cx| {
                this.select_source_tab(item, window, cx);
            }))
    }

    /// `renderBackgroundSourceIcon` (`:2054-2114`). Every tile previews the
    /// thing it would select: the colour tile is the colour, the gradient tile
    /// is the gradient at its current angle, and the three image tiles are the
    /// selected file where there is one and the shipped illustration where
    /// there is not.
    fn render_source_icon(&self, item: SourceTab) -> AnyElement {
        let source = &self.project.background.source;
        match item {
            SourceTab::None => svg()
                .path("icons/image-off.svg")
                .size(px(14.))
                .text_color(Hsla::from(self.theme.gray_11))
                .into_any_element(),
            SourceTab::Gradient => {
                let (from, to, angle) = match source {
                    BackgroundSource::Gradient {
                        from, to, angle, ..
                    } => (*from, *to, f32::from(*angle)),
                    _ => (DEFAULT_GRADIENT_FROM, DEFAULT_GRADIENT_TO, 90.),
                };
                div()
                    .size(px(14.))
                    .rounded(px(2.))
                    .bg(linear_gradient(
                        angle,
                        linear_color_stop(color_to_hsla(from), 0.),
                        linear_color_stop(color_to_hsla(to), 1.),
                    ))
                    .into_any_element()
            }
            SourceTab::Color => {
                let value = match source {
                    BackgroundSource::Color { value, .. } => *value,
                    // `hexToRgb(BACKGROUND_COLORS[9])` -- dodger blue.
                    _ => [71, 133, 255],
                };
                div()
                    .size(px(14.))
                    .rounded(px(5.))
                    .bg(color_to_hsla(value))
                    .into_any_element()
            }
            SourceTab::Image | SourceTab::Wallpaper | SourceTab::Desktop => {
                let thumbnail = match item {
                    SourceTab::Image => match source {
                        BackgroundSource::Image { path: Some(path) } => self.tile_image(path),
                        _ => None,
                    },
                    SourceTab::Desktop => self
                        .sidebar
                        .desktop_background
                        .as_ref()
                        .and_then(|path| self.tile_image(&path.to_string_lossy())),
                    _ => match source {
                        BackgroundSource::Wallpaper { path: Some(path) }
                            if !is_current_desktop_background_path(Some(path)) =>
                        {
                            wallpaper_id_for_path(path)
                                .and_then(|id| self.sidebar.wallpapers.get(id).cloned())
                        }
                        _ => None,
                    },
                };
                match thumbnail {
                    Some(image) => img(image)
                        .size(px(14.))
                        .rounded(px(2.))
                        .object_fit(gpui::ObjectFit::Cover)
                        .into_any_element(),
                    None => img(match item {
                        // `imageBg` for both the desktop and wallpaper tiles,
                        // `transparentBg` for image (`:229-234, 2088-2089`).
                        SourceTab::Image => "illustrations/transparent.webp",
                        _ => "illustrations/image.webp",
                    })
                    .size(px(14.))
                    .rounded(px(2.))
                    .into_any_element(),
                }
            }
        }
    }

    /// The decoded preview for a path, if it is the one already decoded.
    fn tile_image(&self, path: &str) -> Option<Arc<RenderImage>> {
        self.sidebar
            .preview
            .as_ref()
            .filter(|(current, _)| current.to_string_lossy() == path)
            .map(|(_, image)| image.clone())
    }

    // -- Desktop pane ------------------------------------------------------

    fn render_desktop_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let importing = self.sidebar.importing_desktop;
        let label = if importing {
            "Importing..."
        } else {
            "Import desktop background"
        };

        match self.sidebar.desktop_background.clone() {
            None => div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .items_center()
                .justify_center()
                .p(px(24.))
                .w_full()
                .rounded(px(8.))
                .border_dashed_1(Hsla::from(theme.gray_5))
                .bg(Hsla::from(theme.gray_2))
                .child(
                    svg()
                        .path("icons/monitor-outline.svg")
                        .size(px(24.))
                        .text_color(Hsla::from(theme.gray_11)),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(Hsla::from(theme.gray_12))
                        .child("Use the wallpaper from your desktop"),
                )
                .child(
                    ui::EditorButton::plain(&theme, "import-desktop")
                        .left_icon("icons/monitor-outline.svg")
                        .icon_size(px(16.))
                        .label(label)
                        .disabled(importing)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.import_desktop_background(window, cx);
                        })),
                )
                .into_any_element(),
            Some(path) => {
                let selected = matches!(
                    &self.project.background.source,
                    BackgroundSource::Wallpaper { path: Some(current) }
                        if *current == path.to_string_lossy()
                );
                let preview = self.tile_image(&path.to_string_lossy());
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .id("desktop-preview")
                            .relative()
                            .overflow_hidden()
                            .w_full()
                            // `h-48`
                            .h(px(192.))
                            .rounded(px(8.))
                            .border_1()
                            .when(selected, |this| this.border_color(Hsla::from(theme.blue_9)))
                            .when(!selected, |this| {
                                this.border_color(Hsla::from(theme.gray_5))
                                    .cursor_pointer()
                                    .hover(|this| this.border_color(Hsla::from(theme.gray_7)))
                            })
                            .children(preview.map(|image| {
                                img(image)
                                    .size_full()
                                    .object_fit(gpui::ObjectFit::Cover)
                                    .rounded(px(8.))
                            }))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let path = path.to_string_lossy().into_owned();
                                this.set_wallpaper_source(path, window, cx);
                                if this.ensure_background_presentation(false) {
                                    this.project_changed(window, cx);
                                }
                            })),
                    )
                    .child(
                        div().flex().justify_end().child(
                            ui::EditorButton::plain(&theme, "reimport-desktop")
                                .left_icon("icons/monitor-outline.svg")
                                .icon_size(px(16.))
                                .label(if importing {
                                    "Importing..."
                                } else {
                                    "Re-import"
                                })
                                .disabled(importing)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.import_desktop_background(window, cx);
                                })),
                        ),
                    )
                    .into_any_element()
            }
        }
    }

    // -- Wallpaper pane ----------------------------------------------------

    fn render_wallpaper_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected_theme = self.sidebar.wallpaper_theme;
        let selected_id = match &self.project.background.source {
            BackgroundSource::Wallpaper { path: Some(path) }
                if !is_current_desktop_background_path(Some(path)) =>
            {
                wallpaper_id_for_path(path)
            }
            _ => None,
        };
        let ids = wallpapers_for_theme(BACKGROUND_THEMES[selected_theme].0);
        let cell = (CONTENT_WIDTH - WALLPAPER_GAP * (WALLPAPER_COLUMNS - 1.)) / WALLPAPER_COLUMNS;

        div()
            .flex()
            .flex_col()
            .child(
                // The theme sub-tabs: `flex overflow-x-auto ... gap-2 mb-3
                // text-xs` (`:2348-2382`). The source's scroll fade is a
                // `mask-image`; with only six chips at this width the row
                // does not overflow, so there is nothing to fade.
                div()
                    .id("wallpaper-themes")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .mb(px(12.))
                    .text_size(px(12.))
                    .overflow_x_scroll()
                    .children(
                        BACKGROUND_THEMES
                            .iter()
                            .enumerate()
                            .map(|(index, (_, label))| {
                                let selected = index == selected_theme;
                                div()
                                    .id(SharedString::from(format!("wallpaper-theme-{index}")))
                                    .flex()
                                    .flex_1()
                                    .justify_center()
                                    .items_center()
                                    .px(px(16.))
                                    .py(px(8.))
                                    .rounded(px(8.))
                                    .border_1()
                                    .when(selected, |this| {
                                        this.bg(Hsla::from(theme.gray_3))
                                            .border_color(Hsla::from(theme.gray_3))
                                            .text_color(Hsla::from(theme.gray_12))
                                    })
                                    .when(!selected, |this| {
                                        this.border_color(gpui::transparent_black())
                                            .text_color(Hsla::from(theme.gray_11))
                                            .cursor_pointer()
                                            .hover(|this| {
                                                this.border_color(Hsla::from(theme.gray_7))
                                            })
                                    })
                                    .child(*label)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.sidebar.wallpaper_theme = index;
                                        this.ensure_wallpapers(window, cx);
                                        cx.notify();
                                    }))
                            }),
                    ),
            )
            .child(
                // `grid grid-cols-7 gap-2 h-auto`, each item `aspect-square
                // rounded-lg`, selected `ring-2 ring-gray-500 ring-offset-2
                // ring-offset-gray-200`.
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(WALLPAPER_GAP))
                    .children(ids.into_iter().map(|id| {
                        let selected = selected_id == Some(id);
                        let image = self.sidebar.wallpapers.get(id).cloned();
                        div()
                            .id(SharedString::from(format!("wallpaper-{id}")))
                            .w(px(cell))
                            .h(px(cell))
                            .rounded(px(8.))
                            .overflow_hidden()
                            .bg(Hsla::from(theme.gray_3))
                            .cursor_pointer()
                            .when(selected, |this| {
                                // The ring: 2px of `gray-500` outside a 2px
                                // `gray-200` offset. gpui has no outside
                                // border, so the offset is drawn as the tile's
                                // own 2px `gray-200` ring and the selection
                                // colour as the 2px border over it.
                                this.border_2()
                                    .border_color(Hsla::from(theme.gray_500_legacy))
                            })
                            .when(!selected, |this| {
                                this.hover(|this| {
                                    this.border_1().border_color(Hsla::from(theme.gray_7))
                                })
                            })
                            .children(image.map(|image| {
                                // `overflow_hidden` clips to the rect, not the
                                // radius, so the picture needs its own corners.
                                img(image)
                                    .size_full()
                                    .object_fit(gpui::ObjectFit::Cover)
                                    .rounded(px(8.))
                            }))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let Some(path) = wallpaper_path(id) else {
                                    tracing::error!(id, "wallpaper file not found");
                                    return;
                                };
                                this.set_wallpaper_source(
                                    path.to_string_lossy().into_owned(),
                                    window,
                                    cx,
                                );
                                if this.ensure_background_presentation(false) {
                                    this.project_changed(window, cx);
                                }
                            }))
                    })),
            )
    }

    // -- Image pane --------------------------------------------------------

    fn render_image_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let path = match &self.project.background.source {
            BackgroundSource::Image { path } => path.clone(),
            _ => None,
        };

        match path {
            None => div()
                .id("pick-background-image")
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .p(px(24.))
                .w_full()
                .rounded(px(8.))
                .bg(Hsla::from(theme.gray_2))
                .border_dashed_1(Hsla::from(theme.gray_5))
                .text_size(px(13.))
                .cursor_pointer()
                .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                .child(
                    svg()
                        .path("icons/image.svg")
                        .size(px(24.))
                        .text_color(Hsla::from(theme.gray_11)),
                )
                .child(
                    div()
                        .text_color(Hsla::from(theme.gray_12))
                        .child("Click to select or drag and drop image"),
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.pick_background_image(window, cx);
                }))
                .into_any_element(),
            Some(path) => div()
                .relative()
                .w_full()
                .h(px(192.))
                .rounded(px(6.))
                .overflow_hidden()
                .border_1()
                .border_color(Hsla::from(theme.gray_3))
                .children(self.tile_image(&path).map(|image| {
                    img(image)
                        .size_full()
                        .object_fit(gpui::ObjectFit::Cover)
                        .rounded(px(6.))
                }))
                .child(
                    div().absolute().top(px(8.)).right(px(8.)).child(
                        ui::IconButton::new("clear-background-image", "icons/circle-x.svg")
                            .size(px(32.))
                            .icon_size(px(16.))
                            .rounded(px(16.))
                            .color(gpui::white())
                            .filled(with_alpha(gpui::black(), 0.5), None)
                            .hover_bg(with_alpha(gpui::black(), 0.7))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.edit_background(
                                    "image",
                                    |project| {
                                        project.background.source =
                                            BackgroundSource::Image { path: None };
                                        true
                                    },
                                    window,
                                    cx,
                                );
                                this.ensure_preview(window, cx);
                            })),
                    ),
                )
                .into_any_element(),
        }
    }

    // -- Colour pane -------------------------------------------------------

    fn render_color_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let value = match &self.project.background.source {
            BackgroundSource::Color { value, .. } => *value,
            _ => [0, 0, 0],
        };

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            // The `RgbInput` row. `BrandColorsDropdown` sits under it and only
            // renders when the signed-in organisation has brand colours
            // (`BrandColorsDropdown.tsx:16`); there is no auth in this app, so
            // it never renders -- which is also what a user without them sees.
            .child(self.render_rgb_input(
                "background-color",
                ColorTarget::BackgroundColor,
                value,
                cx,
            ))
            .child(
                // The 17 presets: `flex flex-wrap gap-2`, `size-8 rounded-lg`.
                div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                    BACKGROUND_COLORS.iter().enumerate().map(|(index, hex)| {
                        let rgba = hex_to_rgb(hex).unwrap_or([0, 0, 0, 255]);
                        let color: Color =
                            [u16::from(rgba[0]), u16::from(rgba[1]), u16::from(rgba[2])];
                        let transparent = rgba[3] == 0;
                        let selected = !transparent && value == color;
                        div()
                            .id(SharedString::from(format!("bg-color-{index}")))
                            .size(px(32.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .when(transparent, |this| {
                                // `CHECKERED_BUTTON_BACKGROUND` (`:6500`): an
                                // 8px `#a0a0a0` checker.
                                this.bg(gpui::checkerboard(gpui::rgb(0xa0a0a0), 8.))
                            })
                            .when(!transparent, |this| this.bg(color_to_hsla(color)))
                            .when(selected, |this| {
                                this.border_2()
                                    .border_color(Hsla::from(theme.gray_500_legacy))
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_background(
                                    "color-preset",
                                    |project| {
                                        project.background.source = BackgroundSource::Color {
                                            value: color,
                                            alpha: rgba[3],
                                        };
                                        true
                                    },
                                    window,
                                    cx,
                                );
                            }))
                    }),
                ),
            )
    }

    /// `RgbInput` (`color-utils.tsx:18-101`): a `size-8 rounded-lg` swatch with
    /// a computed darker inset ring, which opens the OS colour panel, beside a
    /// hex field.
    ///
    /// The hex field is real entry now: typing a complete 6- or 8-digit colour
    /// commits it live, Enter and blur commit whatever is in the box, and a
    /// value that does not parse snaps back -- `RgbInput`'s own three handlers
    /// (`color-utils.tsx:27-96`), see `EditorWindow::on_hex_event`.
    fn render_rgb_input(
        &self,
        id: &'static str,
        target: ColorTarget,
        value: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let open = self.sidebar.color_target == Some(target);
        // The field's text is re-derived from the value by
        // `EditorWindow::sync_hex_inputs`, which runs once a frame from
        // `render` where the focus is knowable -- see it for why.
        let input = self.hex_input(target).cloned();

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .id(SharedString::from(format!("{id}-swatch")))
                    .size(px(32.))
                    .rounded(px(8.))
                    .bg(color_to_hsla(value))
                    .border_1()
                    .border_color(preview_border_color(value))
                    .cursor_pointer()
                    .when(open, |this| {
                        this.border_2().border_color(Hsla::from(theme.blue_9))
                    })
                    .on_click(
                        cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                            this.open_color_panel_for(target, event.position(), window, cx);
                        }),
                    ),
            )
            .children(input.map(|input| {
                // `w-[4.60rem] p-1.5 text-[13px] border rounded-lg bg-gray-1`.
                ui::TextInput::plain(&theme, id, &input)
                    .width(px(73.6))
                    .padding_x(px(6.))
                    .padding_y(px(6.))
                    .height(px(30.))
                    .radius(px(8.))
                    .bg(Hsla::from(theme.gray_1))
                    .border(Hsla::from(theme.gray_12))
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.gray_12))
            }))
    }

    // -- Gradient pane -----------------------------------------------------

    /// `GradientEditor` (`GradientEditor.tsx:93-287`).
    fn render_gradient_pane(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let (from, to, angle, noise, grain) = match &self.project.background.source {
            BackgroundSource::Gradient {
                from,
                to,
                angle,
                noise_intensity,
                noise_scale,
                ..
            } => (
                *from,
                *to,
                f32::from(*angle),
                noise_intensity.unwrap_or(0.),
                noise_scale.unwrap_or(DEFAULT_NOISE_SCALE),
            ),
            _ => (
                DEFAULT_GRADIENT_FROM,
                DEFAULT_GRADIENT_TO,
                90.,
                0.,
                DEFAULT_NOISE_SCALE,
            ),
        };
        let preset = gradient_preset_index(from, to);

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            // The live preview: `h-28 rounded-xl border border-gray-5`, with
            // the grain overlay mounted only while noise is on -- `<Show
            // when={noiseIntensity() > 0}>`, so it costs nothing when it is
            // off.
            .child(
                div()
                    .relative()
                    .h(px(GRADIENT_PREVIEW_HEIGHT))
                    .w_full()
                    .overflow_hidden()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_5))
                    .bg(linear_gradient(
                        angle,
                        linear_color_stop(color_to_hsla(from), 0.),
                        linear_color_stop(color_to_hsla(to), 1.),
                    ))
                    .children((noise > 0.).then(|| {
                        div()
                            .absolute()
                            .inset_0()
                            .opacity(noise_opacity(noise))
                            .child(img(self.sidebar.noise_image(grain)).size_full())
                    })),
            )
            // From / To, side by side.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.))
                    .items_end()
                    .child(self.render_gradient_stop(
                        "gradient-from",
                        "From",
                        ColorTarget::GradientFrom,
                        from,
                        cx,
                    ))
                    .child(self.render_gradient_stop(
                        "gradient-to",
                        "To",
                        ColorTarget::GradientTo,
                        to,
                        cx,
                    )),
            )
            .child(
                div()
                    .my(px(4.))
                    .child(dashed_divider(Hsla::from(theme.gray_5))),
            )
            // Angle: the slider plus the redundant `w-12 text-right
            // tabular-nums` readout the source draws beside it.
            .child(
                ui::Subfield::plain(&theme, "Angle").gap(px(16.)).child(
                    div()
                        .flex()
                        .flex_1()
                        .flex_row()
                        .items_center()
                        .gap(px(12.))
                        .child(self.slider_flex(SliderKey::Bg(BgSlider::GradientAngle), "deg", cx))
                        .child(
                            div()
                                .w(px(48.))
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.gray_11))
                                .child(format!("{}\u{b0}", angle.round() as i32)),
                        ),
                ),
            )
            .child(
                div()
                    .my(px(4.))
                    .child(dashed_divider(Hsla::from(theme.gray_5))),
            )
            .child(ui::Subfield::plain(&theme, "Noise").child(
                div().w(px(120.)).child(self.slider(
                    SliderKey::Bg(BgSlider::GradientNoise),
                    "%",
                    cx,
                )),
            ))
            // Grain Scale appears only while noise is on (`:204-221`).
            .children((noise > 0.).then(|| {
                ui::Subfield::plain(&theme, "Grain Scale")
                    .child(div().w(px(120.)).child(self.slider(
                        SliderKey::Bg(BgSlider::GradientGrain),
                        "%",
                        cx,
                    )))
                    .into_any_element()
            }))
            .child(
                div()
                    .my(px(4.))
                    .child(dashed_divider(Hsla::from(theme.gray_5))),
            )
            // Randomize, then the 18 presets -- which rotate live with the
            // angle, because each swatch draws the same gradient the preview
            // does (`:255-282`).
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("gradient-randomize")
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(32.))
                            .rounded(px(8.))
                            .bg(Hsla::from(theme.gray_2))
                            .border_dashed_1(Hsla::from(theme.gray_8))
                            .text_color(Hsla::from(theme.gray_10))
                            .cursor_pointer()
                            .child(
                                svg()
                                    .path("icons/shuffle.svg")
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.gray_10)),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                // `Math.floor(Math.random() * 256)` per
                                // channel, twice. No `rand` dependency here,
                                // so the clock's low bits feed an xorshift.
                                let nanos = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|elapsed| elapsed.subsec_nanos())
                                    .unwrap_or(1);
                                let mut seed = u64::from(nanos) ^ 0x9e37_79b9_7f4a_7c15;
                                let mut next = || {
                                    seed ^= seed << 13;
                                    seed ^= seed >> 7;
                                    seed ^= seed << 17;
                                    (seed % 256) as u16
                                };
                                let from = [next(), next(), next()];
                                let to = [next(), next(), next()];
                                this.edit_background(
                                    "gradient-randomize",
                                    |project| {
                                        let BackgroundSource::Gradient {
                                            from: current_from,
                                            to: current_to,
                                            ..
                                        } = &mut project.background.source
                                        else {
                                            return false;
                                        };
                                        *current_from = from;
                                        *current_to = to;
                                        true
                                    },
                                    window,
                                    cx,
                                );
                            })),
                    )
                    .children(GRADIENT_PRESETS.iter().enumerate().map(
                        |(index, (preset_from, preset_to))| {
                            let (preset_from, preset_to) = (*preset_from, *preset_to);
                            div()
                                .id(SharedString::from(format!("gradient-preset-{index}")))
                                .size(px(32.))
                                .rounded(px(8.))
                                .cursor_pointer()
                                .bg(linear_gradient(
                                    angle,
                                    linear_color_stop(color_to_hsla(preset_from), 0.),
                                    linear_color_stop(color_to_hsla(preset_to), 1.),
                                ))
                                .when(preset == Some(index), |this| {
                                    this.border_2()
                                        .border_color(Hsla::from(theme.gray_500_legacy))
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.edit_background(
                                        "gradient-preset",
                                        |project| {
                                            let BackgroundSource::Gradient { from, to, .. } =
                                                &mut project.background.source
                                            else {
                                                return false;
                                            };
                                            *from = preset_from;
                                            *to = preset_to;
                                            true
                                        },
                                        window,
                                        cx,
                                    );
                                }))
                        },
                    )),
            )
    }

    fn render_gradient_stop(
        &self,
        id: &'static str,
        label: &'static str,
        target: ColorTarget,
        value: Color,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_1()
            .flex_col()
            .min_w_0()
            .child(
                div()
                    .mb(px(4.))
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(label),
            )
            .child(self.render_rgb_input(id, target, value, cx))
    }

    // -- Corner style, border, notch, shadow -------------------------------

    /// `CornerStyleSelect` (`:3331-3395`): a small label over the canonical
    /// `bg-gray-3` select trigger.
    fn render_corner_style(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.project.background.rounding_type;
        let label = match current {
            CornerStyle::Squircle => "Squircle",
            CornerStyle::Rounded => "Rounded",
        };

        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(10.4))
                    .text_color(Hsla::from(theme.gray_11))
                    .child("CORNER STYLE"),
            )
            .child(
                ui::Select::plain(&theme, "corner-style", label)
                    .stretch_label()
                    .on_click(cx.listener(move |this, _, window, cx| {
                        // Two options: the trigger toggles between them rather
                        // than opening a two-row menu. `ui::Menu` draws at the
                        // pointer and this select is the only one in the tab;
                        // a real menu arrives with the tabs that have several.
                        let next = match this.project.background.rounding_type {
                            CornerStyle::Squircle => CornerStyle::Rounded,
                            CornerStyle::Rounded => CornerStyle::Squircle,
                        };
                        this.edit_background(
                            "rounding-type",
                            |project| {
                                project.background.rounding_type = next;
                                true
                            },
                            window,
                            cx,
                        );
                    })),
            )
    }

    fn render_border_field(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let border = self.project.background.border.clone();
        let enabled = border.as_ref().is_some_and(|border| border.enabled);
        let color = border.map_or(UI_BORDER_FALLBACK.color, |border| border.color);

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "Border")
                    .icon("icons/settings.svg")
                    .value(
                        ui::Toggle::plain(&theme, "border-enabled", enabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let next = !enabled;
                                this.sidebar.border_open.set_open(next);
                                // gpui renders on invalidation only, so the
                                // height transition needs someone to ask for
                                // the frames.
                                this.animate_collapsibles(window, cx);
                                this.edit_background(
                                    "border-enabled",
                                    |project| {
                                        let mut border = project
                                            .background
                                            .border
                                            .clone()
                                            .unwrap_or(UI_BORDER_FALLBACK);
                                        border.enabled = next;
                                        project.background.border = Some(border);
                                        true
                                    },
                                    window,
                                    cx,
                                );
                            }))
                            .into_any_element(),
                    ),
            )
            .child(collapsible(
                &self.sidebar.border_open,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .pb(px(24.))
                    .child(
                        ui::Field::plain(&theme, "Border Width")
                            .icon("icons/enlarge.svg")
                            .child(self.slider(SliderKey::Bg(BgSlider::BorderWidth), "px", cx)),
                    )
                    .child(
                        ui::Field::plain(&theme, "Border Color")
                            .icon("icons/image.svg")
                            .child(self.render_rgb_input(
                                "border-color",
                                ColorTarget::BorderColor,
                                color,
                                cx,
                            )),
                    )
                    .child(
                        ui::Field::plain(&theme, "Border Opacity")
                            .icon("icons/shadow.svg")
                            .child(self.slider(SliderKey::Bg(BgSlider::BorderOpacity), "%", cx)),
                    )
                    .into_any_element(),
            ))
    }

    fn render_notch_field(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let enabled = self
            .project
            .background
            .notch
            .as_ref()
            .is_some_and(|notch| notch.enabled);

        div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "MacBook notch")
                    .icon("icons/laptop.svg")
                    .value(
                        ui::Toggle::plain(&theme, "notch-enabled", enabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let next = !enabled;
                                this.sidebar.notch_open.set_open(next);
                                // gpui renders on invalidation only, so the
                                // height transition needs someone to ask for
                                // the frames.
                                this.animate_collapsibles(window, cx);
                                this.edit_background(
                                    "notch-enabled",
                                    |project| {
                                        let mut notch =
                                            project.background.notch.unwrap_or(UNPLACED_NOTCH);
                                        notch.enabled = next;
                                        project.background.notch = Some(notch);
                                        true
                                    },
                                    window,
                                    cx,
                                );
                            }))
                            .into_any_element(),
                    ),
            )
            .child(collapsible(
                &self.sidebar.notch_open,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .pb(px(24.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(
                                "Draws a MacBook notch over the recording. Recordings made \
                                 on a Mac with a notch use their own measurements; \
                                 otherwise start from the size below and adjust to match.",
                            ),
                    )
                    .child(
                        ui::Field::plain(&theme, "Notch Width")
                            .icon("icons/enlarge.svg")
                            .child(self.slider(SliderKey::Bg(BgSlider::NotchWidth), "pct", cx)),
                    )
                    .child(
                        ui::Field::plain(&theme, "Notch Height")
                            .icon("icons/enlarge.svg")
                            .child(self.slider(SliderKey::Bg(BgSlider::NotchHeight), "pct", cx)),
                    )
                    .child(
                        ui::Field::plain(&theme, "Notch Position")
                            .icon("icons/enlarge.svg")
                            .child(self.slider(SliderKey::Bg(BgSlider::NotchX), "pct", cx)),
                    )
                    .into_any_element(),
            ))
    }

    fn render_shadow_field(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let open = self.sidebar.shadow_open.is_open();

        ui::Field::plain(&theme, "Shadow")
            .icon("icons/shadow.svg")
            .child(self.slider(SliderKey::Bg(BgSlider::Shadow), "%", cx))
            // `ShadowSettings` (`ShadowSettings.tsx:37-86`): its own trigger
            // row with a rotating chevron, over three sliders.
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id("shadow-advanced")
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .cursor_pointer()
                            .child(div().text_size(px(14.)).child("Advanced shadow settings"))
                            .child(
                                // `rotate-180` when open. There is no rotation
                                // in this gpui rev, so the glyph swaps rather
                                // than turns -- the same substitution the
                                // settings window's reveal makes.
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
                                this.sidebar.shadow_open.toggle();
                                this.animate_collapsibles(window, cx);
                            })),
                    )
                    .child(collapsible(
                        &self.sidebar.shadow_open,
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            .mt(px(16.))
                            .child(ui::Field::plain(&theme, "Size").child(self.slider(
                                SliderKey::Bg(BgSlider::ShadowSize),
                                "",
                                cx,
                            )))
                            .child(ui::Field::plain(&theme, "Opacity").child(self.slider(
                                SliderKey::Bg(BgSlider::ShadowOpacity),
                                "",
                                cx,
                            )))
                            .child(ui::Field::plain(&theme, "Blur").child(self.slider(
                                SliderKey::Bg(BgSlider::ShadowBlur),
                                "",
                                cx,
                            )))
                            .into_any_element(),
                    )),
            )
    }

    /// gpui only renders on invalidation, so a height transition needs someone
    /// to ask for the next frame. Same ticker the settings window's collapsible
    /// uses.
    pub(crate) fn animate_collapsibles(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.notify();
        window.refresh();
        cx.spawn_in(window, async move |this, cx| {
            for _ in 0..14 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(16))
                    .await;
                if this
                    .update_in(cx, |_, window, cx| {
                        cx.notify();
                        window.refresh();
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();
    }

    /// One slider row, wired to the shared drag/undo bracket.
    ///
    /// `unit` is the source's `formatTooltip`, which is what the hover tooltip
    /// prints. gpui's tooltip is hover-driven only -- the Solid slider *also*
    /// forces it open mid-drag, which this rev cannot do (the README's
    /// standing tooltip deviation).
    pub(crate) fn slider(
        &self,
        slider: SliderKey,
        unit: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.slider_sized(slider, unit, false, cx)
    }

    /// The angle row is the one place a slider sits *beside* something rather
    /// than filling a column, and the source spells that out as
    /// `<Slider class="flex-1">` (`GradientEditor.tsx:169`). A flex item with
    /// no basis collapses to its content, which for a track with no intrinsic
    /// width is zero.
    pub(crate) fn slider_flex(
        &self,
        slider: SliderKey,
        unit: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.slider_sized(slider, unit, true, cx)
    }

    /// `<Slider disabled>`: Kobalte stops the pointer reaching the track and
    /// the fill repaints `data-disabled:bg-gray-8` (`editor/ui.tsx:118`). The
    /// two audio volumes are the sidebar's only disabled sliders, and both are
    /// disabled by `project.audio.mute` (`:786, :804`).
    pub(crate) fn slider_disabled(
        &self,
        slider: SliderKey,
        unit: &'static str,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.slider_sized_state(slider, unit, false, disabled, cx)
    }

    fn slider_sized(
        &self,
        slider: SliderKey,
        unit: &'static str,
        flex: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        self.slider_sized_state(slider, unit, flex, false, cx)
    }

    fn slider_sized_state(
        &self,
        slider: SliderKey,
        unit: &'static str,
        flex: bool,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (min, max, _) = self.slider_limits(slider);
        let value = self.slider_value(slider);
        let fraction = if max > min {
            ((value - min) / (max - min)).clamp(0., 1.)
        } else {
            0.
        };
        let track = self.sidebar.track(slider);
        let label = format_slider_value(value, unit);

        div()
            .id(SharedString::from(format!("bg-slider-row-{slider:?}")))
            // The Kobalte root is `relative px-1 h-8 flex items-center`.
            .px(px(4.))
            .h(px(32.))
            .flex()
            .flex_row()
            .items_center()
            .when(flex, |this| this.flex_1().min_w_0())
            .when(!flex, |this| this.w_full())
            .child(
                ui::Slider::new(
                    SharedString::from(format!("bg-slider-{slider:?}")),
                    fraction,
                    track,
                )
                .flex()
                .row_height(px(32.))
                // `h-[0.3rem] bg-gray-4 rounded-full`
                .track(px(4.8), Hsla::from(theme.gray_4))
                .fill(Hsla::from(if disabled {
                    theme.gray_8
                } else {
                    theme.blue_9
                }))
                // `bg-gray-1 dark:bg-gray-12 border border-gray-6 size-4`
                .thumb(
                    px(16.),
                    Hsla::from(if theme.is_dark() {
                        theme.gray_12
                    } else {
                        theme.gray_1
                    }),
                    Some(Hsla::from(theme.gray_6)),
                )
                .when(!disabled, |this| {
                    this.on_drag_start(cx.listener(
                        move |this, event: &MouseDownEvent, window, cx| {
                            this.slider_mouse_down(slider, event, window, cx);
                        },
                    ))
                }),
            )
            .tooltip(move |_window, cx| ui::Tooltip::new(&theme, label.clone()).view(cx))
    }
}

/// `formatTooltip`: a plain string suffix means `value.toFixed(1)` plus it, and
/// the two formatter call sites are motion blur (`${round(v * 100)}%`) and the
/// notch's three (`${(v * 100).toFixed(1)}%`).
pub(crate) fn format_slider_value(value: f32, unit: &str) -> String {
    match unit {
        "" => format!("{value:.1}"),
        "deg" => format!("{}\u{b0}", value.round() as i32),
        "x100%" => format!("{}%", (value * 100.).round() as i32),
        "pct" => format!("{:.1}%", value * 100.),
        unit => format!("{value:.1}{unit}"),
    }
}

/// The dashed dividers. gpui has no dashed border, so the dashes are painted:
/// 4px on, 4px off, one pixel tall.
pub(crate) fn dashed_divider(color: Hsla) -> impl IntoElement {
    div().w_full().h(px(1.)).child(
        canvas(
            |_, _, _| {},
            move |bounds: Bounds<Pixels>, _, window: &mut Window, _| {
                let mut x = f32::from(bounds.origin.x);
                let right = x + f32::from(bounds.size.width);
                while x < right {
                    let width = 4_f32.min(right - x);
                    window.paint_quad(gpui::fill(
                        Bounds {
                            origin: gpui::point(px(x), bounds.origin.y),
                            size: gpui::size(px(width), px(1.)),
                        },
                        color,
                    ));
                    x += 8.;
                }
            },
        )
        .size_full(),
    )
}

/// The clipped, animating container. Mounted while open *and* while animating
/// shut, so the reveal has something to collapse into -- the settings window's
/// rule, and the same reason: an unmounted panel would leave the parent's `gap`
/// as a hole under the trigger.
pub(crate) fn collapsible(state: &CollapsibleState, content: AnyElement) -> AnyElement {
    if !(state.is_open() || state.is_animating()) {
        return div().into_any_element();
    }
    let (height, _) = state.height_for(Instant::now());
    ui::Collapsible::new(height, state.measure_cell())
        .content(content)
        .into_any_element()
}

pub(crate) fn with_alpha(color: impl Into<Hsla>, alpha: f32) -> Hsla {
    let mut color = color.into();
    color.a = alpha;
    color
}

/// A dashed 1px border, which gpui does not have as a style: drawn as four
/// painted edges by the caller's own canvas would be heavy, so the two dashed
/// *boxes* in this tab (the empty desktop and image drop cards) take a solid
/// hairline of the same colour instead. Documented in the README.
trait DashedBorder {
    fn border_dashed_1(self, color: Hsla) -> Self;
}

impl DashedBorder for gpui::Div {
    fn border_dashed_1(self, color: Hsla) -> Self {
        self.border_1().border_color(color)
    }
}

impl DashedBorder for gpui::Stateful<gpui::Div> {
    fn border_dashed_1(self, color: Hsla) -> Self {
        self.border_1().border_color(color)
    }
}

// ---------------------------------------------------------------------------
// Verification hooks
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `CAP_GPUI_AUTO_SIDEBAR=<tab>[:<scroll>]`, through the rail's own handler
    /// so the tab switch is the one a click makes -- selection cleared, menu
    /// dismissed, body back to the top -- with the scroll applied afterwards.
    pub(crate) fn auto_select_sidebar_tab(
        &mut self,
        name: &str,
        scroll: Option<f32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = SidebarTab::ALL
            .iter()
            .position(|tab| tab.label().eq_ignore_ascii_case(name))
        else {
            tracing::warn!(name, "unknown sidebar tab");
            return;
        };
        self.select_sidebar_tab(index, window, cx);
        if let Some(offset) = scroll {
            self.sidebar
                .scroll
                .set_offset(gpui::point(px(0.), px(-offset)));
        }
        tracing::info!(tab = name, scroll = ?scroll, "auto sidebar tab");
        cx.notify();
        window.refresh();
    }

    /// `CAP_GPUI_AUTO_SELECT=<track>:<i>[,<i>]`, through `set_selection` so the
    /// panel opens exactly as a timeline click opens it.
    pub(crate) fn auto_select_segments(&mut self, spec: &str, cx: &mut Context<Self>) {
        let Some((track, indices)) = spec.split_once(':') else {
            tracing::warn!(spec, "auto select needs <track>:<index>");
            return;
        };
        let track = match track.to_ascii_lowercase().as_str() {
            "zoom" => TrackKind::Zoom,
            "text" => TrackKind::Text,
            "caption" => TrackKind::Caption,
            "mask" => TrackKind::Mask,
            "audio" => TrackKind::Audio,
            "keyboard" => TrackKind::Keyboard,
            "scene" => TrackKind::Scene,
            "3d" | "three_d" => TrackKind::ThreeD,
            other => {
                tracing::warn!(track = other, "unknown track");
                return;
            }
        };
        let indices: Vec<usize> = indices
            .split(',')
            .filter_map(|value| value.trim().parse().ok())
            .collect();
        if indices.is_empty() {
            return;
        }
        tracing::info!(?track, ?indices, "auto select segments");
        self.set_selection(Some(crate::editor_edits::Selection { track, indices }), cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_matches_the_source() {
        assert_eq!(WALLPAPER_NAMES.len(), 53);
        assert_eq!(GRADIENT_PRESETS.len(), 18);
        assert_eq!(BACKGROUND_COLORS.len(), 17);
        // Every wallpaper belongs to exactly one theme tab, or it would be
        // invisible in the grid.
        for id in WALLPAPER_NAMES {
            let matches = BACKGROUND_THEMES
                .iter()
                .filter(|(key, _)| id.starts_with(key))
                .count();
            assert_eq!(matches, 1, "{id} matched {matches} themes");
        }
        assert_eq!(wallpapers_for_theme("macOS").len(), 18);
        assert_eq!(wallpapers_for_theme("orange").len(), 9);
    }

    #[test]
    fn hex_parsing_matches_the_apps() {
        assert_eq!(hex_to_rgb("#4785FF"), Some([71, 133, 255, 255]));
        assert_eq!(hex_to_rgb("4785ff"), Some([71, 133, 255, 255]));
        assert_eq!(hex_to_rgb("#abc"), Some([0xaa, 0xbb, 0xcc, 255]));
        assert_eq!(hex_to_rgb("#00000000"), Some([0, 0, 0, 0]));
        assert_eq!(hex_to_rgb("#12345"), None);
        assert_eq!(hex_to_rgb("nope"), None);
        assert_eq!(hex_digit_count("#4785FF"), 6);
        assert_eq!(hex_digit_count("#4785FF00"), 8);
        assert_eq!(hex_digit_count("#47g"), 0);
        assert_eq!(rgb_to_hex([71, 133, 255]), "#4785FF");
    }

    #[test]
    fn the_transparent_preset_is_the_only_one_with_zero_alpha() {
        let transparent: Vec<&str> = BACKGROUND_COLORS
            .iter()
            .copied()
            .filter(|hex| hex_to_rgb(hex).is_some_and(|rgba| rgba[3] == 0))
            .collect();
        assert_eq!(transparent, vec!["#00000000"]);
    }

    #[test]
    fn a_desktop_wallpaper_path_reads_as_the_desktop_tab() {
        let desktop = BackgroundSource::Wallpaper {
            path: Some("/tmp/p.cap/assets/current-desktop-background-1234.jpg".into()),
        };
        assert_eq!(source_tab_for(&desktop), SourceTab::Desktop);

        let legacy = BackgroundSource::Wallpaper {
            path: Some("/tmp/p.cap/assets/current-desktop-background.png".into()),
        };
        assert_eq!(source_tab_for(&legacy), SourceTab::Desktop);

        let bundled = BackgroundSource::Wallpaper {
            path: Some("/Applications/Cap.app/.../assets/backgrounds/macOS/tahoe-dark.jpg".into()),
        };
        assert_eq!(source_tab_for(&bundled), SourceTab::Wallpaper);
        assert_eq!(
            wallpaper_id_for_path(
                "/Applications/Cap.app/.../assets/backgrounds/macOS/tahoe-dark.jpg"
            ),
            Some("macOS/tahoe-dark")
        );
    }

    #[test]
    fn none_wins_over_the_underlying_source() {
        let mut config = ProjectConfiguration::default();
        config.background.padding = 0.;
        config.background.rounding = 0.;
        config.background.source = BackgroundSource::Color {
            value: [1, 2, 3],
            alpha: 255,
        };
        assert!(is_none_background(&config));
        assert_eq!(initial_source_tab(&config), SourceTab::None);

        config.background.padding = 10.;
        assert!(!is_none_background(&config));
        assert_eq!(initial_source_tab(&config), SourceTab::Color);
    }

    #[test]
    fn gradient_maths_matches_the_editor() {
        assert_eq!(gradient_preset_index([15, 52, 67], [52, 232, 158]), Some(0));
        assert_eq!(gradient_preset_index([255, 0, 255], [0, 255, 0]), Some(17));
        // Reversed stops are a different gradient, and the source's exact
        // four-way RGB comparison says so.
        assert_eq!(gradient_preset_index([52, 232, 158], [15, 52, 67]), None);

        // `0.3 + ((100 - scale) / 100) * 1.2`, three decimals.
        assert!((noise_base_frequency(3.) - 1.464).abs() < 1e-6);
        assert!((noise_base_frequency(100.) - 0.3).abs() < 1e-6);
        assert!((noise_opacity(100.) - 0.25).abs() < 1e-6);
        assert!((noise_opacity(0.) - 0.).abs() < 1e-6);
    }

    #[test]
    fn the_notch_position_ceiling_follows_its_width() {
        assert!((notch_x_max(0.4) - 0.6).abs() < 1e-9);
        assert!((notch_x_max(0.) - 1.).abs() < 1e-9);
        // The width slider's own maximum is 0.4, but a stored value outside
        // [0, 1] must still clamp.
        assert!((notch_x_max(1.7) - 0.).abs() < 1e-9);
    }

    #[test]
    fn every_slider_has_the_range_its_call_site_declares() {
        assert_eq!(BgSlider::Blur.limits(), (0., 100., 0.1));
        assert_eq!(BgSlider::Padding.limits(), (0., 40., 0.1));
        assert_eq!(BgSlider::MotionBlur.limits(), (0., 1., 0.01));
        assert_eq!(BgSlider::BorderWidth.limits(), (1., 20., 0.1));
        assert_eq!(BgSlider::NotchWidth.limits(), (0., 0.4, 0.001));
        assert_eq!(BgSlider::NotchHeight.limits(), (0., 0.15, 0.001));
        assert_eq!(BgSlider::GradientAngle.limits(), (0., 360., 1.));
        assert_eq!(BgSlider::GradientGrain.limits(), (1., 100., 1.));
    }

    #[test]
    fn slider_tooltips_print_what_the_source_formats() {
        assert_eq!(format_slider_value(12.34, "%"), "12.3%");
        assert_eq!(format_slider_value(5., "px"), "5.0px");
        assert_eq!(format_slider_value(0.55, "x100%"), "55%");
        assert_eq!(format_slider_value(0.1224, "pct"), "12.2%");
        assert_eq!(format_slider_value(90., "deg"), "90\u{b0}");
        assert_eq!(format_slider_value(50., ""), "50.0");
    }

    #[test]
    fn the_preview_ring_is_the_colour_mixed_toward_black() {
        // `color-mix(in srgb, #FFFFFF 82%, black)` is #D1D1D1.
        let ring = preview_border_color([255, 255, 255]);
        let rgba = gpui::Rgba::from(ring);
        assert_eq!((rgba.r * 255.).round() as u8, 209);
    }
}
