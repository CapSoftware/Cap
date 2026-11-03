use cap_project::{
    SHAPE_REFERENCE_HEIGHT, ShapeArrowHead, ShapeKind, ShapeRect, ShapeSegment, XY, arrow_head_size,
};
use gpui::CursorStyle;

use crate::editor_canvas::{
    GuideAxis, NormRect, SNAP_PX, SnapGuide, SnapTargets, guide_for, snap_axis, snap_moving_rect,
};

pub type Px = (f64, f64);

pub const HANDLE_SIZE: f64 = 10.;
pub const HANDLE_HIT: f64 = 20.;
const HIT_SLOP: f64 = 6.;
const MIN_EXTENT_PX: f64 = 2.;
pub const MIN_DRAW_PX: f64 = 4.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeHandle {
    Box { x: i8, y: i8 },
    From,
    To,
}

impl ShapeHandle {
    pub fn cursor(self) -> CursorStyle {
        match self {
            Self::Box { x: 0, .. } => CursorStyle::ResizeUpDown,
            Self::Box { y: 0, .. } => CursorStyle::ResizeLeftRight,
            Self::Box { x, y } if x == y => CursorStyle::ResizeUpLeftDownRight,
            Self::Box { .. } => CursorStyle::ResizeUpRightDownLeft,
            Self::From | Self::To => CursorStyle::Crosshair,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Box { x: -1, y: -1 } => "nw",
            Self::Box { x: 0, y: -1 } => "n",
            Self::Box { x: 1, y: -1 } => "ne",
            Self::Box { x: -1, y: 0 } => "w",
            Self::Box { x: 1, y: 0 } => "e",
            Self::Box { x: -1, y: 1 } => "sw",
            Self::Box { x: 0, y: 1 } => "s",
            Self::Box { .. } => "se",
            Self::From => "from",
            Self::To => "to",
        }
    }
}

fn to_px(point: XY<f64>, canvas: Px) -> Px {
    (point.x * canvas.0, point.y * canvas.1)
}

fn to_norm(point: Px, canvas: Px) -> XY<f64> {
    XY::new(point.0 / canvas.0.max(1.), point.1 / canvas.1.max(1.))
}

pub fn stroke_on_canvas(segment: &ShapeSegment, canvas: Px) -> f64 {
    f64::from(segment.stroke_width.max(0.)) * canvas.1 / SHAPE_REFERENCE_HEIGHT
}

pub fn shape_bounds(segment: &ShapeSegment) -> NormRect {
    let rect = segment.rect();
    NormRect {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    }
}

pub fn handles(segment: &ShapeSegment, canvas: Px) -> Vec<(ShapeHandle, Px)> {
    if segment.kind.is_line() {
        return vec![
            (ShapeHandle::From, to_px(segment.from, canvas)),
            (ShapeHandle::To, to_px(segment.to, canvas)),
        ];
    }
    let rect = segment.rect();
    let (left, top) = (rect.x * canvas.0, rect.y * canvas.1);
    let (width, height) = (rect.w * canvas.0, rect.h * canvas.1);
    let x_at = |x: i8| left + width * (f64::from(x) + 1.) / 2.;
    let y_at = |y: i8| top + height * (f64::from(y) + 1.) / 2.;
    let mut out = Vec::with_capacity(8);
    for (x, y) in [(-1, -1), (1, -1), (-1, 1), (1, 1)] {
        out.push((ShapeHandle::Box { x, y }, (x_at(x), y_at(y))));
    }
    if !segment.kind.keeps_square() {
        if width >= HANDLE_HIT * 3. {
            for y in [-1, 1] {
                out.push((ShapeHandle::Box { x: 0, y }, (x_at(0), y_at(y))));
            }
        }
        if height >= HANDLE_HIT * 3. {
            for x in [-1, 1] {
                out.push((ShapeHandle::Box { x, y: 0 }, (x_at(x), y_at(0))));
            }
        }
    }
    out
}

pub fn hit_handle(segment: &ShapeSegment, canvas: Px, point: Px) -> Option<ShapeHandle> {
    handles(segment, canvas)
        .into_iter()
        .filter(|(_, at)| {
            (at.0 - point.0).abs() <= HANDLE_HIT / 2. && (at.1 - point.1).abs() <= HANDLE_HIT / 2.
        })
        .min_by(|(_, a), (_, b)| {
            let da = (a.0 - point.0).hypot(a.1 - point.1);
            let db = (b.0 - point.0).hypot(b.1 - point.1);
            da.total_cmp(&db)
        })
        .map(|(handle, _)| handle)
}

pub fn distance_to_segment(point: Px, a: Px, b: Px) -> f64 {
    let (vx, vy) = (b.0 - a.0, b.1 - a.1);
    let length_sq = vx * vx + vy * vy;
    let t = if length_sq <= f64::EPSILON {
        0.
    } else {
        (((point.0 - a.0) * vx + (point.1 - a.1) * vy) / length_sq).clamp(0., 1.)
    };
    (point.0 - (a.0 + vx * t)).hypot(point.1 - (a.1 + vy * t))
}

fn ellipse_radial_distance(point: Px, center: Px, radii: Px) -> f64 {
    let (dx, dy) = (point.0 - center.0, point.1 - center.1);
    let distance = dx.hypot(dy);
    if radii.0 <= f64::EPSILON || radii.1 <= f64::EPSILON {
        return distance;
    }
    if distance <= f64::EPSILON {
        return -radii.0.min(radii.1);
    }
    let (cos, sin) = (dx / distance, dy / distance);
    let boundary = 1. / ((cos / radii.0).powi(2) + (sin / radii.1).powi(2)).sqrt();
    distance - boundary
}

pub fn hit_shape(segment: &ShapeSegment, canvas: Px, point: Px, selected: bool) -> bool {
    let stroke = stroke_on_canvas(segment, canvas);
    let slop = HIT_SLOP + stroke / 2.;
    let from = to_px(segment.from, canvas);
    let to = to_px(segment.to, canvas);
    match segment.kind {
        ShapeKind::Line => distance_to_segment(point, from, to) <= slop,
        ShapeKind::Arrow => {
            if distance_to_segment(point, from, to) <= slop {
                return true;
            }
            let length = (to.0 - from.0).hypot(to.1 - from.1);
            let stroke_px = f64::from(segment.stroke_width.max(0.));
            let scale = canvas.1 / SHAPE_REFERENCE_HEIGHT;
            let (head_length, head_width) = arrow_head_size(stroke_px, length / scale.max(1e-9));
            let (head_length, head_width) = (head_length * scale, head_width * scale);
            let near_tip = |tip: Px, tail: Px| {
                let along = (point.0 - tip.0).hypot(point.1 - tip.1);
                along <= head_length + HIT_SLOP
                    && distance_to_segment(point, tip, tail) <= head_width / 2. + HIT_SLOP
            };
            near_tip(to, from)
                || (segment.arrow_head == ShapeArrowHead::Double && near_tip(from, to))
        }
        ShapeKind::Badge => {
            let rect = segment.rect();
            let center = to_px(rect.center(), canvas);
            let radius = (rect.w * canvas.0).min(rect.h * canvas.1) / 2.;
            (point.0 - center.0).hypot(point.1 - center.1) <= radius + slop
        }
        ShapeKind::Ellipse => {
            let rect = segment.rect();
            let center = to_px(rect.center(), canvas);
            let radii = (rect.w * canvas.0 / 2., rect.h * canvas.1 / 2.);
            let distance = ellipse_radial_distance(point, center, radii);
            if segment.fill || selected {
                distance <= slop
            } else {
                distance.abs() <= slop
            }
        }
        ShapeKind::Rectangle | ShapeKind::Highlight => {
            let rect = segment.rect();
            let (left, top) = (rect.x * canvas.0, rect.y * canvas.1);
            let (right, bottom) = (left + rect.w * canvas.0, top + rect.h * canvas.1);
            let inside = |inset: f64| {
                point.0 >= left + inset
                    && point.0 <= right - inset
                    && point.1 >= top + inset
                    && point.1 <= bottom - inset
            };
            if !inside(-slop) {
                return false;
            }
            segment.fill || selected || segment.kind == ShapeKind::Highlight || !inside(slop)
        }
    }
}

pub fn topmost_hit(
    segments: &[ShapeSegment],
    candidates: &[usize],
    canvas: Px,
    point: Px,
    selected: Option<usize>,
) -> Option<usize> {
    candidates.iter().rev().copied().find(|index| {
        segments
            .get(*index)
            .is_some_and(|segment| hit_shape(segment, canvas, point, selected == Some(*index)))
    })
}

pub fn moved(
    start: &ShapeSegment,
    delta: Px,
    canvas: Px,
    targets: &SnapTargets,
    snap: bool,
    axis_lock: bool,
) -> (XY<f64>, XY<f64>, Vec<SnapGuide>) {
    let delta = if axis_lock {
        if delta.0.abs() >= delta.1.abs() {
            (delta.0, 0.)
        } else {
            (0., delta.1)
        }
    } else {
        delta
    };
    let bounds = shape_bounds(start);
    let raw = NormRect {
        x: bounds.x + delta.0 / canvas.0.max(1.),
        y: bounds.y + delta.1 / canvas.1.max(1.),
        ..bounds
    };
    let (mut dx, mut dy, mut guides) = if snap {
        snap_moving_rect(
            raw,
            targets,
            SNAP_PX / canvas.0.max(1.),
            SNAP_PX / canvas.1.max(1.),
        )
    } else {
        (0., 0., Vec::new())
    };
    if axis_lock {
        if delta.1 == 0. {
            dy = 0.;
            guides.retain(|guide| guide.axis == GuideAxis::V);
        } else {
            dx = 0.;
            guides.retain(|guide| guide.axis == GuideAxis::H);
        }
    }
    let center_x = raw.x + dx + raw.w / 2.;
    let center_y = raw.y + dy + raw.h / 2.;
    let shift_x = center_x.clamp(0., 1.) - (bounds.x + bounds.w / 2.);
    let shift_y = center_y.clamp(0., 1.) - (bounds.y + bounds.h / 2.);
    (
        XY::new(start.from.x + shift_x, start.from.y + shift_y),
        XY::new(start.to.x + shift_x, start.to.y + shift_y),
        guides,
    )
}

struct AxisResize {
    anchor: f64,
    extent: f64,
    base: f64,
}

fn resize_axis(low: f64, high: f64, direction: i8, delta: f64, from_center: bool) -> AxisResize {
    let center = (low + high) / 2.;
    let (moving, anchor) = if direction < 0 {
        (low + delta, if from_center { center } else { high })
    } else {
        (high + delta, if from_center { center } else { low })
    };
    let base = if from_center {
        (high - low) / 2.
    } else {
        high - low
    };
    AxisResize {
        anchor,
        extent: moving - anchor,
        base,
    }
}

fn span(axis: &AxisResize, from_center: bool) -> (f64, f64) {
    let extent = if axis.extent.abs() < MIN_EXTENT_PX / if from_center { 2. } else { 1. } {
        if axis.extent < 0. {
            -MIN_EXTENT_PX
        } else {
            MIN_EXTENT_PX
        }
    } else {
        axis.extent
    };
    if from_center {
        let half = extent.abs();
        (axis.anchor - half, axis.anchor + half)
    } else {
        let end = axis.anchor + extent;
        (axis.anchor.min(end), axis.anchor.max(end))
    }
}

pub struct ResizeOptions {
    pub keep_aspect: bool,
    pub from_center: bool,
    pub snap: bool,
}

pub fn resized(
    start: ShapeRect,
    handle: (i8, i8),
    delta: Px,
    canvas: Px,
    targets: &SnapTargets,
    options: ResizeOptions,
) -> (ShapeRect, Vec<SnapGuide>) {
    let (cw, ch) = (canvas.0.max(1.), canvas.1.max(1.));
    let (left, top) = (start.x * cw, start.y * ch);
    let (right, bottom) = (left + start.w * cw, top + start.h * ch);
    let ResizeOptions {
        keep_aspect,
        from_center,
        snap,
    } = options;

    let snapped = |edge: f64, size: f64, lines: &[crate::editor_canvas::SnapLine]| {
        if !snap || keep_aspect {
            return (0., None);
        }
        snap_axis(&[edge / size], lines, SNAP_PX / size)
            .map_or((0., None), |(delta, line)| (delta * size, Some(line)))
    };

    let mut x = (handle.0 != 0).then(|| resize_axis(left, right, handle.0, delta.0, from_center));
    let mut y = (handle.1 != 0).then(|| resize_axis(top, bottom, handle.1, delta.1, from_center));
    let mut x_line = None;
    let mut y_line = None;
    if let Some(axis) = x.as_mut() {
        let (adjust, line) = snapped(axis.anchor + axis.extent, cw, &targets.v);
        axis.extent += adjust;
        x_line = line;
    }
    if let Some(axis) = y.as_mut() {
        let (adjust, line) = snapped(axis.anchor + axis.extent, ch, &targets.h);
        axis.extent += adjust;
        y_line = line;
    }

    let (width, height) = (right - left, bottom - top);
    if keep_aspect && width > f64::EPSILON && height > f64::EPSILON {
        let min_scale = MIN_EXTENT_PX / width.min(height);
        let rescale = |axis: &mut AxisResize, scale: f64| {
            let sign = if axis.extent < 0. { -1. } else { 1. };
            axis.extent = axis.base * scale * sign;
        };
        let scale_of = |axis: &AxisResize| axis.extent.abs() / axis.base.max(f64::EPSILON);
        match (x.as_mut(), y.as_mut()) {
            (Some(ax), Some(ay)) => {
                let scale = scale_of(ax).max(scale_of(ay)).max(min_scale);
                rescale(ax, scale);
                rescale(ay, scale);
            }
            (Some(ax), None) => {
                let scale = scale_of(ax).max(min_scale);
                rescale(ax, scale);
                let half = height * scale / 2.;
                let (low, high) = span(ax, from_center);
                let center = (top + bottom) / 2.;
                return finish(
                    (low, center - half, high, center + half),
                    canvas,
                    x_line,
                    None,
                );
            }
            (None, Some(ay)) => {
                let scale = scale_of(ay).max(min_scale);
                rescale(ay, scale);
                let half = width * scale / 2.;
                let (low, high) = span(ay, from_center);
                let center = (left + right) / 2.;
                return finish(
                    (center - half, low, center + half, high),
                    canvas,
                    None,
                    y_line,
                );
            }
            (None, None) => {}
        }
    }

    let (new_left, new_right) = x
        .as_ref()
        .map_or((left, right), |axis| span(axis, from_center));
    let (new_top, new_bottom) = y
        .as_ref()
        .map_or((top, bottom), |axis| span(axis, from_center));
    finish(
        (new_left, new_top, new_right, new_bottom),
        canvas,
        x_line,
        y_line,
    )
}

fn finish(
    (left, top, right, bottom): (f64, f64, f64, f64),
    canvas: Px,
    x_line: Option<crate::editor_canvas::SnapLine>,
    y_line: Option<crate::editor_canvas::SnapLine>,
) -> (ShapeRect, Vec<SnapGuide>) {
    let (cw, ch) = (canvas.0.max(1.), canvas.1.max(1.));
    let rect = ShapeRect {
        x: left / cw,
        y: top / ch,
        w: (right - left) / cw,
        h: (bottom - top) / ch,
    };
    let moving = NormRect {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    };
    let mut guides = Vec::new();
    if let Some(line) = x_line {
        guides.push(guide_for(GuideAxis::V, line, moving));
    }
    if let Some(line) = y_line {
        guides.push(guide_for(GuideAxis::H, line, moving));
    }
    (rect, guides)
}

pub fn snap_angle(pivot: Px, point: Px) -> Px {
    let (dx, dy) = (point.0 - pivot.0, point.1 - pivot.1);
    let length = dx.hypot(dy);
    if length <= f64::EPSILON {
        return point;
    }
    let step = std::f64::consts::FRAC_PI_4;
    let angle = (dy.atan2(dx) / step).round() * step;
    (
        pivot.0 + length * angle.cos(),
        pivot.1 + length * angle.sin(),
    )
}

pub fn endpoint_dragged(
    start: &ShapeSegment,
    handle: ShapeHandle,
    delta: Px,
    canvas: Px,
    targets: &SnapTargets,
    angle_lock: bool,
    snap: bool,
) -> (XY<f64>, Vec<SnapGuide>) {
    let (moving, pivot) = match handle {
        ShapeHandle::From => (start.from, start.to),
        _ => (start.to, start.from),
    };
    let moving = to_px(moving, canvas);
    let pivot = to_px(pivot, canvas);
    let raw = (moving.0 + delta.0, moving.1 + delta.1);
    if angle_lock {
        return (to_norm(snap_angle(pivot, raw), canvas), Vec::new());
    }
    let mut point = to_norm(raw, canvas);
    let mut guides = Vec::new();
    if snap {
        let marker = NormRect {
            x: point.x,
            y: point.y,
            w: 0.,
            h: 0.,
        };
        if let Some((delta, line)) = snap_axis(&[point.x], &targets.v, SNAP_PX / canvas.0.max(1.)) {
            point.x += delta;
            guides.push(guide_for(GuideAxis::V, line, marker));
        }
        if let Some((delta, line)) = snap_axis(&[point.y], &targets.h, SNAP_PX / canvas.1.max(1.)) {
            point.y += delta;
            guides.push(guide_for(GuideAxis::H, line, marker));
        }
    }
    (point, guides)
}

pub fn drawn(
    kind: ShapeKind,
    anchor: Px,
    current: Px,
    canvas: Px,
    square: bool,
    from_center: bool,
) -> (XY<f64>, XY<f64>) {
    if kind.is_line() {
        let end = if square {
            snap_angle(anchor, current)
        } else {
            current
        };
        let start = if from_center {
            (2. * anchor.0 - end.0, 2. * anchor.1 - end.1)
        } else {
            anchor
        };
        return (to_norm(start, canvas), to_norm(end, canvas));
    }
    let (mut dx, mut dy) = (current.0 - anchor.0, current.1 - anchor.1);
    if square || kind.keeps_square() {
        let side = dx.abs().max(dy.abs());
        dx = side * if dx < 0. { -1. } else { 1. };
        dy = side * if dy < 0. { -1. } else { 1. };
    }
    let (a, b) = if from_center {
        (
            (anchor.0 - dx, anchor.1 - dy),
            (anchor.0 + dx, anchor.1 + dy),
        )
    } else {
        (anchor, (anchor.0 + dx, anchor.1 + dy))
    };
    let rect = ShapeRect::from_points(to_norm(a, canvas), to_norm(b, canvas));
    (
        XY::new(rect.x, rect.y),
        XY::new(rect.x + rect.w, rect.y + rect.h),
    )
}

pub fn nudged(
    segment: &ShapeSegment,
    direction: Px,
    shift: bool,
    canvas: Px,
) -> (XY<f64>, XY<f64>) {
    let step = if shift { 10. } else { 1. };
    let dx = direction.0 * step / canvas.0.max(1.);
    let dy = direction.1 * step / canvas.1.max(1.);
    (
        XY::new(segment.from.x + dx, segment.from.y + dy),
        XY::new(segment.to.x + dx, segment.to.y + dy),
    )
}

pub fn convert_kind(segment: &mut ShapeSegment, kind: ShapeKind, aspect: f64) {
    if segment.kind == kind {
        return;
    }
    let was_line = segment.kind.is_line();
    segment.kind = kind;
    if kind.keeps_square() {
        let rect = segment.rect();
        let aspect = if aspect.is_finite() && aspect > 0. {
            aspect
        } else {
            16. / 9.
        };
        let side_h = (rect.w * aspect).min(rect.h).max(0.02);
        let center = rect.center();
        let half_w = side_h / aspect / 2.;
        segment.from = XY::new(center.x - half_w, center.y - side_h / 2.);
        segment.to = XY::new(center.x + half_w, center.y + side_h / 2.);
    } else if was_line && !kind.is_line() {
        let rect = segment.rect();
        let min = 0.02;
        let (w, h) = (rect.w.max(min), rect.h.max(min));
        let center = rect.center();
        segment.from = XY::new(center.x - w / 2., center.y - h / 2.);
        segment.to = XY::new(center.x + w / 2., center.y + h / 2.);
    }
    let keep = (
        segment.stroke_color.clone(),
        segment.start,
        segment.end,
        segment.number,
    );
    segment.apply_kind_defaults();
    if kind != ShapeKind::Badge && kind != ShapeKind::Highlight {
        segment.stroke_color = keep.0;
    }
    segment.start = keep.1;
    segment.end = keep.2;
    segment.number = keep.3;
}

use crate::editor_canvas::CanvasSelection;
use crate::editor_edits::{self as edits, Selection};
use crate::editor_timeline::TrackKind;
use crate::editor_window::EditorWindow;
use crate::i18n::tr;
use gpui::{
    AnyElement, Bounds, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement, PathBuilder, Pixels, Point, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

const COPY_OFFSET_PX: f64 = 16.;
const NEW_SHAPE_SECONDS: f64 = 3.;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShapeDragMode {
    Move,
    Handle(ShapeHandle),
    Draw { kind: ShapeKind, anchor: Px },
}

pub struct ShapeDrag {
    pub mode: ShapeDragMode,
    pub primary: Option<usize>,
    pub starts: Vec<(usize, ShapeSegment)>,
    pub down: Point<Pixels>,
    pub targets: SnapTargets,
    pub moved: bool,
}

impl ShapeDrag {
    pub fn cursor(&self) -> CursorStyle {
        match self.mode {
            ShapeDragMode::Move => CursorStyle::ClosedHand,
            ShapeDragMode::Handle(handle) => handle.cursor(),
            ShapeDragMode::Draw { .. } => CursorStyle::Crosshair,
        }
    }
}

struct ShapeChrome {
    canvas: Px,
    hovered: Option<ShapeSegment>,
    selected: Vec<ShapeSegment>,
    accent: Hsla,
}

fn point_at(origin: Point<Pixels>, at: Px) -> Point<Pixels> {
    gpui::point(origin.x + px(at.0 as f32), origin.y + px(at.1 as f32))
}

fn push_ellipse(builder: &mut PathBuilder, origin: Point<Pixels>, center: Px, radii: Px) {
    const KAPPA: f64 = 0.552_284_8;
    let (cx, cy) = center;
    let (rx, ry) = radii;
    let (ox, oy) = (rx * KAPPA, ry * KAPPA);
    let p = |x: f64, y: f64| point_at(origin, (x, y));
    builder.move_to(p(cx + rx, cy));
    builder.cubic_bezier_to(p(cx, cy + ry), p(cx + rx, cy + oy), p(cx + ox, cy + ry));
    builder.cubic_bezier_to(p(cx - rx, cy), p(cx - ox, cy + ry), p(cx - rx, cy + oy));
    builder.cubic_bezier_to(p(cx, cy - ry), p(cx - rx, cy - oy), p(cx - ox, cy - ry));
    builder.cubic_bezier_to(p(cx + rx, cy), p(cx + ox, cy - ry), p(cx + rx, cy - oy));
    builder.close();
}

fn push_rounded_rect(
    builder: &mut PathBuilder,
    origin: Point<Pixels>,
    rect: (f64, f64, f64, f64),
    radius: f64,
) {
    let (left, top, width, height) = rect;
    let radius = radius.min(width / 2.).min(height / 2.).max(0.);
    let (right, bottom) = (left + width, top + height);
    let p = |x: f64, y: f64| point_at(origin, (x, y));
    builder.move_to(p(left + radius, top));
    builder.line_to(p(right - radius, top));
    builder.curve_to(p(right, top + radius), p(right, top));
    builder.line_to(p(right, bottom - radius));
    builder.curve_to(p(right - radius, bottom), p(right, bottom));
    builder.line_to(p(left + radius, bottom));
    builder.curve_to(p(left, bottom - radius), p(left, bottom));
    builder.line_to(p(left, top + radius));
    builder.curve_to(p(left + radius, top), p(left, top));
    builder.close();
}

fn outline_path(
    segment: &ShapeSegment,
    canvas: Px,
    origin: Point<Pixels>,
    width: f32,
) -> PathBuilder {
    let mut builder = PathBuilder::stroke(px(width));
    let rect = segment.rect();
    let (left, top) = (rect.x * canvas.0, rect.y * canvas.1);
    let (w, h) = (rect.w * canvas.0, rect.h * canvas.1);
    let scale = canvas.1 / SHAPE_REFERENCE_HEIGHT;
    match segment.kind {
        ShapeKind::Arrow | ShapeKind::Line => {
            builder.move_to(point_at(origin, to_px(segment.from, canvas)));
            builder.line_to(point_at(origin, to_px(segment.to, canvas)));
        }
        ShapeKind::Rectangle | ShapeKind::Highlight => {
            let radius = f64::from(segment.corner_radius.max(0.)) * scale;
            push_rounded_rect(&mut builder, origin, (left, top, w, h), radius);
        }
        ShapeKind::Ellipse => {
            push_ellipse(
                &mut builder,
                origin,
                (left + w / 2., top + h / 2.),
                (w / 2., h / 2.),
            );
        }
        ShapeKind::Badge => {
            let r = w.min(h) / 2.;
            push_ellipse(&mut builder, origin, (left + w / 2., top + h / 2.), (r, r));
        }
    }
    builder
}

fn paint_chrome(chrome: &ShapeChrome, bounds: Bounds<Pixels>, window: &mut Window) {
    let origin = bounds.origin;
    if let Some(hovered) = &chrome.hovered
        && let Ok(path) = outline_path(hovered, chrome.canvas, origin, 2.).build()
    {
        window.paint_path(path, chrome.accent);
    }
    for segment in &chrome.selected {
        let builder = if segment.kind.is_line() {
            outline_path(segment, chrome.canvas, origin, 1.)
        } else {
            let rect = segment.rect();
            let mut builder = PathBuilder::stroke(px(1.));
            push_rounded_rect(
                &mut builder,
                origin,
                (
                    rect.x * chrome.canvas.0,
                    rect.y * chrome.canvas.1,
                    rect.w * chrome.canvas.0,
                    rect.h * chrome.canvas.1,
                ),
                0.,
            );
            builder
        };
        if let Ok(path) = builder.build() {
            window.paint_path(path, chrome.accent);
        }
    }
}

pub fn free_lane(segments: &[ShapeSegment], start: f64, end: f64) -> u32 {
    let used = edits::used_lane_count(segments);
    (0..used)
        .find(|lane| {
            !segments
                .iter()
                .any(|segment| segment.track == *lane && segment.start < end && start < segment.end)
        })
        .unwrap_or(used)
}

pub fn pasted(
    shapes: &[ShapeSegment],
    time: f64,
    total: f64,
    offset: (f64, f64),
) -> Vec<ShapeSegment> {
    let Some(first) = shapes
        .iter()
        .map(|shape| shape.start)
        .min_by(f64::total_cmp)
    else {
        return Vec::new();
    };
    let last = shapes
        .iter()
        .map(|shape| shape.end)
        .max_by(f64::total_cmp)
        .unwrap_or(first);
    let span = (last - first).max(0.);
    let start = if total > 0. {
        time.clamp(0., (total - span).max(0.))
    } else {
        time.max(0.)
    };
    let shift = start - first;
    shapes
        .iter()
        .map(|shape| {
            let mut copy = shape.clone();
            copy.start += shift;
            copy.end += shift;
            if total > 0. {
                copy.end = copy.end.min(total);
            }
            copy.translate(offset.0, offset.1);
            copy
        })
        .filter(|copy| copy.end > copy.start)
        .collect()
}

impl EditorWindow {
    fn shape_segments(&self) -> &[ShapeSegment] {
        self.project
            .timeline
            .as_ref()
            .map_or(&[], |timeline| timeline.shape_segments.as_slice())
    }

    pub(crate) fn hovering_visible_shape(&self) -> bool {
        let time = self.preview_or_playhead();
        self.shape_hover
            .and_then(|index| self.shape_segments().get(index))
            .is_some_and(|segment| segment.is_active_at(time))
    }

    pub(crate) fn selected_shape_indices(&self) -> Vec<usize> {
        let len = self.shape_segments().len();
        let mut indices: Vec<usize> = self
            .selection
            .as_ref()
            .filter(|selection| selection.track == TrackKind::Shape)
            .map(|selection| selection.indices.clone())
            .unwrap_or_default()
            .into_iter()
            .filter(|index| *index < len)
            .collect();
        indices.sort_unstable();
        indices.dedup();
        indices
    }

    pub(crate) fn visible_shape_order(&self, time: f64) -> Vec<usize> {
        let segments = self.shape_segments();
        if segments.is_empty() {
            return Vec::new();
        }
        let mut order = Vec::new();
        for track in self
            .project
            .overlay_tracks()
            .into_iter()
            .rev()
            .filter(|track| track.kind == cap_project::OverlayTrackKind::Shape)
        {
            order.extend(
                segments
                    .iter()
                    .enumerate()
                    .filter(|(_, segment)| {
                        segment.track == track.track && segment.is_active_at(time)
                    })
                    .map(|(index, _)| index),
            );
        }
        order
    }

    /// Whether a text, image or mask box on a track stacked above the
    /// shape's own covers `point`. The shape layer sits over every other
    /// canvas box, so without this a filled shape would take presses meant
    /// for the text drawn on top of it.
    fn covered_above(&self, shape: usize, point: XY<f64>) -> bool {
        let Some(track) = self
            .shape_segments()
            .get(shape)
            .map(|segment| segment.track)
        else {
            return false;
        };
        let Some(timeline) = self.project.timeline.as_ref() else {
            return false;
        };
        let order = self.project.overlay_tracks();
        let Some(position) = order.iter().position(|candidate| {
            candidate.kind == cap_project::OverlayTrackKind::Shape && candidate.track == track
        }) else {
            return false;
        };
        let time = self.preview_or_playhead();
        let contains = |element: CanvasSelection| {
            self.element_rect(element).is_some_and(|rect| {
                point.x >= rect.x
                    && point.x <= rect.x + rect.w
                    && point.y >= rect.y
                    && point.y <= rect.y + rect.h
            })
        };
        order[..position].iter().any(|above| match above.kind {
            cap_project::OverlayTrackKind::Text => {
                timeline
                    .text_segments
                    .iter()
                    .enumerate()
                    .any(|(index, segment)| {
                        segment.track == above.track
                            && segment.enabled
                            && time >= segment.start
                            && time < segment.end
                            && contains(CanvasSelection::Text(index))
                    })
            }
            cap_project::OverlayTrackKind::Image => {
                timeline
                    .image_segments
                    .iter()
                    .enumerate()
                    .any(|(index, segment)| {
                        segment.track == above.track
                            && segment.is_active_at(time)
                            && segment.opacity > 0.
                            && contains(CanvasSelection::Image(index))
                    })
            }
            cap_project::OverlayTrackKind::Mask => {
                timeline
                    .mask_segments
                    .iter()
                    .enumerate()
                    .any(|(index, segment)| {
                        segment.track == above.track
                            && segment.enabled
                            && time >= segment.start
                            && time < segment.end
                            && contains(CanvasSelection::Mask(index))
                    })
            }
            cap_project::OverlayTrackKind::Shape => false,
        })
    }

    fn shape_canvas(&self) -> Option<(Bounds<Pixels>, Px)> {
        let bounds = self.canvas_bounds()?;
        let size = (
            f64::from(f32::from(bounds.size.width)),
            f64::from(f32::from(bounds.size.height)),
        );
        (size.0 > 0. && size.1 > 0.).then_some((bounds, size))
    }

    fn shape_local(&self, position: Point<Pixels>) -> Option<(Px, Px)> {
        let (bounds, size) = self.shape_canvas()?;
        Some((
            (
                f64::from(f32::from(position.x - bounds.origin.x)),
                f64::from(f32::from(position.y - bounds.origin.y)),
            ),
            size,
        ))
    }

    pub(crate) fn shape_output_aspect(&self) -> f64 {
        self.frame_layout
            .as_ref()
            .map(|layout| {
                f64::from(layout.output_size[0]) / f64::from(layout.output_size[1].max(1))
            })
            .filter(|aspect| aspect.is_finite() && *aspect > 0.)
            .unwrap_or(16. / 9.)
    }

    pub(crate) fn new_shape_segment(&self, start: f64, end: f64, lane: u32) -> ShapeSegment {
        self.shape_template(self.last_shape_kind, XY::new(0.5, 0.5), start, end, lane)
    }

    fn shape_template(
        &self,
        kind: ShapeKind,
        center: XY<f64>,
        start: f64,
        end: f64,
        lane: u32,
    ) -> ShapeSegment {
        let mut segment = ShapeSegment::new(kind, start, end, center, self.shape_output_aspect());
        segment.track = lane;
        if kind == ShapeKind::Badge {
            segment.number = cap_project::next_badge_number(self.shape_segments());
        }
        segment
    }

    fn new_shape_length(&self, window: &Window) -> f64 {
        let viewport_width: f32 = window.viewport_size().width.into();
        let total = self.total_duration();
        NEW_SHAPE_SECONDS
            .max(self.secs_per_pixel(viewport_width) * 80.)
            .min(total)
    }

    fn shape_placement(&self, time: f64, length: f64) -> Option<(u32, f64, f64)> {
        let segments = self.shape_segments();
        let total = self.total_duration();
        let lanes = self.tracks.shape.max(edits::used_lane_count(segments));
        for lane in 0..lanes {
            let on_lane: Vec<ShapeSegment> = segments
                .iter()
                .filter(|segment| segment.track == lane)
                .cloned()
                .collect();
            if let Some((start, end)) = edits::place_segment_at_time(&on_lane, time, length, total)
            {
                return Some((lane, start, end));
            }
        }
        edits::place_segment_at_time(&[] as &[ShapeSegment], time, length, total)
            .map(|(start, end)| (lanes, start, end))
    }

    fn insert_shapes(
        &mut self,
        shapes: Vec<ShapeSegment>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<usize> {
        if shapes.is_empty()
            || !edits::ensure_timeline(&mut self.project, &self.clip_display_durations)
        {
            return Vec::new();
        }
        self.end_field_edit(cx);
        self.close_color_picker(cx);
        let Some(timeline) = self.project.timeline.as_mut() else {
            return Vec::new();
        };
        for shape in &shapes {
            edits::insert_shape_segment(timeline, shape.clone());
        }
        let indices: Vec<usize> = shapes
            .iter()
            .filter_map(|shape| {
                timeline
                    .shape_segments
                    .iter()
                    .position(|item| item == shape)
            })
            .collect();
        self.tracks.shape = self
            .tracks
            .shape
            .max(edits::used_lane_count(&timeline.shape_segments));
        if let Some(last) = shapes.last() {
            self.last_shape_kind = last.kind;
        }
        self.project_changed(window, cx);
        self.set_selection(
            Some(Selection {
                track: TrackKind::Shape,
                indices: indices.clone(),
            }),
            cx,
        );
        indices
    }

    pub(crate) fn add_shape_at_playhead(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let kind = self.last_shape_kind;
        self.place_shape(kind, XY::new(0.5, 0.5), window, cx);
    }

    fn place_shape(
        &mut self,
        kind: ShapeKind,
        center: XY<f64>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<usize> {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return None;
        }
        let time = self.playhead.max(0.);
        let length = self.new_shape_length(window);
        let Some((lane, start, end)) = self.shape_placement(time, length) else {
            return None;
        };
        let shape = self.shape_template(kind, center, start, end, lane);
        let (animation_in, animation_out) =
            (shape.animation_in_duration, shape.animation_out_duration);
        let index = self
            .insert_shapes(vec![shape], window, cx)
            .first()
            .copied()?;
        self.reveal_shape_at_playhead(start, end, animation_in, animation_out, cx);
        self.note_edit("add-shape", Some(TrackKind::Shape));
        Some(index)
    }

    fn reveal_shape_at_playhead(
        &mut self,
        start: f64,
        end: f64,
        animation_in: f64,
        animation_out: f64,
        cx: &mut Context<Self>,
    ) {
        let low = start + animation_in.max(0.) + 0.05;
        let high = end - animation_out.max(0.) - 0.05;
        let time = self.playhead;
        let target = if low <= high {
            time.clamp(low, high)
        } else {
            (start + end) / 2.
        };
        if (target - time).abs() > f64::EPSILON {
            self.seek_to_time(target, cx);
        }
        self.view.preview_time = None;
    }

    pub(crate) fn arm_shape_tool(&mut self, kind: Option<ShapeKind>, cx: &mut Context<Self>) {
        self.shape_tool_menu = false;
        if let Some(kind) = kind {
            self.last_shape_kind = kind;
            if self.playing {
                self.stop_playback(cx);
            }
        }
        self.shape_tool = kind;
        self.shape_hover = None;
        cx.notify();
    }

    pub(crate) fn shape_pointer_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if self.shape_drag.is_some() {
            return;
        }
        let next = if self.shape_tool.is_some() {
            None
        } else {
            self.shape_local(event.position)
                .and_then(|(point, canvas)| {
                    let selected = self.selected_shape_indices();
                    let selected_one = (selected.len() == 1).then(|| selected[0]);
                    topmost_hit(
                        self.shape_segments(),
                        &self.visible_shape_order(self.preview_or_playhead()),
                        canvas,
                        point,
                        selected_one,
                    )
                    .filter(|index| !self.covered_above(*index, to_norm(point, canvas)))
                })
        };
        if self.shape_hover != next {
            self.shape_hover = next;
            cx.notify();
        }
    }

    pub(crate) fn shape_pointer_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((point, canvas)) = self.shape_local(event.position) else {
            return;
        };
        if let Some(kind) = self.shape_tool {
            cx.stop_propagation();
            if self.canvas_drag.is_some() {
                self.canvas_mouse_up(window, cx);
            }
            self.set_selection(None, cx);
            self.canvas_selection = None;
            self.history.pause();
            self.shape_drag = Some(ShapeDrag {
                mode: ShapeDragMode::Draw {
                    kind,
                    anchor: point,
                },
                primary: None,
                starts: Vec::new(),
                down: event.position,
                targets: self.canvas_snap_targets(CanvasSelection::Display),
                moved: false,
            });
            cx.notify();
            window.refresh();
            return;
        }
        let selected = self.selected_shape_indices();
        let selected_one = (selected.len() == 1).then(|| selected[0]);
        if let Some(index) = selected_one
            && let Some(handle) = self
                .shape_segments()
                .get(index)
                .filter(|segment| segment.is_active_at(self.preview_or_playhead()))
                .and_then(|segment| hit_handle(segment, canvas, point))
        {
            cx.stop_propagation();
            self.begin_shape_handle(index, handle, event, window, cx);
            return;
        }
        let Some(index) = topmost_hit(
            self.shape_segments(),
            &self.visible_shape_order(self.preview_or_playhead()),
            canvas,
            point,
            selected_one,
        ) else {
            return;
        };
        if self.covered_above(index, to_norm(point, canvas)) {
            return;
        }
        cx.stop_propagation();
        let toggle = event.modifiers.shift || event.modifiers.platform || event.modifiers.control;
        let indices = if toggle {
            let mut next = selected.clone();
            if let Some(position) = next.iter().position(|item| *item == index) {
                next.remove(position);
            } else {
                next.push(index);
            }
            next
        } else if selected.contains(&index) {
            selected
        } else {
            vec![index]
        };
        if indices.is_empty() {
            self.set_selection(None, cx);
            cx.notify();
            return;
        }
        self.set_selection(
            Some(Selection {
                track: TrackKind::Shape,
                indices: indices.clone(),
            }),
            cx,
        );
        if !indices.contains(&index) {
            cx.notify();
            return;
        }
        let starts: Vec<(usize, ShapeSegment)> = indices
            .iter()
            .filter_map(|item| {
                self.shape_segments()
                    .get(*item)
                    .map(|segment| (*item, segment.clone()))
            })
            .collect();
        self.begin_shape_drag(ShapeDragMode::Move, index, starts, event, window, cx);
    }

    pub(crate) fn begin_shape_handle(
        &mut self,
        index: usize,
        handle: ShapeHandle,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(segment) = self.shape_segments().get(index).cloned() else {
            return;
        };
        self.begin_shape_drag(
            ShapeDragMode::Handle(handle),
            index,
            vec![(index, segment)],
            event,
            window,
            cx,
        );
    }

    fn begin_shape_drag(
        &mut self,
        mode: ShapeDragMode,
        primary: usize,
        starts: Vec<(usize, ShapeSegment)>,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.canvas_drag.is_some() {
            self.canvas_mouse_up(window, cx);
        }
        let moving: Vec<usize> = starts.iter().map(|(index, _)| *index).collect();
        let targets = self.canvas_snap_targets_moving(CanvasSelection::Shape(primary), &moving);
        self.history.pause();
        self.shape_drag = Some(ShapeDrag {
            mode,
            primary: Some(primary),
            starts,
            down: event.position,
            targets,
            moved: false,
        });
        cx.notify();
        window.refresh();
    }

    pub(crate) fn shape_drag_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((_, canvas)) = self.shape_canvas() else {
            return;
        };
        let Some(drag) = self.shape_drag.as_ref() else {
            return;
        };
        let delta = (
            f64::from(f32::from(event.position.x - drag.down.x)),
            f64::from(f32::from(event.position.y - drag.down.y)),
        );
        let threshold = match drag.mode {
            ShapeDragMode::Draw { .. } => MIN_DRAW_PX,
            _ => 2.,
        };
        if !drag.moved && delta.0.hypot(delta.1) < threshold {
            return;
        }
        let shift = event.modifiers.shift;
        let alt = event.modifiers.alt;
        let snap = !(event.modifiers.platform || event.modifiers.control);
        let mode = drag.mode;
        let targets = drag.targets.clone();
        let starts = drag.starts.clone();
        let primary = drag.primary;

        if let ShapeDragMode::Draw { kind, anchor } = mode {
            let current = (anchor.0 + delta.0, anchor.1 + delta.1);
            let (from, to) = drawn(kind, anchor, current, canvas, shift, alt);
            match primary {
                Some(index) => self.write_shape(index, |segment| {
                    segment.from = from;
                    segment.to = to;
                }),
                None => {
                    let center = ShapeRect::from_points(from, to).center();
                    let time = self.playhead.max(0.);
                    let length = self.new_shape_length(window);
                    let Some((lane, start, end)) = self.shape_placement(time, length) else {
                        return;
                    };
                    let mut shape = self.shape_template(kind, center, start, end, lane);
                    shape.from = from;
                    shape.to = to;
                    let (animation_in, animation_out) =
                        (shape.animation_in_duration, shape.animation_out_duration);
                    let index = self.insert_shapes(vec![shape], window, cx).first().copied();
                    self.reveal_shape_at_playhead(start, end, animation_in, animation_out, cx);
                    if let Some(drag) = self.shape_drag.as_mut() {
                        drag.primary = index;
                        drag.moved = true;
                    }
                    return;
                }
            }
            if let Some(drag) = self.shape_drag.as_mut() {
                drag.moved = true;
            }
            self.project_changed_live(cx);
            return;
        }

        let Some((_, primary_start)) = starts
            .iter()
            .find(|(index, _)| Some(*index) == primary)
            .cloned()
        else {
            return;
        };
        if let Some(drag) = self.shape_drag.as_mut() {
            drag.moved = true;
        }
        match mode {
            ShapeDragMode::Move => {
                let (from, _, guides) = moved(&primary_start, delta, canvas, &targets, snap, shift);
                let (dx, dy) = (from.x - primary_start.from.x, from.y - primary_start.from.y);
                self.snap_guides = guides;
                for (index, start) in &starts {
                    self.write_shape(*index, |segment| {
                        segment.from = XY::new(start.from.x + dx, start.from.y + dy);
                        segment.to = XY::new(start.to.x + dx, start.to.y + dy);
                    });
                }
            }
            ShapeDragMode::Handle(ShapeHandle::Box { x, y }) => {
                let (rect, guides) = resized(
                    primary_start.rect(),
                    (x, y),
                    delta,
                    canvas,
                    &targets,
                    ResizeOptions {
                        keep_aspect: shift || primary_start.kind.keeps_square(),
                        from_center: alt,
                        snap,
                    },
                );
                self.snap_guides = guides;
                if let Some(index) = primary {
                    self.write_shape(index, |segment| {
                        segment.from = XY::new(rect.x, rect.y);
                        segment.to = XY::new(rect.x + rect.w, rect.y + rect.h);
                    });
                }
            }
            ShapeDragMode::Handle(handle) => {
                let (point, guides) =
                    endpoint_dragged(&primary_start, handle, delta, canvas, &targets, shift, snap);
                self.snap_guides = guides;
                if let Some(index) = primary {
                    self.write_shape(index, |segment| {
                        if handle == ShapeHandle::From {
                            segment.from = point;
                        } else {
                            segment.to = point;
                        }
                    });
                }
            }
            ShapeDragMode::Draw { .. } => {}
        }
        self.project_changed_live(cx);
    }

    fn write_shape(&mut self, index: usize, change: impl FnOnce(&mut ShapeSegment)) {
        if let Some(segment) = self
            .project
            .timeline
            .as_mut()
            .and_then(|timeline| timeline.shape_segments.get_mut(index))
        {
            change(segment);
        }
    }

    pub(crate) fn shape_drag_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.shape_drag.take() else {
            return;
        };
        if let (ShapeDragMode::Draw { kind, anchor }, None) = (drag.mode, drag.primary)
            && let Some((_, canvas)) = self.shape_canvas()
        {
            self.place_shape(kind, to_norm(anchor, canvas), window, cx);
        }
        let config = self.project.clone();
        self.history.resume(&config);
        self.snap_guides.clear();
        if matches!(drag.mode, ShapeDragMode::Draw { .. }) {
            self.shape_tool = None;
        }
        if drag.moved || matches!(drag.mode, ShapeDragMode::Draw { .. }) {
            self.schedule_save(window, cx);
            self.note_edit("shape-drag", Some(TrackKind::Shape));
        }
        cx.notify();
    }

    pub(crate) fn shape_nudge(
        &mut self,
        direction: Px,
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some((_, canvas)) = self.shape_canvas() else {
            return false;
        };
        let time = self.preview_or_playhead();
        let indices: Vec<usize> = self
            .selected_shape_indices()
            .into_iter()
            .filter(|index| {
                self.shape_segments()
                    .get(*index)
                    .is_some_and(|segment| segment.is_active_at(time))
            })
            .collect();
        if indices.is_empty() {
            return false;
        }
        for index in indices {
            if let Some(segment) = self.shape_segments().get(index).cloned() {
                let (from, to) = nudged(&segment, direction, shift, canvas);
                self.write_shape(index, |segment| {
                    segment.from = from;
                    segment.to = to;
                });
            }
        }
        self.project_changed_live(cx);
        self.schedule_save(window, cx);
        true
    }

    fn copy_offset(&self) -> (f64, f64) {
        self.shape_canvas().map_or((0.01, 0.01), |(_, canvas)| {
            (COPY_OFFSET_PX / canvas.0, COPY_OFFSET_PX / canvas.1)
        })
    }

    pub(crate) fn duplicate_shapes(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let indices = self.selected_shape_indices();
        if indices.is_empty() {
            return false;
        }
        let offset = self.copy_offset();
        let mut placed: Vec<ShapeSegment> = self.shape_segments().to_vec();
        let mut copies = Vec::new();
        for index in indices {
            let Some(source) = self.shape_segments().get(index) else {
                continue;
            };
            let mut copy = source.clone();
            copy.translate(offset.0, offset.1);
            copy.track = free_lane(&placed, copy.start, copy.end);
            placed.push(copy.clone());
            copies.push(copy);
        }
        let inserted = !self.insert_shapes(copies, window, cx).is_empty();
        if inserted {
            self.note_edit("duplicate-shape", Some(TrackKind::Shape));
        }
        inserted
    }

    pub(crate) fn copy_shapes(&mut self) -> bool {
        let indices = self.selected_shape_indices();
        if indices.is_empty() {
            return false;
        }
        self.shape_clipboard = indices
            .iter()
            .filter_map(|index| self.shape_segments().get(*index).cloned())
            .collect();
        !self.shape_clipboard.is_empty()
    }

    pub(crate) fn paste_shapes(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.shape_clipboard.is_empty() {
            return false;
        }
        let total = self.total_duration();
        let step = self.copy_offset();
        let mut offset = (0., 0.);
        let mut copies = pasted(&self.shape_clipboard, self.playhead.max(0.), total, offset);
        for _ in 0..12 {
            let overlaps = copies.iter().any(|copy| {
                self.shape_segments().iter().any(|segment| {
                    (segment.from.x - copy.from.x).abs() < 1e-6
                        && (segment.from.y - copy.from.y).abs() < 1e-6
                        && segment.start < copy.end
                        && copy.start < segment.end
                })
            });
            if !overlaps {
                break;
            }
            offset = (offset.0 + step.0, offset.1 + step.1);
            copies = pasted(&self.shape_clipboard, self.playhead.max(0.), total, offset);
        }
        let mut placed: Vec<ShapeSegment> = self.shape_segments().to_vec();
        for copy in &mut copies {
            copy.track = free_lane(&placed, copy.start, copy.end);
            placed.push(copy.clone());
        }
        let inserted = !self.insert_shapes(copies, window, cx).is_empty();
        if inserted {
            self.note_edit("paste-shape", Some(TrackKind::Shape));
        }
        inserted
    }

    pub(crate) fn render_shapes_layer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (_, canvas) = self.shape_canvas()?;
        let time = self.preview_or_playhead();
        let order = self.visible_shape_order(time);
        if order.is_empty() && self.shape_tool.is_none() {
            return None;
        }
        let theme = self.theme;
        let accent = Hsla::from(theme.blue_9);
        let selected: Vec<usize> = self
            .selected_shape_indices()
            .into_iter()
            .filter(|index| order.contains(index))
            .collect();
        let drawing = matches!(
            self.shape_drag.as_ref().map(|drag| drag.mode),
            Some(ShapeDragMode::Draw { .. })
        );
        let hovered = self
            .shape_hover
            .filter(|index| order.contains(index) && !selected.contains(index))
            .filter(|_| self.shape_drag.is_none())
            .and_then(|index| self.shape_segments().get(index).cloned());
        let chrome = ShapeChrome {
            canvas,
            hovered,
            selected: if drawing {
                Vec::new()
            } else {
                selected
                    .iter()
                    .filter_map(|index| self.shape_segments().get(*index).cloned())
                    .collect()
            },
            accent,
        };
        let cursor = if self.shape_tool.is_some() {
            Some(CursorStyle::Crosshair)
        } else if self.hovering_visible_shape() {
            Some(CursorStyle::OpenHand)
        } else {
            None
        };

        let mut layer = div()
            .id("canvas-shapes")
            .absolute()
            .inset_0()
            .when_some(cursor, |this, cursor| this.cursor(cursor))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                this.shape_pointer_move(event, cx);
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.shape_pointer_down(event, window, cx);
                }),
            )
            .child(
                gpui::canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| paint_chrome(&chrome, bounds, window),
                )
                .absolute()
                .size_full(),
            );

        if !drawing && selected.len() == 1 {
            let index = selected[0];
            if let Some(segment) = self.shape_segments().get(index) {
                layer = layer.child(self.render_shape_label(segment, canvas));
                for (handle, at) in handles(segment, canvas) {
                    layer = layer.child(self.render_shape_handle(index, handle, at, cx));
                }
            }
        }
        Some(layer.into_any_element())
    }

    fn render_shape_label(&self, segment: &ShapeSegment, canvas: Px) -> AnyElement {
        let theme = self.theme;
        let rect = segment.rect();
        let (left, top) = (rect.x * canvas.0, rect.y * canvas.1);
        let label_top = if top >= 28. + HANDLE_SIZE {
            top - 24. - HANDLE_SIZE / 2.
        } else {
            top + rect.h * canvas.1 + HANDLE_SIZE
        };
        div()
            .absolute()
            .left(px(left.clamp(6., (canvas.0 - 60.).max(6.)) as f32))
            .top(px(label_top.clamp(6., (canvas.1 - 24.).max(6.)) as f32))
            .px(px(6.))
            .py(px(2.))
            .rounded(px(4.))
            .bg(Hsla::from(theme.blue_9))
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white())
            .child(crate::editor_timeline::shape_kind_label(segment.kind))
            .into_any_element()
    }

    fn render_shape_handle(
        &self,
        index: usize,
        handle: ShapeHandle,
        at: Px,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let round = matches!(handle, ShapeHandle::From | ShapeHandle::To);
        let visual = if round { HANDLE_SIZE + 2. } else { HANDLE_SIZE };
        div()
            .id(SharedString::from(format!(
                "canvas-shape-{index}-{}",
                handle.id()
            )))
            .absolute()
            .left(px((at.0 - HANDLE_HIT / 2.) as f32))
            .top(px((at.1 - HANDLE_HIT / 2.) as f32))
            .size(px(HANDLE_HIT as f32))
            .flex()
            .items_center()
            .justify_center()
            .cursor(handle.cursor())
            .child(
                div()
                    .size(px(visual as f32))
                    .when(round, |this| this.rounded_full())
                    .when(!round, |this| this.rounded(px(2.)))
                    .border_1()
                    .border_color(Hsla::from(theme.blue_9))
                    .bg(gpui::white())
                    .shadow_sm(),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.begin_shape_handle(index, handle, event, window, cx);
                }),
            )
            .into_any_element()
    }

    pub(crate) fn render_shape_tool_button(
        &self,
        narrow: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let bounds = self.shape_tool_trigger.clone();
        let icon = self
            .shape_tool
            .map_or("icons/shapes.svg", crate::editor_timeline::shape_kind_icon);
        div()
            .relative()
            .flex_none()
            .child(
                crate::ui::EditorButton::plain(&theme, "shape-tool")
                    .text(&theme)
                    .left_icon(icon)
                    .right_icon("icons/chevron-down.svg")
                    .when(!narrow, |button| button.label(tr::editor::shape::toolbar()))
                    .tooltip(&theme, tr::editor::shape::draw())
                    .disabled(!self.project_ready())
                    .pressed(self.shape_tool.is_some() || self.shape_tool_menu)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.focus_root(window, cx);
                        if this.shape_tool.is_some() {
                            this.arm_shape_tool(None, cx);
                        } else {
                            this.shape_tool_menu = !this.shape_tool_menu;
                            cx.notify();
                        }
                    })),
            )
            .child(
                gpui::canvas(move |rect, _, _| bounds.set(Some(rect)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
    }

    pub(crate) fn render_shape_tool_popover(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.shape_tool_menu {
            return None;
        }
        let bounds = self.shape_tool_trigger.get()?;
        let theme = self.theme;
        let color = TrackKind::Shape.color();
        let tile = |kind: ShapeKind, cx: &mut Context<Self>| {
            let current = kind == self.last_shape_kind;
            div()
                .id(SharedString::from(format!("shape-tool-{kind:?}")))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .w(px(72.))
                .pt(px(10.))
                .pb(px(8.))
                .rounded(px(8.))
                .cursor_pointer()
                .when(current, |this| this.bg(Hsla::from(theme.editor.ctl)))
                .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(30.))
                        .rounded(px(8.))
                        .bg(crate::editor_timeline::tile_bg(&theme, color))
                        .child(
                            gpui::svg()
                                .path(crate::editor_timeline::shape_kind_icon(kind))
                                .size(px(15.))
                                .text_color(crate::editor_timeline::tile_fg(&theme, color)),
                        ),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(theme.editor.text_1))
                        .child(crate::editor_timeline::shape_kind_label(kind)),
                )
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.arm_shape_tool(Some(kind), cx);
                }))
        };
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("shape-tool-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.shape_tool_menu = false;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("shape-tool-popover")
                        .absolute()
                        .left(bounds.origin.x)
                        .top(bounds.bottom() + px(6.))
                        .occlude()
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.editor.line))
                        .bg(Hsla::from(theme.editor.card))
                        .shadow(theme.editor.pop_shadow())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(div().flex().flex_col().gap(px(2.)).p(px(6.)).children(
                            ShapeKind::ALL.chunks(3).map(|row| {
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(2.))
                                    .children(row.iter().map(|kind| tile(*kind, cx)))
                            }),
                        ))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .h(px(30.))
                                .px(px(12.))
                                .border_t_1()
                                .border_color(Hsla::from(theme.editor.line))
                                .text_size(px(11.))
                                .text_color(Hsla::from(theme.editor.text_2))
                                .child(tr::editor::shape::draw_hint()),
                        ),
                )
                .into_any_element(),
        )
    }
}

use crate::editor_panels::PanelSlider;
use crate::editor_sidebar::{ColorTarget, SliderKey};
use cap_project::{SHAPE_MAX_ANIMATION_DURATION, SHAPE_MAX_STROKE_WIDTH, ShapeAnimation};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShapeProperty {
    StrokeWidth,
    FillOpacity,
    CornerRadius,
    Shadow,
    Opacity,
    AnimationIn,
    AnimationOut,
}

impl ShapeProperty {
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::StrokeWidth => (0., SHAPE_MAX_STROKE_WIDTH, 0.5),
            Self::CornerRadius => (0., 80., 1.),
            Self::FillOpacity | Self::Shadow | Self::Opacity => (0., 1., 0.01),
            Self::AnimationIn | Self::AnimationOut => {
                (0., SHAPE_MAX_ANIMATION_DURATION as f32, 0.05)
            }
        }
    }

    pub fn read(self, segment: &ShapeSegment) -> f32 {
        let (min, max, _) = self.limits();
        let raw = match self {
            Self::StrokeWidth => segment.stroke_width,
            Self::FillOpacity => segment.fill_opacity,
            Self::CornerRadius => segment.corner_radius,
            Self::Shadow => segment.shadow,
            Self::Opacity => segment.opacity,
            Self::AnimationIn => segment.animation_in_duration as f32,
            Self::AnimationOut => segment.animation_out_duration as f32,
        };
        if raw.is_finite() {
            raw.clamp(min, max)
        } else {
            min
        }
    }

    pub fn write(self, segment: &mut ShapeSegment, value: f32) -> bool {
        if !value.is_finite() {
            return false;
        }
        let (min, max, _) = self.limits();
        let value = value.clamp(min, max);
        let slot = match self {
            Self::StrokeWidth => &mut segment.stroke_width,
            Self::FillOpacity => &mut segment.fill_opacity,
            Self::CornerRadius => &mut segment.corner_radius,
            Self::Shadow => &mut segment.shadow,
            Self::Opacity => &mut segment.opacity,
            Self::AnimationIn | Self::AnimationOut => {
                let slot = if self == Self::AnimationIn {
                    &mut segment.animation_in_duration
                } else {
                    &mut segment.animation_out_duration
                };
                let value = f64::from(value);
                if *slot == value {
                    return false;
                }
                *slot = value;
                return true;
            }
        };
        if *slot == value {
            return false;
        }
        *slot = value;
        true
    }
}

const SHAPE_ANIMATIONS: [ShapeAnimation; 4] = [
    ShapeAnimation::None,
    ShapeAnimation::Fade,
    ShapeAnimation::Scale,
    ShapeAnimation::Draw,
];

fn animation_label(animation: ShapeAnimation) -> &'static str {
    match animation {
        ShapeAnimation::None => tr::editor::shape::animations::none(),
        ShapeAnimation::Fade => tr::editor::shape::animations::fade(),
        ShapeAnimation::Scale => tr::editor::shape::animations::scale(),
        ShapeAnimation::Draw => tr::editor::shape::animations::draw(),
    }
}

const ARROW_HEADS: [ShapeArrowHead; 3] = [
    ShapeArrowHead::Filled,
    ShapeArrowHead::Open,
    ShapeArrowHead::Double,
];

fn arrow_head_label(head: ShapeArrowHead) -> &'static str {
    match head {
        ShapeArrowHead::Filled => tr::editor::shape::heads::filled(),
        ShapeArrowHead::Open => tr::editor::shape::heads::open(),
        ShapeArrowHead::Double => tr::editor::shape::heads::double(),
    }
}

impl EditorWindow {
    fn shape_slider(
        &self,
        label: &'static str,
        property: ShapeProperty,
        unit: &'static str,
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.slider_field(
            label,
            SliderKey::Panel(PanelSlider::Shape(property), index),
            unit,
            cx,
        )
        .into_any_element()
    }

    pub(crate) fn render_shape_panel(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let Some(segment) = self.shape_segments().get(index) else {
            return div().into_any_element();
        };
        let kind = segment.kind;
        let enabled = segment.enabled;
        let fill = segment.fill;
        let stroke_color = segment.stroke_color.clone();
        let fill_color = segment.fill_color.clone();
        let arrow_head = segment.arrow_head;
        let number = segment.number;
        let is_out = self.sidebar.text_anim_edge;
        let edge_animation = if is_out {
            segment.animation_out
        } else {
            segment.animation_in
        };
        let aspect = self.shape_output_aspect();

        let kinds = crate::ui::SegmentedControl::editor(
            &theme,
            SharedString::from(format!("shape-kind-{index}")),
            ShapeKind::ALL
                .iter()
                .map(|candidate| {
                    crate::ui::SegmentOption::icon(
                        crate::editor_timeline::shape_kind_icon(*candidate),
                        *candidate == kind,
                    )
                })
                .collect(),
        )
        .stretch()
        .on_select(cx.listener(move |this, choice: &usize, window, cx| {
            let Some(next) = ShapeKind::ALL.get(*choice).copied() else {
                return;
            };
            this.last_shape_kind = next;
            this.edit_shape_segment("shape-kind", index, window, cx, move |segment| {
                if segment.kind == next {
                    return false;
                }
                convert_kind(segment, next, aspect);
                true
            });
        }));

        let mut panel = div().flex().flex_col().gap(px(16.)).child(
            crate::ui::Field::section(
                &theme,
                SharedString::from(tr::editor::shape::title(index + 1)),
            )
            .value(
                crate::ui::Toggle::plain(
                    &theme,
                    SharedString::from(format!("shape-enabled-{index}")),
                    enabled,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_shape_segment("shape-enabled", index, window, cx, move |segment| {
                        segment.enabled = !enabled;
                        true
                    });
                }))
                .into_any_element(),
            )
            .child(
                div().flex().flex_col().gap(px(6.)).child(kinds).child(
                    div()
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.editor.text_2))
                        .child(crate::editor_timeline::shape_kind_label(kind)),
                ),
            ),
        );

        panel = panel.child(
            crate::ui::Field::section(&theme, tr::editor::shape::stroke()).child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(self.render_color_input(
                        ColorTarget::ShapeStroke(index),
                        &stroke_color,
                        cx,
                    ))
                    .child(self.shape_slider(
                        tr::editor::shape::width(),
                        ShapeProperty::StrokeWidth,
                        "px",
                        index,
                        cx,
                    )),
            ),
        );

        if kind.supports_fill() {
            let mut section = crate::ui::Field::section(&theme, tr::editor::shape::fill()).value(
                crate::ui::Toggle::plain(
                    &theme,
                    SharedString::from(format!("shape-fill-{index}")),
                    fill,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.edit_shape_segment("shape-fill", index, window, cx, move |segment| {
                        segment.fill = !fill;
                        true
                    });
                }))
                .into_any_element(),
            );
            if fill {
                section = section.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(self.render_color_input(
                            ColorTarget::ShapeFill(index),
                            &fill_color,
                            cx,
                        ))
                        .child(self.shape_slider(
                            tr::editor::shape::fill_opacity(),
                            ShapeProperty::FillOpacity,
                            "x100%",
                            index,
                            cx,
                        )),
                );
            }
            panel = panel.child(section);
        }

        if kind.supports_corner_radius() {
            panel = panel.child(self.shape_slider(
                tr::editor::shape::corner_radius(),
                ShapeProperty::CornerRadius,
                "px",
                index,
                cx,
            ));
        }

        if kind == ShapeKind::Arrow {
            panel = panel.child(
                crate::ui::Field::section(&theme, tr::editor::shape::arrowhead()).child(
                    crate::ui::SegmentedControl::editor(
                        &theme,
                        SharedString::from(format!("shape-head-{index}")),
                        ARROW_HEADS
                            .iter()
                            .map(|head| {
                                crate::ui::SegmentOption::new(
                                    arrow_head_label(*head),
                                    *head == arrow_head,
                                )
                            })
                            .collect(),
                    )
                    .stretch()
                    .on_select(cx.listener(
                        move |this, choice: &usize, window, cx| {
                            let Some(head) = ARROW_HEADS.get(*choice).copied() else {
                                return;
                            };
                            this.edit_shape_segment(
                                "shape-arrowhead",
                                index,
                                window,
                                cx,
                                move |segment| {
                                    if segment.arrow_head == head {
                                        return false;
                                    }
                                    segment.arrow_head = head;
                                    true
                                },
                            );
                        },
                    )),
                ),
            );
        }

        if kind == ShapeKind::Badge {
            let stepper = |id: &'static str,
                           icon: &'static str,
                           label: &'static str,
                           delta: i64,
                           cx: &mut Context<Self>| {
                div()
                    .id(SharedString::from(format!("shape-number-{id}-{index}")))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.))
                    .rounded(px(7.))
                    .bg(Hsla::from(theme.editor.ctl))
                    .cursor_pointer()
                    .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                    .tooltip(move |_window, cx| crate::ui::Tooltip::new(&theme, label).view(cx))
                    .child(
                        gpui::svg()
                            .path(icon)
                            .size(px(14.))
                            .text_color(Hsla::from(theme.editor.text_1)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.edit_shape_segment(
                            "shape-number",
                            index,
                            window,
                            cx,
                            move |segment| {
                                let next = (i64::from(segment.number) + delta).clamp(0, 999) as u32;
                                if next == segment.number {
                                    return false;
                                }
                                segment.number = next;
                                true
                            },
                        );
                    }))
            };
            panel = panel.child(
                crate::ui::Field::inline(&theme, tr::editor::shape::number()).child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .child(stepper(
                            "down",
                            "icons/minus.svg",
                            tr::editor::shape::decrease(),
                            -1,
                            cx,
                        ))
                        .child(
                            div()
                                .min_w(px(28.))
                                .flex()
                                .justify_center()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(Hsla::from(theme.editor.text_1))
                                .child(number.to_string()),
                        )
                        .child(stepper(
                            "up",
                            "icons/plus.svg",
                            tr::editor::shape::increase(),
                            1,
                            cx,
                        )),
                ),
            );
        }

        panel = panel.child(
            crate::ui::Field::section(&theme, tr::editor::shape::look()).child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(self.shape_slider(
                        tr::editor::shape::shadow(),
                        ShapeProperty::Shadow,
                        "x100%",
                        index,
                        cx,
                    ))
                    .child(self.shape_slider(
                        tr::editor::panel::opacity(),
                        ShapeProperty::Opacity,
                        "x100%",
                        index,
                        cx,
                    )),
            ),
        );

        panel = panel.child(
            crate::ui::Field::section(&theme, tr::editor::shape::animation())
                .value(
                    crate::ui::SegmentedControl::editor(
                        &theme,
                        SharedString::from(format!("shape-anim-edge-{index}")),
                        vec![
                            crate::ui::SegmentOption::new(tr::editor::panel::edge_in(), !is_out),
                            crate::ui::SegmentOption::new(tr::editor::panel::edge_out(), is_out),
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
                        .child(
                            crate::ui::SegmentedControl::editor(
                                &theme,
                                SharedString::from(format!("shape-anim-{index}")),
                                SHAPE_ANIMATIONS
                                    .iter()
                                    .map(|animation| {
                                        crate::ui::SegmentOption::new(
                                            animation_label(*animation),
                                            *animation == edge_animation,
                                        )
                                    })
                                    .collect(),
                            )
                            .stretch()
                            .on_select(cx.listener(
                                move |this, choice: &usize, window, cx| {
                                    let Some(animation) = SHAPE_ANIMATIONS.get(*choice).copied()
                                    else {
                                        return;
                                    };
                                    this.edit_shape_segment(
                                        "shape-animation",
                                        index,
                                        window,
                                        cx,
                                        move |segment| {
                                            let slot = if is_out {
                                                &mut segment.animation_out
                                            } else {
                                                &mut segment.animation_in
                                            };
                                            if *slot == animation {
                                                return false;
                                            }
                                            *slot = animation;
                                            true
                                        },
                                    );
                                },
                            )),
                        )
                        .children((edge_animation != ShapeAnimation::None).then(|| {
                            self.shape_slider(
                                tr::editor::panel::duration(),
                                if is_out {
                                    ShapeProperty::AnimationOut
                                } else {
                                    ShapeProperty::AnimationIn
                                },
                                "secs",
                                index,
                                cx,
                            )
                        })),
                ),
        );

        panel.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor_canvas::{SnapLineKind, build_snap_targets};

    const CANVAS: Px = (1600., 900.);

    fn shape(kind: ShapeKind, from: (f64, f64), to: (f64, f64)) -> ShapeSegment {
        ShapeSegment {
            kind,
            from: XY::new(from.0, from.1),
            to: XY::new(to.0, to.1),
            stroke_width: 6.,
            ..Default::default()
        }
    }

    fn no_targets() -> SnapTargets {
        SnapTargets::default()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn line_shapes_hit_along_the_stroke_only() {
        let line = shape(ShapeKind::Line, (0.25, 0.5), (0.75, 0.5));
        assert!(hit_shape(&line, CANVAS, (800., 450.), false));
        assert!(hit_shape(&line, CANVAS, (800., 457.), false));
        assert!(!hit_shape(&line, CANVAS, (800., 470.), false));
        assert!(!hit_shape(&line, CANVAS, (1250., 450.), false));
    }

    #[test]
    fn arrow_heads_are_part_of_the_target() {
        let mut arrow = shape(ShapeKind::Arrow, (0.25, 0.5), (0.75, 0.5));
        let scale = CANVAS.1 / SHAPE_REFERENCE_HEIGHT;
        let (_, head_width) = arrow_head_size(6., 800. / scale);
        let flank = 450. + head_width * scale / 2.;
        assert!(hit_shape(&arrow, CANVAS, (1195., flank), false));
        assert!(!hit_shape(&arrow, CANVAS, (405., flank), false));
        arrow.arrow_head = ShapeArrowHead::Double;
        assert!(hit_shape(&arrow, CANVAS, (405., flank), false));
    }

    #[test]
    fn unfilled_boxes_hit_on_the_stroke_until_selected() {
        let mut rect = shape(ShapeKind::Rectangle, (0.25, 0.25), (0.75, 0.75));
        assert!(hit_shape(&rect, CANVAS, (400., 450.), false));
        assert!(!hit_shape(&rect, CANVAS, (800., 450.), false));
        assert!(hit_shape(&rect, CANVAS, (800., 450.), true));
        rect.fill = true;
        assert!(hit_shape(&rect, CANVAS, (800., 450.), false));
        assert!(!hit_shape(&rect, CANVAS, (380., 450.), false));
        let highlight = shape(ShapeKind::Highlight, (0.25, 0.25), (0.75, 0.75));
        assert!(hit_shape(&highlight, CANVAS, (800., 450.), false));
    }

    #[test]
    fn ellipses_hit_on_their_outline() {
        let ellipse = shape(ShapeKind::Ellipse, (0.25, 0.25), (0.75, 0.75));
        assert!(hit_shape(&ellipse, CANVAS, (400., 450.), false));
        assert!(hit_shape(&ellipse, CANVAS, (800., 225.), false));
        assert!(!hit_shape(&ellipse, CANVAS, (800., 450.), false));
        assert!(hit_shape(&ellipse, CANVAS, (800., 450.), true));
        assert!(!hit_shape(&ellipse, CANVAS, (420., 250.), true));
    }

    #[test]
    fn badges_hit_inside_their_circle() {
        let badge = shape(ShapeKind::Badge, (0.45, 0.4), (0.55, 0.6));
        assert!(hit_shape(&badge, CANVAS, (800., 450.), false));
        assert!(!hit_shape(&badge, CANVAS, (800., 540.), false));
    }

    #[test]
    fn degenerate_shapes_stay_hittable_at_their_point() {
        let dot = shape(ShapeKind::Rectangle, (0.5, 0.5), (0.5, 0.5));
        assert!(hit_shape(&dot, CANVAS, (802., 452.), false));
        let point_line = shape(ShapeKind::Line, (0.5, 0.5), (0.5, 0.5));
        assert!(hit_shape(&point_line, CANVAS, (803., 450.), false));
    }

    #[test]
    fn the_topmost_hit_wins() {
        let below = shape(ShapeKind::Highlight, (0.2, 0.2), (0.8, 0.8));
        let above = shape(ShapeKind::Highlight, (0.4, 0.4), (0.6, 0.6));
        let segments = [below, above];
        assert_eq!(
            topmost_hit(&segments, &[0, 1], CANVAS, (800., 450.), None),
            Some(1)
        );
        assert_eq!(
            topmost_hit(&segments, &[1, 0], CANVAS, (800., 450.), None),
            Some(0)
        );
        assert_eq!(
            topmost_hit(&segments, &[0, 1], CANVAS, (400., 250.), None),
            Some(0)
        );
        assert_eq!(
            topmost_hit(&segments, &[], CANVAS, (800., 450.), None),
            None
        );
    }

    #[test]
    fn lines_get_endpoint_handles_and_boxes_get_eight() {
        let line = shape(ShapeKind::Arrow, (0.1, 0.2), (0.3, 0.4));
        let handles_line = handles(&line, CANVAS);
        assert_eq!(handles_line.len(), 2);
        assert_eq!(handles_line[0], (ShapeHandle::From, (160., 180.)));
        let rect = shape(ShapeKind::Rectangle, (0.25, 0.25), (0.75, 0.75));
        assert_eq!(handles(&rect, CANVAS).len(), 8);
        let badge = shape(ShapeKind::Badge, (0.45, 0.4), (0.55, 0.6));
        assert_eq!(handles(&badge, CANVAS).len(), 4);
    }

    #[test]
    fn small_boxes_drop_edge_handles_but_keep_corners() {
        let tiny = shape(ShapeKind::Rectangle, (0.5, 0.5), (0.52, 0.53));
        let list = handles(&tiny, CANVAS);
        assert_eq!(list.len(), 4);
        assert!(
            list.iter().all(
                |(handle, _)| matches!(handle, ShapeHandle::Box { x, y } if *x != 0 && *y != 0)
            )
        );
        assert_eq!(
            hit_handle(&tiny, CANVAS, (800. + 32., 450. + 27.)),
            Some(ShapeHandle::Box { x: 1, y: 1 })
        );
    }

    #[test]
    fn handles_are_found_within_their_hit_area() {
        let rect = shape(ShapeKind::Rectangle, (0.25, 0.25), (0.75, 0.75));
        assert_eq!(
            hit_handle(&rect, CANVAS, (409., 234.)),
            Some(ShapeHandle::Box { x: -1, y: -1 })
        );
        assert_eq!(
            hit_handle(&rect, CANVAS, (800., 675.)),
            Some(ShapeHandle::Box { x: 0, y: 1 })
        );
        assert_eq!(hit_handle(&rect, CANVAS, (800., 450.)), None);
    }

    #[test]
    fn handle_cursors_follow_their_axis() {
        assert_eq!(
            ShapeHandle::Box { x: 0, y: 1 }.cursor(),
            CursorStyle::ResizeUpDown
        );
        assert_eq!(
            ShapeHandle::Box { x: -1, y: 0 }.cursor(),
            CursorStyle::ResizeLeftRight
        );
        assert_eq!(
            ShapeHandle::Box { x: 1, y: 1 }.cursor(),
            CursorStyle::ResizeUpLeftDownRight
        );
        assert_eq!(
            ShapeHandle::Box { x: 1, y: -1 }.cursor(),
            CursorStyle::ResizeUpRightDownLeft
        );
    }

    #[test]
    fn moves_follow_the_pointer_and_snap_to_the_frame_centre() {
        let rect = shape(ShapeKind::Rectangle, (0.1, 0.1), (0.3, 0.3));
        let (from, to, guides) = moved(&rect, (160., 90.), CANVAS, &no_targets(), true, false);
        assert!(close(from.x, 0.2) && close(from.y, 0.2));
        assert!(close(to.x, 0.4) && close(to.y, 0.4));
        assert!(guides.is_empty());

        let targets = build_snap_targets(&[], None);
        let (from, to, guides) = moved(&rect, (476., 0.), CANVAS, &targets, true, false);
        assert!(close((from.x + to.x) / 2., 0.5));
        assert_eq!(guides.len(), 1);
        assert_eq!(guides[0].kind, SnapLineKind::FrameCenter);

        let (from, _, _) = moved(&rect, (476., 0.), CANVAS, &targets, false, false);
        assert!(close(from.x, 0.1 + 476. / 1600.));
    }

    #[test]
    fn axis_locked_moves_keep_one_axis() {
        let rect = shape(ShapeKind::Rectangle, (0.1, 0.1), (0.3, 0.3));
        let (from, _, _) = moved(&rect, (100., 30.), CANVAS, &no_targets(), false, true);
        assert!(close(from.y, 0.1));
        assert!(close(from.x, 0.1 + 100. / 1600.));
        let (from, _, _) = moved(&rect, (10., -45.), CANVAS, &no_targets(), false, true);
        assert!(close(from.x, 0.1));
        assert!(close(from.y, 0.05));
    }

    #[test]
    fn moves_keep_the_centre_inside_the_frame() {
        let arrow = shape(ShapeKind::Arrow, (0.8, 0.8), (0.9, 0.9));
        let (from, to, _) = moved(&arrow, (5000., 5000.), CANVAS, &no_targets(), false, false);
        assert!(close((from.x + to.x) / 2., 1.));
        assert!(close((from.y + to.y) / 2., 1.));
        assert!(close(to.x - from.x, 0.1));
    }

    fn options(keep_aspect: bool, from_center: bool) -> ResizeOptions {
        ResizeOptions {
            keep_aspect,
            from_center,
            snap: false,
        }
    }

    fn assert_px(rect: ShapeRect, expected: (f64, f64, f64, f64)) {
        let actual = px_rect(rect);
        assert!(
            close(actual.0, expected.0)
                && close(actual.1, expected.1)
                && close(actual.2, expected.2)
                && close(actual.3, expected.3),
            "{actual:?} != {expected:?}"
        );
    }

    fn px_rect(rect: ShapeRect) -> (f64, f64, f64, f64) {
        (
            rect.x * CANVAS.0,
            rect.y * CANVAS.1,
            rect.w * CANVAS.0,
            rect.h * CANVAS.1,
        )
    }

    #[test]
    fn corner_resizes_move_two_edges() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        let (rect, _) = resized(
            start,
            (1, 1),
            (40., 20.),
            CANVAS,
            &no_targets(),
            options(false, false),
        );
        assert_px(rect, (400., 225., 440., 245.));
        let (rect, _) = resized(
            start,
            (-1, 0),
            (-40., 99.),
            CANVAS,
            &no_targets(),
            options(false, false),
        );
        assert_px(rect, (360., 225., 440., 225.));
    }

    #[test]
    fn resizing_past_the_opposite_edge_flips_the_box() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        let (rect, _) = resized(
            start,
            (1, 0),
            (-500., 0.),
            CANVAS,
            &no_targets(),
            options(false, false),
        );
        assert_px(rect, (300., 225., 100., 225.));
    }

    #[test]
    fn shift_keeps_the_pixel_aspect() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        let (rect, _) = resized(
            start,
            (1, 1),
            (200., 10.),
            CANVAS,
            &no_targets(),
            options(true, false),
        );
        let (_, _, w, h) = px_rect(rect);
        assert!(close(w / h, 400. / 225.));
        assert!(close(w, 600.));
        let (rect, _) = resized(
            start,
            (1, 0),
            (200., 0.),
            CANVAS,
            &no_targets(),
            options(true, false),
        );
        let (_, y, w, h) = px_rect(rect);
        assert!(close(w / h, 400. / 225.));
        assert!(close(y + h / 2., 225. + 225. / 2.));
    }

    #[test]
    fn alt_resizes_about_the_centre() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        let (rect, _) = resized(
            start,
            (1, 0),
            (50., 0.),
            CANVAS,
            &no_targets(),
            options(false, true),
        );
        let (x, _, w, _) = px_rect(rect);
        assert!(close(x, 350.));
        assert!(close(w, 500.));
        let (rect, _) = resized(
            start,
            (1, 1),
            (100., 0.),
            CANVAS,
            &no_targets(),
            options(true, true),
        );
        let (x, y, w, h) = px_rect(rect);
        assert!(close(x + w / 2., 600.) && close(y + h / 2., 337.5));
        assert!(close(w / h, 400. / 225.));
    }

    #[test]
    fn shift_side_resizes_keep_both_sides_above_the_minimum() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        for (handle, delta) in [
            ((1, 0), (-400., 0.)),
            ((0, 1), (0., -225.)),
            ((1, 1), (-400., -225.)),
        ] {
            let (rect, _) = resized(
                start,
                handle,
                delta,
                CANVAS,
                &no_targets(),
                options(true, false),
            );
            let (_, _, w, h) = px_rect(rect);
            assert!(
                w >= MIN_EXTENT_PX - 1e-9 && h >= MIN_EXTENT_PX - 1e-9,
                "{handle:?} {w} {h}"
            );
            assert!(close(w / h, 400. / 225.), "{handle:?} {w} {h}");
        }
    }

    #[test]
    fn resizes_never_collapse_below_the_minimum() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.25,
            h: 0.25,
        };
        let (rect, _) = resized(
            start,
            (1, 0),
            (-400., 0.),
            CANVAS,
            &no_targets(),
            options(false, false),
        );
        let (_, _, w, _) = px_rect(rect);
        assert!(w >= MIN_EXTENT_PX - 1e-9);
    }

    #[test]
    fn resized_edges_snap_and_report_a_guide() {
        let start = ShapeRect {
            x: 0.25,
            y: 0.25,
            w: 0.2,
            h: 0.25,
        };
        let targets = build_snap_targets(&[], None);
        let (rect, guides) = resized(
            start,
            (1, 0),
            (77., 0.),
            CANVAS,
            &targets,
            ResizeOptions {
                keep_aspect: false,
                from_center: false,
                snap: true,
            },
        );
        assert!(close(rect.x + rect.w, 0.5));
        assert_eq!(guides.len(), 1);
        assert_eq!(guides[0].axis, GuideAxis::V);
    }

    #[test]
    fn shift_endpoint_drags_snap_to_45_degrees() {
        let arrow = shape(ShapeKind::Arrow, (0.25, 0.5), (0.5, 0.5));
        let (to, guides) = endpoint_dragged(
            &arrow,
            ShapeHandle::To,
            (0., 380.),
            CANVAS,
            &no_targets(),
            true,
            true,
        );
        assert!(guides.is_empty());
        let (dx, dy) = (to.x * CANVAS.0 - 400., to.y * CANVAS.1 - 450.);
        assert!(close(dx.abs(), dy.abs()));
        let length = (400_f64).hypot(380.);
        assert!(close(dx.hypot(dy), length));
    }

    #[test]
    fn endpoint_drags_snap_to_frame_lines() {
        let line = shape(ShapeKind::Line, (0.25, 0.25), (0.4, 0.3));
        let targets = build_snap_targets(&[], None);
        let (to, guides) = endpoint_dragged(
            &line,
            ShapeHandle::To,
            (155., 0.),
            CANVAS,
            &targets,
            false,
            true,
        );
        assert!(close(to.x, 0.5));
        assert_eq!(guides.len(), 1);
        let (from, _) = endpoint_dragged(
            &line,
            ShapeHandle::From,
            (10., 10.),
            CANVAS,
            &targets,
            false,
            false,
        );
        assert!(close(from.x, 0.25 + 10. / 1600.));
    }

    #[test]
    fn drawing_boxes_spans_the_drag_and_normalises() {
        let (from, to) = drawn(
            ShapeKind::Rectangle,
            (800., 450.),
            (400., 225.),
            CANVAS,
            false,
            false,
        );
        assert!(close(from.x, 0.25) && close(from.y, 0.25));
        assert!(close(to.x, 0.5) && close(to.y, 0.5));
        let (from, to) = drawn(
            ShapeKind::Ellipse,
            (800., 450.),
            (900., 480.),
            CANVAS,
            true,
            false,
        );
        assert!(close(
            (to.x - from.x) * CANVAS.0,
            (to.y - from.y) * CANVAS.1
        ));
        let (from, to) = drawn(
            ShapeKind::Rectangle,
            (800., 450.),
            (900., 500.),
            CANVAS,
            false,
            true,
        );
        assert!(close(from.x * CANVAS.0, 700.) && close(to.x * CANVAS.0, 900.));
        let (from, to) = drawn(
            ShapeKind::Badge,
            (800., 450.),
            (830., 500.),
            CANVAS,
            false,
            false,
        );
        assert!(close(
            (to.x - from.x) * CANVAS.0,
            (to.y - from.y) * CANVAS.1
        ));
    }

    #[test]
    fn drawing_lines_keeps_direction() {
        let (from, to) = drawn(
            ShapeKind::Arrow,
            (800., 450.),
            (400., 225.),
            CANVAS,
            false,
            false,
        );
        assert!(close(from.x, 0.5) && close(to.x, 0.25));
        let (from, to) = drawn(
            ShapeKind::Line,
            (800., 450.),
            (900., 460.),
            CANVAS,
            true,
            false,
        );
        assert!(close(from.y * CANVAS.1, to.y * CANVAS.1));
    }

    #[test]
    fn nudges_move_one_or_ten_canvas_pixels() {
        let rect = shape(ShapeKind::Rectangle, (0.1, 0.1), (0.3, 0.3));
        let (from, to) = nudged(&rect, (1., 0.), false, CANVAS);
        assert!(close(from.x, 0.1 + 1. / 1600.) && close(to.x, 0.3 + 1. / 1600.));
        let (from, _) = nudged(&rect, (0., -1.), true, CANVAS);
        assert!(close(from.y, 0.1 - 10. / 900.));
    }

    #[test]
    fn converting_to_a_badge_makes_a_circle_about_the_centre() {
        let mut rect = shape(ShapeKind::Rectangle, (0.2, 0.2), (0.6, 0.4));
        rect.stroke_color = "#00FF00".into();
        rect.start = 3.;
        rect.end = 7.;
        convert_kind(&mut rect, ShapeKind::Badge, 16. / 9.);
        let bounds = rect.rect();
        assert!(close(bounds.w * 16. / 9., bounds.h));
        assert!(close(bounds.center().x, 0.4) && close(bounds.center().y, 0.3));
        assert_eq!((rect.start, rect.end), (3., 7.));
        assert!(rect.fill);

        let mut arrow = shape(ShapeKind::Arrow, (0.2, 0.2), (0.6, 0.2));
        arrow.stroke_color = "#00FF00".into();
        convert_kind(&mut arrow, ShapeKind::Rectangle, 16. / 9.);
        assert!(arrow.rect().h >= 0.02 - 1e-12);
        assert_eq!(arrow.stroke_color, "#00FF00");
    }

    fn timed(start: f64, end: f64, track: u32) -> ShapeSegment {
        ShapeSegment {
            start,
            end,
            track,
            ..Default::default()
        }
    }

    #[test]
    fn free_lanes_skip_overlaps_and_open_a_new_lane_when_full() {
        let shapes = [timed(0., 5., 0), timed(2., 4., 1)];
        assert_eq!(free_lane(&shapes, 5., 7.), 0);
        assert_eq!(free_lane(&shapes, 4., 6.), 1);
        assert_eq!(free_lane(&shapes, 3., 4.5), 2);
        assert_eq!(free_lane(&[], 0., 1.), 0);
    }

    #[test]
    fn pastes_keep_relative_timing_and_stay_inside_the_timeline() {
        let copied = [timed(10., 12., 0), timed(11., 15., 1)];
        let pasted_at = pasted(&copied, 2., 60., (0.01, 0.02));
        assert_eq!(
            pasted_at
                .iter()
                .map(|s| (s.start, s.end))
                .collect::<Vec<_>>(),
            [(2., 4.), (3., 7.)]
        );
        assert!(close(pasted_at[0].from.x, copied[0].from.x + 0.01));
        assert!(close(pasted_at[0].to.y, copied[0].to.y + 0.02));
        let near_end = pasted(&copied, 58., 60., (0., 0.));
        assert_eq!(near_end[1].end, 60.);
        assert_eq!(near_end[0].start, 55.);
        assert!(pasted(&[], 1., 60., (0., 0.)).is_empty());
        let longer_than_timeline = pasted(&[timed(0., 90., 0)], 5., 60., (0., 0.));
        assert_eq!(
            (longer_than_timeline[0].start, longer_than_timeline[0].end),
            (0., 60.)
        );
    }

    #[test]
    fn shape_properties_clamp_and_report_changes() {
        let mut shape = ShapeSegment::default();
        assert!(ShapeProperty::StrokeWidth.write(&mut shape, 500.));
        assert_eq!(shape.stroke_width, SHAPE_MAX_STROKE_WIDTH);
        assert!(!ShapeProperty::StrokeWidth.write(&mut shape, 900.));
        assert!(!ShapeProperty::Opacity.write(&mut shape, f32::NAN));
        assert!(ShapeProperty::AnimationIn.write(&mut shape, 9.));
        assert_eq!(shape.animation_in_duration, SHAPE_MAX_ANIMATION_DURATION);
        shape.shadow = f32::NAN;
        assert_eq!(ShapeProperty::Shadow.read(&shape), 0.);
        assert!(ShapeProperty::FillOpacity.write(&mut shape, -1.));
        assert_eq!(shape.fill_opacity, 0.);
    }

    #[test]
    fn angle_snap_preserves_length_and_handles_zero() {
        assert_eq!(snap_angle((0., 0.), (0., 0.)), (0., 0.));
        let snapped = snap_angle((0., 0.), (10., 1.));
        assert!(close(snapped.1, 0.));
        assert!(close(snapped.0, (101_f64).sqrt()));
    }
}
