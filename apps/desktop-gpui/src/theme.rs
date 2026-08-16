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
/// `<html>`: `data-macos-native-material` ("panel" for the main window) and
/// `data-macos-visual-system` ("liquid-glass" or "vibrancy"). Only the panel
/// material's resolved values are transcribed here -- the settings and
/// teleprompter materials belong to windows this app does not have yet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialTokens {
    pub kind: MaterialKind,

    /// `.cap-window-shell`'s background.
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

    /// `--blue-500`: the device-list selection fill and the Mode pill's ring.
    /// Distinct from `blue-9`; the two are not interchangeable.
    pub blue_500: Rgba,

    /// `--red-300`, the recording bar's stop button. Same value in both themes.
    pub red_300: Rgba,

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

            blue_500: rgb(0x3666c5),
            red_300: rgb(0xff4766),

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

            blue_500: rgb(0x0a84ff),
            red_300: rgb(0xff4766),

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
