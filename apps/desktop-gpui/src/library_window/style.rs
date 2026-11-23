//! The library window's measurements. Colours come from the notes window's
//! palette so the two windows read as one family; values that builder AP's
//! shared glass tokens also define are named the same way so they can be
//! swapped for `meetings_ui::documents::glass` once that lands.

use gpui::{BoxShadow, Hsla, hsla, point, px};

pub use crate::meetings_ui::documents::style::Palette;

pub const DEFAULT_WIDTH: f32 = 1180.;
pub const DEFAULT_HEIGHT: f32 = 780.;
pub const MIN_WIDTH: f32 = 720.;
pub const MIN_HEIGHT: f32 = 480.;
/// AppKit draws a titled window's frame (edge highlight, shadow) at 16 pt on
/// macOS 27; the content clip must match it or the frame shows as a ring.
pub const MATERIAL_RADIUS: f64 = 16.;
pub const PLAIN_WINDOW_RADIUS: f32 = 12.;

pub const SIDEBAR_WIDTH: f32 = 236.;
/// Rows in the sidebar's source list.
pub const ROW_HEIGHT: f32 = 28.;
pub const ROW_RADIUS: f32 = 8.;
pub const SECTION_TITLE_SIZE: f32 = 12.5;
pub const TOOLBAR_HEIGHT: f32 = 52.;
/// The search field keeps this width whatever else is in the toolbar: the
/// title gives way first.
pub const SEARCH_WIDTH: f32 = 280.;
pub const SEARCH_MIN_WIDTH: f32 = 200.;
pub const CONTENT_PAD: f32 = 28.;
/// Direction B floats the page on the window's glass.
pub const PAGE_INSET: f32 = 8.;
pub const PAGE_RADIUS: f32 = MATERIAL_RADIUS as f32 - PAGE_INSET;
pub const CARD_RADIUS: f32 = 12.;
pub const LIST_ROW_HEIGHT: f32 = 56.;
pub const GRID_MIN_TILE: f32 = 200.;
pub const GRID_GAP: f32 = 18.;

pub fn card_shadow(dark: bool) -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: hsla(0., 0., 0., if dark { 0.34 } else { 0.07 }),
            offset: point(px(0.), px(6.)),
            blur_radius: px(18.),
            spread_radius: px(0.),
            inset: false,
        },
        BoxShadow {
            color: hsla(0., 0., 0., if dark { 0.40 } else { 0.06 }),
            offset: point(px(0.), px(1.)),
            blur_radius: px(2.),
            spread_radius: px(0.),
            inset: false,
        },
    ]
}

/// A painted glass capsule: tint fill, lit top lip, soft contact shadow. No
/// live blur, so it costs the same over scrolling content on every OS.
pub fn capsule_shadow(dark: bool) -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: hsla(0., 0., 1., if dark { 0.08 } else { 0.7 }),
            offset: point(px(0.), px(0.5)),
            blur_radius: px(0.),
            spread_radius: px(0.),
            inset: true,
        },
        BoxShadow {
            color: hsla(0., 0., 0., if dark { 0.30 } else { 0.06 }),
            offset: point(px(0.), px(1.)),
            blur_radius: px(3.),
            spread_radius: px(0.),
            inset: false,
        },
    ]
}

pub fn capsule_fill(dark: bool) -> Hsla {
    if dark {
        hsla(0., 0., 1., 0.08)
    } else {
        hsla(0., 0., 1., 0.85)
    }
}

pub fn capsule_border(dark: bool) -> Hsla {
    if dark {
        hsla(0., 0., 1., 0.08)
    } else {
        hsla(0., 0., 0., 0.08)
    }
}

pub fn thumb_well(dark: bool) -> Hsla {
    if dark {
        hsla(240. / 360., 0.06, 0.16, 1.)
    } else {
        hsla(40. / 360., 0.12, 0.93, 1.)
    }
}

/// The sidebar's wash over the window glass (AP's `glass::sidebar_wash`).
pub fn sidebar_wash(dark: bool) -> Hsla {
    if dark {
        hsla(240. / 360., 0.04, 0.11, 0.50)
    } else {
        hsla(0., 0., 1., 0.45)
    }
}

/// The month band of a calendar leaf, the red calendars have always used.
pub fn calendar_red(dark: bool) -> Hsla {
    if dark {
        hsla(3. / 360., 0.78, 0.58, 1.)
    } else {
        hsla(3. / 360., 0.82, 0.55, 1.)
    }
}

pub fn leaf_face(dark: bool) -> Hsla {
    if dark {
        hsla(240. / 360., 0.04, 0.22, 1.)
    } else {
        hsla(0., 0., 1., 1.)
    }
}

pub const MEDIA_RADIUS: f32 = 10.;
pub const LEAD_WIDTH: f32 = 64.;
pub const LEAD_HEIGHT: f32 = 40.;
pub const LEAD_RADIUS: f32 = 6.;

/// One neutral surface for every kind: colour is kept for state.
pub fn well(dark: bool) -> Hsla {
    if dark {
        hsla(0., 0., 1., 0.045)
    } else {
        hsla(0., 0., 0., 0.03)
    }
}

pub fn wave_ink(p: &Palette) -> Hsla {
    Hsla {
        a: if p.dark { 0.5 } else { 0.42 },
        ..p.text
    }
}
