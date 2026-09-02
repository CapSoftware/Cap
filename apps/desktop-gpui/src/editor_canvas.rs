//! The in-canvas move control for the screen recording:
//! `routes/editor/CanvasElementsOverlay.tsx`'s `display` element, and the
//! `snapping.ts` geometry it drags against.
//!
//! # What it writes
//!
//! `background.displayPosition` -- the **normalised centre** of the display
//! card in output-frame space (`configuration.rs:352-355`). `None` keeps the
//! display centred; a value is a fraction of the output frame, so `0.5, 0.5`
//! is dead centre and `0.25, 0.5` is a quarter of the way in from the left.
//! `cap-rendering` turns it back into a pixel offset as
//! `(position.clamp(0,1) - 0.5) * output_size` and adds it to the layout's
//! own offset (`rendering/src/lib.rs:2952-2969`), which is why the display can
//! overhang an edge but can never leave the frame.
//!
//! # The drag mapping, exactly
//!
//! The box tracks the rect the renderer reported for the latest frame
//! (`FrameLayout::display`, output-frame pixels), normalised against
//! `output_size`. A drag then reads (`CanvasElementsOverlay.tsx:596-637`):
//!
//! ```text
//! raw.x  = rect.x + (mouse.x - down.x) / canvas_width      // canvas px -> 0..1
//! raw.y  = rect.y + (mouse.y - down.y) / canvas_height
//! dx, dy = snapMovingRect(raw, targets, 7/canvas_width, 7/canvas_height)   // unless Shift
//! x      = clamp(raw.x + dx, -raw.w / 2, 1 - raw.w / 2)     // the DISPLAY clamp:
//! y      = clamp(raw.y + dy, -raw.h / 2, 1 - raw.h / 2)     // half of it may hang out
//! centre = (x + raw.w / 2, y + raw.h / 2)
//! ```
//!
//! `canvas_width` / `canvas_height` are the **letterboxed frame size on
//! screen**, not the player pane -- `size()` in `Player.tsx:590-601`, which is
//! [`crate::editor_window::letterbox`].
//!
//! # History
//!
//! One entry per drag: `projectHistory.pause()` on mouse-down and the returned
//! `resumeHistory()` on mouse-up (`:284-320`), the same bracket the sidebar's
//! sliders take. A press that never moved 2px writes nothing at all, so a
//! plain click on the display cannot convert a centred layout into a manual
//! one.

use std::cell::Cell;
use std::rc::Rc;

use crate::{editor_timeline::TrackKind, editor_window::EditorWindow};
use cap_project::{CameraXPosition, CameraYPosition, SceneMode, XY};
use cap_rendering::FrameLayout;
use gpui::{
    AnyElement, Bounds, Context, CursorStyle, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, SharedString,
    StatefulInteractiveElement, Styled, Window, div, px,
};

/// `NormRect` (`snapping.ts:6`): normalised against the output frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `SNAP_PX` (`snapping.ts:35`) -- the magnetic radius, in CSS pixels.
pub const SNAP_PX: f64 = 7.;

/// `clamp` (`CanvasElementsOverlay.tsx:36-37`). Note the inverted-range arm:
/// when the element is wider than the frame the two bounds cross, and the
/// source centres it rather than picking an end.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if min > max {
        (min + max) / 2.
    } else {
        value.max(min).min(max)
    }
}

/// `normRect` (`:39-49`).
pub fn norm_rect(bounds: [f32; 4], layout: &FrameLayout) -> NormRect {
    let width = f64::from(layout.output_size[0]).max(1.);
    let height = f64::from(layout.output_size[1]).max(1.);
    NormRect {
        x: f64::from(bounds[0]) / width,
        y: f64::from(bounds[1]) / height,
        w: f64::from(bounds[2] - bounds[0]) / width,
        h: f64::from(bounds[3] - bounds[1]) / height,
    }
}

/// `classicMargin` (`:53-56`): the renderer's stock 50px-at-1080p camera
/// inset, exposed as snap lines.
pub fn classic_margin(layout: &FrameLayout) -> (f64, f64) {
    let width = f64::from(layout.output_size[0]).max(1.);
    let height = f64::from(layout.output_size[1]).max(1.);
    let pad = 50. * (height / 1080.);
    (pad / width, pad / height)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapLineKind {
    FrameEdge,
    FrameCenter,
    Margin,
    ElementEdge,
    ElementCenter,
}

impl SnapLineKind {
    fn is_center(self) -> bool {
        matches!(self, Self::FrameCenter | Self::ElementCenter)
    }
}

/// `SnapLine` (`snapping.ts:16-23`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapLine {
    pub pos: f64,
    pub kind: SnapLineKind,
    /// The source rect's extent along the *other* axis, so a guide can be
    /// drawn spanning both aligned elements. `None` = a full-frame line.
    pub reference: Option<(f64, f64)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapTargets {
    pub v: Vec<SnapLine>,
    pub h: Vec<SnapLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuideAxis {
    V,
    H,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SnapGuide {
    pub axis: GuideAxis,
    pub pos: f64,
    pub start: f64,
    pub end: f64,
    pub kind: SnapLineKind,
}

/// `buildSnapTargets` (`snapping.ts:37-79`).
pub fn build_snap_targets(others: &[NormRect], margin: Option<(f64, f64)>) -> SnapTargets {
    let frame = |pos: f64, kind: SnapLineKind| SnapLine {
        pos,
        kind,
        reference: None,
    };
    let mut v = vec![
        frame(0., SnapLineKind::FrameEdge),
        frame(1., SnapLineKind::FrameEdge),
        frame(0.5, SnapLineKind::FrameCenter),
    ];
    let mut h = v.clone();

    if let Some((mx, my)) = margin {
        v.push(frame(mx, SnapLineKind::Margin));
        v.push(frame(1. - mx, SnapLineKind::Margin));
        h.push(frame(my, SnapLineKind::Margin));
        h.push(frame(1. - my, SnapLineKind::Margin));
    }

    for rect in others {
        let ref_v = Some((rect.y, rect.y + rect.h));
        let ref_h = Some((rect.x, rect.x + rect.w));
        v.push(SnapLine {
            pos: rect.x,
            kind: SnapLineKind::ElementEdge,
            reference: ref_v,
        });
        v.push(SnapLine {
            pos: rect.x + rect.w / 2.,
            kind: SnapLineKind::ElementCenter,
            reference: ref_v,
        });
        v.push(SnapLine {
            pos: rect.x + rect.w,
            kind: SnapLineKind::ElementEdge,
            reference: ref_v,
        });
        h.push(SnapLine {
            pos: rect.y,
            kind: SnapLineKind::ElementEdge,
            reference: ref_h,
        });
        h.push(SnapLine {
            pos: rect.y + rect.h / 2.,
            kind: SnapLineKind::ElementCenter,
            reference: ref_h,
        });
        h.push(SnapLine {
            pos: rect.y + rect.h,
            kind: SnapLineKind::ElementEdge,
            reference: ref_h,
        });
    }

    SnapTargets { v, h }
}

/// `snapAxis` (`snapping.ts:83-106`). Centre lines carry a `threshold * 0.15`
/// cost bias so they win ties against edges.
fn snap_axis(anchors: &[f64], lines: &[SnapLine], threshold: f64) -> Option<(f64, SnapLine)> {
    let mut best: Option<(f64, SnapLine)> = None;
    let mut best_cost = f64::INFINITY;
    for line in lines {
        let bias = if line.kind.is_center() {
            threshold * 0.15
        } else {
            0.
        };
        for anchor in anchors {
            let delta = line.pos - anchor;
            if delta.abs() > threshold {
                continue;
            }
            let cost = delta.abs() - bias;
            if cost < best_cost {
                best_cost = cost;
                best = Some((delta, *line));
            }
        }
    }
    best
}

/// `guideFor` (`snapping.ts:108-125`).
fn guide_for(axis: GuideAxis, line: SnapLine, moving: NormRect) -> SnapGuide {
    let Some((ref_start, ref_end)) = line.reference else {
        return SnapGuide {
            axis,
            pos: line.pos,
            start: 0.,
            end: 1.,
            kind: line.kind,
        };
    };
    let (moving_start, moving_end) = match axis {
        GuideAxis::V => (moving.y, moving.y + moving.h),
        GuideAxis::H => (moving.x, moving.x + moving.w),
    };
    SnapGuide {
        axis,
        pos: line.pos,
        start: ref_start.min(moving_start),
        end: ref_end.max(moving_end),
        kind: line.kind,
    }
}

/// `snapMovingRect` (`snapping.ts:132-160`): the rect's three x-anchors and
/// three y-anchors are tested independently.
pub fn snap_moving_rect(
    rect: NormRect,
    targets: &SnapTargets,
    threshold_x: f64,
    threshold_y: f64,
) -> (f64, f64, Vec<SnapGuide>) {
    let sx = snap_axis(
        &[rect.x, rect.x + rect.w / 2., rect.x + rect.w],
        &targets.v,
        threshold_x,
    );
    let sy = snap_axis(
        &[rect.y, rect.y + rect.h / 2., rect.y + rect.h],
        &targets.h,
        threshold_y,
    );

    let dx = sx.map_or(0., |(delta, _)| delta);
    let dy = sy.map_or(0., |(delta, _)| delta);
    let snapped = NormRect {
        x: rect.x + dx,
        y: rect.y + dy,
        ..rect
    };

    let mut guides = Vec::new();
    if let Some((_, line)) = sx {
        guides.push(guide_for(GuideAxis::V, line, snapped));
    }
    if let Some((_, line)) = sy {
        guides.push(guide_for(GuideAxis::H, line, snapped));
    }
    (dx, dy, guides)
}

fn overlay_drag_center(
    rect: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    targets: &SnapTargets,
    shift: bool,
) -> (XY<f64>, Vec<SnapGuide>) {
    let raw = NormRect {
        x: rect.x + delta.0 / canvas.0.max(1.),
        y: rect.y + delta.1 / canvas.1.max(1.),
        ..rect
    };
    let (dx, dy, guides) = if shift {
        (0., 0., Vec::new())
    } else {
        snap_moving_rect(raw, targets, 7. / canvas.0.max(1.), 7. / canvas.1.max(1.))
    };
    let x = (raw.x + dx).clamp(0., 1.);
    let y = (raw.y + dy).clamp(0., 1.);
    (
        XY {
            x: (x + raw.w / 2.).clamp(0., 1.),
            y: (y + raw.h / 2.).clamp(0., 1.),
        },
        guides,
    )
}

fn overlay_resize_rect(
    start: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    dir_x: i8,
    dir_y: i8,
    targets: &SnapTargets,
    shift: bool,
) -> (NormRect, Vec<SnapGuide>) {
    let ndx = delta.0 / canvas.0.max(1.);
    let ndy = delta.1 / canvas.1.max(1.);
    let mut w = start.w;
    let mut h = start.h;
    let mut cx = start.x + start.w / 2.;
    let mut cy = start.y + start.h / 2.;
    if dir_x != 0 {
        w = (start.w + ndx * f64::from(dir_x)).max(0.01);
        cx = start.x + start.w / 2. + ndx / 2.;
    }
    if dir_y != 0 {
        h = (start.h + ndy * f64::from(dir_y)).max(0.01);
        cy = start.y + start.h / 2. + ndy / 2.;
    }
    let rect = NormRect {
        x: (cx - w / 2.).clamp(0., 1.),
        y: (cy - h / 2.).clamp(0., 1.),
        w,
        h,
    };
    let guides = if shift {
        Vec::new()
    } else {
        snap_moving_rect(rect, targets, 7. / canvas.0.max(1.), 7. / canvas.1.max(1.)).2
    };
    (rect, guides)
}

fn overlay_nudge_center(rect: NormRect, direction: (f64, f64), shift: bool) -> XY<f64> {
    let step = if shift { 0.05 } else { 0.01 };
    XY {
        x: (rect.x + rect.w / 2. + direction.0 * step).clamp(0., 1.),
        y: (rect.y + rect.h / 2. + direction.1 * step).clamp(0., 1.),
    }
}

fn overlay_rect_from_center_size(segment: &cap_project::MaskSegment) -> Option<NormRect> {
    Some(NormRect {
        x: segment.center.x - segment.size.x / 2.,
        y: segment.center.y - segment.size.y / 2.,
        w: segment.size.x,
        h: segment.size.y,
    })
}

/// The whole move mapping, pure, so a scripted drag can be predicted.
///
/// `canvas` is the letterboxed frame size on screen; `delta` is the pointer's
/// travel in those same pixels.
pub fn display_drag_center(
    rect: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    targets: &SnapTargets,
    shift: bool,
) -> (XY<f64>, Vec<SnapGuide>) {
    let raw = NormRect {
        x: rect.x + delta.0 / canvas.0.max(1.),
        y: rect.y + delta.1 / canvas.1.max(1.),
        ..rect
    };
    let (dx, dy, guides) = if shift {
        (0., 0., Vec::new())
    } else {
        snap_moving_rect(
            raw,
            targets,
            SNAP_PX / canvas.0.max(1.),
            SNAP_PX / canvas.1.max(1.),
        )
    };
    // The display's centre may go anywhere in-frame, so it can overhang the
    // edges (revealing background) but never be dragged fully out of view.
    let x = clamp(raw.x + dx, -raw.w / 2., 1. - raw.w / 2.);
    let y = clamp(raw.y + dy, -raw.h / 2., 1. - raw.h / 2.);
    (XY::new(x + raw.w / 2., y + raw.h / 2.), guides)
}

/// The arrow-key nudge (`:563-720`): 1px, or 10 with Shift, in canvas pixels,
/// with the same clamp the drag uses and no snapping.
pub fn display_nudge_center(
    rect: NormRect,
    canvas: (f64, f64),
    direction: (f64, f64),
    shift: bool,
) -> XY<f64> {
    let step = if shift { 10. } else { 1. };
    let x = clamp(
        rect.x + (direction.0 * step) / canvas.0.max(1.),
        -rect.w / 2.,
        1. - rect.w / 2.,
    );
    let y = clamp(
        rect.y + (direction.1 * step) / canvas.1.max(1.),
        -rect.h / 2.,
        1. - rect.h / 2.,
    );
    XY::new(x + rect.w / 2., y + rect.h / 2.)
}

// ---------------------------------------------------------------------------
// The live drag
// ---------------------------------------------------------------------------

/// The letterboxed frame and the preview container it sits in, both in
/// window space. Written from the preview canvas's paint closure; gpui has
/// no `getBoundingClientRect`.
#[derive(Clone, Copy, Debug)]
pub struct PlayerFrame {
    pub container: Bounds<Pixels>,
    pub frame: Bounds<Pixels>,
}

pub type CanvasRect = Rc<Cell<Option<PlayerFrame>>>;

/// `editorState.canvasSelection` (`CanvasElementsOverlay.tsx:252`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasSelection {
    Display,
    Camera,
    Mask(usize),
    Text(usize),
}

impl CanvasSelection {
    fn label(self) -> SharedString {
        match self {
            Self::Display => "Screen".into(),
            Self::Camera => "Camera".into(),
            Self::Mask(_) => "Mask".into(),
            Self::Text(_) => "Text".into(),
        }
    }

    fn element_id(self) -> SharedString {
        match self {
            Self::Display => "canvas-display".into(),
            Self::Camera => "canvas-camera".into(),
            Self::Mask(index) => format!("canvas-mask-{index}").into(),
            Self::Text(index) => format!("canvas-text-{index}").into(),
        }
    }

    fn timeline_selection(self) -> Option<(TrackKind, usize)> {
        match self {
            Self::Mask(index) => Some((TrackKind::Mask, index)),
            Self::Text(index) => Some((TrackKind::Text, index)),
            _ => None,
        }
    }
}

pub struct CanvasResize {
    pub dir_x: i8,
    pub dir_y: i8,
    pub output_width: f64,
    pub output_height: f64,
    pub camera_manual: Option<XY<f64>>,
    pub camera_x: CameraXPosition,
    pub camera_y: CameraYPosition,
    pub max_width: f64,
    pub padding_scale: f64,
}

pub struct CanvasDrag {
    pub element: CanvasSelection,
    /// The rect the press started from, normalised.
    pub start: NormRect,
    pub targets: SnapTargets,
    pub down: Point<Pixels>,
    /// `state.moved` -- whether the 2px threshold has been crossed.
    pub moved: bool,
    pub resize: Option<CanvasResize>,
}

impl EditorWindow {
    /// `overlayVisible()` (`:238`): only while paused, and only once the
    /// renderer has reported a layout.
    pub(crate) fn canvas_overlay_visible(&self) -> bool {
        !self.playing && self.frame_layout.is_some() && self.crop.is_none()
    }

    fn scene_mode_at(&self, time: f64) -> SceneMode {
        self.project
            .timeline
            .as_ref()
            .and_then(|timeline| {
                timeline
                    .scene_segments
                    .iter()
                    .find(|segment| time >= segment.start && time < segment.end)
                    .map(|segment| segment.mode)
            })
            .unwrap_or(SceneMode::Default)
    }

    fn pane_scene(&self) -> bool {
        matches!(
            self.scene_mode_at(self.preview_or_playhead()),
            SceneMode::SplitScreen | SceneMode::Floating
        )
    }

    fn show_display(&self) -> bool {
        self.canvas_overlay_visible()
            && !self.pane_scene()
            && !matches!(
                self.scene_mode_at(self.preview_or_playhead()),
                SceneMode::CameraOnly
            )
    }

    fn show_camera(&self) -> bool {
        self.canvas_overlay_visible() && !self.pane_scene() && self.camera_rect().is_some()
    }

    /// `displayDraggable()` (`:249`): the rendered display rect is
    /// zoom-transformed while a zoom segment is active, but a drag writes
    /// base-layout config, so it is locked rather than mismatched.
    pub(crate) fn display_draggable(&self) -> bool {
        self.active_zoom_index().is_none()
    }

    fn camera_resizable(&self) -> bool {
        self.active_zoom_index().is_none()
    }

    fn active_zoom_index(&self) -> Option<usize> {
        let t = self.preview_or_playhead();
        self.project
            .timeline
            .as_ref()?
            .zoom_segments
            .iter()
            .position(|segment| t >= segment.start && t < segment.end)
    }

    /// `displayRect()` (`:224-229`): the optimistic rect while dragging, the
    /// renderer's own otherwise.
    pub(crate) fn display_rect(&self) -> Option<NormRect> {
        if let Some(rect) = self.canvas_drag_rect {
            return Some(rect);
        }
        let layout = self.frame_layout.as_ref()?;
        Some(norm_rect(layout.display, layout))
    }

    fn camera_rect(&self) -> Option<NormRect> {
        if let Some(rect) = self.canvas_drag_camera_rect {
            return Some(rect);
        }
        let layout = self.frame_layout.as_ref()?;
        Some(norm_rect(layout.camera?, layout))
    }

    /// `useCanvasSnapTargets()` (`:70-129`): every other visible element's
    /// edges and centres, the frame's own, and the classic camera margin.
    pub(crate) fn canvas_snap_targets(&self, exclude: CanvasSelection) -> SnapTargets {
        let mut rects: Vec<NormRect> = Vec::new();
        let Some(layout) = self.frame_layout.as_ref() else {
            return build_snap_targets(&rects, None);
        };
        if exclude != CanvasSelection::Display {
            rects.push(norm_rect(layout.display, layout));
        }
        if let Some(camera) = layout.camera
            && exclude != CanvasSelection::Camera
        {
            rects.push(norm_rect(camera, layout));
        }
        let t = self.preview_or_playhead();
        if let Some(timeline) = self.project.timeline.as_ref() {
            for (index, segment) in timeline.text_segments.iter().enumerate() {
                if exclude == CanvasSelection::Text(index) {
                    continue;
                }
                if !(t >= segment.start && t < segment.end && segment.enabled) {
                    continue;
                }
                let center = segment.center;
                let size = segment.size;
                rects.push(NormRect {
                    x: center.x - size.x / 2.,
                    y: center.y - size.y / 2.,
                    w: size.x,
                    h: size.y,
                });
            }
            for (index, segment) in timeline.mask_segments.iter().enumerate() {
                if exclude == CanvasSelection::Mask(index) {
                    continue;
                }
                if !(t >= segment.start && t < segment.end) {
                    continue;
                }
                rects.push(NormRect {
                    x: segment.center.x - segment.size.x / 2.,
                    y: segment.center.y - segment.size.y / 2.,
                    w: segment.size.x,
                    h: segment.size.y,
                });
            }
        }
        let wants_margin = matches!(exclude, CanvasSelection::Display | CanvasSelection::Camera);
        build_snap_targets(&rects, wants_margin.then(|| classic_margin(layout)))
    }

    /// The letterboxed frame rect on screen, in window space.
    pub(crate) fn canvas_bounds(&self) -> Option<Bounds<Pixels>> {
        self.player_frame_rect.get().map(|player| player.frame)
    }

    fn begin_canvas_move(
        &mut self,
        element: CanvasSelection,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some((kind, index)) = element.timeline_selection() {
            self.canvas_selection = Some(element);
            self.set_selection(
                Some(crate::editor_edits::Selection::single(kind, index)),
                cx,
            );
        } else if self.canvas_selection != Some(element) {
            self.canvas_selection = Some(element);
            self.set_selection(None, cx);
        }
        let draggable = match element {
            CanvasSelection::Display => self.display_draggable(),
            CanvasSelection::Camera | CanvasSelection::Mask(_) | CanvasSelection::Text(_) => true,
        };
        if !draggable {
            cx.notify();
            return;
        }
        let Some(rect) = self.element_rect(element) else {
            return;
        };
        self.history.pause();
        self.canvas_drag = Some(CanvasDrag {
            element,
            start: rect,
            targets: self.canvas_snap_targets(element),
            down: event.position,
            moved: false,
            resize: None,
        });
        cx.notify();
        window.refresh();
    }

    fn begin_canvas_resize(
        &mut self,
        element: CanvasSelection,
        dir_x: i8,
        dir_y: i8,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let resizable = match element {
            CanvasSelection::Display => self.display_draggable(),
            CanvasSelection::Camera => self.camera_resizable(),
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => true,
        };
        if !resizable {
            return;
        }
        if let Some((kind, index)) = element.timeline_selection() {
            self.canvas_selection = Some(element);
            self.set_selection(
                Some(crate::editor_edits::Selection::single(kind, index)),
                cx,
            );
        } else if self.canvas_selection != Some(element) {
            self.canvas_selection = Some(element);
            self.set_selection(None, cx);
        }
        let Some(rect) = self.element_rect(element) else {
            return;
        };
        let Some(layout) = self.frame_layout else {
            return;
        };
        let (max_width, padding_scale) =
            display_resize_scales(rect, &layout, self.project.aspect_ratio.is_some());
        self.history.pause();
        self.canvas_drag = Some(CanvasDrag {
            element,
            start: rect,
            targets: self.canvas_snap_targets(element),
            down: event.position,
            moved: false,
            resize: Some(CanvasResize {
                dir_x,
                dir_y,
                output_width: f64::from(layout.output_size[0]),
                output_height: f64::from(layout.output_size[1]),
                camera_manual: self.project.camera.manual_position,
                camera_x: self.project.camera.position.x.clone(),
                camera_y: self.project.camera.position.y.clone(),
                max_width,
                padding_scale,
            }),
        });
        cx.notify();
        window.refresh();
    }

    pub(crate) fn canvas_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(canvas) = self.canvas_bounds() else {
            return;
        };
        let Some(drag) = self.canvas_drag.as_ref() else {
            return;
        };
        let delta = (
            f64::from(f32::from(event.position.x - drag.down.x)),
            f64::from(f32::from(event.position.y - drag.down.y)),
        );
        // `if (!state.moved && Math.hypot(...) < 2) return` (`:299-309`): a
        // plain click must not write config.
        if !drag.moved && delta.0.hypot(delta.1) < 2. {
            return;
        }
        self.apply_canvas_drag(delta, event.modifiers.shift, canvas, window, cx);
    }

    fn apply_canvas_drag(
        &mut self,
        delta: (f64, f64),
        shift: bool,
        canvas: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(drag) = self.canvas_drag.as_mut() else {
            return;
        };
        drag.moved = true;
        let start = drag.start;
        let targets = drag.targets.clone();
        let element = drag.element;
        let resize = drag.resize.as_ref().map(|resize| {
            (
                resize.dir_x,
                resize.dir_y,
                resize.output_width,
                resize.output_height,
                resize.camera_manual,
                resize.camera_x.clone(),
                resize.camera_y.clone(),
                resize.max_width,
                resize.padding_scale,
            )
        });
        let size = (
            f64::from(f32::from(canvas.size.width)),
            f64::from(f32::from(canvas.size.height)),
        );
        if let Some((
            dir_x,
            dir_y,
            output_w,
            output_h,
            camera_manual,
            camera_x,
            camera_y,
            max_width,
            padding_scale,
        )) = resize
        {
            match element {
                CanvasSelection::Display => {
                    let (rect, padding, guides) = display_resize_rect(
                        start,
                        size,
                        delta,
                        (dir_x, dir_y),
                        &targets,
                        shift,
                        DisplayResize {
                            max_width,
                            padding_scale,
                        },
                    );
                    self.snap_guides = guides;
                    self.canvas_drag_rect = Some(rect);
                    if (self.project.background.padding - padding).abs() > 1e-6 {
                        self.project.background.padding = padding;
                        self.project_changed_live(cx);
                    }
                }
                CanvasSelection::Camera => {
                    let (rect, size_pct, guides) = camera_resize_rect(
                        start,
                        size,
                        delta,
                        (dir_x, dir_y),
                        &targets,
                        shift,
                        CameraResize {
                            output: (output_w, output_h),
                            manual: camera_manual,
                            position: (camera_x, camera_y),
                        },
                    );
                    self.snap_guides = guides;
                    self.canvas_drag_camera_rect = Some(rect);
                    if (f64::from(self.project.camera.size) - size_pct).abs() > 1e-6 {
                        self.project.camera.size = size_pct as f32;
                        self.project_changed_live(cx);
                    }
                }
                CanvasSelection::Mask(_) | CanvasSelection::Text(_) => {
                    let (rect, guides) =
                        overlay_resize_rect(start, size, delta, dir_x, dir_y, &targets, shift);
                    self.snap_guides = guides;
                    self.canvas_overlay_rect = Some(rect);
                    self.write_overlay_rect(element, rect, cx);
                }
            }
            let _ = (window, output_w, output_h);
            return;
        }
        let (center, guides) = match element {
            CanvasSelection::Display => display_drag_center(start, size, delta, &targets, shift),
            CanvasSelection::Camera => camera_drag_center(start, size, delta, &targets, shift),
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => {
                overlay_drag_center(start, size, delta, &targets, shift)
            }
        };
        self.snap_guides = guides;
        let optimistic = NormRect {
            x: center.x - start.w / 2.,
            y: center.y - start.h / 2.,
            ..start
        };
        match element {
            CanvasSelection::Display => {
                self.canvas_drag_rect = Some(optimistic);
                self.write_display_position(center, cx);
            }
            CanvasSelection::Camera => {
                self.canvas_drag_camera_rect = Some(optimistic);
                self.write_camera_position(center, cx);
            }
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => {
                self.canvas_overlay_rect = Some(optimistic);
                self.write_overlay_rect(element, optimistic, cx);
            }
        }
        let _ = window;
    }

    pub(crate) fn canvas_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.canvas_drag.take() else {
            return;
        };
        let config = self.project.clone();
        self.history.resume(&config);
        self.snap_guides.clear();
        self.canvas_overlay_rect = None;
        if drag.moved {
            self.schedule_save(window, cx);
            match drag.element {
                CanvasSelection::Display => tracing::info!(
                    position = ?self
                        .project
                        .background
                        .display_position
                        .map(|p| format!("{:.6},{:.6}", p.x, p.y)),
                    "canvas display drag"
                ),
                CanvasSelection::Camera => tracing::info!(
                    position = ?self
                        .project
                        .camera
                        .manual_position
                        .map(|p| format!("{:.6},{:.6}", p.x, p.y)),
                    "canvas camera drag"
                ),
                CanvasSelection::Mask(index) => {
                    tracing::info!(index, "canvas mask drag");
                }
                CanvasSelection::Text(index) => {
                    tracing::info!(index, "canvas text drag");
                }
            }
        }
        cx.notify();
    }

    /// One arrow press on a selected element (`:563-720`).
    pub(crate) fn canvas_nudge(
        &mut self,
        direction: (f64, f64),
        shift: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(selected) = self.canvas_selection else {
            return false;
        };
        if !self.canvas_overlay_visible() {
            return false;
        }
        let (Some(canvas), Some(rect)) = (self.canvas_bounds(), self.element_rect(selected)) else {
            return false;
        };
        if matches!(selected, CanvasSelection::Display)
            && (!self.show_display() || !self.display_draggable())
        {
            return false;
        }
        if matches!(selected, CanvasSelection::Camera) && !self.show_camera() {
            return false;
        }
        let size = (
            f64::from(f32::from(canvas.size.width)),
            f64::from(f32::from(canvas.size.height)),
        );
        let center = match selected {
            CanvasSelection::Display => display_nudge_center(rect, size, direction, shift),
            CanvasSelection::Camera => camera_nudge_center(rect, size, direction, shift),
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => {
                overlay_nudge_center(rect, direction, shift)
            }
        };
        let optimistic = NormRect {
            x: center.x - rect.w / 2.,
            y: center.y - rect.h / 2.,
            ..rect
        };
        match selected {
            CanvasSelection::Display => {
                self.canvas_drag_rect = Some(optimistic);
                self.write_display_position(center, cx);
            }
            CanvasSelection::Camera => {
                self.canvas_drag_camera_rect = Some(optimistic);
                self.write_camera_position(center, cx);
            }
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => {
                self.canvas_overlay_rect = Some(optimistic);
                self.write_overlay_rect(selected, optimistic, cx);
            }
        }
        let _ = window;
        true
    }

    fn write_display_position(&mut self, center: XY<f64>, cx: &mut Context<Self>) {
        if self.project.background.display_position == Some(center) {
            return;
        }
        self.project.background.display_position = Some(center);
        self.project_changed_live(cx);
    }

    fn write_camera_position(&mut self, center: XY<f64>, cx: &mut Context<Self>) {
        if self.project.camera.manual_position == Some(center) {
            return;
        }
        self.project.camera.manual_position = Some(center);
        self.project_changed_live(cx);
    }

    fn element_rect(&self, element: CanvasSelection) -> Option<NormRect> {
        match element {
            CanvasSelection::Display => self.display_rect(),
            CanvasSelection::Camera => self.camera_rect(),
            CanvasSelection::Mask(index) => {
                if self
                    .canvas_drag
                    .as_ref()
                    .is_some_and(|drag| drag.element == element)
                    && let Some(rect) = self.canvas_overlay_rect
                {
                    return Some(rect);
                }
                overlay_rect_from_center_size(
                    self.project.timeline.as_ref()?.mask_segments.get(index)?,
                )
            }
            CanvasSelection::Text(index) => {
                if self
                    .canvas_drag
                    .as_ref()
                    .is_some_and(|drag| drag.element == element)
                    && let Some(rect) = self.canvas_overlay_rect
                {
                    return Some(rect);
                }
                let segment = self.project.timeline.as_ref()?.text_segments.get(index)?;
                Some(NormRect {
                    x: segment.center.x - segment.size.x / 2.,
                    y: segment.center.y - segment.size.y / 2.,
                    w: segment.size.x,
                    h: segment.size.y,
                })
            }
        }
    }

    fn write_overlay_rect(
        &mut self,
        element: CanvasSelection,
        rect: NormRect,
        cx: &mut Context<Self>,
    ) {
        let center = XY {
            x: rect.x + rect.w / 2.,
            y: rect.y + rect.h / 2.,
        };
        let size = XY {
            x: rect.w.max(0.01),
            y: rect.h.max(0.01),
        };
        let Some(timeline) = self.project.timeline.as_mut() else {
            return;
        };
        match element {
            CanvasSelection::Mask(index) => {
                let Some(segment) = timeline.mask_segments.get_mut(index) else {
                    return;
                };
                segment.center = center;
                segment.size = size;
                segment.keyframes.position.clear();
                segment.keyframes.size.clear();
            }
            CanvasSelection::Text(index) => {
                let Some(segment) = timeline.text_segments.get_mut(index) else {
                    return;
                };
                segment.center = center;
                segment.size = size;
            }
            _ => return,
        }
        self.project_changed_live(cx);
    }

    fn set_canvas_hover(
        &mut self,
        element: CanvasSelection,
        hovered: bool,
        cx: &mut Context<Self>,
    ) {
        let next = if hovered {
            Some(element)
        } else if self.hovered_canvas == Some(element) {
            None
        } else {
            self.hovered_canvas
        };
        if self.hovered_canvas != next {
            self.hovered_canvas = next;
            cx.notify();
        }
    }

    fn select_active_zoom(&mut self, cx: &mut Context<Self>) {
        let Some(index) = self.active_zoom_index() else {
            return;
        };
        self.canvas_selection = None;
        self.set_selection(
            Some(crate::editor_edits::Selection::single(
                TrackKind::Zoom,
                index,
            )),
            cx,
        );
    }

    /// The boxes, labels, handles and smart guides. Positioned in the
    /// letterboxed frame's own space -- `CanvasElementsOverlay` is mounted
    /// inside `size()` (`Player.tsx:636`), not the player pane.
    pub(crate) fn render_canvas_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.canvas_overlay_visible() {
            return None;
        }
        let player = self.player_frame_rect.get()?;
        let (cw, ch) = (
            f32::from(player.frame.size.width),
            f32::from(player.frame.size.height),
        );
        let origin_x = player.frame.origin.x - player.container.origin.x;
        let origin_y = player.frame.origin.y - player.container.origin.y;

        let mut layer = div()
            .absolute()
            .left(origin_x)
            .top(origin_y)
            .w(player.frame.size.width)
            .h(player.frame.size.height)
            .overflow_hidden();

        if self.canvas_selection.is_some() {
            layer = layer.child(
                div()
                    .id("canvas-deselect")
                    .absolute()
                    .inset_0()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.canvas_selection = None;
                            cx.notify();
                            window.refresh();
                        }),
                    ),
            );
        }

        if self.show_display()
            && let Some(rect) = self.display_rect()
        {
            layer =
                layer.child(self.render_element_box(CanvasSelection::Display, rect, (cw, ch), cx));
        }
        if self.show_camera()
            && let Some(rect) = self.camera_rect()
        {
            layer =
                layer.child(self.render_element_box(CanvasSelection::Camera, rect, (cw, ch), cx));
        }
        let time = self.preview_or_playhead();
        if let Some(timeline) = self.project.timeline.as_ref() {
            for (index, segment) in timeline.mask_segments.iter().enumerate() {
                if !(time >= segment.start && time < segment.end) {
                    continue;
                }
                let element = CanvasSelection::Mask(index);
                if let Some(rect) = self.element_rect(element) {
                    layer = layer.child(self.render_element_box(element, rect, (cw, ch), cx));
                }
            }
            for (index, segment) in timeline.text_segments.iter().enumerate() {
                if !(time >= segment.start && time < segment.end && segment.enabled) {
                    continue;
                }
                let element = CanvasSelection::Text(index);
                if let Some(rect) = self.element_rect(element) {
                    layer = layer.child(self.render_element_box(element, rect, (cw, ch), cx));
                }
            }
        }

        for guide in &self.snap_guides {
            let color = gpui::rgb(0xFF3B6B);
            layer = layer.child(match guide.axis {
                GuideAxis::V => div()
                    .absolute()
                    .left(px(guide.pos as f32 * cw))
                    .top(px(guide.start as f32 * ch))
                    .w(px(1.))
                    .h(px((guide.end - guide.start) as f32 * ch))
                    .bg(color),
                GuideAxis::H => div()
                    .absolute()
                    .top(px(guide.pos as f32 * ch))
                    .left(px(guide.start as f32 * cw))
                    .h(px(1.))
                    .w(px((guide.end - guide.start) as f32 * cw))
                    .bg(color),
            });
        }

        Some(layer.into_any_element())
    }

    fn render_element_box(
        &self,
        element: CanvasSelection,
        rect: NormRect,
        canvas: (f32, f32),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let selected = self.canvas_selection == Some(element);
        let hovered = self.hovered_canvas == Some(element);
        let dragging = self
            .canvas_drag
            .as_ref()
            .is_some_and(|drag| drag.element == element);
        let show = selected || hovered || dragging;
        let (draggable, resizable, locked_message) = match element {
            CanvasSelection::Display => (
                self.display_draggable(),
                self.display_draggable(),
                (!self.display_draggable()).then_some("Screen is locked while a zoom is active"),
            ),
            CanvasSelection::Camera => (
                true,
                self.camera_resizable(),
                (!self.camera_resizable()).then_some("Camera size follows the zoom — drag to move"),
            ),
            CanvasSelection::Mask(_) | CanvasSelection::Text(_) => (true, true, None),
        };

        let left = rect.x as f32 * canvas.0;
        let top = rect.y as f32 * canvas.1;
        let width = rect.w as f32 * canvas.0;
        let height = rect.h as f32 * canvas.1;
        let id = element.element_id();
        let box_id = id.clone();

        let border = if selected {
            Hsla::from(theme.blue_9)
        } else if hovered || dragging {
            Hsla::from(theme.blue_6)
        } else {
            gpui::transparent_black()
        };

        let mut box_el = div()
            .id(box_id)
            .absolute()
            .left(px(left))
            .top(px(top))
            .w(px(width))
            .h(px(height))
            .cursor(if draggable {
                CursorStyle::OpenHand
            } else {
                CursorStyle::Arrow
            })
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(6.))
                    .border_2()
                    .border_color(border),
            )
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                this.set_canvas_hover(element, *hovered, cx);
            }))
            // Boxes overlap -- a mask sits on the display -- and gpui runs
            // every containing sibling's listener topmost-first, so without
            // the stop the display would hijack the drag one event later.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event, window, cx| {
                    cx.stop_propagation();
                    this.begin_canvas_move(element, event, window, cx);
                }),
            );

        if show {
            let label_left = (6. - left).max(6.);
            let label_top = if top >= 28. { -24. } else { (6. - top).max(6.) };
            box_el = box_el.child(
                div()
                    .absolute()
                    .left(px(label_left))
                    .top(px(label_top))
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .bg(Hsla::from(theme.blue_9))
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui::white())
                    .child(element.label()),
            );

            if let Some(message) = locked_message {
                box_el = box_el.child(
                    div()
                        .id(SharedString::from(format!("{id}-locked")))
                        .absolute()
                        .left(px(canvas.0 / 2. - left))
                        .top(px(10. - top))
                        .ml(px(-4.))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(6.))
                        .rounded(px(8.))
                        .bg(gpui::hsla(0., 0., 0., 0.8))
                        .text_size(px(12.))
                        .text_color(gpui::white())
                        .child(message)
                        .child(
                            div()
                                .id(SharedString::from(format!("{id}-edit-zoom")))
                                .px(px(8.))
                                .py(px(2.))
                                .rounded(px(6.))
                                .bg(gpui::hsla(0., 0., 1., 0.15))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Edit zoom")
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, event, _, cx| {
                                        cx.stop_propagation();
                                        let _ = event;
                                        this.select_active_zoom(cx);
                                    }),
                                ),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|_, _, _, cx| cx.stop_propagation()),
                        ),
                );
            }

            let flush = (
                left <= 6.,
                top <= 6.,
                left + width >= canvas.0 - 6.,
                top + height >= canvas.1 - 6.,
            );
            for (dir_x, dir_y, cursor) in [
                (-1_i8, -1_i8, CursorStyle::ResizeUpLeftDownRight),
                (1, -1, CursorStyle::ResizeUpRightDownLeft),
                (-1, 1, CursorStyle::ResizeUpRightDownLeft),
                (1, 1, CursorStyle::ResizeUpLeftDownRight),
            ] {
                let hx = if dir_x < 0 {
                    if flush.0 { 0. } else { -6. }
                } else if flush.2 {
                    width - 12.
                } else {
                    width - 6.
                };
                let hy = if dir_y < 0 {
                    if flush.1 { 0. } else { -6. }
                } else if flush.3 {
                    height - 12.
                } else {
                    height - 6.
                };
                let handle_id = format!(
                    "{id}-{}{}",
                    if dir_x < 0 { "w" } else { "e" },
                    if dir_y < 0 { "n" } else { "s" }
                );
                box_el = box_el.child(
                    div()
                        .id(SharedString::from(handle_id))
                        .absolute()
                        .left(px(hx))
                        .top(px(hy))
                        .size(px(12.))
                        .cursor(if resizable {
                            cursor
                        } else {
                            CursorStyle::OperationNotAllowed
                        })
                        .child(
                            div()
                                .size_full()
                                .rounded_full()
                                .border_1()
                                .border_color(gpui::white())
                                .bg(if resizable {
                                    Hsla::from(theme.blue_9)
                                } else {
                                    with_alpha(theme.gray_8, 0.6)
                                }),
                        )
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, event, window, cx| {
                                cx.stop_propagation();
                                this.begin_canvas_resize(element, dir_x, dir_y, event, window, cx);
                            }),
                        ),
                );
            }
        }

        box_el.into_any_element()
    }
}

fn with_alpha(color: gpui::Rgba, alpha: f32) -> Hsla {
    let mut hsla = Hsla::from(color);
    hsla.a = alpha;
    hsla
}

#[cfg(test)]
fn rect_contains(canvas: Bounds<Pixels>, rect: NormRect, position: Point<Pixels>) -> bool {
    let x = f64::from(f32::from(position.x - canvas.origin.x))
        / f64::from(f32::from(canvas.size.width)).max(1.);
    let y = f64::from(f32::from(position.y - canvas.origin.y))
        / f64::from(f32::from(canvas.size.height)).max(1.);
    x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

pub fn canvas_rect_cell() -> CanvasRect {
    Rc::new(Cell::new(None))
}

pub fn camera_drag_center(
    rect: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    targets: &SnapTargets,
    shift: bool,
) -> (XY<f64>, Vec<SnapGuide>) {
    let raw = NormRect {
        x: rect.x + delta.0 / canvas.0.max(1.),
        y: rect.y + delta.1 / canvas.1.max(1.),
        ..rect
    };
    let (dx, dy, guides) = if shift {
        (0., 0., Vec::new())
    } else {
        snap_moving_rect(
            raw,
            targets,
            SNAP_PX / canvas.0.max(1.),
            SNAP_PX / canvas.1.max(1.),
        )
    };
    let x = clamp(raw.x + dx, 0., (1. - raw.w).max(0.));
    let y = clamp(raw.y + dy, 0., (1. - raw.h).max(0.));
    (XY::new(x + raw.w / 2., y + raw.h / 2.), guides)
}

pub fn camera_nudge_center(
    rect: NormRect,
    canvas: (f64, f64),
    direction: (f64, f64),
    shift: bool,
) -> XY<f64> {
    let step = if shift { 10. } else { 1. };
    let x = clamp(
        rect.x + (direction.0 * step) / canvas.0.max(1.),
        0.,
        (1. - rect.w).max(0.),
    );
    let y = clamp(
        rect.y + (direction.1 * step) / canvas.1.max(1.),
        0.,
        (1. - rect.h).max(0.),
    );
    XY::new(x + rect.w / 2., y + rect.h / 2.)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapAxis {
    X,
    Y,
}

struct CornerSnap {
    axis: Option<SnapAxis>,
    x: f64,
    y: f64,
    guides: Vec<SnapGuide>,
}

fn snap_resize_corner(
    corner: (f64, f64),
    targets: &SnapTargets,
    threshold_x: f64,
    threshold_y: f64,
) -> CornerSnap {
    let sx = snap_axis(&[corner.0], &targets.v, threshold_x);
    let sy = snap_axis(&[corner.1], &targets.h, threshold_y);
    let use_x = sx.filter(|(dx, _)| sy.is_none_or(|(dy, _)| dx.abs() <= dy.abs()));
    if let Some((dx, line)) = use_x {
        return CornerSnap {
            axis: Some(SnapAxis::X),
            x: corner.0 + dx,
            y: corner.1,
            guides: vec![SnapGuide {
                axis: GuideAxis::V,
                pos: line.pos,
                start: 0.,
                end: 1.,
                kind: line.kind,
            }],
        };
    }
    if let Some((dy, line)) = sy {
        return CornerSnap {
            axis: Some(SnapAxis::Y),
            x: corner.0,
            y: corner.1 + dy,
            guides: vec![SnapGuide {
                axis: GuideAxis::H,
                pos: line.pos,
                start: 0.,
                end: 1.,
                kind: line.kind,
            }],
        };
    }
    CornerSnap {
        axis: None,
        x: corner.0,
        y: corner.1,
        guides: Vec::new(),
    }
}

fn resolve_scale(
    start: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    direction: (i8, i8),
    anchor: (f64, f64),
    targets: &SnapTargets,
    shift: bool,
) -> (f64, Vec<SnapGuide>) {
    let (dir_x, dir_y) = direction;
    let dx_n = delta.0 / canvas.0.max(1.);
    let dy_n = delta.1 / canvas.1.max(1.);
    let outward = dx_n * f64::from(dir_x) + dy_n * f64::from(dir_y);
    let mut scale = 1. + (2. * outward) / (start.w + start.h);
    let mut guides = Vec::new();
    if !shift {
        let corner0 = (
            start.x + if dir_x > 0 { start.w } else { 0. },
            start.y + if dir_y > 0 { start.h } else { 0. },
        );
        let raw_corner = (
            anchor.0 + (corner0.0 - anchor.0) * scale,
            anchor.1 + (corner0.1 - anchor.1) * scale,
        );
        let snap = snap_resize_corner(
            raw_corner,
            targets,
            SNAP_PX / canvas.0.max(1.),
            SNAP_PX / canvas.1.max(1.),
        );
        if snap.axis == Some(SnapAxis::X) && (corner0.0 - anchor.0).abs() > 1e-6 {
            scale = (snap.x - anchor.0) / (corner0.0 - anchor.0);
        } else if snap.axis == Some(SnapAxis::Y) && (corner0.1 - anchor.1).abs() > 1e-6 {
            scale = (snap.y - anchor.1) / (corner0.1 - anchor.1);
        }
        guides = snap.guides;
    }
    (scale.max(0.05), guides)
}

fn display_resize_scales(rect: NormRect, layout: &FrameLayout, has_aspect: bool) -> (f64, f64) {
    let width = f64::from(layout.output_size[0]).max(1.);
    let height = f64::from(layout.output_size[1]).max(1.);
    let content_aspect = (rect.w * width) / (rect.h * height).max(1e-6);
    let frame_aspect = width / height;
    let max_width = 1f64.min(content_aspect / frame_aspect);
    let k = if !has_aspect {
        1.
    } else if content_aspect <= frame_aspect {
        content_aspect.max(1.)
    } else {
        (1. / content_aspect).max(1.)
    };
    (max_width, (2. * k * 0.4) / 100.)
}

struct DisplayResize {
    max_width: f64,
    padding_scale: f64,
}

fn display_resize_rect(
    start: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    direction: (i8, i8),
    targets: &SnapTargets,
    shift: bool,
    resize: DisplayResize,
) -> (NormRect, f64, Vec<SnapGuide>) {
    let DisplayResize {
        max_width,
        padding_scale,
    } = resize;
    let anchor = (start.x + start.w / 2., start.y + start.h / 2.);
    let (scale, guides) = resolve_scale(start, canvas, delta, direction, anchor, targets, shift);
    let target_width = (start.w * scale).max(1e-6);
    let padding = clamp(
        (max_width / target_width - 1.) / padding_scale.max(1e-9),
        0.,
        100.,
    );
    let new_width = max_width / (1. + padding_scale * padding);
    let applied = new_width / start.w;
    let w = start.w * applied;
    let h = start.h * applied;
    (
        NormRect {
            x: clamp(anchor.0 - w / 2., 0., (1. - w).max(0.)),
            y: clamp(anchor.1 - h / 2., 0., (1. - h).max(0.)),
            w,
            h,
        },
        padding,
        guides,
    )
}

struct CameraResize {
    output: (f64, f64),
    manual: Option<XY<f64>>,
    position: (CameraXPosition, CameraYPosition),
}

fn camera_resize_rect(
    start: NormRect,
    canvas: (f64, f64),
    delta: (f64, f64),
    direction: (i8, i8),
    targets: &SnapTargets,
    shift: bool,
    resize: CameraResize,
) -> (NormRect, f64, Vec<SnapGuide>) {
    let CameraResize {
        output: (output_w, output_h),
        manual,
        position: (enum_x, enum_y),
    } = resize;
    let anchor = if manual.is_some() {
        (start.x + start.w / 2., start.y + start.h / 2.)
    } else {
        (
            match enum_x {
                CameraXPosition::Left => start.x,
                CameraXPosition::Center => start.x + start.w / 2.,
                CameraXPosition::Right => start.x + start.w,
            },
            match enum_y {
                CameraYPosition::Top => start.y,
                CameraYPosition::Bottom => start.y + start.h,
            },
        )
    };
    let (scale, guides) = resolve_scale(start, canvas, delta, direction, anchor, targets, shift);
    let min_axis = output_w.min(output_h);
    let cam_pad = 50. * (output_h / 1080.);
    let min_dim0 = (start.w * output_w).min(start.h * output_h);
    let size_pct = clamp(
        ((min_dim0 * scale - cam_pad) / min_axis.max(1e-9)) * 100.,
        20.,
        80.,
    );
    let applied = ((size_pct / 100.) * min_axis + cam_pad) / min_dim0.max(1e-9);
    let w = start.w * applied;
    let h = start.h * applied;
    (
        NormRect {
            x: clamp(
                anchor.0 - (anchor.0 - start.x) * applied,
                0.,
                (1. - w).max(0.),
            ),
            y: clamp(
                anchor.1 - (anchor.1 - start.y) * applied,
                0.,
                (1. - h).max(0.),
            ),
            w,
            h,
        },
        size_pct,
        guides,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(width: u32, height: u32, display: [f32; 4]) -> FrameLayout {
        FrameLayout {
            display,
            camera: None,
            output_size: [width, height],
        }
    }

    #[test]
    fn a_point_inside_the_normalised_rect_hits() {
        let canvas = Bounds {
            origin: gpui::point(px(100.), px(50.)),
            size: gpui::size(px(200.), px(100.)),
        };
        let rect = NormRect {
            x: 0.25,
            y: 0.25,
            w: 0.5,
            h: 0.5,
        };
        assert!(rect_contains(canvas, rect, gpui::point(px(200.), px(100.)),));
        assert!(!rect_contains(canvas, rect, gpui::point(px(110.), px(55.))));
    }

    #[test]
    fn a_layout_rect_normalises_against_the_output_frame() {
        // A 1920x1080 output with the display card inset 10% each side.
        let layout = layout(1920, 1080, [192., 108., 1728., 972.]);
        let rect = norm_rect(layout.display, &layout);
        assert!((rect.x - 0.1).abs() < 1e-9);
        assert!((rect.w - 0.8).abs() < 1e-9);
        assert!((rect.h - 0.8).abs() < 1e-9);
    }

    #[test]
    fn a_drag_maps_canvas_pixels_onto_normalised_centre() {
        let rect = NormRect {
            x: 0.1,
            y: 0.1,
            w: 0.8,
            h: 0.8,
        };
        // No snap targets at all, so the mapping is bare arithmetic.
        let targets = SnapTargets::default();
        // A 700x394 canvas, dragged 70px right and 39.4px down = exactly 0.1
        // of the frame each way. Centre 0.5, 0.5 -> 0.6, 0.6.
        let (center, guides) = display_drag_center(rect, (700., 394.), (70., 39.4), &targets, true);
        assert!((center.x - 0.6).abs() < 1e-9);
        assert!((center.y - 0.6).abs() < 1e-9);
        assert!(guides.is_empty());
    }

    #[test]
    fn the_display_clamp_lets_half_the_card_hang_out() {
        let rect = NormRect {
            x: 0.1,
            y: 0.1,
            w: 0.8,
            h: 0.8,
        };
        let targets = SnapTargets::default();
        // Drag a whole canvas width to the right: x wants 1.1, clamps to
        // 1 - 0.4 = 0.6, so the centre lands at 1.0 -- the card's left edge on
        // the frame's right edge.
        let (center, _) = display_drag_center(rect, (700., 394.), (700., 0.), &targets, true);
        assert!((center.x - 1.0).abs() < 1e-9);
        // ...and the other way, centre 0.
        let (center, _) = display_drag_center(rect, (700., 394.), (-700., 0.), &targets, true);
        assert!((center.x - 0.0).abs() < 1e-9);
    }

    /// The inverted-range arm of `clamp` is what the **camera**'s
    /// `clamp(x, 0, max(0, 1 - w))` hits when the element is wider than the
    /// frame. The display's own bounds are `[-w/2, 1 - w/2]`, which are a
    /// fixed span of 1 and therefore can never cross -- so the display clamp
    /// always pins rather than centres, however wide the card is.
    #[test]
    fn the_inverted_clamp_arm_centres_and_the_display_bounds_never_reach_it() {
        assert_eq!(clamp(5., 0.6, 0.2), 0.4);
        let rect = NormRect {
            x: -0.2,
            y: 0.1,
            w: 1.4,
            h: 0.8,
        };
        assert!(-rect.w / 2. <= 1. - rect.w / 2.);
        let targets = SnapTargets::default();
        let (center, _) = display_drag_center(rect, (700., 394.), (500., 0.), &targets, true);
        // 0.514 clamps to max = 1 - 0.7 = 0.3, so the centre lands at 1.0 --
        // the card's left edge on the frame's right edge, exactly as for a
        // narrow one.
        assert!((center.x - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_drag_snaps_to_the_frame_centre_and_reports_a_guide() {
        let rect = NormRect {
            x: 0.095,
            y: 0.1,
            w: 0.8,
            h: 0.8,
        };
        let targets = build_snap_targets(&[], None);
        // The rect's centre is at 0.495; the frame centre line is 0.005 away
        // and the threshold is 7/700 = 0.01, so it is inside.
        let (center, guides) = display_drag_center(rect, (700., 700.), (0., 0.), &targets, false);
        assert!((center.x - 0.5).abs() < 1e-9);
        // Two guides: the y centre was already exactly on the frame's, so it
        // snaps with a zero delta and draws its line too.
        assert_eq!(guides.len(), 2);
        let vertical = guides.iter().find(|g| g.axis == GuideAxis::V).unwrap();
        assert_eq!(vertical.kind, SnapLineKind::FrameCenter);
        // A full-frame line's guide spans the whole frame.
        assert_eq!((vertical.start, vertical.end), (0., 1.));
        assert!((center.y - 0.5).abs() < 1e-9);

        // Shift suppresses it entirely.
        let (center, guides) = display_drag_center(rect, (700., 700.), (0., 0.), &targets, true);
        assert!((center.x - 0.495).abs() < 1e-9);
        assert!(guides.is_empty());
    }

    #[test]
    fn centre_lines_win_ties_against_edges() {
        let lines = vec![
            SnapLine {
                pos: 0.5,
                kind: SnapLineKind::FrameCenter,
                reference: None,
            },
            SnapLine {
                pos: 0.52,
                kind: SnapLineKind::ElementEdge,
                reference: None,
            },
        ];
        // An anchor at 0.51 is equidistant. The centre's 0.15 bias wins.
        let (delta, line) = snap_axis(&[0.51], &lines, 0.05).unwrap();
        assert_eq!(line.kind, SnapLineKind::FrameCenter);
        assert!((delta - (-0.01)).abs() < 1e-9);
    }

    #[test]
    fn the_classic_camera_margin_is_50px_at_1080p() {
        let hd = layout(1920, 1080, [0., 0., 1920., 1080.]);
        let (mx, my) = classic_margin(&hd);
        assert!((mx - 50. / 1920.).abs() < 1e-9);
        assert!((my - 50. / 1080.).abs() < 1e-9);
        // It scales with the output height, so a 4K frame gets a 100px inset.
        let uhd = layout(3840, 2160, [0., 0., 3840., 2160.]);
        let (mx, _) = classic_margin(&uhd);
        assert!((mx - 100. / 3840.).abs() < 1e-9);
    }

    #[test]
    fn the_camera_clamp_keeps_the_card_fully_visible() {
        let rect = NormRect {
            x: 0.6,
            y: 0.6,
            w: 0.3,
            h: 0.3,
        };
        let targets = SnapTargets::default();
        let (center, _) = camera_drag_center(rect, (700., 394.), (700., 394.), &targets, true);
        assert!((center.x - 0.85).abs() < 1e-9);
        assert!((center.y - 0.85).abs() < 1e-9);
    }

    #[test]
    fn a_nudge_moves_one_canvas_pixel_and_ten_with_shift() {
        let rect = NormRect {
            x: 0.1,
            y: 0.1,
            w: 0.8,
            h: 0.8,
        };
        let center = display_nudge_center(rect, (700., 394.), (1., 0.), false);
        assert!((center.x - (0.5 + 1. / 700.)).abs() < 1e-9);
        let center = display_nudge_center(rect, (700., 394.), (0., 1.), true);
        assert!((center.y - (0.5 + 10. / 394.)).abs() < 1e-9);
    }

    #[test]
    fn an_element_edge_guide_spans_both_rects() {
        let other = NormRect {
            x: 0.2,
            y: 0.0,
            w: 0.2,
            h: 0.2,
        };
        let targets = build_snap_targets(&[other], None);
        // Left edges 0.001 apart, and every other anchor pair well outside the
        // threshold -- so the winning line is the other rect's own left edge
        // rather than a frame line.
        let moving = NormRect {
            x: 0.201,
            y: 0.6,
            w: 0.24,
            h: 0.1,
        };
        let (dx, dy, guides) = snap_moving_rect(moving, &targets, 0.01, 0.01);
        assert!((dx - (-0.001)).abs() < 1e-9);
        assert_eq!(dy, 0.);
        let guide = guides.iter().find(|g| g.axis == GuideAxis::V).unwrap();
        assert_eq!(guide.kind, SnapLineKind::ElementEdge);
        // From the other rect's top (0.0) to the moving rect's bottom (0.7).
        assert!((guide.start - 0.0).abs() < 1e-9);
        assert!((guide.end - 0.7).abs() < 1e-9);
    }
}
