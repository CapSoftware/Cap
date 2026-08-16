//! Colour tokens, transcribed from the web app's resolved values.
//!
//! The Tauri UI gets these from Radix Colors via Tailwind v4 `@theme` aliases,
//! with a handful of dark-mode entries overridden in
//! `apps/desktop/src/styles/theme.css` (`:root.dark`, which outranks Radix's own
//! `.dark`). The overridden ones are marked below -- they are *not* stock Radix,
//! so regenerating this from a Radix crate would silently change the palette.

use gpui::{Hsla, Rgba, WindowAppearance, rgb, rgba};

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

/// Every colour the main window draws with, already resolved for one appearance.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub appearance: Appearance,

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

    pub red_9: Rgba,
    pub red_10: Rgba,

    /// `--blue-500`: the device-list selection fill and the Mode pill's ring.
    /// Distinct from `blue-9`; the two are not interchangeable.
    pub blue_500: Rgba,

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

            red_9: rgb(0xe5484d),
            red_10: rgb(0xdc3e42),

            blue_500: rgb(0x3666c5),

            text_primary: rgba(0x12161ff2),
        }
    }

    pub fn dark() -> Self {
        Self {
            appearance: Appearance::Dark,

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

            red_9: rgb(0xe5484d),
            red_10: rgb(0xec5d5e),

            blue_500: rgb(0x0a84ff),

            text_primary: rgba(0xfffffff2),
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

    pub fn tile_selected_hover_bg(&self) -> Hsla {
        if self.is_dark() {
            let mut color: Hsla = self.blue_4.into();
            color.a = 0.4;
            color
        } else {
            self.blue_4.into()
        }
    }

    /// Traffic light fills. Minimize is never drawn in the main window
    /// (`showMinimize={false}`), so only close and zoom are needed.
    pub const TRAFFIC_CLOSE: u32 = 0xff5f57;
    pub const TRAFFIC_ZOOM: u32 = 0x28c840;
    pub const TRAFFIC_INACTIVE: u32 = 0xdcdcdc;
}
