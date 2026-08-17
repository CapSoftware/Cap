//! Colour tokens, transcribed from the web app's resolved values.
//!
//! The Tauri UI gets these from Radix Colors via Tailwind v4 `@theme` aliases,
//! with a handful of dark-mode entries overridden in
//! `apps/desktop/src/styles/theme.css` (`:root.dark`, which outranks Radix's own
//! `.dark`). The overridden ones are marked below -- they are *not* stock Radix,
//! so regenerating this from a Radix crate would silently change the palette.

use gpui::{Hsla, Rgba, WindowAppearance, rgb, rgba};

use crate::platform::MaterialKind;

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
    /// Only Liquid Glass remaps the body's gray fills: every
    /// `.cap-window-body .bg-gray-N` rule in `theme.css` is gated on
    /// `[data-macos-visual-system="liquid-glass"]`. Under vibrancy the body
    /// keeps its Radix grays and only the shell and header change.
    fn remaps_body(&self) -> bool {
        self.kind == MaterialKind::LiquidGlass
    }

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
                // `--macos-settings-sidebar: rgba(255, 255, 255, 0.58)`
                sidebar: rgba(0xffffff94),
                // `--macos-settings-content: #f6f6f5` -- opaque, unlike every
                // other surface here: under Liquid Glass only the sidebar
                // shows the backdrop.
                content: rgba(0xf6f6f5ff),
                // `--macos-settings-card: rgba(255, 255, 255, 0.92)`
                card: rgba(0xffffffeb),
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
                // `--macos-settings-content: rgba(17, 17, 17, 0.92)`
                content: rgba(0x111111eb),
                // `--macos-settings-card: rgba(28, 28, 28, 0.94)`
                card: rgba(0x1c1c1cf0),
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
                // `--macos-settings-content: rgba(244, 244, 243, 0.84)`
                content: rgba(0xf4f4f3d6),
                // `--macos-settings-card: rgba(249, 249, 248, 0.94)`
                card: rgba(0xf9f9f8f0),
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
                // `--macos-settings-content: rgba(17, 17, 17, 0.94)`
                content: rgba(0x111111f0),
                // `--macos-settings-card: rgba(28, 28, 28, 0.96)`
                card: rgba(0x1c1c1cf5),
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
    pub blue_8: Rgba,
    pub blue_9: Rgba,
    pub blue_10: Rgba,
    pub blue_11: Rgba,

    pub red_2: Rgba,
    pub red_4: Rgba,
    pub red_9: Rgba,
    pub red_10: Rgba,

    /// The settings page's one non-gray, non-blue accent: the "recommended Cap
    /// windows are not excluded" warning is `border-amber-6 bg-amber-3/30
    /// text-amber-11`. Stock Radix -- `theme.css` overrides no amber step.
    pub amber_3: Rgba,
    pub amber_6: Rgba,
    pub amber_11: Rgba,

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
    /// ring-offset-2 ring-offset-gray-200`.
    pub gray_200_legacy: Rgba,
    pub gray_300_legacy: Rgba,
    pub gray_500_legacy: Rgba,

    /// `--text-primary`, the root text colour. Slightly translucent by design.
    pub text_primary: Rgba,
}

impl Theme {
    pub fn new(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Light => Self::light(),
            Appearance::Dark => Self::dark(),
        }
    }

    pub fn light() -> Self {
        Self {
            appearance: Appearance::Light,
            material: None,

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
            blue_8: rgb(0x5eb1ef),
            blue_9: rgb(0x0090ff),
            blue_10: rgb(0x0588f0),
            blue_11: rgb(0x0d74ce),

            red_2: rgb(0xfff7f7),
            red_4: rgb(0xffdbdc),
            red_9: rgb(0xe5484d),
            red_10: rgb(0xdc3e42),

            amber_3: rgb(0xfff7c2),
            amber_6: rgb(0xf3d673),
            amber_11: rgb(0xab6400),

            blue_500: rgb(0x3666c5),
            red_300: rgb(0xff4766),

            // `theme.css:38-44`.
            gray_200_legacy: rgb(0xe4e6ed),
            gray_300_legacy: rgb(0xc7ccda),
            gray_500_legacy: rgb(0x161b26),

            text_primary: rgba(0x12161ff2),
        }
    }

    pub fn dark() -> Self {
        Self {
            appearance: Appearance::Dark,
            material: None,

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
            blue_8: rgb(0x2870bd),
            blue_9: rgb(0x0090ff),
            blue_10: rgb(0x3b9eff),
            blue_11: rgb(0x70b8ff),

            red_2: rgb(0x201314),
            red_4: rgb(0x500f1c),
            red_9: rgb(0xe5484d),
            red_10: rgb(0xec5d5e),

            amber_3: rgb(0x302008),
            amber_6: rgb(0x5c3d05),
            amber_11: rgb(0xffca16),

            blue_500: rgb(0x0a84ff),
            red_300: rgb(0xff4766),

            // `theme.css:101-107`.
            gray_200_legacy: rgb(0x282828),
            gray_300_legacy: rgb(0x323232),
            gray_500_legacy: rgb(0xffffff),

            text_primary: rgba(0xfffffff2),
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

    /// `.cap-window-shell`'s background: the material's tint when one is
    /// installed, `bg-gray-1` otherwise.
    pub fn shell_bg(&self) -> Hsla {
        match self.material {
            Some(material) => material.shell.into(),
            None => self.gray_1.into(),
        }
    }

    /// The shell's `1px solid var(--macos-settings-border)`. Liquid Glass
    /// draws none (`.cap-window-shell { border: 0 }`), and neither does the
    /// bare window.
    pub fn shell_border(&self) -> Option<Hsla> {
        self.material
            .filter(|material| !material.remaps_body())
            .map(|material| material.border.into())
    }

    /// `.cap-window-header`'s background.
    pub fn header_bg(&self) -> Hsla {
        match self.material {
            Some(material) => material.header.into(),
            None => self.gray_2.into(),
        }
    }

    /// The `divide-y divide-gray-5` hairline under the header. Liquid Glass
    /// erases it: `.cap-window-shell > * + * { border-color: transparent }`.
    pub fn header_border(&self) -> Hsla {
        match self.material {
            Some(material) if material.remaps_body() => gpui::transparent_black(),
            Some(material) => material.border.into(),
            None => self.gray_5.into(),
        }
    }

    /// `.cap-window-body`'s inherited text colour.
    pub fn body_text(&self) -> Hsla {
        match self.material {
            Some(material) if material.remaps_body() => material.text.into(),
            _ => self.text_primary.into(),
        }
    }

    /// A `.bg-gray-N` fill inside `.cap-window-body`.
    ///
    /// ```text
    /// .bg-gray-2, .bg-gray-3 { background-color: var(--macos-settings-control-fill) }
    /// .bg-gray-4            { background-color: var(--macos-settings-control-hover) }
    /// .bg-gray-5            { background-color: var(--macos-settings-control-active) }
    /// ```
    ///
    /// (The `.dark\:bg-gray-3` / `.dark\:bg-gray-4` rule lands on the same
    /// `control-fill`, so a dark-mode `bg-gray-3 dark:bg-gray-4` pair --
    /// already collapsed to one token by the time it reaches here -- resolves
    /// identically either way.)
    pub fn body_fill(&self, step: u8) -> Hsla {
        let Some(material) = self.material.filter(MaterialTokens::remaps_body) else {
            return self.gray(step);
        };
        match step {
            2 | 3 => material.control_fill.into(),
            4 => material.control_hover.into(),
            5 => material.control_active.into(),
            _ => self.gray(step),
        }
    }

    /// A `hover:bg-gray-N` fill inside `.cap-window-body`.
    ///
    /// ```text
    /// [class*="hover:bg-gray-4"]:hover, [class*="hover:bg-gray-5"]:hover
    ///   { background-color: var(--macos-settings-control-hover) }
    /// [class*="hover:bg-gray-6"]:hover, [class*="hover:bg-gray-7"]:hover
    ///   { background-color: var(--macos-settings-selection) }
    /// ```
    pub fn body_hover_fill(&self, step: u8) -> Hsla {
        let Some(material) = self.material.filter(MaterialTokens::remaps_body) else {
            return self.gray(step);
        };
        match step {
            4 | 5 => material.control_hover.into(),
            6 | 7 => material.selection.into(),
            _ => self.gray(step),
        }
    }

    /// A `border-gray-N` inside `.cap-window-body`.
    ///
    /// ```text
    /// .border-gray-4, .dark\:border-gray-5 { border-color: var(--macos-settings-border) }
    /// .border-gray-5, .border-gray-6       { border-color: var(--macos-settings-border) }
    /// ```
    pub fn body_border(&self, step: u8) -> Hsla {
        let Some(material) = self.material.filter(MaterialTokens::remaps_body) else {
            return self.gray(step);
        };
        match step {
            4..=6 => material.border.into(),
            _ => self.gray(step),
        }
    }

    /// `ring-offset-gray-1`, the 1px gap between the selected Mode button and
    /// its blue ring. Liquid Glass makes it transparent
    /// (`--tw-ring-offset-color: transparent`) so the ring is not sitting on a
    /// solid disc floating over the material.
    pub fn ring_offset(&self) -> Hsla {
        match self.material {
            Some(material) if material.remaps_body() => gpui::transparent_black(),
            _ => self.gray_1.into(),
        }
    }

    // ---- The settings window's surfaces -------------------------------
    //
    // Same tokens, a different set of elements. Every rule quoted below is
    // under `[data-macos-native-material="settings"]`; the fallbacks are the
    // Tailwind classes the TSX carries when no material was installed, which
    // is what the window would paint on a non-mac.

    /// `.cap-settings-shell`'s corner: `border-radius:
    /// var(--macos-settings-window-radius)` with no per-material override
    /// (unlike `.cap-window-shell`'s `16px` for "panel").
    pub fn settings_window_radius(&self) -> f32 {
        self.material
            .map(|material| material.window_radius)
            .unwrap_or(16.)
    }

    /// `.cap-settings-sidebar { background: var(--macos-settings-sidebar) }`,
    /// `bg-gray-2` without a material.
    pub fn settings_sidebar_bg(&self) -> Hsla {
        match self.material {
            Some(material) => material.sidebar.into(),
            None => self.gray_2.into(),
        }
    }

    /// `.cap-settings-content { background: var(--macos-settings-content) }`.
    /// Bare, the pane has no background of its own and shows the shell's
    /// `bg-gray-1`.
    pub fn settings_content_bg(&self) -> Hsla {
        match self.material {
            Some(material) => material.content.into(),
            None => self.gray_1.into(),
        }
    }

    /// `.cap-settings-card, .cap-settings-content .bg-gray-2
    /// { background-color: var(--macos-settings-card) }`.
    pub fn settings_card_bg(&self) -> Hsla {
        match self.material {
            Some(material) => material.card.into(),
            None => self.gray_2.into(),
        }
    }

    /// `.cap-settings-content .bg-gray-3, .bg-gray-4, .bg-gray-5
    /// { background-color: var(--macos-settings-fill) }` -- selects, inline
    /// code chips, the summary boxes.
    pub fn settings_fill(&self) -> Hsla {
        match self.material {
            Some(material) => material.fill.into(),
            None => self.gray_3.into(),
        }
    }

    /// `.cap-settings-nav-item:hover`, `.cap-settings-profile:hover`
    /// `{ background: var(--macos-settings-hover) }`; `hover:bg-gray-3` bare.
    pub fn settings_hover(&self) -> Hsla {
        match self.material {
            Some(material) => material.hover.into(),
            None => self.gray_3.into(),
        }
    }

    /// `.cap-settings-nav-item.bg-gray-5 { background:
    /// var(--macos-settings-selection) }` -- the selected sidebar row.
    pub fn settings_selection(&self) -> Hsla {
        match self.material {
            Some(material) => material.selection.into(),
            None => self.gray_5.into(),
        }
    }

    /// `--macos-settings-border`: the row dividers, the account footer's top
    /// rule, and the sidebar/content divider.
    pub fn settings_border(&self) -> Hsla {
        match self.material {
            Some(material) => material.border.into(),
            None => self.gray_3.into(),
        }
    }

    /// The divider between the sidebar and the content pane:
    /// `[..liquid-glass][..settings] .cap-settings-shell > * + *
    /// { border-color: var(--macos-settings-border) }`. Only the glass path
    /// remaps it; on the others the shell's own `divide-x divide-gray-3`
    /// stands.
    pub fn settings_divider(&self) -> Hsla {
        match self.material {
            Some(material) if material.kind == MaterialKind::LiquidGlass => material.border.into(),
            _ => self.gray_3.into(),
        }
    }

    /// `.cap-settings-page { color: var(--macos-settings-text) }`; the page's
    /// `text-gray-12` bare.
    pub fn settings_text(&self) -> Hsla {
        match self.material {
            Some(material) => material.text.into(),
            None => self.gray_12.into(),
        }
    }

    /// `.cap-settings-page .text-gray-10, .text-gray-11 { color:
    /// var(--macos-settings-muted) }` -- every description line.
    pub fn settings_muted(&self) -> Hsla {
        match self.material {
            Some(material) => material.muted.into(),
            None => self.gray_10.into(),
        }
    }

    // ---- The teleprompter window's shell -------------------------------
    //
    // `applyMacOSWindowMaterial("teleprompter")` sets the same two data
    // attributes as the other two windows, and `theme.css` gives the material
    // exactly two rules of its own:
    //
    // ```text
    // [data-macos-native-material="teleprompter"] .cap-window-shell { border-radius: 16px }
    // [..visual-system="liquid-glass"][..native-material="teleprompter"]
    //   .cap-window-shell { border-radius: 22px }
    // ```
    //
    // Everything else it paints comes from the shared blocks: the base
    // `[data-macos-native-material] .cap-window-shell` wash + border under
    // vibrancy, and `[..="liquid-glass"] .cap-window-shell { background:
    // transparent; border: 0 }` under glass. The panel's `rgba(255,255,255,
    // 0.55)` tint is *not* inherited -- that rule is `[..="panel"]`-gated --
    // so under Liquid Glass this window is bare glass. The body remaps are
    // panel-gated too, so the footer and script keep their Radix grays.

    /// `.cap-window-shell` under material `"teleprompter"`.
    pub fn teleprompter_shell_bg(&self) -> Hsla {
        match self.material {
            // `[data-macos-visual-system="liquid-glass"] .cap-window-shell
            //  { background: transparent }`, with no panel-style tint on top.
            Some(material) if material.remaps_body() => gpui::transparent_black(),
            // `background: var(--macos-settings-window)`, which is what
            // `MaterialTokens::shell` already holds on the vibrancy path.
            Some(material) => material.shell.into(),
            // No material (non-mac): the route's own
            // `bg-gray-1/90 rounded-2xl border border-gray-5` fallback.
            None => Self::with_alpha(self.gray_1, 0.9),
        }
    }

    /// The teleprompter shell's `1px solid var(--macos-settings-border)` --
    /// the same base rule the panel material takes, erased by the glass block.
    /// Without a material the route draws `border border-gray-5`.
    pub fn teleprompter_shell_border(&self) -> Option<Hsla> {
        match self.material {
            Some(material) if material.remaps_body() => None,
            Some(material) => Some(material.border.into()),
            None => Some(self.gray_5.into()),
        }
    }

    /// 22 under Liquid Glass, 16 under vibrancy; `rounded-2xl` (16) is also
    /// what the non-mac fallback draws.
    pub fn teleprompter_window_radius(&self) -> f32 {
        match self.material_kind() {
            Some(MaterialKind::LiquidGlass) => 22.,
            _ => 16.,
        }
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

    pub fn tile_selected_hover_bg(&self) -> Hsla {
        if self.is_dark() {
            let mut color: Hsla = self.blue_4.into();
            color.a = 0.4;
            color
        } else {
            self.blue_4.into()
        }
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

    /// Traffic light fills. Minimize is never drawn in the main window
    /// (`showMinimize={false}`), so only close and zoom are needed.
    pub const TRAFFIC_CLOSE: u32 = 0xff5f57;
    pub const TRAFFIC_ZOOM: u32 = 0x28c840;
    pub const TRAFFIC_INACTIVE: u32 = 0xdcdcdc;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With no material the palette must be byte-for-byte what it was before
    /// the material existed: the shell is opaque `gray-1`, and every body fill
    /// is its plain Radix step.
    #[test]
    fn no_material_keeps_the_radix_palette() {
        for theme in [Theme::light(), Theme::dark()] {
            assert_eq!(theme.shell_bg(), Hsla::from(theme.gray_1));
            assert_eq!(theme.shell_border(), None);
            assert_eq!(theme.header_bg(), Hsla::from(theme.gray_2));
            assert_eq!(theme.header_border(), Hsla::from(theme.gray_5));
            assert_eq!(theme.body_text(), Hsla::from(theme.text_primary));
            assert_eq!(theme.ring_offset(), Hsla::from(theme.gray_1));
            for step in 1..=12 {
                assert_eq!(theme.body_fill(step), theme.gray(step));
                assert_eq!(theme.body_hover_fill(step), theme.gray(step));
                assert_eq!(theme.body_border(step), theme.gray(step));
            }
        }
    }

    /// The `.cap-window-body` remaps are gated on
    /// `[data-macos-visual-system="liquid-glass"]`, so vibrancy must leave
    /// them alone and change only the shell and header.
    #[test]
    fn vibrancy_changes_the_shell_but_not_the_body() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let theme = Theme::new(appearance).with_material(Some(MaterialKind::Vibrancy));
            assert_ne!(theme.shell_bg(), Hsla::from(theme.gray_1));
            // `border: 1px solid var(--macos-settings-border)` -- only the
            // vibrancy path draws it.
            assert!(theme.shell_border().is_some());
            for step in 1..=12 {
                assert_eq!(theme.body_fill(step), theme.gray(step));
                assert_eq!(theme.body_hover_fill(step), theme.gray(step));
                assert_eq!(theme.body_border(step), theme.gray(step));
            }
        }
    }

    /// The exact `theme.css` mapping for material "panel" under Liquid Glass.
    #[test]
    fn liquid_glass_maps_body_fills_to_the_panel_material() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let theme = Theme::new(appearance).with_material(Some(MaterialKind::LiquidGlass));
            let material = theme.material.expect("material was just installed");

            // `.cap-window-shell { border: 0; box-shadow: none }`, then the
            // panel tint.
            assert_eq!(theme.shell_border(), None);
            assert_eq!(theme.shell_bg(), Hsla::from(material.shell));
            // `.cap-window-header { background: transparent;
            //  border-bottom-color: transparent }`
            assert_eq!(theme.header_bg().a, 0.);
            assert_eq!(theme.header_border(), gpui::transparent_black());
            assert_eq!(theme.body_text(), Hsla::from(material.text));
            // `.ring-offset-gray-1 { --tw-ring-offset-color: transparent }`
            assert_eq!(theme.ring_offset(), gpui::transparent_black());

            // `.bg-gray-2, .bg-gray-3 -> control-fill`, `.bg-gray-4 ->
            // control-hover`, `.bg-gray-5 -> control-active`.
            assert_eq!(theme.body_fill(2), Hsla::from(material.control_fill));
            assert_eq!(theme.body_fill(3), Hsla::from(material.control_fill));
            assert_eq!(theme.body_fill(4), Hsla::from(material.control_hover));
            assert_eq!(theme.body_fill(5), Hsla::from(material.control_active));
            // Untouched steps stay Radix.
            assert_eq!(theme.body_fill(6), theme.gray(6));

            // `hover:bg-gray-4|5 -> control-hover`, `hover:bg-gray-6|7 ->
            // selection`.
            assert_eq!(theme.body_hover_fill(4), Hsla::from(material.control_hover));
            assert_eq!(theme.body_hover_fill(5), Hsla::from(material.control_hover));
            assert_eq!(theme.body_hover_fill(6), Hsla::from(material.selection));
            assert_eq!(theme.body_hover_fill(7), Hsla::from(material.selection));

            // `border-gray-4|5|6 -> --macos-settings-border`.
            for step in 4..=6 {
                assert_eq!(theme.body_border(step), Hsla::from(material.border));
            }
            assert_eq!(theme.body_border(8), theme.gray(8));
        }
    }

    /// The settings window's own surfaces, material "settings".
    #[test]
    fn liquid_glass_settings_surfaces() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let theme = Theme::new(appearance).with_material(Some(MaterialKind::LiquidGlass));
            let material = theme.material.expect("material was just installed");

            // `--macos-settings-window-radius: 26px` under the glass block,
            // and the settings shell takes it unmodified -- 16 is the panel's
            // override, which must not leak over here.
            assert_eq!(theme.settings_window_radius(), 26.);
            assert_eq!(material.sidebar_radius, 18.);

            assert_eq!(theme.settings_sidebar_bg(), Hsla::from(material.sidebar));
            assert_eq!(theme.settings_content_bg(), Hsla::from(material.content));
            assert_eq!(theme.settings_card_bg(), Hsla::from(material.card));
            assert_eq!(theme.settings_fill(), Hsla::from(material.fill));
            assert_eq!(theme.settings_hover(), Hsla::from(material.hover));
            assert_eq!(theme.settings_selection(), Hsla::from(material.selection));
            assert_eq!(theme.settings_border(), Hsla::from(material.border));
            assert_eq!(theme.settings_divider(), Hsla::from(material.border));
            assert_eq!(theme.settings_text(), Hsla::from(material.text));
            assert_eq!(theme.settings_muted(), Hsla::from(material.muted));
        }

        // The sidebar is a wash over the live backdrop; the content pane is
        // `#f6f6f5`, fully opaque, in light mode only.
        let light = Theme::light().with_material(Some(MaterialKind::LiquidGlass));
        assert!((light.settings_sidebar_bg().a - 0.58).abs() < 0.01);
        assert_eq!(light.settings_content_bg().a, 1.);
        let dark = Theme::dark().with_material(Some(MaterialKind::LiquidGlass));
        assert!((dark.settings_sidebar_bg().a - 0.88).abs() < 0.01);
        assert!((dark.settings_content_bg().a - 0.92).abs() < 0.01);
    }

    /// Vibrancy keeps the `:root` radius and the pre-Tahoe surface set, and
    /// the sidebar/content divider falls back to the shell's own
    /// `divide-x divide-gray-3`.
    #[test]
    fn vibrancy_settings_surfaces() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let theme = Theme::new(appearance).with_material(Some(MaterialKind::Vibrancy));
            assert_eq!(theme.settings_window_radius(), 16.);
            assert_eq!(theme.settings_divider(), theme.gray(3));
        }
        // No material at all: the Tailwind classes, unremapped.
        let bare = Theme::light();
        assert_eq!(bare.settings_sidebar_bg(), bare.gray(2));
        assert_eq!(bare.settings_card_bg(), bare.gray(2));
        assert_eq!(bare.settings_fill(), bare.gray(3));
        assert_eq!(bare.settings_selection(), bare.gray(5));
        assert_eq!(bare.settings_text(), bare.gray(12));
        assert_eq!(bare.settings_muted(), bare.gray(10));
        assert_eq!(bare.settings_window_radius(), 16.);
    }

    /// Material `"teleprompter"` differs from `"panel"` in exactly one thing:
    /// the radius. It gets no tint under Liquid Glass (that rule is
    /// `[..native-material="panel"]`-gated) and the shared vibrancy wash
    /// otherwise.
    #[test]
    fn the_teleprompter_material_is_the_shared_one_at_radius_22() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let glass = Theme::new(appearance).with_material(Some(MaterialKind::LiquidGlass));
            assert_eq!(glass.teleprompter_window_radius(), 22.);
            assert_eq!(glass.teleprompter_shell_bg(), gpui::transparent_black());
            assert_eq!(glass.teleprompter_shell_border(), None);
            // The panel's tint must not leak over: it is a different window.
            assert_ne!(glass.teleprompter_shell_bg(), glass.shell_bg());

            let vibrancy = Theme::new(appearance).with_material(Some(MaterialKind::Vibrancy));
            assert_eq!(vibrancy.teleprompter_window_radius(), 16.);
            // `background: var(--macos-settings-window)` -- the same value the
            // panel and settings shells take on this path.
            assert_eq!(vibrancy.teleprompter_shell_bg(), vibrancy.shell_bg());
            assert!(vibrancy.teleprompter_shell_border().is_some());
        }

        // No material at all: the route's own non-macOS classes.
        let bare = Theme::dark();
        assert_eq!(bare.teleprompter_window_radius(), 16.);
        assert!((bare.teleprompter_shell_bg().a - 0.9).abs() < 0.01);
        assert_eq!(bare.teleprompter_shell_border(), Some(bare.gray(5)));
    }

    /// The light panel tint is `rgba(255, 255, 255, 0.55)` and the dark one
    /// `rgba(17, 17, 17, 0.88)` -- both translucent, or there would be no
    /// glass to see.
    #[test]
    fn panel_glass_tint_is_translucent() {
        let light = Theme::light().with_material(Some(MaterialKind::LiquidGlass));
        let dark = Theme::dark().with_material(Some(MaterialKind::LiquidGlass));
        assert!((light.shell_bg().a - 0.55).abs() < 0.01);
        assert!((dark.shell_bg().a - 0.88).abs() < 0.01);
    }
}
