//! The editor's crop mode: `components/Cropper.tsx` (1589 lines) and the
//! `type: "crop"` arm of `routes/editor/Editor.tsx`'s `Dialogs()`
//! (`Editor.tsx:940-1445`).
//!
//! # What crop mode *is*
//!
//! It is **not** a mode of the player. The toolbar's Crop button is
//! `cropDialogHandler` (`Player.tsx:161-180`), which stops playback and opens a
//! **modal dialog** (`max-w-[1180px]`) holding two side-by-side boxes: the
//! cropper over the *raw, uncropped* display recording on the left, and the
//! live composited preview on the right. The player underneath is untouched
//! until Save.
//!
//! # The two coordinate spaces, which decide everything
//!
//! `Cropper` keeps its rectangle in **container pixels** -- `rawBounds`, the
//! CSS-pixel space of the box the frame is drawn in (`:262`). What the config
//! stores is in **target-resolution pixels**: the raw display recording's own
//! dimensions, `editorInstance.recordings.segments[0].display`
//! (`Editor.tsx:963`, passed as `targetSize`).
//!
//! ```text
//! scale   = target / container                     (`logicalScale`, :342-349)
//! real    = round(raw * scale), then clamped into  (`realBounds`,   :351-372)
//!           [0, target] on both axes
//! raw     = max(0, real / scale)                   (`boundsToRaw`,  :422-430)
//! ```
//!
//! The container is [`crop_box_size`]: the display's aspect fitted into
//! `min(vw * 0.4, 520) x min(vh * 0.5, 520)` (`Editor.tsx:1010-1023`). At the
//! editor's 1275x800 that is 510x400, so a 3024x1964 recording gets a 510x331
//! box and one container pixel is `3024 / 510 = 5.929` target pixels.
//!
//! Every number the user sees in the header -- Size and Position -- is
//! `realBounds`, i.e. target space. Every number the pointer maths works in is
//! `rawBounds`.
//!
//! # What is deliberately *not* here
//!
//! The `minSize` / `maxSize` props: the editor's cropper passes neither
//! (`Editor.tsx:1302-1335`), so `rawSizeConstraint()` is `{min: null, max:
//! null}`. The general form is transcribed and tested anyway, because it is
//! what `constrainBoundsToSize` does and the capture-area cropper does pass
//! them.

use std::collections::BTreeSet;

use crate::{
    editor_window::{EDITOR_PREVIEW_FPS, EditorWindow, letterbox},
    ui,
};
use cap_project::{Crop, XY};
use gpui::{
    AnyElement, Context, CursorStyle, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, RenderImage,
    SharedString, StatefulInteractiveElement, Styled, Window, div, img, px, svg,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// `CropBounds` (`Cropper.tsx:27-32`). Which space it is in is the caller's
/// business -- see the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CropBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `CROP_ZERO` (`:33`).
pub const CROP_ZERO: CropBounds = CropBounds {
    x: 0.,
    y: 0.,
    width: 0.,
    height: 0.,
};

impl CropBounds {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// `ORIGIN_CENTER` (`:91`).
pub const ORIGIN_CENTER: Vec2 = Vec2::new(0.5, 0.5);
/// The top-left origin `setCropProperty` and the keyboard's resize use.
pub const ORIGIN_TOP_LEFT: Vec2 = Vec2::new(0., 0.);

/// `Ratio` (`:80`) -- kept as the integer pair so the menu and the badge can
/// print `16:9` rather than `1.7777`.
pub type Ratio = (u32, u32);

/// `COMMON_RATIOS` (`:81-90`), in the source's order: it is also the menu's.
pub const COMMON_RATIOS: [Ratio; 8] = [
    (1, 1),
    (2, 1),
    (3, 2),
    (4, 3),
    (9, 16),
    (16, 9),
    (16, 10),
    (21, 9),
];

pub fn ratio_to_value(ratio: Ratio) -> f64 {
    f64::from(ratio.0) / f64::from(ratio.1)
}

/// `clamp` (`:94`).
fn clamp(n: f64, min: f64, max: f64) -> f64 {
    n.max(min).min(max)
}

/// `easeInOutCubic` (`:95-96`).
fn ease_in_out_cubic(t: f64) -> f64 {
    if t < 0.5 {
        4. * t * t * t
    } else {
        1. - (-2. * t + 2.).powi(3) / 2.
    }
}

/// **`Math.round`, not `f64::round`.** JavaScript rounds a half *up* (towards
/// +Infinity) while Rust rounds it *away from zero*, so `-0.5` is `-0` in the
/// source and `-1` here. Every rounding in this module is a drag's arithmetic
/// and a drag routinely produces negative intermediates, so the difference is
/// observable.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// `"l"` / `"t"`.
    Low,
    /// `"r"` / `"b"`.
    High,
    /// `"c"`.
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    N,
    E,
    S,
    W,
    Nw,
    Ne,
    Se,
    Sw,
}

impl Direction {
    pub fn label(self) -> &'static str {
        match self {
            Self::N => "n",
            Self::E => "e",
            Self::S => "s",
            Self::W => "w",
            Self::Nw => "nw",
            Self::Ne => "ne",
            Self::Se => "se",
            Self::Sw => "sw",
        }
    }

    /// `cursor` (`:55-62`), mapped onto gpui's own names.
    pub fn cursor(self) -> CursorStyle {
        match self {
            Self::N | Self::S => CursorStyle::ResizeUpDown,
            Self::E | Self::W => CursorStyle::ResizeLeftRight,
            Self::Nw | Self::Se => CursorStyle::ResizeUpLeftDownRight,
            Self::Ne | Self::Sw => CursorStyle::ResizeUpRightDownLeft,
        }
    }
}

/// `BoundsConstraints` (`:36-41`): which edges this handle moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Movable {
    pub top: bool,
    pub right: bool,
    pub bottom: bool,
    pub left: bool,
}

/// `HandleSide` (`:44-52`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Handle {
    pub x: Axis,
    pub y: Axis,
    pub direction: Direction,
    pub movable: Movable,
    pub origin: Vec2,
    pub is_corner: bool,
}

const fn handle(x: Axis, y: Axis, direction: Direction) -> Handle {
    Handle {
        x,
        y,
        direction,
        // `movable` (`:67-72`).
        movable: Movable {
            top: matches!(y, Axis::Low),
            bottom: matches!(y, Axis::High),
            left: matches!(x, Axis::Low),
            right: matches!(x, Axis::High),
        },
        // `origin` (`:73-76`): the *opposite* edge is the anchor, so a left
        // handle has origin.x = 1.
        origin: Vec2 {
            x: match x {
                Axis::Low => 1.,
                Axis::High => 0.,
                Axis::Center => 0.5,
            },
            y: match y {
                Axis::Low => 1.,
                Axis::High => 0.,
                Axis::Center => 0.5,
            },
        },
        is_corner: !matches!(x, Axis::Center) && !matches!(y, Axis::Center),
    }
}

/// `HANDLES` (`:54-79`), **in the source's order**: the four corners first,
/// then n, s, w, e. The order is load-bearing twice -- `HANDLES[3]` is the
/// bottom-right handle the draw-a-new-region gesture borrows (`:904-905`), and
/// hit-testing walks it front to back.
pub const HANDLES: [Handle; 8] = [
    handle(Axis::Low, Axis::Low, Direction::Nw),
    handle(Axis::High, Axis::Low, Direction::Ne),
    handle(Axis::Low, Axis::High, Direction::Sw),
    handle(Axis::High, Axis::High, Direction::Se),
    handle(Axis::Center, Axis::Low, Direction::N),
    handle(Axis::Center, Axis::High, Direction::S),
    handle(Axis::Low, Axis::Center, Direction::W),
    handle(Axis::High, Axis::Center, Direction::E),
];

/// `HANDLES[SE_HANDLE_INDEX]` (`:904`).
pub const SE_HANDLE: Handle = HANDLES[3];

// -- Bounds helpers (`:118-220`) --------------------------------------------

/// `moveBounds` (`:121-131`).
pub fn move_bounds(bounds: CropBounds, x: Option<f64>, y: Option<f64>) -> CropBounds {
    CropBounds {
        x: x.map_or(bounds.x, js_round),
        y: y.map_or(bounds.y, js_round),
        ..bounds
    }
}

/// `resizeBounds` (`:133-147`): keep the point at `origin` fixed.
pub fn resize_bounds(
    bounds: CropBounds,
    new_width: f64,
    new_height: f64,
    origin: Vec2,
) -> CropBounds {
    let from_x = bounds.x + bounds.width * origin.x;
    let from_y = bounds.y + bounds.height * origin.y;
    CropBounds {
        x: js_round(from_x - new_width * origin.x),
        y: js_round(from_y - new_height * origin.y),
        width: js_round(new_width),
        height: js_round(new_height),
    }
}

/// `scaleBounds` (`:149-156`).
pub fn scale_bounds(bounds: CropBounds, factor: f64, origin: Vec2) -> CropBounds {
    resize_bounds(
        bounds,
        bounds.width * factor,
        bounds.height * factor,
        origin,
    )
}

/// `constrainBoundsToRatio` (`:158-166`). Note it solves for *height* from the
/// width it already has, so the width is what survives a ratio change.
pub fn constrain_bounds_to_ratio(bounds: CropBounds, ratio: f64, origin: Vec2) -> CropBounds {
    let current = bounds.width / bounds.height;
    if (current - ratio).abs() < 0.001 {
        return bounds;
    }
    resize_bounds(bounds, bounds.width, bounds.width / ratio, origin)
}

/// `constrainBoundsToSize` (`:168-205`).
pub fn constrain_bounds_to_size(
    bounds: CropBounds,
    max: Option<Vec2>,
    min: Option<Vec2>,
    origin: Vec2,
    ratio: Option<f64>,
) -> CropBounds {
    let mut next = bounds;
    let mut max_w = max.map(|v| v.x);
    let mut max_h = max.map(|v| v.y);
    let mut min_w = min.map(|v| v.x);
    let mut min_h = min.map(|v| v.y);

    if let Some(ratio) = ratio.filter(|r| *r != 0.) {
        // The source's truthiness tests (`if (minW && minH)`) treat 0 as
        // absent, which is why these are `filter(|v| *v != 0.)`.
        if let (Some(w), Some(h)) = (min_w.filter(|v| *v != 0.), min_h.filter(|v| *v != 0.)) {
            let effective = w.max(h * ratio);
            min_w = Some(effective);
            min_h = Some(effective / ratio);
        }
        if let (Some(w), Some(h)) = (max_w.filter(|v| *v != 0.), max_h.filter(|v| *v != 0.)) {
            let effective = w.min(h * ratio);
            max_w = Some(effective);
            max_h = Some(effective / ratio);
        }
    }

    if let Some(max_w) = max_w.filter(|v| *v != 0.)
        && next.width > max_w
    {
        let height = ratio.map_or(next.height, |r| max_w / r);
        next = resize_bounds(next, max_w, height, origin);
    }
    if let Some(max_h) = max_h.filter(|v| *v != 0.)
        && next.height > max_h
    {
        let width = ratio.map_or(next.width, |r| max_h * r);
        next = resize_bounds(next, width, max_h, origin);
    }
    if let Some(min_w) = min_w.filter(|v| *v != 0.)
        && next.width < min_w
    {
        let height = ratio.map_or(next.height, |r| min_w / r);
        next = resize_bounds(next, min_w, height, origin);
    }
    if let Some(min_h) = min_h.filter(|v| *v != 0.)
        && next.height < min_h
    {
        let width = ratio.map_or(next.width, |r| min_h * r);
        next = resize_bounds(next, width, min_h, origin);
    }

    next
}

/// `slideBoundsIntoContainer` (`:207-220`): translate only, never resize.
pub fn slide_bounds_into_container(
    bounds: CropBounds,
    container_width: f64,
    container_height: f64,
) -> CropBounds {
    let mut x = bounds.x;
    let mut y = bounds.y;
    if x < 0. {
        x = 0.;
    }
    if y < 0. {
        y = 0.;
    }
    if x + bounds.width > container_width {
        x = container_width - bounds.width;
    }
    if y + bounds.height > container_height {
        y = container_height - bounds.height;
    }
    CropBounds { x, y, ..bounds }
}

/// `findClosestRatio` (`:103-116`). Both orientations of every common ratio
/// are candidates, so a portrait drag snaps to `9:16` as readily as a
/// landscape one to `16:9`.
pub fn find_closest_ratio(width: f64, height: f64, threshold: f64) -> Option<Ratio> {
    if height == 0. {
        return None;
    }
    let current = width / height;
    for (a, b) in COMMON_RATIOS {
        if (current - f64::from(a) / f64::from(b)).abs() < threshold {
            return Some((a, b));
        }
        if (current - f64::from(b) / f64::from(a)).abs() < threshold {
            return Some((b, a));
        }
    }
    None
}

// -- The two resize solvers (`:1336-1559`) ----------------------------------

/// `ResizeOptions` (`:1336-1344`).
#[derive(Debug, Clone, Copy)]
pub struct ResizeOptions {
    pub container: Vec2,
    pub min: Option<Vec2>,
    pub max: Option<Vec2>,
    pub is_alt: bool,
    pub shift: bool,
    pub ratio: Option<f64>,
    pub snap_to_ratio: bool,
}

/// `computeAspectRatioResize` (`:1346-1428`).
///
/// Returns `None` where the source returns `null` -- a result that would leave
/// the container is **refused**, and the caller keeps the bounds it had
/// (`:837-844`). That is why an aspect-locked drag stops dead at the edge
/// instead of sliding along it.
pub fn compute_aspect_ratio_resize(
    point_x: f64,
    point_y: f64,
    start: CropBounds,
    handle: Handle,
    options: ResizeOptions,
) -> Option<CropBounds> {
    let ratio = options.ratio?;
    let container = options.container;

    let anchor_x = start.x + if handle.movable.left { start.width } else { 0. };
    let anchor_y = start.y + if handle.movable.top { start.height } else { 0. };

    let m_x = clamp(point_x, 0., container.x);
    let m_y = clamp(point_y, 0., container.y);
    let raw_width = (m_x - anchor_x).abs();
    let raw_height = (m_y - anchor_y).abs();

    let (target_w, target_h) = if handle.is_corner {
        if raw_width / ratio > raw_height {
            (raw_width, raw_width / ratio)
        } else {
            (raw_height * ratio, raw_height)
        }
    } else if !matches!(handle.x, Axis::Center) {
        (raw_width, raw_width / ratio)
    } else {
        (raw_height * ratio, raw_height)
    };

    let new_x = if m_x < anchor_x {
        anchor_x - target_w
    } else {
        anchor_x
    };
    let new_y = if m_y < anchor_y {
        anchor_y - target_h
    } else {
        anchor_y
    };
    let mut final_bounds = CropBounds::new(new_x, new_y, target_w, target_h);

    if final_bounds.x < 0.
        || final_bounds.y < 0.
        || final_bounds.x + final_bounds.width > container.x
        || final_bounds.y + final_bounds.height > container.y
    {
        return None;
    }

    let resize_origin = Vec2::new(
        if m_x < anchor_x { 1. } else { 0. },
        if m_y < anchor_y { 1. } else { 0. },
    );
    final_bounds = constrain_bounds_to_size(
        final_bounds,
        options.max,
        options.min,
        resize_origin,
        Some(ratio),
    );

    if final_bounds.width > container.x {
        let scale = container.x / final_bounds.width;
        final_bounds.width = container.x;
        final_bounds.height *= scale;
    }
    if final_bounds.height > container.y {
        let scale = container.y / final_bounds.height;
        final_bounds.height = container.y;
        final_bounds.width *= scale;
    }

    final_bounds = slide_bounds_into_container(final_bounds, container.x, container.y);

    Some(CropBounds {
        x: js_round(final_bounds.x),
        y: js_round(final_bounds.y),
        width: js_round(final_bounds.width.max(1.)),
        height: js_round(final_bounds.height.max(1.)),
    })
}

/// `computeFreeResize` (`:1430-1559`). The second return is the ratio the
/// drag *snapped* to, which is what the floating `16:9` badge shows.
pub fn compute_free_resize(
    point_x: f64,
    point_y: f64,
    start: CropBounds,
    handle: Handle,
    options: ResizeOptions,
) -> (CropBounds, Option<Ratio>) {
    let container = options.container;
    let mut snapped: Option<Ratio> = None;

    let bounds = if options.is_alt {
        // Alt: grow symmetrically about the rect's centre, and never past the
        // container on either side.
        let center = Vec2::new(start.x + start.width / 2., start.y + start.height / 2.);
        let dist_w = (point_x - center.x).abs();
        let dist_h = (point_y - center.y).abs();

        let exp_left = dist_w.min(center.x);
        let exp_right = dist_w.min(container.x - center.x);
        let exp_top = dist_h.min(center.y);
        let exp_bottom = dist_h.min(container.y - center.y);

        let mut new_w = exp_left + exp_right;
        let mut new_h = exp_top + exp_bottom;

        if let Some(min) = options.min {
            new_w = new_w.max(min.x);
            new_h = new_h.max(min.y);
        }
        if let Some(max) = options.max {
            new_w = new_w.min(max.x);
            new_h = new_h.min(max.y);
        }

        if !options.shift
            && handle.is_corner
            && options.snap_to_ratio
            && let Some(closest) = find_closest_ratio(new_w, new_h, RATIO_SNAP_THRESHOLD)
        {
            let r = ratio_to_value(closest);
            // Corners always have a movable top or bottom, so this is
            // always the first arm -- the height leads and the width
            // follows.
            if handle.movable.top || handle.movable.bottom {
                new_w = new_h * r;
            } else {
                new_h = new_w / r;
            }
            snapped = Some(closest);
        }

        CropBounds {
            x: js_round(center.x - new_w / 2.),
            y: js_round(center.y - new_h / 2.),
            width: js_round(new_w),
            height: js_round(new_h),
        }
    } else {
        let anchor = Vec2::new(
            start.x + if handle.movable.left { start.width } else { 0. },
            start.y + if handle.movable.top { start.height } else { 0. },
        );
        let clamped_x = clamp(point_x, 0., container.x);
        let clamped_y = clamp(point_y, 0., container.y);

        let mut x1 = if handle.movable.left || handle.movable.right {
            clamped_x
        } else {
            start.x
        };
        let mut y1 = if handle.movable.top || handle.movable.bottom {
            clamped_y
        } else {
            start.y
        };
        let mut x2 = anchor.x;
        let mut y2 = anchor.y;

        if !handle.movable.left && !handle.movable.right {
            x1 = start.x;
            x2 = start.x + start.width;
        }
        if !handle.movable.top && !handle.movable.bottom {
            y1 = start.y;
            y2 = start.y + start.height;
        }

        let mut new_x = x1.min(x2);
        let mut new_y = y1.min(y2);
        let mut new_w = (x1 - x2).abs();
        let mut new_h = (y1 - y2).abs();

        if let Some(min) = options.min {
            if new_w < min.x {
                let diff = min.x - new_w;
                new_w = min.x;
                if clamped_x < anchor.x {
                    new_x -= diff;
                }
            }
            if new_h < min.y {
                let diff = min.y - new_h;
                new_h = min.y;
                if clamped_y < anchor.y {
                    new_y -= diff;
                }
            }
        }
        if let Some(max) = options.max {
            if new_w > max.x {
                let diff = new_w - max.x;
                new_w = max.x;
                if clamped_x < anchor.x {
                    new_x += diff;
                }
            }
            if new_h > max.y {
                let diff = new_h - max.y;
                new_h = max.y;
                if clamped_y < anchor.y {
                    new_y += diff;
                }
            }
        }

        if !options.shift
            && handle.is_corner
            && options.snap_to_ratio
            && let Some(closest) = find_closest_ratio(new_w, new_h, RATIO_SNAP_THRESHOLD)
        {
            let r = ratio_to_value(closest);
            if handle.movable.top || handle.movable.bottom {
                new_w = new_h * r;
            } else {
                new_h = new_w / r;
            }
            if clamped_x < anchor.x {
                new_x = anchor.x - new_w;
            }
            if clamped_y < anchor.y {
                new_y = anchor.y - new_h;
            }
            snapped = Some(closest);
        }

        CropBounds {
            x: js_round(new_x),
            y: js_round(new_y),
            width: js_round(new_w),
            height: js_round(new_h),
        }
    };

    (bounds, snapped)
}

/// `findClosestRatio`'s default `threshold` (`:106`).
pub const RATIO_SNAP_THRESHOLD: f64 = 0.01;

// -- Space conversion (`:342-430`) ------------------------------------------

/// `logicalScale` (`:342-349`): target pixels per container pixel.
pub fn logical_scale(target: Vec2, container: Vec2) -> Vec2 {
    Vec2::new(target.x / container.x, target.y / container.y)
}

/// `realBounds` (`:351-372`): container space -> target space, rounded, then
/// squeezed into the target rect. This is what lands in `background.crop`.
pub fn real_bounds(raw: CropBounds, scale: Vec2, target: Vec2) -> CropBounds {
    let mut bounds = CropBounds {
        x: js_round(raw.x * scale.x),
        y: js_round(raw.y * scale.y),
        width: js_round(raw.width * scale.x),
        height: js_round(raw.height * scale.y),
    };
    if bounds.width > target.x {
        bounds.width = target.x;
    }
    if bounds.height > target.y {
        bounds.height = target.y;
    }
    if bounds.x < 0. {
        bounds.x = 0.;
    }
    if bounds.y < 0. {
        bounds.y = 0.;
    }
    if bounds.x + bounds.width > target.x {
        bounds.x = target.x - bounds.width;
    }
    if bounds.y + bounds.height > target.y {
        bounds.y = target.y - bounds.height;
    }
    bounds
}

/// `boundsToRaw` (`:422-430`): target space -> container space. Unrounded, and
/// floored at zero rather than clamped at the far edge.
pub fn bounds_to_raw(real: CropBounds, scale: Vec2) -> CropBounds {
    CropBounds {
        x: (real.x / scale.x).max(0.),
        y: (real.y / scale.y).max(0.),
        width: (real.width / scale.x).max(0.),
        height: (real.height / scale.y).max(0.),
    }
}

/// `boxSize` (`Editor.tsx:1010-1023`): the display's aspect fitted into
/// `min(vw * 0.4, 520) x min(vh * 0.5, 520)`, rounded.
pub fn crop_box_size(viewport: (f32, f32), display: (u32, u32)) -> (f32, f32) {
    let ratio = f64::from(display.0) / f64::from(display.1).max(1.);
    let max_w = f64::from(viewport.0 * 0.4).min(520.);
    let max_h = f64::from(viewport.1 * 0.5).min(520.);
    let mut w = max_w;
    let mut h = w / ratio;
    if h > max_h {
        h = max_h;
        w = h * ratio;
    }
    (w.round() as f32, h.round() as f32)
}

// -- Hit testing ------------------------------------------------------------

/// The corner button: `h-[30px] w-[30px]` at `left/right: -12px` and
/// `top/bottom: -12px` (`:1181-1196`).
pub const CORNER_SIZE: f64 = 30.;
pub const CORNER_OFFSET: f64 = 12.;
/// The edge button: a 10px bar sitting `-1px` outside the border and shifted
/// half its own width outwards, inset 10px from each corner (`:1251-1281`).
pub const EDGE_THICKNESS: f64 = 10.;
pub const EDGE_OFFSET: f64 = 1.;
pub const EDGE_INSET: f64 = 10.;

/// A rect in *region-local* container pixels: (0, 0) is the crop region's
/// top-left corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LocalRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

/// A handle's hit box, in region-local coordinates.
pub fn handle_rect(handle: Handle, bounds: CropBounds) -> LocalRect {
    let (w, h) = (bounds.width, bounds.height);
    if handle.is_corner {
        let x = match handle.x {
            Axis::Low => -CORNER_OFFSET,
            _ => w + CORNER_OFFSET - CORNER_SIZE,
        };
        let y = match handle.y {
            Axis::Low => -CORNER_OFFSET,
            _ => h + CORNER_OFFSET - CORNER_SIZE,
        };
        return LocalRect {
            x,
            y,
            width: CORNER_SIZE,
            height: CORNER_SIZE,
        };
    }
    // `transform: translateX(-50%)` moves the bar out by half its width, so a
    // west bar spans [-6, 4] rather than [-1, 9].
    let shift = EDGE_THICKNESS / 2.;
    match (handle.x, handle.y) {
        (Axis::Low, _) => LocalRect {
            x: -EDGE_OFFSET - shift,
            y: EDGE_INSET,
            width: EDGE_THICKNESS,
            height: (h - EDGE_INSET * 2.).max(0.),
        },
        (Axis::High, _) => LocalRect {
            x: w + EDGE_OFFSET - EDGE_THICKNESS + shift,
            y: EDGE_INSET,
            width: EDGE_THICKNESS,
            height: (h - EDGE_INSET * 2.).max(0.),
        },
        (_, Axis::Low) => LocalRect {
            x: EDGE_INSET,
            y: -EDGE_OFFSET - shift,
            width: (w - EDGE_INSET * 2.).max(0.),
            height: EDGE_THICKNESS,
        },
        (_, _) => LocalRect {
            x: EDGE_INSET,
            y: h + EDGE_OFFSET - EDGE_THICKNESS + shift,
            width: (w - EDGE_INSET * 2.).max(0.),
            height: EDGE_THICKNESS,
        },
    }
}

/// What a press at a point lands on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CropHit {
    /// One of the eight resize handles.
    Handle(Handle),
    /// The region itself: drag to move.
    Move,
    /// Anywhere else in the box: drag to draw a fresh region.
    Draw,
}

/// Hit-test a point in **container** coordinates against the region.
///
/// The order reproduces the source's paint order exactly, including one
/// artefact of it. Within the region's stacking context (`z-30`), the corner
/// buttons are `z-50`, the move button is `z-10` and the four **edge** buttons
/// carry no z-index at all (`:1176-1293`) -- so the move button paints over
/// the half of every edge handle that lies inside the region, and only the
/// ~6px that sticks out past the border is actually grabbable. That is what
/// the shipping app does; see the README.
pub fn hit_test(point: Vec2, bounds: CropBounds) -> CropHit {
    let x = point.x - bounds.x;
    let y = point.y - bounds.y;

    for handle in HANDLES.iter().filter(|handle| handle.is_corner) {
        if handle_rect(*handle, bounds).contains(x, y) {
            return CropHit::Handle(*handle);
        }
    }

    let region = LocalRect {
        x: 0.,
        y: 0.,
        width: bounds.width,
        height: bounds.height,
    };
    let inside_region = region.contains(x, y);

    for handle in HANDLES.iter().filter(|handle| !handle.is_corner) {
        if handle_rect(*handle, bounds).contains(x, y) && !inside_region {
            return CropHit::Handle(*handle);
        }
    }

    if inside_region {
        CropHit::Move
    } else {
        CropHit::Draw
    }
}

/// `onHandleDoubleClick` (`:870-893`): push the handle's own edges out to the
/// container.
pub fn double_click_bounds(handle: Handle, bounds: CropBounds, container: Vec2) -> CropBounds {
    let mut next = bounds;
    if handle.movable.top {
        next.height = bounds.y + bounds.height;
        next.y = 0.;
    }
    if handle.movable.bottom {
        next.height = container.y - bounds.y;
    }
    if handle.movable.left {
        next.width = bounds.x + bounds.width;
        next.x = 0.;
    }
    if handle.movable.right {
        next.width = container.x - bounds.x;
    }
    next
}

// ---------------------------------------------------------------------------
// The live dialog
// ---------------------------------------------------------------------------

/// `ResizeSessionState` (`:790-796`).
#[derive(Debug, Clone, Copy)]
pub struct ResizeSession {
    pub start_bounds: CropBounds,
    pub is_alt: bool,
    pub active_handle: Handle,
    pub original_handle: Handle,
}

#[derive(Debug, Clone, Copy)]
pub enum CropDrag {
    /// `onRegionPointerDown` (`:643-677`).
    Region {
        start_offset: Vec2,
        bounds: CropBounds,
    },
    /// `onHandlePointerDown` (`:740-765`).
    Handle(ResizeSession),
    /// `onOverlayPointerDown` (`:895-943`) -- draw a new region from scratch.
    Overlay {
        restore: CropBounds,
        session: ResizeSession,
    },
}

impl CropDrag {
    fn cursor(&self) -> CursorStyle {
        match self {
            // `cursorStyle()` (`:290-294`): both the region and the draw drag
            // show `grabbing`.
            Self::Region { .. } | Self::Overlay { .. } => CursorStyle::ClosedHand,
            Self::Handle(session) => session.active_handle.direction.cursor(),
        }
    }
}

/// `animateToRawBounds` (`:432-469`): 240ms `easeInOutCubic` from wherever the
/// painted rect currently is.
#[derive(Debug, Clone, Copy)]
pub struct CropAnim {
    pub started: Instant,
    pub from: CropBounds,
    pub to: CropBounds,
    pub duration: Duration,
}

impl CropAnim {
    pub const DEFAULT: Duration = Duration::from_millis(240);

    fn at(&self, now: Instant) -> (CropBounds, bool) {
        let t = (now.duration_since(self.started).as_secs_f64() / self.duration.as_secs_f64())
            .clamp(0., 1.);
        let e = ease_in_out_cubic(t);
        let lerp = |a: f64, b: f64| a + (b - a) * e;
        (
            CropBounds {
                x: lerp(self.from.x, self.to.x),
                y: lerp(self.from.y, self.to.y),
                width: lerp(self.from.width, self.to.width),
                height: lerp(self.from.height, self.to.height),
            },
            t >= 1.,
        )
    }
}

/// `keyboardState` (`:952-957`) plus the rAF loop that reads it.
#[derive(Debug, Default, Clone)]
pub struct KeyNudge {
    /// `pressedKeys`, as gpui key names.
    pub keys: BTreeSet<&'static str>,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

impl KeyNudge {
    /// `delta = shift ? 10 : 2` (`:965`), in **container** pixels.
    pub fn delta(&self) -> f64 {
        if self.shift { 10. } else { 2. }
    }

    /// One tick of `keyboardActionLoop` (`:961-1004`). Returns the bounds and
    /// the origin the constraint pass must use.
    pub fn step(&self, bounds: CropBounds) -> (CropBounds, Vec2) {
        let delta = self.delta();
        if self.meta {
            // Resize. Alt grows about the centre, otherwise the top-left is
            // pinned.
            let origin = if self.alt {
                ORIGIN_CENTER
            } else {
                ORIGIN_TOP_LEFT
            };
            let mut width = bounds.width;
            let mut height = bounds.height;
            if self.keys.contains("left") {
                width -= delta;
            }
            if self.keys.contains("right") {
                width += delta;
            }
            if self.keys.contains("up") {
                height -= delta;
            }
            if self.keys.contains("down") {
                height += delta;
            }
            let resized = resize_bounds(bounds, width.max(1.), height.max(1.), origin);
            (resized, origin)
        } else {
            let mut dx = 0.;
            let mut dy = 0.;
            if self.keys.contains("left") {
                dx -= delta;
            }
            if self.keys.contains("right") {
                dx += delta;
            }
            if self.keys.contains("up") {
                dy -= delta;
            }
            if self.keys.contains("down") {
                dy += delta;
            }
            (
                move_bounds(bounds, Some(bounds.x + dx), Some(bounds.y + dy)),
                ORIGIN_CENTER,
            )
        }
    }
}

/// `KEY_MAPPINGS` (`:945-950`), in gpui's key names.
pub fn is_nudge_key(key: &str) -> Option<&'static str> {
    match key {
        "left" => Some("left"),
        "right" => Some("right"),
        "up" => Some("up"),
        "down" => Some("down"),
        _ => None,
    }
}

/// Everything the open dialog owns. `None` on [`EditorWindow`] means the
/// dialog is closed, which is `dialog().type !== "crop"`.
pub struct CropState {
    /// `targetSize` -- `recordings.segments[0].display`, the raw recording
    /// resolution and the space `background.crop` is written in.
    pub target: (u32, u32),
    /// `boxSize()` -- the **bordered wrapper**'s size, which is what the
    /// inline style sets (`Editor.tsx:1290-1293`).
    pub box_size: (f32, f32),
    /// `containerSize` -- what the `ResizeObserver` on the cropper's own
    /// `w-full h-full` div reports, i.e. the wrapper's **content** box. With
    /// Tailwind's `border-box` that is `boxSize` minus the 1px hairline on
    /// each axis, and it is the space every raw bound lives in.
    pub container: (f32, f32),
    /// `rawBounds` (`:262`).
    pub raw: CropBounds,
    /// `displayRawBounds` (`:263`) -- what is painted. Equal to `raw` unless
    /// an animation is in flight.
    pub display_raw: CropBounds,
    pub anim: Option<CropAnim>,
    /// `initialCrop` in *target* space: the crop the dialog opened on, which
    /// Reset returns to (`Editor.tsx:1136-1141`).
    pub initial: CropBounds,
    /// `aspect()` -- the ratio the menu locked, if any.
    pub aspect: Option<Ratio>,
    /// `aspectState.snapped` -- the ratio a free drag landed on.
    pub snapped: Option<Ratio>,
    pub drag: Option<CropDrag>,
    /// `mouseState.hoveringHandle`, for the corner-cursor rule.
    pub hovering: Option<Handle>,
    /// The decoded raw display frame.
    pub frame: Option<Arc<RenderImage>>,
    /// Whether the decode failed, in which case the pre-baked
    /// `screenshots/display.jpg` stands in (`Editor.tsx:1330-1334`).
    pub frame_failed: bool,
    pub keys: KeyNudge,
    /// The crop options menu (`createCropOptionsMenuItems`).
    pub menu: Option<ui::MenuState>,
    /// The ticker driving the animation and the key-repeat nudge. gpui only
    /// paints on invalidation, so a continuous gesture needs one.
    pub ticker: Option<gpui::Task<()>>,
}

impl CropState {
    /// `computeInitialBounds` (`:483-517`) at open, with the container the
    /// viewport gives.
    pub fn new(target: (u32, u32), box_size: (f32, f32), initial: CropBounds) -> Self {
        let mut state = Self {
            target,
            box_size,
            // Seeded from the border inset so the first frame is already
            // right; the measurement then confirms it.
            container: (box_size.0 - 2., box_size.1 - 2.),
            raw: CROP_ZERO,
            display_raw: CROP_ZERO,
            anim: None,
            initial,
            aspect: None,
            snapped: None,
            drag: None,
            hovering: None,
            frame: None,
            frame_failed: false,
            keys: KeyNudge::default(),
            menu: None,
            ticker: None,
        };
        let bounds = state.compute_initial_bounds();
        state.set_raw_constraining(bounds, ORIGIN_CENTER);
        state.display_raw = state.raw;
        state
    }

    pub fn target_vec(&self) -> Vec2 {
        Vec2::new(f64::from(self.target.0), f64::from(self.target.1))
    }

    pub fn container_vec(&self) -> Vec2 {
        Vec2::new(f64::from(self.container.0), f64::from(self.container.1))
    }

    pub fn scale(&self) -> Vec2 {
        logical_scale(self.target_vec(), self.container_vec())
    }

    /// `realBounds()` -- the value the header shows and Save writes.
    pub fn real(&self) -> CropBounds {
        real_bounds(self.raw, self.scale(), self.target_vec())
    }

    pub fn ratio_value(&self) -> Option<f64> {
        self.aspect.map(ratio_to_value)
    }

    /// `boundsTooSmall` (`:277-279`) -- suppresses ratio snapping and shrinks
    /// the corner glyphs.
    pub fn bounds_too_small(&self) -> bool {
        self.display_raw.width <= 30. || self.display_raw.height <= 30.
    }

    /// `computeInitialBounds` (`:483-517`).
    fn compute_initial_bounds(&self) -> CropBounds {
        let mut bounds = bounds_to_raw(self.initial, self.scale());
        if let Some(ratio) = self.ratio_value() {
            bounds = constrain_bounds_to_ratio(bounds, ratio, ORIGIN_CENTER);
        }
        let container = self.container_vec();
        if bounds.width > container.x {
            bounds = scale_bounds(bounds, container.x / bounds.width, ORIGIN_CENTER);
        }
        if bounds.height > container.y {
            bounds = scale_bounds(bounds, container.y / bounds.height, ORIGIN_CENTER);
        }
        slide_bounds_into_container(bounds, container.x, container.y)
    }

    /// `setRawBoundsConstraining` (`:531-557`).
    pub fn set_raw_constraining(&mut self, bounds: CropBounds, origin: Vec2) {
        let ratio = self.ratio_value();
        let container = self.container_vec();
        let mut next = constrain_bounds_to_size(bounds, None, None, origin, ratio);
        if let Some(ratio) = ratio {
            next = constrain_bounds_to_ratio(next, ratio, origin);
        }
        if next.width > container.x {
            next = scale_bounds(next, container.x / next.width, origin);
        }
        if next.height > container.y {
            next = scale_bounds(next, container.y / next.height, origin);
        }
        next = slide_bounds_into_container(next, container.x, container.y);
        self.raw = next;
        if self.anim.is_none() {
            self.display_raw = next;
        }
    }

    /// `setRawBounds` -- the drag path, which skips the constraint pass
    /// because the solver has already applied it.
    fn set_raw(&mut self, bounds: CropBounds) {
        self.raw = bounds;
        if self.anim.is_none() {
            self.display_raw = bounds;
        }
    }

    /// `setRawBoundsAndAnimate` (`:471-481`).
    pub fn set_raw_and_animate(&mut self, bounds: CropBounds, origin: Vec2, duration: Duration) {
        let from = self.display_raw;
        self.anim = None;
        self.set_raw_constraining(bounds, origin);
        let to = self.raw;
        if to == from {
            self.display_raw = to;
            return;
        }
        self.display_raw = from;
        self.anim = Some(CropAnim {
            started: Instant::now(),
            from,
            to,
            duration,
        });
    }

    /// `stopAnimation` (`:270-275`): every pointer press cancels an animation
    /// and snaps the painted rect to the real one.
    pub fn stop_animation(&mut self) {
        self.anim = None;
        self.display_raw = self.raw;
    }

    /// Advance the animation. Returns whether another frame is wanted.
    pub fn tick_anim(&mut self, now: Instant) -> bool {
        let Some(anim) = self.anim else {
            return false;
        };
        let (bounds, done) = anim.at(now);
        self.display_raw = bounds;
        if done {
            self.anim = None;
            self.display_raw = anim.to;
            return false;
        }
        true
    }

    /// `fill()` (`:559-569`).
    pub fn fill(&mut self) {
        let container = self.container_vec();
        self.set_raw_and_animate(
            CropBounds::new(0., 0., container.x, container.y),
            ORIGIN_CENTER,
            CropAnim::DEFAULT,
        );
        self.snapped = None;
    }

    /// `reset()` (`:611-615`) plus `setAspect(null)` (`Editor.tsx:1271`).
    pub fn reset(&mut self) {
        self.aspect = None;
        let bounds = self.compute_initial_bounds();
        self.set_raw_and_animate(bounds, ORIGIN_CENTER, CropAnim::DEFAULT);
        self.snapped = None;
    }

    /// `setCropProperty` (`:617-623`) -- one of the four header boxes.
    pub fn set_property(&mut self, field: CropField, value: f64) {
        self.snapped = None;
        let mut real = self.real();
        match field {
            CropField::X => real.x = value,
            CropField::Y => real.y = value,
            CropField::Width => real.width = value,
            CropField::Height => real.height = value,
        }
        let raw = bounds_to_raw(real, self.scale());
        self.set_raw_constraining(raw, ORIGIN_TOP_LEFT);
    }

    /// The menu's ratio rows (`:319-337`): constrain about the centre, animated.
    pub fn set_aspect(&mut self, aspect: Option<Ratio>) {
        self.aspect = aspect;
        let Some(ratio) = self.ratio_value() else {
            return;
        };
        let target = constrain_bounds_to_ratio(self.raw, ratio, ORIGIN_CENTER);
        self.set_raw_and_animate(target, ORIGIN_CENTER, CropAnim::DEFAULT);
    }

    /// `updateContainerSize` (`:575-593`): the box changed size, so re-derive
    /// the container-space rect from the *target*-space one it was showing.
    pub fn set_container(&mut self, box_size: (f32, f32), container: (f32, f32)) {
        self.box_size = box_size;
        if self.container == container || container.0 <= 1. || container.1 <= 1. {
            return;
        }
        let preserved = self.real();
        self.container = container;
        let raw = bounds_to_raw(preserved, self.scale());
        self.set_raw_constraining(raw, ORIGIN_CENTER);
        self.display_raw = self.raw;
    }

    fn resize_options(
        &self,
        session: &ResizeSession,
        shift: bool,
        snap_enabled: bool,
    ) -> ResizeOptions {
        ResizeOptions {
            container: self.container_vec(),
            min: None,
            max: None,
            is_alt: session.is_alt,
            shift,
            ratio: self.ratio_value(),
            // `snapToRatioEnabled: !!props.snapToRatioEnabled &&
            // !boundsTooSmall()` (`:831`).
            snap_to_ratio: snap_enabled && !self.bounds_too_small(),
        }
    }

    /// `handleResizePointerMove` (`:798-868`).
    pub fn resize_move(&mut self, point: Vec2, alt: bool, shift: bool, snap_enabled: bool) {
        let Some(session) = self.session_mut() else {
            return;
        };
        if alt != session.is_alt {
            session.is_alt = alt;
            let original = session.original_handle;
            let start = self.raw;
            let session = self.session_mut().expect("session");
            session.start_bounds = start;
            session.active_handle = if alt {
                original
            } else {
                update_handle_for_mode_switch(original, start, point.x, point.y)
            };
        }

        let session = *self.session_mut().expect("session");
        let options = self.resize_options(&session, shift, snap_enabled);

        let next = if options.ratio.is_some() {
            compute_aspect_ratio_resize(
                point.x,
                point.y,
                session.start_bounds,
                session.active_handle,
                options,
            )
            .unwrap_or(self.raw)
        } else {
            let (bounds, snapped) = compute_free_resize(
                point.x,
                point.y,
                session.start_bounds,
                session.active_handle,
                options,
            );
            self.snapped = snapped;
            bounds
        };

        let container = self.container_vec();
        let final_bounds = slide_bounds_into_container(next, container.x, container.y);
        self.set_raw(final_bounds);
    }

    fn session_mut(&mut self) -> Option<&mut ResizeSession> {
        match self.drag.as_mut()? {
            CropDrag::Handle(session) | CropDrag::Overlay { session, .. } => Some(session),
            CropDrag::Region { .. } => None,
        }
    }
}

/// `updateHandleForModeSwitch` (`:768-788`): dropping Alt mid-drag re-picks
/// which edges move from which side of the centre the pointer is on.
pub fn update_handle_for_mode_switch(
    handle: Handle,
    bounds: CropBounds,
    point_x: f64,
    point_y: f64,
) -> Handle {
    let center = Vec2::new(bounds.x + bounds.width / 2., bounds.y + bounds.height / 2.);
    let mut movable = handle.movable;
    if handle.movable.left || handle.movable.right {
        movable.left = point_x < center.x;
        movable.right = point_x >= center.x;
    }
    if handle.movable.top || handle.movable.bottom {
        movable.top = point_y < center.y;
        movable.bottom = point_y >= center.y;
    }
    Handle { movable, ..handle }
}

/// Which of the four header boxes a commit came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CropField {
    X,
    Y,
    Width,
    Height,
}

impl CropField {
    pub fn read(self, bounds: CropBounds) -> f64 {
        match self {
            Self::X => bounds.x,
            Self::Y => bounds.y,
            Self::Width => bounds.width,
            Self::Height => bounds.height,
        }
    }
}

// ---------------------------------------------------------------------------
// The menu (`createCropOptionsMenuItems`, `:1561-1589`)
// ---------------------------------------------------------------------------

/// Rows: `Free`, the eight common ratios, a separator, `Snap to ratios`.
///
/// `ui::Menu` has no separator row, so the separator is dropped and the two
/// groups are simply adjacent -- documented in the README. The check marks and
/// the keyboard contract are the real thing.
pub fn crop_menu_items(aspect: Option<Ratio>, snap: bool) -> Vec<ui::MenuItem> {
    let mut items = vec![ui::MenuItem::new("Free", aspect.is_none())];
    items.extend(COMMON_RATIOS.map(|ratio| {
        ui::MenuItem::new(
            SharedString::from(format!("{}:{}", ratio.0, ratio.1)),
            aspect == Some(ratio),
        )
    }));
    items.push(ui::MenuItem::new("Snap to ratios", snap));
    items
}

/// What row `index` of [`crop_menu_items`] does.
pub enum CropMenuChoice {
    Aspect(Option<Ratio>),
    ToggleSnap,
}

pub fn crop_menu_choice(index: usize) -> Option<CropMenuChoice> {
    match index {
        0 => Some(CropMenuChoice::Aspect(None)),
        n if n <= COMMON_RATIOS.len() => Some(CropMenuChoice::Aspect(Some(COMMON_RATIOS[n - 1]))),
        n if n == COMMON_RATIOS.len() + 1 => Some(CropMenuChoice::ToggleSnap),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The window's half
// ---------------------------------------------------------------------------

impl EditorWindow {
    /// `cropDialogHandler` (`Player.tsx:161-180`): stop playback, then open
    /// the dialog seeded with the crop in force (or the whole frame).
    pub(crate) fn open_crop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.crop.is_some() {
            return;
        }
        let Some(target) = self.display_resolution() else {
            tracing::warn!("crop: no display recording to crop");
            return;
        };
        self.stop_playback_for_crop(cx);

        let initial = match &self.project.background.crop {
            Some(crop) => CropBounds::new(
                f64::from(crop.position.x),
                f64::from(crop.position.y),
                f64::from(crop.size.x),
                f64::from(crop.size.y),
            ),
            None => CropBounds::new(0., 0., f64::from(target.0), f64::from(target.1)),
        };

        let viewport = window.viewport_size();
        let container = crop_box_size((viewport.width.into(), viewport.height.into()), target);
        let state = CropState::new(target, container, initial);
        tracing::info!(
            target = format!("{}x{}", target.0, target.1),
            container = format!("{}x{}", container.0, container.1),
            scale = format!("{:.4}", f64::from(target.0) / f64::from(container.0)),
            initial = crop_log(initial),
            "crop opened"
        );
        self.crop = Some(state);
        self.load_crop_frame(window, cx);
        self.publish_crop_preview();
        cx.notify();
        window.refresh();
    }

    /// The source's `ResizeObserver` on the cropper box plus its
    /// `window.addEventListener("resize")` (`Cropper.tsx:595-598`,
    /// `Editor.tsx:1000-1008`): the box is a fraction of the viewport, so a
    /// window resize re-derives it -- and the *target*-space rect is what
    /// survives, not the container-space one.
    pub(crate) fn sync_crop_container(&mut self, window: &Window) {
        let Some(target) = self.crop.as_ref().map(|state| state.target) else {
            return;
        };
        // The observer watches the cropper's own `w-full h-full` div, which is
        // the box's **content** box -- `boxSize()` sizes the bordered wrapper,
        // and Tailwind's `border-box` takes the 1px hairline off each axis. So
        // a 510x331 box observes 508x329, and that 2px is the difference
        // between the handles landing where they are painted and landing 2px
        // off. Measured, therefore, not computed; `crop_box_size` only seeds
        // the state before the first paint.
        let viewport = window.viewport_size();
        let box_size = crop_box_size((viewport.width.into(), viewport.height.into()), target);
        let container = match self.crop_area_rect.get() {
            Some(bounds) if bounds.size.width > px(1.) && bounds.size.height > px(1.) => {
                (f32::from(bounds.size.width), f32::from(bounds.size.height))
            }
            _ => (box_size.0 - 2., box_size.1 - 2.),
        };
        if let Some(state) = self.crop.as_mut() {
            state.set_container(box_size, container);
        }
    }

    /// `editorInstance.recordings.segments[0].display` -- width and height.
    pub(crate) fn display_resolution(&self) -> Option<(u32, u32)> {
        let instance = self.instance.as_ref()?;
        let display = &instance.recordings.segments.first()?.display;
        Some((display.width, display.height))
    }

    fn stop_playback_for_crop(&mut self, cx: &mut Context<Self>) {
        if self.playing {
            self.toggle_play_from_crop(cx);
        }
    }

    /// Close without writing: Escape, the backdrop, or the close path. The
    /// in-memory preview override is dropped and the real config re-published,
    /// which is `onCleanup`'s `queueConfig(null)` plus the `isCropMode` effect
    /// re-emitting the render frame (`Editor.tsx:1128-1134, 610-616`).
    pub(crate) fn cancel_crop(
        &mut self,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.crop.take().is_none() {
            return;
        }
        tracing::info!(reason, "crop cancelled");
        self.publish_project();
        cx.notify();
        window.refresh();
    }

    /// The footer's Save (`Editor.tsx:1414-1432`): **one** `setProject` call,
    /// so **one** history entry for the whole session, then close.
    pub(crate) fn save_crop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(state) = self.crop.take() else {
            return;
        };
        let bounds = state.real();
        let crop = Crop {
            position: XY::new(bounds.x.max(0.) as u32, bounds.y.max(0.) as u32),
            size: XY::new(bounds.width.max(0.) as u32, bounds.height.max(0.) as u32),
        };
        tracing::info!(
            crop = format!(
                "{},{} {}x{}",
                crop.position.x, crop.position.y, crop.size.x, crop.size.y
            ),
            "crop saved"
        );
        self.project.background.crop = Some(crop);
        self.project_changed(window, cx);
        window.refresh();
    }

    /// The in-memory preview: the project as it stands with `background.crop`
    /// overridden, pushed straight at the renderer without touching
    /// `self.project`. That is `updateProjectConfigInMemory`
    /// (`Editor.tsx:1054-1077`), and it is why nothing is written and no
    /// history entry exists until Save.
    pub(crate) fn publish_crop_preview(&self) {
        let Some(instance) = &self.instance else {
            return;
        };
        let mut config = self.project.clone();
        if let Some(state) = &self.crop {
            let bounds = state.real();
            config.background.crop = Some(Crop {
                position: XY::new(bounds.x.max(0.) as u32, bounds.y.max(0.) as u32),
                size: XY::new(bounds.width.max(0.) as u32, bounds.height.max(0.) as u32),
            });
        }
        instance.project_config.0.send(config).ok();
        let time = self.preview_or_playhead();
        crate::editor_window::request_frame(
            instance,
            (time * f64::from(EDITOR_PREVIEW_FPS)).floor() as u32,
            self.preview_resolution(),
        );
    }

    /// After any change to the crop rect: repaint, and re-render the preview
    /// pane through the real pipeline.
    fn crop_changed(&mut self, cx: &mut Context<Self>) {
        self.publish_crop_preview();
        cx.notify();
    }

    // -- Pointer ------------------------------------------------------------

    /// The container's own press. One handler rather than eleven elements:
    /// [`hit_test`] reproduces the source's paint order, including its
    /// occlusion artefact, and a single hitbox keeps the drag on the window
    /// root where gpui can follow a pointer that leaves the box.
    pub(crate) fn crop_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let area = self.crop_area_rect.get();
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        let point = crop_local(area, event.position);
        // `onDblClick={() => fill()}` on the container, and the region's own
        // `onDblClick` stops propagation, so a double-click only fills when it
        // lands outside the region -- but a **handle**'s double-click expands
        // that side (`:1097, 1143, 1200, 1286`).
        if event.click_count == 2 {
            let hit = hit_test(point, state.raw);
            match hit {
                CropHit::Handle(handle) => {
                    state.stop_animation();
                    let container = state.container_vec();
                    let bounds = double_click_bounds(handle, state.raw, container);
                    state.set_raw_and_animate(bounds, handle.origin, CropAnim::DEFAULT);
                }
                CropHit::Move => {}
                CropHit::Draw => state.fill(),
            }
            state.drag = None;
            self.start_crop_ticker(window, cx);
            self.crop_changed(cx);
            return;
        }

        state.stop_animation();
        let hit = hit_test(point, state.raw);
        // The press log every crop probe calibrates against: where the box is
        // on screen, where the pointer landed inside it, and what it grabbed.
        tracing::info!(
            area = ?area.map(|bounds| format!(
                "{:.1},{:.1} {:.1}x{:.1}",
                f32::from(bounds.origin.x),
                f32::from(bounds.origin.y),
                f32::from(bounds.size.width),
                f32::from(bounds.size.height),
            )),
            local = format!("{:.1},{:.1}", point.x, point.y),
            hit = match hit {
                CropHit::Handle(handle) => handle.direction.label(),
                CropHit::Move => "move",
                CropHit::Draw => "draw",
            },
            raw = crop_log(state.raw),
            scale = format!("{:.6}", state.scale().x),
            "crop press"
        );
        match hit {
            CropHit::Handle(handle) => {
                state.hovering = Some(handle);
                state.drag = Some(CropDrag::Handle(ResizeSession {
                    start_bounds: state.raw,
                    is_alt: event.modifiers.alt,
                    active_handle: handle,
                    original_handle: handle,
                }));
            }
            CropHit::Move => {
                let bounds = state.raw;
                state.drag = Some(CropDrag::Region {
                    start_offset: Vec2::new(point.x - bounds.x, point.y - bounds.y),
                    bounds,
                });
            }
            CropHit::Draw => {
                let restore = state.raw;
                let start = CropBounds::new(point.x, point.y, 1., 1.);
                state.drag = Some(CropDrag::Overlay {
                    restore,
                    session: ResizeSession {
                        start_bounds: start,
                        is_alt: event.modifiers.alt,
                        active_handle: SE_HANDLE,
                        original_handle: SE_HANDLE,
                    },
                });
                state.hovering = Some(SE_HANDLE);
            }
        }
        cx.notify();
    }

    pub(crate) fn crop_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let snap = self.crop_snap_to_ratio;
        let area = self.crop_area_rect.get();
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        let point = crop_local(area, event.position);
        let Some(drag) = state.drag else {
            // `onMouseEnter` on the handles is what seeds `hoveringHandle`,
            // which the corner-cursor rule reads.
            let hovering = match hit_test(point, state.raw) {
                CropHit::Handle(handle) => Some(handle),
                _ => None,
            };
            if hovering.map(|h| h.direction) != state.hovering.map(|h| h.direction) {
                state.hovering = hovering;
                cx.notify();
            }
            return;
        };

        match drag {
            CropDrag::Region {
                start_offset,
                bounds,
            } => {
                let container = state.container_vec();
                let new_x = clamp(point.x - start_offset.x, 0., container.x - bounds.width);
                let new_y = clamp(point.y - start_offset.y, 0., container.y - bounds.height);
                let moved = move_bounds(bounds, Some(new_x), Some(new_y));
                state.set_raw(moved);
            }
            CropDrag::Handle(_) | CropDrag::Overlay { .. } => {
                state.resize_move(point, event.modifiers.alt, event.modifiers.shift, snap);
            }
        }
        self.crop_changed(cx);
    }

    pub(crate) fn crop_mouse_up(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        let Some(drag) = state.drag.take() else {
            return;
        };
        // `onOverlayPointerDown`'s end (`:934-941`): a drag that never grew
        // past 5px in either axis is a stray click, and the previous region
        // comes back.
        if let CropDrag::Overlay { restore, .. } = drag
            && (state.raw.width < 5. || state.raw.height < 5.)
        {
            state.set_raw(restore);
        }
        let real = state.real();
        tracing::info!(
            handle = match drag {
                CropDrag::Region { .. } => "move",
                CropDrag::Handle(session) => session.active_handle.direction.label(),
                CropDrag::Overlay { .. } => "draw",
            },
            raw = crop_log(state.raw),
            real = crop_log(real),
            aspect = ?state.aspect,
            snapped = ?state.snapped,
            "crop drag"
        );
        self.crop_changed(cx);
    }

    /// The ratio button and the right-click, which open the same menu
    /// (`Editor.tsx:1150-1170`). The button anchors 40px below its own rect;
    /// the right-click anchors at the cursor.
    pub(crate) fn open_crop_menu(
        &mut self,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let snap = self.crop_snap_to_ratio;
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        let items = crop_menu_items(state.aspect, snap);
        state.menu = Some(ui::MenuState::new(origin, &items));
        cx.notify();
    }

    pub(crate) fn choose_crop_menu(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(choice) = crop_menu_choice(index) else {
            return;
        };
        match choice {
            CropMenuChoice::Aspect(aspect) => {
                if let Some(state) = self.crop.as_mut() {
                    state.menu = None;
                    state.set_aspect(aspect);
                }
                self.start_crop_ticker(window, cx);
            }
            CropMenuChoice::ToggleSnap => {
                self.crop_snap_to_ratio = !self.crop_snap_to_ratio;
                if let Some(state) = self.crop.as_mut() {
                    state.menu = None;
                }
            }
        }
        self.crop_changed(cx);
    }

    /// Arrows / Home / End / Enter / Escape on the open crop menu.
    pub(crate) fn crop_menu_key(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(state) = self.crop.as_mut() else {
            return false;
        };
        let Some(menu) = state.menu.as_mut() else {
            return false;
        };
        match menu.on_key(key) {
            ui::MenuKey::Moved => {
                cx.notify();
                true
            }
            ui::MenuKey::Commit(index) => {
                self.choose_crop_menu(index, window, cx);
                true
            }
            ui::MenuKey::Dismiss => {
                state.menu = None;
                cx.notify();
                true
            }
            ui::MenuKey::Ignored => false,
        }
    }

    // -- Keyboard -----------------------------------------------------------

    /// Returns whether the key was consumed. Called from `on_key` *before* the
    /// editor's own shortcuts, so Escape closes the dialog rather than
    /// clearing the timeline selection.
    pub(crate) fn crop_key_down(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.crop.is_none() {
            return false;
        }
        let key = event.keystroke.key.as_str();
        if self.crop_menu_key(key, window, cx) {
            return true;
        }
        // A focused header box owns its own arrows -- `onKeyDown={... (e) =>
        // e.stopPropagation()}` on `NumberField.Input` (`Editor.tsx:1195-1197`).
        if ui::text_input_has_focus(window, cx) {
            return false;
        }
        if key == "escape" {
            self.cancel_crop("escape", window, cx);
            return true;
        }
        let Some(nudge) = is_nudge_key(key) else {
            return false;
        };
        let modifiers = event.keystroke.modifiers;
        let Some(state) = self.crop.as_mut() else {
            return false;
        };
        // `if (!KEY_MAPPINGS.has(e.key) || mouseState.drag !== null) return`
        // (`:1007`): a live pointer drag suppresses the keyboard entirely.
        if state.drag.is_some() {
            return true;
        }
        state.keys.keys.insert(nudge);
        state.keys.shift = modifiers.shift;
        state.keys.alt = modifiers.alt;
        state.keys.meta = modifiers.platform || modifiers.control;
        state.stop_animation();
        // The loop applies a step immediately, so a tap moves once.
        self.nudge_step(cx);
        self.start_crop_ticker(window, cx);
        true
    }

    pub(crate) fn crop_key_up(&mut self, event: &gpui::KeyUpEvent, cx: &mut Context<Self>) {
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if let Some(nudge) = is_nudge_key(key) {
            state.keys.keys.remove(nudge);
        } else if !matches!(
            key,
            "shift" | "alt" | "cmd" | "ctrl" | "control" | "platform"
        ) {
            return;
        }
        state.keys.shift = modifiers.shift;
        state.keys.alt = modifiers.alt;
        state.keys.meta = modifiers.platform || modifiers.control;
        cx.notify();
    }

    /// One tick of `keyboardActionLoop` (`:961-1004`).
    fn nudge_step(&mut self, cx: &mut Context<Self>) {
        let Some(state) = self.crop.as_mut() else {
            return;
        };
        if state.keys.keys.is_empty() {
            return;
        }
        let (bounds, origin) = state.keys.step(state.raw);
        state.set_raw_constraining(bounds, origin);
        self.crop_changed(cx);
    }

    /// The one ticker the dialog needs: it drives the 240ms bounds animation
    /// *and* the held-arrow nudge, because gpui only paints on invalidation.
    ///
    /// **This is the rAF loop, not gpui's key repeat.** `handleKeyDown` starts
    /// a `requestAnimationFrame` loop that runs until every arrow is released
    /// (`:1019-1022`), so a held arrow moves 2px (or 10 with Shift) *every
    /// frame*, with no initial delay -- which is not what AppKit's key repeat
    /// would give. The ticker reproduces the source's cadence.
    pub(crate) fn start_crop_ticker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let wanted = self
            .crop
            .as_ref()
            .is_some_and(|state| state.anim.is_some() || !state.keys.keys.is_empty());
        if !wanted {
            if let Some(state) = self.crop.as_mut() {
                state.ticker = None;
            }
            return;
        }
        if self
            .crop
            .as_ref()
            .is_some_and(|state| state.ticker.is_some())
        {
            return;
        }
        let task = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(1000 / 60))
                    .await;
                let keep = this
                    .update(cx, |this: &mut Self, cx| {
                        let Some(state) = this.crop.as_mut() else {
                            return false;
                        };
                        let animating = state.tick_anim(Instant::now());
                        let nudging = !state.keys.keys.is_empty();
                        if nudging {
                            this.nudge_step(cx);
                        } else {
                            cx.notify();
                        }
                        animating || nudging
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
            this.update(cx, |this: &mut Self, _| {
                if let Some(state) = this.crop.as_mut() {
                    state.ticker = None;
                }
            })
            .ok();
        });
        if let Some(state) = self.crop.as_mut() {
            state.ticker = Some(task);
        }
    }

    // -- The raw frame ------------------------------------------------------

    /// `getDisplayFrameForCropping(FPS)` (`lib.rs:4243-4340`): decode the raw
    /// display frame at the playhead, straight off the segment's own decoder,
    /// so the cropper draws the *uncropped* recording with no padding,
    /// background or zoom baked in.
    ///
    /// The Tauri command JPEG-encodes the result to get it across the IPC
    /// boundary and the frontend decodes it again. There is no boundary here,
    /// so the RGBA goes straight into a `RenderImage`.
    fn load_crop_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(instance) = self.instance.clone() else {
            return;
        };
        let time = self.preview_or_playhead();
        let frame_number = (time * f64::from(EDITOR_PREVIEW_FPS)).floor().max(0.) as u32;
        let time_secs = f64::from(frame_number) / f64::from(EDITOR_PREVIEW_FPS);
        let project = self.project.clone();

        cx.spawn_in(window, async move |this, cx| {
            let decoded = cx
                .update(|_, cx| {
                    gpui_tokio::Tokio::spawn(cx, async move {
                        decode_display_frame(&instance, &project, time_secs).await
                    })
                })
                .ok();
            let image = match decoded {
                Some(task) => task.await.ok().flatten(),
                None => None,
            };
            this.update(cx, |this: &mut Self, cx| {
                let Some(state) = this.crop.as_mut() else {
                    return;
                };
                match image {
                    Some(image) => state.frame = Some(image),
                    None => {
                        tracing::warn!("crop: display frame decode failed");
                        state.frame_failed = true;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl EditorWindow {
    /// `CAP_GPUI_AUTO_CROP=<spec>`, for the same reason as every other
    /// `CAP_GPUI_AUTO_*` hook: an unprivileged synthetic click is dropped, and
    /// the dialog has to be **up** before a real `CGEvent` drag inside it can
    /// be posted at all.
    ///
    /// * `1` -- open it, through `open_crop`, exactly as the toolbar does.
    /// * `1:16x9` -- open it and lock that ratio, through the menu's own path.
    /// * `1:nosnap` -- open it with `Snap to ratios` off.
    pub(crate) fn auto_crop(&mut self, spec: &str, window: &mut Window, cx: &mut Context<Self>) {
        let mut parts = spec.split(':');
        parts.next();
        self.open_crop(window, cx);
        for option in parts {
            match option {
                "nosnap" => self.crop_snap_to_ratio = false,
                ratio => {
                    if let Some((a, b)) = ratio.split_once('x')
                        && let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>())
                        && let Some(index) = COMMON_RATIOS.iter().position(|item| *item == (a, b))
                    {
                        self.choose_crop_menu(index + 1, window, cx);
                    }
                }
            }
        }
        if let Some(state) = self.crop.as_mut() {
            state.stop_animation();
        }
        cx.notify();
        window.refresh();
    }

    /// `CAP_GPUI_AUTO_CANVAS=1` selects the on-canvas display box so the
    /// overlay draws, which is what a click on it would do.
    pub(crate) fn auto_canvas_select(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.canvas_selection = Some(crate::editor_canvas::CanvasSelection::Display);
        self.set_selection(None, cx);
        tracing::info!(
            rect = ?self.display_rect().map(|rect| format!(
                "{:.4},{:.4} {:.4}x{:.4}", rect.x, rect.y, rect.w, rect.h
            )),
            canvas = ?self.canvas_bounds().map(|bounds| format!(
                "{:.1},{:.1} {:.1}x{:.1}",
                f32::from(bounds.origin.x),
                f32::from(bounds.origin.y),
                f32::from(bounds.size.width),
                f32::from(bounds.size.height),
            )),
            draggable = self.display_draggable(),
            "auto canvas select"
        );
        cx.notify();
        window.refresh();
    }
}

fn crop_log(bounds: CropBounds) -> String {
    format!(
        "{:.0},{:.0} {:.0}x{:.0}",
        bounds.x, bounds.y, bounds.width, bounds.height
    )
}

/// Window coordinates -> container-local container pixels.
fn crop_local(area: Option<gpui::Bounds<Pixels>>, position: Point<Pixels>) -> Vec2 {
    let origin = area.map(|bounds| bounds.origin).unwrap_or_default();
    Vec2::new(
        f64::from(f32::from(position.x - origin.x)),
        f64::from(f32::from(position.y - origin.y)),
    )
}

/// The decode half of [`EditorWindow::load_crop_frame`], transcribed from
/// `get_display_frame_for_cropping` minus the JPEG round trip.
async fn decode_display_frame(
    instance: &cap_editor::EditorInstance,
    project: &cap_project::ProjectConfiguration,
    time_secs: f64,
) -> Option<Arc<RenderImage>> {
    use cap_rendering::{PixelFormat, cpu_yuv};

    let (segment_time, segment) = project.get_segment_time(time_secs)?;
    let medias = instance
        .segment_medias
        .get(segment.recording_clip as usize)?;
    let clip_offsets = project
        .clips
        .iter()
        .find(|clip| clip.index == segment.recording_clip)
        .map(|clip| clip.offsets)
        .unwrap_or_default();

    let frames = medias
        .decoders
        .get_frames(segment_time as f32, false, true, clip_offsets)
        .await?;
    let screen = frames.screen_frame?;
    let width = screen.width();
    let height = screen.height();

    let mut rgba = match screen.format() {
        PixelFormat::Rgba => screen.data().to_vec(),
        PixelFormat::Nv12 => {
            let y = screen.y_plane()?;
            let uv = screen.uv_plane()?;
            let mut out = vec![0u8; (width * height * 4) as usize];
            cpu_yuv::nv12_to_rgba(
                y,
                uv,
                width,
                height,
                screen.y_stride(),
                screen.uv_stride(),
                &mut out,
            );
            out
        }
        PixelFormat::Yuv420p => {
            let y = screen.y_plane()?;
            let u = screen.u_plane()?;
            let v = screen.v_plane()?;
            let mut out = vec![0u8; (width * height * 4) as usize];
            cpu_yuv::yuv420p_to_rgba(
                y,
                u,
                v,
                width,
                height,
                screen.y_stride(),
                screen.uv_stride(),
                &mut out,
            );
            out
        }
    };
    // gpui's `RenderImage` is BGRA behind an `RgbaImage`, which is the same
    // swap `editor_window::frame_image` does for the player's frames.
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = image::RgbaImage::from_raw(width, height, rgba)?;
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(buffer)
    ])))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// `Dialog.Root`'s `max-w-[1180px]` (`Editor.tsx:809`).
const CROP_DIALOG_MAX_WIDTH: f32 = 1180.;
/// `h-14 px-4` (`ui.tsx:231`).
const DIALOG_HEADER_HEIGHT: f32 = 56.;
/// `h-16 px-4 gap-3` (`ui.tsx:213-215`).
const DIALOG_FOOTER_HEIGHT: f32 = 64.;
/// `w-13` on each of the four header boxes (`Editor.tsx:1218`).
const BOUND_INPUT_WIDTH: f32 = 52.;
/// `bg-black/45` (`:1126`).
const OCCLUDER_ALPHA: f32 = 0.45;

impl EditorWindow {
    /// The whole modal. Painted last in the window's root so it is over the
    /// sidebar, the timeline and the drag layers.
    pub(crate) fn render_crop_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.crop.as_ref()?;
        let theme = self.theme;

        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                // `KDialog.Overlay class="fixed inset-0 z-50 bg-black/80"`.
                .child(
                    div()
                        .id("crop-backdrop")
                        .absolute()
                        .inset_0()
                        .bg(gpui::hsla(0., 0., 0., 0.8))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.cancel_crop("backdrop", window, cx)
                        })),
                )
                .child(
                    // `z-50 text-sm rounded-[1.25rem] overflow-hidden border
                    // border-gray-3 bg-gray-1` (`ui.tsx:185-190`).
                    div()
                        // The modal's own hit shield. Without it the backdrop's
                        // click handler is still "hovered" under the card --
                        // gpui's `on_click` only asks whether *its* hitbox is
                        // in the hit test, and a plain `div` with no listeners
                        // (the card, its header row, its footer) inserts no
                        // hitbox to block one. So a press inside the dialog
                        // also armed the backdrop's click and the release
                        // dismissed the dialog. `occlude()` is `pointer-events`
                        // on a real modal surface.
                        .occlude()
                        .relative()
                        .flex()
                        .flex_col()
                        .max_w(px(CROP_DIALOG_MAX_WIDTH))
                        .rounded(px(20.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .overflow_hidden()
                        .child(self.render_crop_header(state, cx))
                        .child(self.render_crop_body(state, cx))
                        .child(self.render_crop_footer(cx)),
                )
                .children(self.render_crop_menu(cx))
                .into_any_element(),
        )
    }

    fn render_crop_header(&self, state: &CropState, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let real = state.real();
        let full =
            real.width >= f64::from(state.target.0) && real.height >= f64::from(state.target.1);
        let untouched = real == state.initial;

        let group = |label: &'static str, a: CropField, b: CropField, this: &Self| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .text_color(Hsla::from(theme.gray_11))
                .child(label)
                .child(this.render_crop_field(a))
                .child("×")
                .child(this.render_crop_field(b))
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(DIALOG_HEADER_HEIGHT))
            .px(px(16.))
            .flex_none()
            .child(
                // `flex flex-row space-x-8`.
                div()
                    .flex()
                    .flex_row()
                    .gap(px(32.))
                    .flex_none()
                    .child(group("Size", CropField::Width, CropField::Height, self))
                    .child(group("Position", CropField::X, CropField::Y, self)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .items_center()
                    .justify_end()
                    .gap(px(12.))
                    // The ratio button: `rounded-full h-8 w-8 border`, showing
                    // the ratio icon when free and `N:M` in `text-blue-10`
                    // when locked (`Editor.tsx:1218-1258`).
                    .child(
                        div()
                            .id("crop-ratio")
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(32.))
                            .rounded_full()
                            .border_1()
                            .border_color(Hsla::from(theme.gray_4))
                            .bg(Hsla::from(theme.gray_1))
                            .cursor_pointer()
                            .child(match state.aspect {
                                Some(ratio) => div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(theme.blue_10))
                                    .child(SharedString::from(format!("{}:{}", ratio.0, ratio.1)))
                                    .into_any_element(),
                                None => svg()
                                    .path("icons/ratio.svg")
                                    .size(px(16.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .into_any_element(),
                            })
                            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                                // `pos = new LogicalPosition(rect.x, rect.y + 40)`.
                                let position = event.position();
                                let origin =
                                    gpui::point(position.x - px(16.), position.y + px(24.));
                                this.open_crop_menu(origin, window, cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "crop-full")
                            .left_icon("icons/maximize.svg")
                            .label("Full")
                            .disabled(full)
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(state) = this.crop.as_mut() {
                                    state.fill();
                                }
                                this.start_crop_ticker(window, cx);
                                this.crop_changed(cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "crop-reset")
                            .left_icon("icons/circle-x.svg")
                            .label("Reset")
                            .disabled(untouched)
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(state) = this.crop.as_mut() {
                                    state.reset();
                                }
                                this.start_crop_ticker(window, cx);
                                this.crop_changed(cx);
                            })),
                    ),
            )
            .into_any_element()
    }

    /// One of the four `NumberField.Input` boxes: `w-13`, `h-8`, `rounded-lg
    /// bg-gray-2` (`Editor.tsx:1200-1215`).
    fn render_crop_field(&self, field: CropField) -> AnyElement {
        let theme = self.theme;
        let key = crate::editor_panels::FieldKey::Crop(field);
        let Some(input) = self.field(key) else {
            return div().w(px(BOUND_INPUT_WIDTH)).into_any_element();
        };
        ui::TextInput::plain(&theme, SharedString::from(format!("crop-{field:?}")), input)
            .width(px(BOUND_INPUT_WIDTH))
            .padding_x(px(8.))
            .height(px(32.))
            .text_size(px(14.))
            .bg(Hsla::from(theme.gray_2))
            .border(Hsla::from(theme.gray_2))
            .into_any_element()
    }

    /// `Dialog.Content`: `p-4 flex flex-col border-y border-gray-3`, holding
    /// the two labelled boxes and the chevron between them.
    fn render_crop_body(&self, state: &CropState, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let (w, h) = state.box_size;

        let labelled = |label: &'static str, body: AnyElement| {
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    // `px-1 text-[11px] font-medium tracking-wide uppercase
                    // text-gray-10`.
                    div()
                        .px(px(4.))
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.gray_10))
                        .child(label),
                )
                .child(body)
        };

        div()
            .flex()
            .flex_col()
            .p(px(16.))
            .border_t_1()
            .border_b_1()
            .border_color(Hsla::from(theme.gray_3))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.))
                    .justify_center()
                    .items_stretch()
                    .child(labelled("Crop area", self.render_crop_area(state, cx)))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .self_end()
                            .h(px(h))
                            .child(
                                svg()
                                    .path("icons/chevron-right.svg")
                                    .size(px(20.))
                                    .text_color(Hsla::from(theme.gray_8)),
                            ),
                    )
                    .child(labelled("Preview", self.render_crop_preview(px(w), px(h)))),
            )
            .into_any_element()
    }

    /// The cropper itself: the raw frame, the occluder, the region and the
    /// eight handles.
    fn render_crop_area(&self, state: &CropState, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let (w, h) = state.container;
        let (box_w, box_h) = state.box_size;
        let bounds = state.display_raw;
        let too_small = state.bounds_too_small();
        let dragging = state.drag.is_some();
        let drag_cursor = state.drag.map(|drag| drag.cursor());
        // `cursor: cursorStyle() ?? (props.aspectRatio ? "default" :
        // "crosshair")` on the container (`:1091`).
        let base_cursor = drag_cursor.unwrap_or(if state.aspect.is_some() {
            CursorStyle::Arrow
        } else {
            CursorStyle::Crosshair
        });

        let region = div()
            .absolute()
            .left(px(bounds.x as f32))
            .top(px(bounds.y as f32))
            .w(px(bounds.width as f32))
            .h(px(bounds.height as f32))
            .border_1()
            // `border border-white/50` (`:1139`).
            .border_color(gpui::hsla(0., 0., 1., 0.5))
            .cursor(drag_cursor.unwrap_or(CursorStyle::OpenHand))
            // The rule-of-thirds grid, shown while any drag is live
            // (`:1168-1174`): `border-white/40`.
            .children(dragging.then(|| thirds_grid(bounds)))
            // The snapped-ratio badge (`:1295-1321`). Only while free.
            .children(
                (state.aspect.is_none() && !too_small)
                    .then_some(state.snapped)
                    .flatten()
                    .map(|ratio| {
                        div()
                            .absolute()
                            .top_0()
                            .w(px(bounds.width as f32))
                            .h(px(32.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .h(px(18.))
                                    .w(px(44.))
                                    .rounded_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .border_1()
                                    .border_color(gpui::hsla(0., 0., 1., 0.7))
                                    .bg(if theme.is_dark() {
                                        gpui::hsla(0., 0., 0., 0.5)
                                    } else {
                                        gpui::hsla(0., 0., 1., 0.5)
                                    })
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(SharedString::from(format!("{}:{}", ratio.0, ratio.1))),
                            )
                    }),
            )
            // The corner glyphs: an L of two bars, `stroke="white"` with a
            // drop shadow, shrinking to nothing when the region is tiny
            // (`:1205-1238`).
            .children(
                HANDLES
                    .iter()
                    .filter(|handle| handle.is_corner)
                    .flat_map(|handle| corner_glyph(*handle, bounds, too_small)),
            );

        // The eight hit zones, in the source's paint order: edges first (which
        // is why the move layer occludes their inner halves), then the move
        // layer, then the corners.
        let mut layers = div().absolute().inset_0();
        for handle in HANDLES.iter().filter(|handle| !handle.is_corner) {
            layers = layers.child(handle_zone(*handle, bounds, drag_cursor));
        }
        layers = layers.child(
            div()
                .absolute()
                .left(px(bounds.x as f32))
                .top(px(bounds.y as f32))
                .w(px(bounds.width as f32))
                .h(px(bounds.height as f32))
                .cursor(drag_cursor.unwrap_or(CursorStyle::OpenHand)),
        );
        for handle in HANDLES.iter().filter(|handle| handle.is_corner) {
            let cursor = match (drag_cursor, state.hovering) {
                // `mouseState.drag === "handle" &&
                // mouseState.hoveringHandle?.isCorner` (`:1186-1189`).
                (Some(_), Some(hovering)) if hovering.is_corner => hovering.direction.cursor(),
                (Some(cursor), _) => cursor,
                (None, _) => handle.direction.cursor(),
            };
            layers = layers.child(handle_zone_with_cursor(*handle, bounds, cursor));
        }

        div()
            .id("crop-area")
            .relative()
            .w(px(box_w))
            .h(px(box_h))
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_3))
            .overflow_hidden()
            .cursor(base_cursor)
            // The box's painted origin, so a pointer position can be made
            // container-local. gpui has no `getBoundingClientRect`; this is
            // the shared-cell shape `ui::Slider` uses for its track.
            .child(
                gpui::canvas(
                    {
                        let cell = self.crop_area_rect.clone();
                        move |bounds, _window, _cx| {
                            cell.set(Some(bounds));
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(match (&state.frame, state.frame_failed) {
                (Some(image), _) => Some(
                    img(image.clone())
                        .absolute()
                        .inset_0()
                        .size_full()
                        .into_any_element(),
                ),
                (None, true) => Some(
                    img(self.crop_screenshot_path())
                        .absolute()
                        .inset_0()
                        .size_full()
                        .into_any_element(),
                ),
                (None, false) => None,
            })
            // The four occluder quads (`:1124-1133`).
            .children(occluders(bounds, w, h))
            .child(region)
            .child(layers)
            // `Loading frame…` (`Editor.tsx:1356-1364`).
            .children((state.frame.is_none() && !state.frame_failed).then(|| {
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(Hsla::from(theme.gray_3))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Loading frame…")
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::crop_mouse_down))
            // `onContextMenu={(e) => showCropOptionsMenu(e, true)}` -- anchored
            // at the cursor (`Editor.tsx:1333-1335`).
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.open_crop_menu(event.position, window, cx);
                }),
            )
            .into_any_element()
    }

    fn crop_screenshot_path(&self) -> Arc<std::path::Path> {
        self.project_path.join("screenshots/display.jpg").into()
    }

    /// The right-hand pane: the live composited frame, which is the same
    /// `latestFrame` the player draws, `object-contain` inside the box
    /// (`Editor.tsx:1395-1414`).
    fn render_crop_preview(&self, w: Pixels, h: Pixels) -> AnyElement {
        let theme = self.theme;
        let frame_size = self
            .frame_layout
            .map(|layout| (layout.output_size[0] as f32, layout.output_size[1] as f32))
            .unwrap_or((1920., 1080.));
        let (fitted_w, fitted_h) = letterbox((f32::from(w), f32::from(h)), frame_size);

        div()
            .relative()
            .w(w)
            .h(h)
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_3))
            .overflow_hidden()
            .children(match self.latest_frame.clone() {
                Some(frame) => Some(
                    gpui::canvas(
                        |bounds, _window, _cx| bounds,
                        move |_, bounds, window, _cx| frame.paint(bounds, window),
                    )
                    .w(px(fitted_w))
                    .h(px(fitted_h))
                    .into_any_element(),
                ),
                None => Some(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.gray_10))
                        .child("Rendering preview…")
                        .into_any_element(),
                ),
            })
            .into_any_element()
    }

    /// `Dialog.Footer` with the single `Save` button (`Editor.tsx:1412-1434`).
    fn render_crop_footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .h(px(DIALOG_FOOTER_HEIGHT))
            .px(px(16.))
            .flex_none()
            .child(
                ui::Button::plain(
                    &theme,
                    "crop-save",
                    ui::ButtonVariant::Primary,
                    ui::ButtonSize::Md,
                )
                .label("Save")
                .on_click(cx.listener(|this, _, window, cx| this.save_crop(window, cx))),
            )
            .into_any_element()
    }

    fn render_crop_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.crop.as_ref()?;
        let menu = state.menu.as_ref()?;
        let items = crop_menu_items(state.aspect, self.crop_snap_to_ratio);
        Some(
            ui::Menu::plain(&self.theme, "crop-menu", items, menu)
                .on_select(cx.listener(|this, index: &usize, window, cx| {
                    this.choose_crop_menu(*index, window, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    if let Some(state) = this.crop.as_mut() {
                        state.menu = None;
                    }
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

/// The four `bg-black/45` quads around the region (`:1124-1133`).
fn occluders(bounds: CropBounds, w: f32, h: f32) -> Vec<gpui::Div> {
    let fill = gpui::hsla(0., 0., 0., OCCLUDER_ALPHA);
    let (x, y, bw, bh) = (
        bounds.x as f32,
        bounds.y as f32,
        bounds.width as f32,
        bounds.height as f32,
    );
    vec![
        // left
        div()
            .absolute()
            .left_0()
            .top_0()
            .w(px(x.max(0.)))
            .h(px(h))
            .bg(fill),
        // right
        div()
            .absolute()
            .left(px(x + bw))
            .top_0()
            .w(px((w - x - bw).max(0.)))
            .h(px(h))
            .bg(fill),
        // top
        div()
            .absolute()
            .left(px(x))
            .top_0()
            .w(px(bw))
            .h(px(y.max(0.)))
            .bg(fill),
        // bottom
        div()
            .absolute()
            .left(px(x))
            .top(px(y + bh))
            .w(px(bw))
            .h(px((h - y - bh).max(0.)))
            .bg(fill),
    ]
}

/// The rule-of-thirds cross drawn inside the region during a drag.
fn thirds_grid(bounds: CropBounds) -> gpui::Div {
    let line = gpui::hsla(0., 0., 1., 0.4);
    let (w, h) = (bounds.width as f32, bounds.height as f32);
    div()
        .absolute()
        .inset_0()
        .child(
            div()
                .absolute()
                .left_0()
                .top(px(h / 3.))
                .w(px(w))
                .h(px(1.))
                .bg(line),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .top(px(h * 2. / 3.))
                .w(px(w))
                .h(px(1.))
                .bg(line),
        )
        .child(
            div()
                .absolute()
                .top_0()
                .left(px(w / 3.))
                .h(px(h))
                .w(px(1.))
                .bg(line),
        )
        .child(
            div()
                .absolute()
                .top_0()
                .left(px(w * 2. / 3.))
                .h(px(h))
                .w(px(1.))
                .bg(line),
        )
}

/// The corner L. The SVG is `size-6` in a `0 0 16 16` viewBox with
/// `stroke-width: 4` and `stroke-linecap: square`, offset 9px inside a 30px
/// button that starts 12px outside the corner -- which resolves to two 24x6
/// bars whose inner edges sit exactly on the region's corner. `size-1` when
/// the region is under 30px (`:1208-1211`).
fn corner_glyph(handle: Handle, bounds: CropBounds, too_small: bool) -> Vec<gpui::Div> {
    let scale = if too_small { 4. / 24. } else { 1. };
    let arm = 24. * scale;
    let thickness = 6. * scale;
    let (w, h) = (bounds.width as f32, bounds.height as f32);
    let left = matches!(handle.x, Axis::Low);
    let top = matches!(handle.y, Axis::Low);

    let x0 = if left {
        -thickness
    } else {
        w - arm + thickness
    };
    let y0 = if top { -thickness } else { h - arm + thickness };
    let bar_x = if left { -thickness } else { w };
    let bar_y = if top { -thickness } else { h };
    let white = gpui::hsla(0., 0., 1., 1.);

    vec![
        // horizontal arm
        div()
            .absolute()
            .left(px(x0))
            .top(px(bar_y))
            .w(px(arm))
            .h(px(thickness))
            .bg(white),
        // vertical arm
        div()
            .absolute()
            .left(px(bar_x))
            .top(px(y0))
            .w(px(thickness))
            .h(px(arm))
            .bg(white),
    ]
}

/// A handle's transparent hit zone, carrying its cursor.
fn handle_zone(handle: Handle, bounds: CropBounds, drag_cursor: Option<CursorStyle>) -> gpui::Div {
    handle_zone_with_cursor(
        handle,
        bounds,
        drag_cursor.unwrap_or(handle.direction.cursor()),
    )
}

fn handle_zone_with_cursor(handle: Handle, bounds: CropBounds, cursor: CursorStyle) -> gpui::Div {
    let rect = handle_rect(handle, bounds);
    div()
        .absolute()
        .left(px((bounds.x + rect.x) as f32))
        .top(px((bounds.y + rect.y) as f32))
        .w(px(rect.width as f32))
        .h(px(rect.height as f32))
        .cursor(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- The coordinate spaces ----------------------------------------------

    /// The box the editor's 1275x800 window gives a 3024x1964 recording, and
    /// the scale that follows from it.
    #[test]
    fn crop_box_fits_the_display_aspect_into_the_source_caps() {
        // maxW = min(1275 * 0.4, 520) = 510; maxH = min(800 * 0.5, 520) = 400.
        // 510 / (3024/1964) = 331.2 -> under 400, so the width wins.
        assert_eq!(crop_box_size((1275., 800.), (3024, 1964)), (510., 331.));
        // An ultrawide is capped by width too, but a tall display is capped by
        // height: 510 / (1080/1920) = 906 > 400, so h = 400, w = 225.
        assert_eq!(crop_box_size((1275., 800.), (1080, 1920)), (225., 400.));
        // A large viewport is still capped at 520.
        assert_eq!(crop_box_size((2000., 1400.), (1000, 1000)), (520., 520.));
    }

    #[test]
    fn real_bounds_are_target_pixels_and_raw_bounds_are_container_pixels() {
        let target = Vec2::new(3024., 1964.);
        let container = Vec2::new(510., 331.);
        let scale = logical_scale(target, container);
        assert!((scale.x - 5.9294117).abs() < 1e-6);
        assert!((scale.y - 5.9335347).abs() < 1e-6);

        // A 100x50 rect at (10, 20) in the box is 593x297 at (59, 119) in the
        // recording.
        let raw = CropBounds::new(10., 20., 100., 50.);
        let real = real_bounds(raw, scale, target);
        assert_eq!(real, CropBounds::new(59., 119., 593., 297.));

        // ...and back, unrounded.
        let round_trip = bounds_to_raw(real, scale);
        assert!((round_trip.x - 9.9503).abs() < 0.01);
        assert!((round_trip.width - 100.0093).abs() < 0.01);
    }

    #[test]
    fn real_bounds_never_leave_the_recording() {
        let target = Vec2::new(3024., 1964.);
        let container = Vec2::new(510., 331.);
        let scale = logical_scale(target, container);
        // The whole box maps to the whole recording, clamped rather than
        // rounded past it.
        let real = real_bounds(CropBounds::new(0., 0., 510., 331.), scale, target);
        assert_eq!(real, CropBounds::new(0., 0., 3024., 1964.));

        // A rect hanging off the right edge is slid back in, not shrunk.
        let real = real_bounds(CropBounds::new(500., 0., 100., 50.), scale, target);
        assert_eq!(real.width, 593.);
        assert_eq!(real.x, 3024. - 593.);
    }

    #[test]
    fn js_round_rounds_a_half_up_not_away_from_zero() {
        assert_eq!(js_round(0.5), 1.);
        assert_eq!(js_round(1.5), 2.);
        // The one that differs from `f64::round`.
        assert_eq!(js_round(-0.5), 0.);
        assert_eq!(js_round(-1.5), -1.);
        assert_eq!((-1.5f64).round(), -2.);
    }

    // -- Handle hit zones ---------------------------------------------------

    #[test]
    fn corner_hit_zones_are_30px_boxes_straddling_the_corner() {
        let bounds = CropBounds::new(100., 50., 200., 120.);
        let nw = handle_rect(HANDLES[0], bounds);
        assert_eq!((nw.x, nw.y, nw.width, nw.height), (-12., -12., 30., 30.));
        let se = handle_rect(HANDLES[3], bounds);
        // right: -12px on a 200-wide region -> [200 - 18, 200 + 12].
        assert_eq!((se.x, se.y, se.width, se.height), (182., 102., 30., 30.));

        // In container coordinates the NW zone is (88, 38)..(118, 68).
        assert_eq!(
            hit_test(Vec2::new(90., 40.), bounds),
            CropHit::Handle(HANDLES[0])
        );
        assert_eq!(
            hit_test(Vec2::new(117., 67.), bounds),
            CropHit::Handle(HANDLES[0])
        );
        // ...and one pixel past it is the region's own move zone.
        assert_eq!(hit_test(Vec2::new(119., 69.), bounds), CropHit::Move);
    }

    #[test]
    fn edge_hit_zones_are_10px_bars_shifted_half_their_width_outwards() {
        let bounds = CropBounds::new(100., 50., 200., 120.);
        let west = handle_rect(HANDLES[6], bounds);
        // `left: -1px; width: 10px; translateX(-50%)` -> [-6, 4].
        assert_eq!((west.x, west.width), (-6., 10.));
        // `top: 10px; bottom: 10px`.
        assert_eq!((west.y, west.height), (10., 100.));

        let east = handle_rect(HANDLES[7], bounds);
        assert_eq!((east.x, east.width), (196., 10.));
        let north = handle_rect(HANDLES[4], bounds);
        assert_eq!((north.y, north.height), (-6., 10.));
        assert_eq!((north.x, north.width), (10., 180.));
        let south = handle_rect(HANDLES[5], bounds);
        assert_eq!((south.y, south.height), (116., 10.));
    }

    /// The transcribed z-order artefact: the move button is `z-10` and the
    /// edge handles carry no z-index, so only the part of an edge handle that
    /// sticks out past the region is grabbable.
    #[test]
    fn an_edge_handle_is_only_live_outside_the_region() {
        let bounds = CropBounds::new(100., 50., 200., 120.);
        // 2px outside the left border: the west handle.
        assert_eq!(
            hit_test(Vec2::new(98., 110.), bounds),
            CropHit::Handle(HANDLES[6])
        );
        // 2px inside it: the move layer, even though the handle's box reaches
        // 4px in.
        assert_eq!(hit_test(Vec2::new(102., 110.), bounds), CropHit::Move);
        // 8px outside: past the 6px reach, so the draw layer.
        assert_eq!(hit_test(Vec2::new(92., 110.), bounds), CropHit::Draw);
        // The north handle, inset 10px from each corner.
        assert_eq!(
            hit_test(Vec2::new(200., 46.), bounds),
            CropHit::Handle(HANDLES[4])
        );
        // ...but 5px in from the left corner is inside the NW corner's box.
        assert_eq!(
            hit_test(Vec2::new(105., 46.), bounds),
            CropHit::Handle(HANDLES[0])
        );
    }

    #[test]
    fn a_press_far_from_the_region_draws_a_new_one() {
        let bounds = CropBounds::new(100., 50., 200., 120.);
        assert_eq!(hit_test(Vec2::new(400., 300.), bounds), CropHit::Draw);
    }

    // -- Aspect lock --------------------------------------------------------

    #[test]
    fn an_aspect_locked_corner_drag_holds_the_ratio_exactly() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: false,
            shift: false,
            ratio: Some(16. / 9.),
            snap_to_ratio: false,
        };
        let start = CropBounds::new(50., 50., 160., 90.);
        // Drag the SE corner out to (400, 200). The anchor is (50, 50);
        // rawWidth 350, rawHeight 150. 350 / (16/9) = 196.9 > 150, so the
        // width leads: 350 x 196.875 -> rounds to 350 x 197.
        let bounds = compute_aspect_ratio_resize(400., 200., start, HANDLES[3], options).unwrap();
        assert_eq!(bounds, CropBounds::new(50., 50., 350., 197.));

        // The dominant-axis rule the other way: a tall drag lets the height
        // lead. (100, 300): rawWidth 50, rawHeight 250; 50 / (16/9) = 28 < 250.
        let bounds = compute_aspect_ratio_resize(100., 300., start, HANDLES[3], options).unwrap();
        assert_eq!(bounds.height, 250.);
        assert_eq!(bounds.width, js_round(250. * 16. / 9.));
    }

    #[test]
    fn an_aspect_locked_drag_that_would_leave_the_box_is_refused() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: false,
            shift: false,
            ratio: Some(16. / 9.),
            snap_to_ratio: false,
        };
        let start = CropBounds::new(50., 50., 160., 90.);
        // (400, 300) from the anchor (50, 50): rawWidth 350, rawHeight 250,
        // and 350 / (16/9) = 196.9 < 250 so the **height** leads -- 250 x
        // 444.4, whose right edge (494.4) is still inside 510. Accepted.
        assert!(compute_aspect_ratio_resize(400., 300., start, HANDLES[3], options).is_some());
        // (509, 330) wants 280 x 497.8 from x=50, i.e. a right edge at 547.8.
        // Past the container, so the drag is **refused** and the rect stays
        // where the last accepted move left it -- the aspect lock never slides
        // along an edge.
        assert!(compute_aspect_ratio_resize(509., 330., start, HANDLES[3], options).is_none());
        // Anchoring at the bottom-right and dragging up-left past the top
        // leaves the container too.
        let start = CropBounds::new(400., 300., 100., 30.);
        assert!(compute_aspect_ratio_resize(0., 0., start, HANDLES[0], options).is_none());
    }

    #[test]
    fn constrain_to_ratio_keeps_the_width_and_solves_for_the_height() {
        let bounds = CropBounds::new(0., 0., 320., 320.);
        let next = constrain_bounds_to_ratio(bounds, 16. / 9., ORIGIN_CENTER);
        assert_eq!(next.width, 320.);
        assert_eq!(next.height, 180.);
        // Centred: the box shrank by 140, so the top moved down 70.
        assert_eq!(next.y, 70.);
        // Already at the ratio -> untouched, including the origin shift.
        let same = constrain_bounds_to_ratio(next, 16. / 9., ORIGIN_TOP_LEFT);
        assert_eq!(same, next);
    }

    #[test]
    fn free_corner_drags_snap_to_the_nearest_common_ratio() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: false,
            shift: false,
            ratio: None,
            snap_to_ratio: true,
        };
        let start = CropBounds::new(0., 0., 100., 100.);
        // Drag SE to (320, 179): 320/179 = 1.7877, and |1.7877 - 1.7778| =
        // 0.0099 < 0.01, so it snaps to 16:9 -- and the *height* leads, so the
        // width becomes 179 * 16/9 = 318.2 -> 318.
        let (bounds, snapped) = compute_free_resize(320., 179., start, HANDLES[3], options);
        assert_eq!(snapped, Some((16, 9)));
        assert_eq!(bounds.height, 179.);
        assert_eq!(bounds.width, js_round(179. * 16. / 9.));

        // Shift suppresses it (`!shiftKey`).
        let (bounds, snapped) = compute_free_resize(
            320.,
            179.,
            start,
            HANDLES[3],
            ResizeOptions {
                shift: true,
                ..options
            },
        );
        assert_eq!(snapped, None);
        assert_eq!((bounds.width, bounds.height), (320., 179.));

        // An edge handle never snaps, even unshifted.
        let (_, snapped) = compute_free_resize(320., 179., start, HANDLES[7], options);
        assert_eq!(snapped, None);
    }

    #[test]
    fn find_closest_ratio_accepts_both_orientations() {
        assert_eq!(find_closest_ratio(1920., 1080., 0.01), Some((16, 9)));
        assert_eq!(find_closest_ratio(1080., 1920., 0.01), Some((9, 16)));
        // `9:16` is listed before `16:9`, so a portrait 9:16 matches its own
        // entry first rather than the flipped `16:9`.
        assert_eq!(find_closest_ratio(900., 1600., 0.01), Some((9, 16)));
        assert_eq!(find_closest_ratio(100., 37., 0.01), None);
    }

    // -- Free resize --------------------------------------------------------

    #[test]
    fn a_free_corner_drag_anchors_the_opposite_corner() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: false,
            shift: true,
            ratio: None,
            snap_to_ratio: false,
        };
        let start = CropBounds::new(100., 100., 200., 100.);
        // SE handle: anchor (100, 100).
        let (bounds, _) = compute_free_resize(400., 250., start, HANDLES[3], options);
        assert_eq!(bounds, CropBounds::new(100., 100., 300., 150.));
        // NW handle: anchor (300, 200), so dragging to (150, 150) gives
        // 150x50 at (150, 150).
        let (bounds, _) = compute_free_resize(150., 150., start, HANDLES[0], options);
        assert_eq!(bounds, CropBounds::new(150., 150., 150., 50.));
        // Crossing the anchor flips the rect rather than going negative.
        let (bounds, _) = compute_free_resize(400., 250., start, HANDLES[0], options);
        assert_eq!(bounds, CropBounds::new(300., 200., 100., 50.));
    }

    #[test]
    fn an_edge_drag_only_moves_its_own_axis() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: false,
            shift: true,
            ratio: None,
            snap_to_ratio: false,
        };
        let start = CropBounds::new(100., 100., 200., 100.);
        // East handle: only the width changes.
        let (bounds, _) = compute_free_resize(350., 400., start, HANDLES[7], options);
        assert_eq!(bounds, CropBounds::new(100., 100., 250., 100.));
        // North handle: only y and height.
        let (bounds, _) = compute_free_resize(999., 40., start, HANDLES[4], options);
        assert_eq!(bounds, CropBounds::new(100., 40., 200., 160.));
    }

    #[test]
    fn an_alt_drag_grows_about_the_centre_and_stops_at_the_box() {
        let options = ResizeOptions {
            container: Vec2::new(510., 331.),
            min: None,
            max: None,
            is_alt: true,
            shift: true,
            ratio: None,
            snap_to_ratio: false,
        };
        // Centre (200, 150). A pointer 150 to the right grows 150 each way.
        let start = CropBounds::new(100., 100., 200., 100.);
        let (bounds, _) = compute_free_resize(350., 200., start, HANDLES[3], options);
        assert_eq!(bounds.width, 300.);
        assert_eq!(bounds.x, 50.);
        // Each side's growth is capped independently at its own container
        // edge, so the result is *not* symmetric: a centre 100px from the left
        // grows 100 that way and 400 the other, giving 500 -- and the rect is
        // then re-centred on the old centre, so it hangs 150px off the left.
        let start = CropBounds::new(50., 100., 100., 100.);
        let (bounds, _) = compute_free_resize(500., 150., start, HANDLES[3], options);
        assert_eq!(bounds.width, 500.);
        assert_eq!(bounds.x, -150.);
    }

    #[test]
    fn dropping_alt_mid_drag_re_picks_the_moving_edges() {
        let bounds = CropBounds::new(100., 100., 200., 100.);
        // Pointer left of centre (200): the west and north edges move.
        let handle = update_handle_for_mode_switch(HANDLES[3], bounds, 120., 120.);
        assert!(handle.movable.left && !handle.movable.right);
        assert!(handle.movable.top && !handle.movable.bottom);
        // Pointer right of and below centre: back to the SE behaviour.
        let handle = update_handle_for_mode_switch(HANDLES[3], bounds, 280., 180.);
        assert!(handle.movable.right && !handle.movable.left);
        assert!(handle.movable.bottom && !handle.movable.top);
    }

    // -- Keyboard nudging ---------------------------------------------------

    #[test]
    fn a_nudge_moves_two_pixels_and_ten_with_shift() {
        let bounds = CropBounds::new(100., 100., 200., 100.);
        let mut keys = KeyNudge::default();
        keys.keys.insert("right");
        let (moved, origin) = keys.step(bounds);
        assert_eq!(moved.x, 102.);
        assert_eq!(moved.y, 100.);
        assert_eq!(origin, ORIGIN_CENTER);

        keys.shift = true;
        assert_eq!(keys.step(bounds).0.x, 110.);

        // Two arrows at once move diagonally, and opposite arrows cancel.
        let mut keys = KeyNudge::default();
        keys.keys.insert("right");
        keys.keys.insert("down");
        let (moved, _) = keys.step(bounds);
        assert_eq!((moved.x, moved.y), (102., 102.));
        keys.keys.insert("left");
        assert_eq!(keys.step(bounds).0.x, 100.);
    }

    #[test]
    fn cmd_arrow_resizes_from_the_top_left_and_alt_from_the_centre() {
        let bounds = CropBounds::new(100., 100., 200., 100.);
        let mut keys = KeyNudge {
            meta: true,
            ..Default::default()
        };
        keys.keys.insert("right");
        let (resized, origin) = keys.step(bounds);
        assert_eq!(origin, ORIGIN_TOP_LEFT);
        assert_eq!(resized, CropBounds::new(100., 100., 202., 100.));

        keys.alt = true;
        let (resized, origin) = keys.step(bounds);
        assert_eq!(origin, ORIGIN_CENTER);
        // Centred: the extra 2px is split, so x moves back 1.
        assert_eq!(resized, CropBounds::new(99., 100., 202., 100.));

        // A resize never goes below 1px.
        let mut keys = KeyNudge {
            meta: true,
            shift: true,
            ..Default::default()
        };
        keys.keys.insert("left");
        let tiny = CropBounds::new(0., 0., 4., 4.);
        assert_eq!(keys.step(tiny).0.width, 1.);
    }

    #[test]
    fn a_nudge_is_clamped_into_the_container() {
        let mut state = CropState::new(
            (3024, 1964),
            (510., 331.),
            CropBounds::new(0., 0., 3024., 1964.),
        );
        // Full-frame: the rect already fills the container, so nothing moves.
        assert_eq!(state.raw, CropBounds::new(0., 0., 508., 329.));
        let mut keys = KeyNudge::default();
        keys.keys.insert("right");
        let (moved, origin) = keys.step(state.raw);
        state.set_raw_constraining(moved, origin);
        assert_eq!(state.raw.x, 0.);

        // Shrink it, then walk it off the left edge.
        state.set_raw_constraining(CropBounds::new(4., 4., 100., 100.), ORIGIN_TOP_LEFT);
        let mut keys = KeyNudge::default();
        keys.keys.insert("left");
        for _ in 0..5 {
            let (moved, origin) = keys.step(state.raw);
            state.set_raw_constraining(moved, origin);
        }
        assert_eq!(state.raw.x, 0.);
        assert_eq!(state.raw.width, 100.);
    }

    // -- The state machine --------------------------------------------------

    #[test]
    fn opening_on_no_crop_starts_at_the_whole_frame() {
        let state = CropState::new(
            (3024, 1964),
            (510., 331.),
            CropBounds::new(0., 0., 3024., 1964.),
        );
        assert_eq!(state.raw, CropBounds::new(0., 0., 508., 329.));
        assert_eq!(state.real(), CropBounds::new(0., 0., 3024., 1964.));
    }

    #[test]
    fn opening_on_an_existing_crop_reconstructs_the_rect() {
        let initial = CropBounds::new(600., 400., 1200., 800.);
        let state = CropState::new((3024, 1964), (510., 331.), initial);
        // scale.x = 3024 / 508 = 5.952756, so 600 -> 100.79 and 1200 -> 201.59.
        assert!((state.raw.x - 100.79).abs() < 0.05);
        assert!((state.raw.width - 201.59).abs() < 0.05);
        // The round trip through target space is within a pixel of where it
        // started -- the rounding is the container's, not an accumulation.
        let real = state.real();
        assert!((real.x - 600.).abs() <= 3.);
        assert!((real.width - 1200.).abs() <= 3.);
    }

    #[test]
    fn set_property_pins_the_top_left() {
        let mut state = CropState::new(
            (3024, 1964),
            (510., 331.),
            CropBounds::new(0., 0., 3024., 1964.),
        );
        state.set_property(CropField::Width, 1512.);
        let real = state.real();
        assert!((real.width - 1512.).abs() <= 6.);
        assert_eq!(real.x, 0.);
        assert_eq!(real.height, 1964.);
    }

    #[test]
    fn fill_and_reset_walk_between_the_whole_frame_and_the_opening_crop() {
        let initial = CropBounds::new(600., 400., 1200., 800.);
        let mut state = CropState::new((3024, 1964), (510., 331.), initial);
        state.fill();
        // The animation is what paints; `raw` is already at the target.
        assert_eq!(state.raw, CropBounds::new(0., 0., 508., 329.));
        assert!(state.anim.is_some());
        state.stop_animation();
        assert_eq!(state.display_raw, state.raw);

        state.set_aspect(Some((16, 9)));
        assert_eq!(state.aspect, Some((16, 9)));
        state.stop_animation();
        let real = state.real();
        assert!(((real.width / real.height) - 16. / 9.).abs() < 0.02);

        state.reset();
        // Reset also clears the ratio lock.
        assert_eq!(state.aspect, None);
        state.stop_animation();
        let real = state.real();
        assert!((real.x - 600.).abs() <= 3.);
        assert!((real.width - 1200.).abs() <= 3.);
    }

    #[test]
    fn resizing_the_window_preserves_the_target_space_rect() {
        let mut state = CropState::new(
            (3024, 1964),
            (510., 331.),
            CropBounds::new(600., 400., 1200., 800.),
        );
        // A 510x331 wrapper observes a 508x329 content box.
        assert_eq!(state.container, (508., 329.));
        let before = state.real();
        let box_size = crop_box_size((1600., 1000.), (3024, 1964));
        state.set_container(box_size, (box_size.0 - 2., box_size.1 - 2.));
        let after = state.real();
        assert!((before.x - after.x).abs() <= 6.);
        assert!((before.width - after.width).abs() <= 6.);
    }

    #[test]
    fn a_double_click_on_a_handle_pushes_its_own_edges_out() {
        let bounds = CropBounds::new(100., 50., 200., 120.);
        let container = Vec2::new(510., 331.);
        // West handle: the left edge goes to 0 and the width grows to match.
        let next = double_click_bounds(HANDLES[6], bounds, container);
        assert_eq!(next, CropBounds::new(0., 50., 300., 120.));
        // SE corner: both far edges go to the container.
        let next = double_click_bounds(HANDLES[3], bounds, container);
        assert_eq!(next, CropBounds::new(100., 50., 410., 281.));
    }

    // -- The menu -----------------------------------------------------------

    #[test]
    fn the_menu_lists_free_then_the_eight_ratios_then_the_snap_toggle() {
        let items = crop_menu_items(Some((16, 9)), true);
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].label.as_ref(), "Free");
        assert!(!items[0].checked);
        assert_eq!(items[6].label.as_ref(), "16:9");
        assert!(items[6].checked);
        assert_eq!(items[9].label.as_ref(), "Snap to ratios");
        assert!(items[9].checked);

        assert!(matches!(
            crop_menu_choice(0),
            Some(CropMenuChoice::Aspect(None))
        ));
        assert!(matches!(
            crop_menu_choice(6),
            Some(CropMenuChoice::Aspect(Some((16, 9))))
        ));
        assert!(matches!(
            crop_menu_choice(9),
            Some(CropMenuChoice::ToggleSnap)
        ));
        assert!(crop_menu_choice(10).is_none());
    }
}
