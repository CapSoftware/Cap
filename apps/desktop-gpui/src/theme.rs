//! GPUI colors, radii, and shadows are compiled from `platform.css`.

use gpui::{
    App, BoxShadow, Context, Global, Hsla, Rgba, Window, WindowAppearance, point, px, rgb, rgba,
};

use crate::platform::{self, ForcedAppearance, MaterialKind};
use crate::store::AppTheme;

pub use cap_desktop_gpui::design_tokens::{
    PlatformColors, RadiusToken, ShadowToken, dark_colors, light_colors, radius, shadow,
};

#[cfg(test)]
#[path = "../token_compiler.rs"]
mod token_compiler;

const BUNDLED_UI_FONT: &str = "Inter";
const BUNDLED_DISPLAY_FONT: &str = "Faculty Glyphic";
const SYSTEM_UI_FONT: &str = ".SystemUIFont";

struct FontFamilies {
    ui: &'static str,
    display: &'static str,
}

static FONT_FAMILIES: std::sync::OnceLock<FontFamilies> = std::sync::OnceLock::new();

/// Registers the bundled faces and records which families actually resolve.
/// GPUI's own fallback for an unresolvable family is a fixed list (Helvetica
/// before Segoe UI), so a failed face is mapped to the platform UI font here.
pub fn install_fonts(cx: &App) {
    let loaded = match crate::assets::Assets.load_fonts(cx) {
        Ok(()) => true,
        Err(error) => {
            tracing::error!("bundled fonts unavailable, using the system font: {error:#}");
            false
        }
    };
    let resolve = |family: &'static str| {
        if loaded && family_resolves(cx, family) {
            family
        } else {
            tracing::warn!(
                family,
                "bundled font did not resolve, using the system font"
            );
            SYSTEM_UI_FONT
        }
    };
    let families = FontFamilies {
        ui: resolve(BUNDLED_UI_FONT),
        display: resolve(BUNDLED_DISPLAY_FONT),
    };
    let _ = FONT_FAMILIES.set(families);
}

fn family_resolves(cx: &App, family: &str) -> bool {
    let text_system = cx.text_system();
    let id = text_system.resolve_font(&gpui::font(family.to_string()));
    text_system
        .get_font_for_id(id)
        .is_some_and(|font| font.family.as_ref() == family)
}

/// The platform text face: bundled Inter, or the system UI font when it failed.
pub fn ui_font() -> &'static str {
    FONT_FAMILIES
        .get()
        .map_or(BUNDLED_UI_FONT, |families| families.ui)
}

/// The brand/display face, reserved for display headings and wordmarks.
pub fn display_font() -> &'static str {
    FONT_FAMILIES
        .get()
        .map_or(BUNDLED_DISPLAY_FONT, |families| families.display)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

impl Appearance {
    pub fn from_window(appearance: WindowAppearance) -> Self {
        match appearance {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::Light,
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::Dark,
        }
    }
}

/// `general_settings.theme`, the same `AppTheme` the Tauri app persists and
/// applies through `commands.setTheme` / `windows::set_theme`.
struct ThemePreference(AppTheme);

impl Global for ThemePreference {}

pub fn init(cx: &mut App) {
    cx.set_global(ThemePreference(crate::store::GeneralSettings::load().theme));
}

pub fn current_preference(cx: &App) -> AppTheme {
    cx.try_global::<ThemePreference>()
        .map(|preference| preference.0)
        .unwrap_or_else(|| crate::store::GeneralSettings::load().theme)
}

pub fn set_preference(preference: AppTheme, cx: &mut App) {
    cx.set_global(ThemePreference(preference));
}

/// Light/Dark force that appearance; System follows the window (and therefore
/// the OS, once `NSWindow.appearance` is cleared).
pub fn resolve_appearance(preference: AppTheme, system: Appearance) -> Appearance {
    match preference {
        AppTheme::System => system,
        AppTheme::Light => Appearance::Light,
        AppTheme::Dark => Appearance::Dark,
    }
}

fn forced_appearance(preference: AppTheme) -> ForcedAppearance {
    match preference {
        AppTheme::System => ForcedAppearance::System,
        AppTheme::Light => ForcedAppearance::Light,
        AppTheme::Dark => ForcedAppearance::Dark,
    }
}

/// `window.set_theme(...)` — native chrome (traffic lights, materials, menus)
/// follows the preference, not only the painted palette.
pub fn apply_native(window: &Window, cx: &App) {
    let appearance = forced_appearance(current_preference(cx));
    #[cfg(target_os = "windows")]
    platform::apply_window_theme(window, appearance, cx.foreground_executor());
    #[cfg(not(target_os = "windows"))]
    platform::apply_window_theme(window, appearance);
}

/// Force the native appearance and invalidate on OS theme changes so a System
/// preference picks up a light/dark flip without waiting for another event.
pub fn bind_window<T: 'static>(window: &mut Window, cx: &mut Context<T>) {
    apply_native(window, cx);
    cx.observe_window_appearance(window, |_, _window, cx| {
        #[cfg(target_os = "windows")]
        _window.defer(cx, |window, cx| apply_native(window, cx));
        cx.notify();
    })
    .detach();
}

/// What the shell paints *over* a native window material, resolved for one
/// appearance and one visual system.
///
/// The web app expresses this as `--macos-settings-*` custom properties
/// (`apps/desktop/src/styles/theme.css`) selected by two data attributes on
/// `<html>`: `data-macos-native-material` ("panel" for the main window,
/// "settings" for the settings window) and `data-macos-visual-system`
/// ("liquid-glass" or "vibrancy").
///
/// The custom properties themselves are set by the *visual system* blocks, not
/// per material, so one token set serves both windows; what differs is which
/// element each variable lands on, plus the two material-specific shell rules
/// (`[..native-material="panel"] .cap-window-shell`). `shell` and `header`
/// below are the panel's; `sidebar` / `content` / `card` are the settings
/// window's surfaces. Material `"teleprompter"` adds no custom properties at
/// all -- its whole block in `theme.css` is two `border-radius` rules (16, and
/// 22 under liquid glass) -- so it reuses this set through
/// [`Theme::teleprompter_shell_bg`] and [`Theme::teleprompter_window_radius`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialTokens {
    pub kind: MaterialKind,

    /// `.cap-window-shell`'s background, material "panel".
    pub shell: Rgba,
    /// `.cap-window-header`'s background.
    pub header: Rgba,
    /// `--macos-settings-border`.
    pub border: Rgba,
    /// `--macos-settings-control-fill`.
    pub control_fill: Rgba,
    /// `--macos-settings-control-hover`.
    pub control_hover: Rgba,
    /// `--macos-settings-control-active`.
    pub control_active: Rgba,
    /// `--macos-settings-selection`.
    pub selection: Rgba,
    /// `--macos-settings-text`.
    pub text: Rgba,
    /// `--macos-settings-muted`.
    pub muted: Rgba,
    /// `--macos-settings-fill`.
    pub fill: Rgba,
    /// `--macos-settings-hover`.
    pub hover: Rgba,
    /// `--macos-settings-sidebar`, the settings window's left pane.
    pub sidebar: Rgba,
    /// `--macos-settings-content`, the settings window's right pane.
    pub content: Rgba,
    /// `--macos-settings-card`, a `.cap-settings-card` / `.bg-gray-2` surface
    /// inside that pane.
    pub card: Rgba,
    /// `--macos-settings-window-radius`. The settings shell takes it as-is;
    /// the main window overrides it back to 16
    /// (`[data-macos-native-material="panel"] .cap-window-shell
    /// { border-radius: 16px }`), which is why `MAIN_WINDOW_MATERIAL_RADIUS`
    /// is a constant and this is not.
    pub window_radius: f32,
    /// `--macos-settings-sidebar-radius`. Transcribed for the record: the
    /// liquid-glass settings rule zeroes it again
    /// (`[..visual-system="liquid-glass"][..native-material="settings"]
    /// .cap-settings-sidebar { border-radius: 0 }`), so the pane is square on
    /// both paths and the window's own radius does the clipping.
    pub sidebar_radius: f32,
}

impl MaterialTokens {
    /// The panel material under `NSGlassEffectView`.
    fn liquid_glass(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Light => Self {
                kind: MaterialKind::LiquidGlass,
                // `[data-macos-visual-system="liquid-glass"][data-macos-native-material="panel"]
                //  .cap-window-shell { background: rgba(255, 255, 255, 0.55) }`
                // -- a wash *over* the live glass backdrop, not a replacement
                // for it. The base glass rule strips the border and shadow:
                // `.cap-window-shell { background: transparent; border: 0;
                //  box-shadow: none }`.
                shell: rgba(0xffffff8c),
                // `[data-macos-visual-system="liquid-glass"] .cap-window-header
                //  { background: transparent; border-bottom-color: transparent }`
                header: rgba(0x00000000),
                // `[data-macos-visual-system="liquid-glass"] {
                //  --macos-settings-border: rgba(0, 0, 0, 0.14) }` -- the glass
                // block overrides the base `rgba(0, 0, 0, 0.08)`.
                border: rgba(0x00000024),
                // Not overridden by the glass block, so the `:root` values:
                // `--macos-settings-control-fill: rgba(255, 255, 255, 0.78)`
                control_fill: rgba(0xffffffc7),
                // `--macos-settings-control-hover: rgba(255, 255, 255, 0.96)`
                control_hover: rgba(0xfffffff5),
                // `--macos-settings-control-active: rgba(0, 0, 0, 0.08)`
                control_active: rgba(0x00000014),
                // `--macos-settings-selection: rgba(0, 0, 0, 0.1)`
                selection: rgba(0x0000001a),
                // `--macos-settings-text: rgba(0, 0, 0, 0.88)`
                text: rgba(0x000000e0),
                // `:root { --macos-settings-muted: rgba(0, 0, 0, 0.48) }`,
                // not overridden by the glass block.
                muted: rgba(0x0000007a),
                // The glass block *does* override these three:
                // `--macos-settings-fill: rgba(0, 0, 0, 0.045)`
                fill: rgba(0x0000000b),
                // `--macos-settings-hover: rgba(0, 0, 0, 0.065)`
                hover: rgba(0x00000011),
                sidebar: rgba(0xffffffc7),
                // Deliberately not the Tauri `--macos-settings-content` /
                // `--macos-settings-card` values: the GPUI settings window has
                // its own grouped layout.
                content: rgba(0xffffffff),
                card: rgba(0x0000000a),
                // `--macos-settings-window-radius: 26px`
                window_radius: 26.,
                // `--macos-settings-sidebar-radius: 18px`
                sidebar_radius: 18.,
            },
            Appearance::Dark => Self {
                kind: MaterialKind::LiquidGlass,
                // `.dark[data-macos-visual-system="liquid-glass"][data-macos-native-material="panel"]
                //  .cap-window-shell { background: rgba(17, 17, 17, 0.88) }`
                shell: rgba(0x111111e0),
                header: rgba(0x00000000),
                // `:root.dark[data-macos-visual-system="liquid-glass"]`:
                // `--macos-settings-border: rgba(255, 255, 255, 0.07)`
                border: rgba(0xffffff12),
                // `--macos-settings-control-fill: rgba(255, 255, 255, 0.08)`
                control_fill: rgba(0xffffff14),
                // `--macos-settings-control-hover: rgba(255, 255, 255, 0.12)`
                control_hover: rgba(0xffffff1f),
                // `--macos-settings-control-active: rgba(255, 255, 255, 0.06)`
                control_active: rgba(0xffffff0f),
                // `--macos-settings-selection: #2c2c2c`
                selection: rgb(0x2c2c2c),
                // `--macos-settings-text: rgba(255, 255, 255, 0.95)`
                text: rgba(0xfffffff2),
                // `--macos-settings-muted: #a1a1a1`
                muted: rgb(0xa1a1a1),
                // `--macos-settings-fill: rgba(255, 255, 255, 0.05)`
                fill: rgba(0xffffff0d),
                // `--macos-settings-hover: rgba(255, 255, 255, 0.05)`
                hover: rgba(0xffffff0d),
                // `--macos-settings-sidebar: rgba(28, 28, 28, 0.88)`
                sidebar: rgba(0x1c1c1ce0),
                content: rgba(0x1e1e1eff),
                card: rgba(0xffffff0d),
                // The radii are set once, outside the `.dark` block.
                window_radius: 26.,
                sidebar_radius: 18.,
            },
        }
    }

    /// The panel material under `NSVisualEffectView`, i.e. pre-macOS-26. The
    /// shell keeps the border and the header keeps its own wash, because none
    /// of the `liquid-glass` overrides apply.
    fn vibrancy(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Light => Self {
                kind: MaterialKind::Vibrancy,
                // `[data-macos-native-material] .cap-window-shell { background:
                //  var(--macos-settings-window); border: 1px solid
                //  var(--macos-settings-border) }`, and `:root`'s
                // `--macos-settings-window: rgba(244, 244, 243, 0.84)`.
                shell: rgba(0xf4f4f3d6),
                // `[data-macos-native-material] .cap-window-header { background:
                //  rgba(250, 250, 249, 0.72) }`. Its `backdrop-filter:
                //  blur(28px) saturate(1.45)` has no equivalent in this gpui
                // rev (same gap as the recording overlay's `backdrop-blur-xs`).
                header: rgba(0xfafaf9b8),
                // `--macos-settings-border: rgba(0, 0, 0, 0.08)`
                border: rgba(0x00000014),
                control_fill: rgba(0xffffffc7),
                control_hover: rgba(0xfffffff5),
                control_active: rgba(0x00000014),
                selection: rgba(0x0000001a),
                text: rgba(0x000000e0),
                muted: rgba(0x0000007a),
                // The `:root` values, none of them overridden without the
                // glass block: `--macos-settings-fill: rgba(0, 0, 0, 0.055)`
                fill: rgba(0x0000000e),
                // `--macos-settings-hover: rgba(0, 0, 0, 0.055)`
                hover: rgba(0x0000000e),
                // `--macos-settings-sidebar: rgba(250, 250, 249, 0.74)`
                sidebar: rgba(0xfafaf9bd),
                content: rgba(0xfbfbfbff),
                card: rgba(0x0000000a),
                // `--macos-settings-window-radius: 16px`
                window_radius: 16.,
                // `--macos-settings-sidebar-radius: 0px`
                sidebar_radius: 0.,
            },
            Appearance::Dark => Self {
                kind: MaterialKind::Vibrancy,
                // `:root.dark { --macos-settings-window: rgba(17, 17, 17, 0.94) }`
                shell: rgba(0x111111f0),
                // `:root.dark[data-macos-native-material] .cap-window-header
                //  { background: rgba(28, 28, 28, 0.88) }`
                header: rgba(0x1c1c1ce0),
                // `:root.dark { --macos-settings-border: rgba(255, 255, 255, 0.07) }`
                border: rgba(0xffffff12),
                control_fill: rgba(0xffffff14),
                control_hover: rgba(0xffffff1f),
                control_active: rgba(0xffffff0f),
                selection: rgb(0x2c2c2c),
                text: rgba(0xfffffff2),
                // `:root.dark { --macos-settings-muted: #a1a1a1 }`
                muted: rgb(0xa1a1a1),
                // `--macos-settings-fill: rgba(255, 255, 255, 0.05)`
                fill: rgba(0xffffff0d),
                // `--macos-settings-hover: rgba(255, 255, 255, 0.05)`
                hover: rgba(0xffffff0d),
                // `--macos-settings-sidebar: rgba(22, 22, 22, 0.9)` -- the one
                // settings surface the glass block does *not* just re-tint.
                sidebar: rgba(0x161616e6),
                content: rgba(0x1e1e1eff),
                card: rgba(0xffffff0d),
                window_radius: 16.,
                sidebar_radius: 0.,
            },
        }
    }

    pub fn new(kind: MaterialKind, appearance: Appearance) -> Self {
        match kind {
            MaterialKind::LiquidGlass => Self::liquid_glass(appearance),
            MaterialKind::Vibrancy => Self::vibrancy(appearance),
        }
    }
}

/// Every colour the main window draws with, already resolved for one appearance.
///
/// The scales are transcribed whole rather than trimmed to today's callers.
/// Half a Radix scale is worse than none: the next person needing `red-9` for
/// the Stop Recording button or `blue-5` for a pressed tile would otherwise
/// have to go back to the CSS and re-derive which entries were overridden.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub appearance: Appearance,
    pub platform: PlatformColors,

    /// The native window material behind the shell, already resolved for this
    /// appearance. `None` -- non-mac, or the install failed -- keeps the
    /// opaque `gray-1` shell, which is what the web app falls back to when
    /// `applyMacOSWindowMaterial` never runs.
    pub material: Option<MaterialTokens>,

    pub gray_1: Rgba,
    pub gray_2: Rgba,
    pub gray_3: Rgba,
    pub gray_4: Rgba,
    pub gray_5: Rgba,
    pub gray_6: Rgba,
    pub gray_7: Rgba,
    pub gray_8: Rgba,
    pub gray_9: Rgba,
    pub gray_10: Rgba,
    pub gray_11: Rgba,
    pub gray_12: Rgba,

    pub blue_3: Rgba,
    pub blue_4: Rgba,
    pub blue_5: Rgba,
    pub blue_6: Rgba,
    pub blue_8: Rgba,
    pub blue_9: Rgba,
    pub blue_10: Rgba,
    pub blue_11: Rgba,
    /// The screenshot editor's layers panel selected-row label
    /// (`text-blue-12`). Stock Radix -- `theme.css` overrides no blue-12.
    pub blue_12: Rgba,

    pub red_2: Rgba,
    /// The layers panel's delete-hover wash (`hover:bg-red-3`). Stock Radix.
    pub red_3: Rgba,
    pub red_4: Rgba,
    pub red_9: Rgba,
    pub red_10: Rgba,
    /// The layers panel's delete-hover glyph (`hover:text-red-11`). Stock
    /// Radix.
    pub red_11: Rgba,

    /// The settings page's one non-gray, non-blue accent: the "recommended Cap
    /// windows are not excluded" warning is `border-amber-6 bg-amber-3/30
    /// text-amber-11`. Stock Radix -- `theme.css` overrides no amber step.
    pub amber_3: Rgba,
    pub amber_6: Rgba,
    pub amber_11: Rgba,

    /// `--blue-100`: the settings Recordings page's Instant badge
    /// (`bg-blue-100`). Part of the same legacy ramp as `--blue-500`, and like
    /// it not a Radix step -- `theme.css:77` / `:144`.
    pub blue_100: Rgba,

    /// `--blue-500`: the device-list selection fill and the Mode pill's ring.
    /// Distinct from `blue-9`; the two are not interchangeable.
    pub blue_500: Rgba,

    /// `--red-300`, the recording bar's stop button. Same value in both themes.
    pub red_300: Rgba,

    /// The **legacy** gray scale (`--gray-50 … --gray-500`, `theme.css:36-45`
    /// and `:97-107`), which coexists with Radix's 1-12 and is *not*
    /// numerically aligned with it -- legacy `gray-500` is the darkest text
    /// colour, Radix `gray-1` the lightest surface. Only the three steps the
    /// config sidebar actually uses are carried: the background section's
    /// dashed dividers are `border-gray-300`, and every selected swatch in it
    /// (wallpaper, colour preset, gradient preset) is `ring-2 ring-gray-500
    /// ring-offset-2 ring-offset-gray-200`. E5b adds `gray-400`, the
    /// `PositionPad` knob's ring (`ConfigSidebar.tsx:6283`) and the manual-zoom
    /// dot's (`:5843`).
    pub gray_200_legacy: Rgba,
    pub gray_300_legacy: Rgba,
    pub gray_400_legacy: Rgba,
    pub gray_500_legacy: Rgba,

    /// The editor's layered surface system (`--ed-*` in `theme.css`).
    pub editor: EditorPalette,
}

impl std::ops::Deref for Theme {
    type Target = PlatformColors;

    fn deref(&self) -> &Self::Target {
        &self.platform
    }
}

/// Editor surfaces, transcribed from the `--ed-*` custom properties in
/// `apps/desktop/src/styles/theme.css`. A layered, low-contrast system
/// (window < card < control) with one accent; change both files together.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EditorPalette {
    pub window: Rgba,
    pub card: Rgba,
    pub card_2: Rgba,
    pub stage: Rgba,
    pub line: Rgba,
    pub line_strong: Rgba,
    pub text_1: Rgba,
    pub text_2: Rgba,
    pub text_3: Rgba,
    pub ctl: Rgba,
    pub ctl_hover: Rgba,
    pub ctl_active: Rgba,
    pub accent: Rgba,
    pub accent_2: Rgba,
    pub playhead: Rgba,
    pub thumb: Rgba,
    /// `--ed-seg-tint`: how much of a track colour a segment fill carries.
    pub seg_tint: f32,
    /// `--ed-seg-line`: the segment border's alpha.
    pub seg_line: f32,
    /// `--ed-seg-label-base` / `--ed-seg-label-mix`: segment text is the
    /// track colour pulled this far toward black (light) or white (dark).
    pub seg_label_base: Rgba,
    pub seg_label_mix: f32,
    /// `--ed-card-shadow`: how black a card's drop shadow is. A card lifts
    /// barely at all on white and much more on the dark window, where the
    /// hairline alone is invisible.
    pub card_shadow_alpha: f32,
}

impl EditorPalette {
    pub fn light() -> Self {
        Self {
            window: rgb(0xf1f1f3),
            card: rgb(0xffffff),
            card_2: rgb(0xf6f6f7),
            stage: rgb(0xe9e9ec),
            line: rgba(0x00000013),
            line_strong: rgba(0x0000001f),
            text_1: rgb(0x1c1c1e),
            text_2: rgb(0x6e6e75),
            text_3: rgb(0xa0a0a8),
            ctl: rgba(0x0000000b),
            ctl_hover: rgba(0x00000013),
            ctl_active: rgba(0x0000001c),
            accent: rgb(0x007aff),
            accent_2: rgb(0x2b8cff),
            playhead: rgb(0xff3b30),
            thumb: rgb(0xffffff),
            seg_tint: 0.13,
            seg_line: 0.34,
            seg_label_base: rgb(0x000000),
            seg_label_mix: 0.58,
            card_shadow_alpha: 0.04,
        }
    }

    pub fn dark() -> Self {
        Self {
            window: rgb(0x131315),
            card: rgb(0x1b1b1e),
            card_2: rgb(0x202024),
            stage: rgb(0x121214),
            line: rgba(0xffffff14),
            line_strong: rgba(0xffffff21),
            text_1: rgb(0xf4f4f5),
            text_2: rgb(0x9a9aa3),
            text_3: rgb(0x62626a),
            ctl: rgba(0xffffff0f),
            ctl_hover: rgba(0xffffff17),
            ctl_active: rgba(0xffffff21),
            accent: rgb(0x0a84ff),
            accent_2: rgb(0x3d9bff),
            playhead: rgb(0xff453a),
            thumb: rgb(0xe8e8ea),
            seg_tint: 0.20,
            seg_line: 0.42,
            seg_label_base: rgb(0xffffff),
            seg_label_mix: 0.55,
            card_shadow_alpha: 0.30,
        }
    }

    /// `color-mix(in srgb, color <tint>, card)`: the segment fill.
    pub fn seg_fill(&self, color: Rgba) -> Rgba {
        mix(self.card, color, self.seg_tint)
    }

    /// A selected segment: the tint plus ten points.
    pub fn seg_fill_selected(&self, color: Rgba) -> Rgba {
        mix(self.card, color, self.seg_tint + 0.10)
    }

    /// The segment's 1px inset border.
    pub fn seg_border(&self, color: Rgba) -> Rgba {
        rgba_alpha(color, self.seg_line)
    }

    /// Segment label text.
    pub fn seg_label(&self, color: Rgba) -> Rgba {
        mix(self.seg_label_base, color, self.seg_label_mix)
    }

    /// Segment secondary text (durations, amounts): the label colour at 45%
    /// toward `text_3`.
    pub fn seg_muted(&self, color: Rgba) -> Rgba {
        mix(self.text_3, color, 0.45)
    }

    /// The track gutter's icon tile: `color 16%` over transparent.
    pub fn tile_bg(&self, color: Rgba) -> Rgba {
        rgba_alpha(color, 0.16)
    }

    /// The tile's glyph: the track colour pulled 62% toward the label base.
    pub fn tile_fg(&self, color: Rgba) -> Rgba {
        mix(self.seg_label_base, color, 0.62)
    }

    /// Trim handles: the colour at 70% toward the label base.
    pub fn seg_handle(&self, color: Rgba) -> Rgba {
        mix(self.seg_label_base, color, 0.70)
    }

    /// `--ed-card-shadow`: `0 1px 2px` under every editor card.
    pub fn card_shadow(&self) -> Vec<BoxShadow> {
        vec![BoxShadow {
            color: gpui::hsla(0., 0., 0., self.card_shadow_alpha),
            offset: point(px(0.), px(1.)),
            blur_radius: px(2.),
            spread_radius: px(0.),
            inset: false,
        }]
    }
}

/// The drop shadow under the stage's letterboxed preview. The stage is nearly
/// black in both themes, so this one does not vary with the appearance.
pub fn preview_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: gpui::hsla(0., 0., 0., 0.35),
        offset: point(px(0.), px(12.)),
        blur_radius: px(32.),
        spread_radius: px(-8.),
        inset: false,
    }]
}

/// The drop shadow under a slider knob.
pub fn thumb_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: gpui::hsla(0., 0., 0., 0.25),
        offset: point(px(0.), px(1.)),
        blur_radius: px(3.),
        spread_radius: px(0.),
        inset: false,
    }]
}

/// `color-mix(in srgb, b <t>, a)`: straight sRGB interpolation, which is what
/// the CSS side does.
pub fn mix(a: Rgba, b: Rgba, t: f32) -> Rgba {
    let t = t.clamp(0.0, 1.0);
    Rgba {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
    }
}

pub fn rgba_alpha(color: Rgba, alpha: f32) -> Rgba {
    Rgba { a: alpha, ..color }
}

impl Theme {
    pub fn new(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Light => Self::light(),
            Appearance::Dark => Self::dark(),
        }
    }

    pub fn for_window(window: &Window, cx: &App, with_material: bool) -> Self {
        let preference = current_preference(cx);
        let system = platform::window_is_dark(window)
            .map(|dark| {
                if dark {
                    Appearance::Dark
                } else {
                    Appearance::Light
                }
            })
            .unwrap_or_else(|| Appearance::from_window(window.appearance()));
        let theme = Self::new(resolve_appearance(preference, system));
        if with_material {
            theme.with_material(platform::active_material(cx))
        } else {
            theme
        }
    }

    pub fn refresh(&mut self, window: &Window, cx: &App, with_material: bool) -> bool {
        let next = Self::for_window(window, cx, with_material);
        if next.appearance != self.appearance || next.material_kind() != self.material_kind() {
            *self = next;
            true
        } else {
            false
        }
    }

    pub fn light() -> Self {
        Self {
            appearance: Appearance::Light,
            platform: light_colors(),
            material: None,
            editor: EditorPalette::light(),

            gray_1: rgb(0xfcfcfc),
            gray_2: rgb(0xf9f9f9),
            gray_3: rgb(0xf0f0f0),
            gray_4: rgb(0xe8e8e8),
            gray_5: rgb(0xe0e0e0),
            gray_6: rgb(0xd9d9d9),
            gray_7: rgb(0xcecece),
            gray_8: rgb(0xbbbbbb),
            gray_9: rgb(0x8d8d8d),
            gray_10: rgb(0x838383),
            gray_11: rgb(0x646464),
            gray_12: rgb(0x202020),

            blue_3: rgb(0xe6f4fe),
            blue_4: rgb(0xd5efff),
            blue_5: rgb(0xc2e5ff),
            blue_6: rgb(0xacd8fc),
            blue_8: rgb(0x5eb1ef),
            blue_9: rgb(0x0090ff),
            blue_10: rgb(0x0588f0),
            blue_11: rgb(0x0d74ce),
            blue_12: rgb(0x113264),

            red_2: rgb(0xfff7f7),
            red_3: rgb(0xfeebec),
            red_4: rgb(0xffdbdc),
            red_9: rgb(0xe5484d),
            red_10: rgb(0xdc3e42),
            red_11: rgb(0xce2c31),

            amber_3: rgb(0xfff7c2),
            amber_6: rgb(0xf3d673),
            amber_11: rgb(0xab6400),

            blue_100: rgb(0xadc9ff),
            blue_500: rgb(0x3666c5),
            red_300: rgb(0xff4766),

            // `theme.css:38-44`.
            gray_200_legacy: rgb(0xe4e6ed),
            gray_300_legacy: rgb(0xc7ccda),
            // `--gray-400: #868e9f` (`theme.css:42`).
            gray_400_legacy: rgb(0x868e9f),
            gray_500_legacy: rgb(0x161b26),
        }
    }

    pub fn dark() -> Self {
        Self {
            appearance: Appearance::Dark,
            platform: dark_colors(),
            material: None,
            editor: EditorPalette::dark(),

            // gray 1-6 and 11 are the theme.css overrides, not stock Radix.
            gray_1: rgb(0x111111),
            gray_2: rgb(0x1c1c1c),
            gray_3: rgb(0x282828),
            gray_4: rgb(0x323232),
            gray_5: rgb(0x3a3a3a),
            gray_6: rgb(0x444444),
            gray_7: rgb(0x484848),
            gray_8: rgb(0x606060),
            gray_9: rgb(0x6e6e6e),
            gray_10: rgb(0x7b7b7b),
            gray_11: rgb(0xa1a1a1),
            gray_12: rgb(0xeeeeee),

            blue_3: rgb(0x0d2847),
            blue_4: rgb(0x003362),
            blue_5: rgb(0x004074),
            blue_6: rgb(0x104d87),
            blue_8: rgb(0x2870bd),
            blue_9: rgb(0x0090ff),
            blue_10: rgb(0x3b9eff),
            blue_11: rgb(0x70b8ff),
            blue_12: rgb(0xc2e6ff),

            red_2: rgb(0x201314),
            red_3: rgb(0x3b1219),
            red_4: rgb(0x500f1c),
            red_9: rgb(0xe5484d),
            red_10: rgb(0xec5d5e),
            red_11: rgb(0xff9592),

            amber_3: rgb(0x302008),
            amber_6: rgb(0x5c3d05),
            amber_11: rgb(0xffca16),

            blue_100: rgb(0x243352),
            blue_500: rgb(0x0a84ff),
            red_300: rgb(0xff4766),

            // `theme.css:101-107`.
            gray_200_legacy: rgb(0x282828),
            gray_300_legacy: rgb(0x323232),
            // `--gray-400: #a1a1a1` (`theme.css:105`).
            gray_400_legacy: rgb(0xa1a1a1),
            gray_500_legacy: rgb(0xffffff),
        }
    }

    /// Resolve the panel material for this theme's appearance.
    /// `None` leaves the opaque shell alone.
    pub fn with_material(mut self, kind: Option<MaterialKind>) -> Self {
        self.material = kind.map(|kind| MaterialTokens::new(kind, self.appearance));
        self
    }

    /// The material's own kind, for the `render`-side "is a material live"
    /// checks that have nothing to paint.
    pub fn material_kind(&self) -> Option<MaterialKind> {
        self.material.map(|material| material.kind)
    }

    /// One Radix gray step by number, so the `.bg-gray-N` remaps below can be
    /// written the way `theme.css` writes them.
    pub fn gray(&self, step: u8) -> Hsla {
        match step {
            1 => self.gray_1,
            2 => self.gray_2,
            3 => self.gray_3,
            4 => self.gray_4,
            5 => self.gray_5,
            6 => self.gray_6,
            7 => self.gray_7,
            8 => self.gray_8,
            9 => self.gray_9,
            10 => self.gray_10,
            11 => self.gray_11,
            _ => self.gray_12,
        }
        .into()
    }

    pub fn shell_bg(&self) -> Hsla {
        self.surface.into()
    }

    pub fn shell_border(&self) -> Option<Hsla> {
        Some(self.border.into())
    }

    pub fn header_bg(&self) -> Hsla {
        self.surface_secondary.into()
    }

    pub fn header_border(&self) -> Hsla {
        self.border.into()
    }

    pub fn body_text(&self) -> Hsla {
        self.text_primary.into()
    }

    pub fn body_fill(&self, step: u8) -> Hsla {
        match step {
            2 | 3 => self.surface_subtle.into(),
            4 => self.hover_bg.into(),
            5 => self.active_bg.into(),
            _ => self.gray(step),
        }
    }

    pub fn body_hover_fill(&self, step: u8) -> Hsla {
        match step {
            4 | 5 => self.hover_bg.into(),
            6 | 7 => self.active_bg.into(),
            _ => self.gray(step),
        }
    }

    pub fn body_border(&self, step: u8) -> Hsla {
        match step {
            4..=6 => self.border.into(),
            _ => self.gray(step),
        }
    }

    pub fn ring_offset(&self) -> Hsla {
        self.surface.into()
    }

    pub fn settings_sidebar_bg(&self) -> Hsla {
        self.surface_secondary.into()
    }

    pub fn settings_content_bg(&self) -> Hsla {
        self.surface.into()
    }

    pub fn settings_card_bg(&self) -> Hsla {
        self.surface_raised.into()
    }

    pub fn settings_fill(&self) -> Hsla {
        self.surface_subtle.into()
    }

    pub fn settings_hover(&self) -> Hsla {
        self.hover_bg.into()
    }

    pub fn settings_selection(&self) -> Hsla {
        self.active_bg.into()
    }

    pub fn settings_border(&self) -> Hsla {
        self.border.into()
    }

    pub fn settings_divider(&self) -> Hsla {
        self.border_subtle.into()
    }

    pub fn settings_text(&self) -> Hsla {
        self.text_default.into()
    }

    pub fn settings_muted(&self) -> Hsla {
        self.text_secondary.into()
    }

    pub fn teleprompter_shell_bg(&self) -> Hsla {
        self.surface.into()
    }

    pub fn teleprompter_shell_border(&self) -> Option<Hsla> {
        Some(self.border.into())
    }

    pub fn teleprompter_window_radius(&self) -> f32 {
        f32::from(radius(RadiusToken::Medium))
    }

    pub fn is_dark(&self) -> bool {
        self.appearance == Appearance::Dark
    }

    /// The selected-tile fill. Dark mode uses `blue-3/30` rather than solid
    /// `blue-3`, so it reads as a tint over `gray-1` instead of a slab.
    pub fn tile_selected_bg(&self) -> Hsla {
        if self.is_dark() {
            let mut color: Hsla = self.blue_3.into();
            color.a = 0.3;
            color
        } else {
            self.blue_3.into()
        }
    }

    /// A colour at an alpha, for Tailwind's `/N` overlay fills
    /// (`hover:bg-gray-12/6`, `hover:bg-red-500/8`).
    pub fn with_alpha(color: Rgba, alpha: f32) -> Hsla {
        let mut color: Hsla = color.into();
        color.a = alpha;
        color
    }

    /// Tailwind v4's stock `blue-600` -- the target-select overlay's highlight
    /// wash (`bg-blue-600/40`). Not a Radix step and not one of the app's own
    /// `--blue-*` overrides: the overlay reaches straight for the Tailwind
    /// palette there.
    pub const TARGET_HIGHLIGHT: u32 = 0x155dfc;

    /// `--macos-settings-accent: AccentColor` -- the selected sidebar icon and
    /// the checked toggle. `AccentColor` is the system-wide accent the user
    /// picked in System Settings; gpui exposes no query for it, so this is
    /// macOS's default blue. A user on a non-blue accent sees blue here and
    /// their own colour in the Tauri app (README deviation).
    pub const SETTINGS_ACCENT: u32 = 0x007aff;

    /// The TSX has a `#DCDCDC` unfocused state, but it hangs off an
    /// `onFocusChanged` the non-activating main panel never delivers -- the
    /// shipping lights stay colored, so no inactive color exists here.
    pub const TRAFFIC_CLOSE: u32 = 0xff5f57;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_preference_resolves_like_tauri() {
        assert_eq!(
            resolve_appearance(AppTheme::System, Appearance::Dark),
            Appearance::Dark
        );
        assert_eq!(
            resolve_appearance(AppTheme::System, Appearance::Light),
            Appearance::Light
        );
        assert_eq!(
            resolve_appearance(AppTheme::Light, Appearance::Dark),
            Appearance::Light
        );
        assert_eq!(
            resolve_appearance(AppTheme::Dark, Appearance::Light),
            Appearance::Dark
        );
    }

    #[test]
    fn platform_colors_and_window_surfaces_are_stable_before_material_installation() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let before = Theme::new(appearance);
            let after = before.with_material(Some(MaterialKind::LiquidGlass));
            assert_eq!(before.shell_bg(), after.shell_bg());
            assert_eq!(before.header_bg(), after.header_bg());
            assert_eq!(before.body_text(), after.body_text());
            assert_eq!(before.settings_sidebar_bg(), after.settings_sidebar_bg());
            assert_eq!(
                before.teleprompter_shell_bg(),
                after.teleprompter_shell_bg()
            );
            assert_eq!(before.shell_bg(), Hsla::from(before.surface));
            assert_eq!(before.header_bg(), Hsla::from(before.surface_secondary));
            assert_eq!(before.header_border(), Hsla::from(before.border));
        }
        assert_eq!(light_colors().surface.r, 1.);
        assert_eq!(dark_colors().surface.r, 31. / 255.);
        assert_eq!(dark_colors().primary, light_colors().primary);
        assert_ne!(
            light_colors().surface_overlay.a,
            dark_colors().surface_overlay.a
        );
    }

    #[test]
    fn radius_and_shadow_tokens_match_the_css() {
        assert_eq!(f32::from(radius(RadiusToken::Small)), 4.);
        assert_eq!(f32::from(radius(RadiusToken::Compact)), 6.);
        assert_eq!(f32::from(radius(RadiusToken::Default)), 8.);
        assert_eq!(f32::from(radius(RadiusToken::Medium)), 12.);
        assert_eq!(f32::from(radius(RadiusToken::Large)), 999.);
        for (token, layers) in [
            (ShadowToken::One, 3),
            (ShadowToken::Two, 1),
            (ShadowToken::Three, 1),
            (ShadowToken::Dialog, 2),
        ] {
            assert_eq!(shadow(token).len(), layers);
        }
    }
}
