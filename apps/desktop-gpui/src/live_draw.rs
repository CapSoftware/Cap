//! Drawing on screen while recording.
//!
//! Two transparent panels cover the recorded display. The canvas paints the
//! strokes and stays in the capture, so they land in the recording, and it
//! never takes the mouse. The input panel sits just above it only while
//! drawing is on: it takes the pointer, is left out of every capture, and
//! closes the moment drawing stops, so clicks reach the apps underneath
//! again. Nothing is open while there is nothing to draw or show. The tools
//! live in the recording bar, which is already out of the capture.
//!
//! macOS only for now: a window recording there captures the one window on
//! its own, without our canvas, so drawing is offered for display and area
//! recordings. Windows and Linux have no proven click-through and capture
//! inclusion for these panels yet, so the feature is not offered there.

use std::time::{Duration, Instant};

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, Context, Entity, Global, Hsla, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Path, PathBuilder, PathStyle,
    Pixels, Render, Styled as _, Task, Window, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, canvas, div, point, px, size,
};
use lyon_tessellation::{LineCap, LineJoin, StrokeOptions};

use crate::{
    platform,
    session::{Phase, RecordingSession},
};

pub const SUPPORTED: bool = cfg!(target_os = "macos");

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tool {
    #[default]
    Pen,
    Highlighter,
    Arrow,
    Rectangle,
}

impl Tool {
    pub const ALL: [Self; 4] = [Self::Pen, Self::Highlighter, Self::Arrow, Self::Rectangle];

    pub fn icon(self) -> &'static str {
        match self {
            Self::Pen => "icons/pencil.svg",
            Self::Highlighter => "icons/highlighter.svg",
            Self::Arrow => "icons/arrow-up-right.svg",
            Self::Rectangle => "icons/square.svg",
        }
    }

    fn width(self) -> f32 {
        match self {
            Self::Highlighter => 18.,
            Self::Pen | Self::Arrow | Self::Rectangle => 4.,
        }
    }

    fn opacity(self) -> f32 {
        match self {
            Self::Highlighter => 0.4,
            Self::Pen | Self::Arrow | Self::Rectangle => 1.,
        }
    }

    fn freehand(self) -> bool {
        matches!(self, Self::Pen | Self::Highlighter)
    }
}

/// The screenshot annotator's red first, then the editor palette's yellow,
/// green, blue and white.
pub const COLORS: [u32; 5] = [0xF05656, 0xFFD700, 0x32CD32, 0x4785FF, 0xFFFFFF];

/// Freehand points closer than this to the last one are skipped.
const MIN_STEP: f32 = 1.5;
/// An arrow or rectangle smaller than this on either axis is a stray click.
const MIN_SHAPE: f32 = 2.;
const HOLD: Duration = Duration::from_secs(3);
const FADE: Duration = Duration::from_millis(600);
const MAX_STROKES: usize = 200;
/// How far, in points, a tessellated curve may stray from the true one. gpui
/// copies every vertex of every visible stroke each frame, and lyon's default
/// (0.1) puts several times more vertices into each round cap and join.
const STROKE_TOLERANCE: f32 = 0.25;
/// Points closer than this to the line through their neighbours are dropped
/// before a run is tessellated: invisible at these widths, and most of a
/// freehand stroke's points.
const SIMPLIFY_TOLERANCE: f32 = 0.35;
/// gpui tessellates a path into 16-bit indices, so long freehand strokes are
/// painted in runs of this many points.
const CHUNK: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f32,
    pub y: f32,
}

impl Pt {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn distance(self, other: Self) -> f32 {
        (other.x - self.x).hypot(other.y - self.y)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    Line(Vec<Pt>),
    Arrow { from: Pt, to: Pt },
    Rect { from: Pt, to: Pt },
}

/// `to` turned to the nearest multiple of 45 degrees around `from`, at the
/// same distance.
pub fn snap_to_45(from: Pt, to: Pt) -> Pt {
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let length = dx.hypot(dy);
    if length == 0. {
        return to;
    }
    let step = std::f32::consts::FRAC_PI_4;
    let angle = (dy.atan2(dx) / step).round() * step;
    Pt::new(from.x + length * angle.cos(), from.y + length * angle.sin())
}

/// The corner opposite `from` of the square that the drag to `to` covers,
/// sized by its longer side.
pub fn square_corner(from: Pt, to: Pt) -> Pt {
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let side = dx.abs().max(dy.abs());
    Pt::new(from.x + side.copysign(dx), from.y + side.copysign(dy))
}

/// What a drag draws. `points` starts where the pointer went down; Shift
/// (`straight`) makes the pen and highlighter a straight line, snaps arrows
/// to 45 degrees and makes rectangles square.
pub fn shape(tool: Tool, points: &[Pt], current: Pt, straight: bool) -> Option<Shape> {
    let start = *points.first()?;
    match tool {
        Tool::Pen | Tool::Highlighter => {
            if straight {
                return Some(Shape::Line(vec![start, current]));
            }
            let mut line = points.to_vec();
            if line.last() != Some(&current) {
                line.push(current);
            }
            Some(Shape::Line(line))
        }
        Tool::Arrow => {
            let to = if straight {
                snap_to_45(start, current)
            } else {
                current
            };
            (start.distance(to) >= MIN_SHAPE).then_some(Shape::Arrow { from: start, to })
        }
        Tool::Rectangle => {
            let to = if straight {
                square_corner(start, current)
            } else {
                current
            };
            ((to.x - start.x).abs() >= MIN_SHAPE && (to.y - start.y).abs() >= MIN_SHAPE)
                .then_some(Shape::Rect { from: start, to })
        }
    }
}

/// How visible a fading stroke is this long after it was drawn: fully for a
/// few seconds, then easing out. `None` once it is gone.
pub fn opacity_after(elapsed: Duration) -> Option<f32> {
    if elapsed < HOLD {
        return Some(1.);
    }
    let fading = elapsed.saturating_sub(HOLD);
    if fading >= FADE {
        return None;
    }
    let t = fading.as_secs_f32() / FADE.as_secs_f32();
    Some(1. - t * t * (3. - 2. * t))
}

fn append_point(points: &mut Vec<Pt>, at: Pt) {
    if points
        .last()
        .is_none_or(|last| last.distance(at) >= MIN_STEP)
    {
        points.push(at);
    }
}

/// Seals every full run of [`CHUNK`] points from `*from` on. Each run ends
/// on a seam added halfway along its last segment, where the next run
/// starts. Both ends there are butt caps square to the same direction, so a
/// translucent highlighter is painted once across the seam, with no gap.
fn seal_runs(points: &mut Vec<Pt>, from: &mut usize, width: f32, sealed: &mut Vec<Path<Pixels>>) {
    while points.len() - *from >= CHUNK {
        let seam = *from + CHUNK - 1;
        let (before, after) = (points[seam - 1], points[seam]);
        points.insert(
            seam,
            Pt::new((before.x + after.x) / 2., (before.y + after.y) / 2.),
        );
        sealed.extend(line_path(
            &points[*from..=seam],
            width,
            start_cap(*from),
            LineCap::Butt,
        ));
        *from = seam;
    }
}

/// The run after the sealed ones, round at the stroke's end.
fn last_run(points: &[Pt], from: usize, width: f32) -> Option<Path<Pixels>> {
    line_path(&points[from..], width, start_cap(from), LineCap::Round)
}

fn start_cap(from: usize) -> LineCap {
    if from == 0 {
        LineCap::Round
    } else {
        LineCap::Butt
    }
}

/// A finished stroke, tessellated once when it is committed.
struct Stroke {
    tool: Tool,
    color: u32,
    paths: Vec<Path<Pixels>>,
    done: Instant,
    fades: bool,
}

/// The stroke under the pointer. A freehand stroke seals each full run of
/// [`CHUNK`] points into a path as it grows, so a frame only tessellates
/// the run still being drawn.
struct Draft {
    tool: Tool,
    color: u32,
    points: Vec<Pt>,
    current: Pt,
    straight: bool,
    sealed: Vec<Path<Pixels>>,
    sealed_from: usize,
}

impl Draft {
    fn new(tool: Tool, color: u32, at: Pt, straight: bool) -> Self {
        Self {
            tool,
            color,
            points: vec![at],
            current: at,
            straight,
            sealed: Vec::new(),
            sealed_from: 0,
        }
    }

    fn seal(&mut self) {
        seal_runs(
            &mut self.points,
            &mut self.sealed_from,
            self.tool.width(),
            &mut self.sealed,
        );
    }

    /// The freehand run after the sealed ones, ending at the pointer.
    fn tail(&self) -> Option<Path<Pixels>> {
        let mut run = self.points[self.sealed_from..].to_vec();
        if run.last() != Some(&self.current) {
            run.push(self.current);
        }
        line_path(
            &run,
            self.tool.width(),
            start_cap(self.sealed_from),
            LineCap::Round,
        )
    }

    fn uses_sealed(&self) -> bool {
        self.tool.freehand() && !self.straight
    }

    fn into_paths(self) -> Option<Vec<Path<Pixels>>> {
        if self.uses_sealed() {
            let tail = self.tail();
            let mut paths = self.sealed;
            paths.extend(tail);
            return Some(paths);
        }
        let shape = shape(self.tool, &self.points, self.current, self.straight)?;
        Some(build_paths(&shape, self.tool))
    }

    fn paint(&self, window: &mut Window) {
        let color = ink_color(self.tool, self.color, 1.);
        if self.uses_sealed() {
            for path in &self.sealed {
                window.paint_path(path.clone(), color);
            }
            if let Some(path) = self.tail() {
                window.paint_path(path, color);
            }
        } else if let Some(shape) = shape(self.tool, &self.points, self.current, self.straight) {
            for path in build_paths(&shape, self.tool) {
                window.paint_path(path, color);
            }
        }
    }
}

pub struct Ink {
    strokes: Vec<Stroke>,
    draft: Option<Draft>,
    fading: bool,
    _fade: Task<()>,
}

impl Ink {
    fn new() -> Self {
        Self {
            strokes: Vec::new(),
            draft: None,
            fading: false,
            _fade: Task::ready(()),
        }
    }

    fn is_empty(&self) -> bool {
        self.strokes.is_empty() && self.draft.is_none()
    }

    fn begin(&mut self, tool: Tool, color: u32, at: Pt, straight: bool, cx: &mut Context<Self>) {
        self.draft = Some(Draft::new(tool, color, at, straight));
        cx.notify();
    }

    fn extend(&mut self, at: Pt, straight: bool, cx: &mut Context<Self>) {
        let Some(draft) = &mut self.draft else {
            return;
        };
        if draft.current == at && draft.straight == straight {
            return;
        }
        draft.current = at;
        draft.straight = straight;
        if draft.tool.freehand() {
            append_point(&mut draft.points, at);
            draft.seal();
        }
        cx.notify();
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.draft.take() else {
            return;
        };
        let (tool, color) = (draft.tool, draft.color);
        if let Some(paths) = draft.into_paths().filter(|paths| !paths.is_empty()) {
            if self.strokes.len() >= MAX_STROKES {
                self.strokes.remove(0);
            }
            self.strokes.push(Stroke {
                tool,
                color,
                paths,
                done: Instant::now(),
                fades: !crate::store::keep_drawings(),
            });
        }
        self.ensure_fade(cx);
        cx.notify();
    }

    fn undo(&mut self, cx: &mut Context<Self>) {
        if self.draft.take().is_none() {
            self.strokes.pop();
        }
        cx.notify();
    }

    fn clear(&mut self, cx: &mut Context<Self>) {
        self.strokes.clear();
        self.draft = None;
        cx.notify();
    }

    fn prune(&mut self, now: Instant) {
        self.strokes.retain(|stroke| {
            !stroke.fades || opacity_after(now.saturating_duration_since(stroke.done)).is_some()
        });
    }

    /// When the next stroke starts or finishes fading.
    fn next_fade_event(&self, now: Instant) -> Option<Instant> {
        self.strokes
            .iter()
            .filter(|stroke| stroke.fades)
            .map(|stroke| {
                let shown = stroke.done + HOLD;
                if shown > now { shown } else { shown + FADE }
            })
            .min()
    }

    /// One timer task sleeps until the next stroke starts or finishes fading.
    /// The frames in between come from the canvas while something is fading,
    /// so nothing wakes while every stroke is steady.
    fn ensure_fade(&mut self, cx: &mut Context<Self>) {
        if self.fading || self.next_fade_event(Instant::now()).is_none() {
            return;
        }
        self.fading = true;
        self._fade = cx.spawn(async move |this, cx| {
            loop {
                let Ok(next) = this.update(cx, |ink, _| {
                    let next = ink.next_fade_event(Instant::now());
                    if next.is_none() {
                        ink.fading = false;
                    }
                    next
                }) else {
                    return;
                };
                let Some(next) = next else {
                    return;
                };
                cx.background_executor()
                    .timer(next.saturating_duration_since(Instant::now()))
                    .await;
                let Ok(empty) = this.update(cx, |ink, cx| {
                    ink.prune(Instant::now());
                    cx.notify();
                    ink.strokes.is_empty()
                }) else {
                    return;
                };
                if empty {
                    cx.update(ink_changed);
                }
            }
        });
    }
}

fn to_point(at: Pt) -> gpui::Point<gpui::Pixels> {
    point(px(at.x), px(at.y))
}

fn stroke_builder(width: f32) -> PathBuilder {
    stroke_builder_capped(width, LineCap::Round, LineCap::Round)
}

fn stroke_builder_capped(width: f32, start: LineCap, end: LineCap) -> PathBuilder {
    PathBuilder::stroke(px(width)).with_style(PathStyle::Stroke(
        StrokeOptions::default()
            .with_line_width(width)
            .with_start_cap(start)
            .with_end_cap(end)
            .with_line_join(LineJoin::Round)
            .with_tolerance(STROKE_TOLERANCE),
    ))
}

fn ink_color(tool: Tool, color: u32, opacity: f32) -> Hsla {
    let mut color: Hsla = gpui::rgb(color).into();
    color.a = tool.opacity() * opacity;
    color
}

/// Measured to the segment, not the infinite line through it: a stroke that
/// doubles back along itself would otherwise lose everything past its end.
fn distance_to_segment(p: Pt, a: Pt, b: Pt) -> f32 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0. {
        return a.distance(p);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / length_squared).clamp(0., 1.);
    Pt::new(a.x + dx * t, a.y + dy * t).distance(p)
}

/// Ramer-Douglas-Peucker: the points needed to keep the line within
/// `tolerance` of the original. The ends always stay.
pub fn simplify(points: &[Pt], tolerance: f32) -> Vec<Pt> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut spans = vec![(0, points.len() - 1)];
    while let Some((start, end)) = spans.pop() {
        let (a, b) = (points[start], points[end]);
        let mut farthest = (0., start);
        for (index, p) in points.iter().enumerate().take(end).skip(start + 1) {
            let distance = distance_to_segment(*p, a, b);
            if distance > farthest.0 {
                farthest = (distance, index);
            }
        }
        if farthest.0 > tolerance {
            keep[farthest.1] = true;
            spans.push((start, farthest.1));
            spans.push((farthest.1, end));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(p, kept)| kept.then_some(*p))
        .collect()
}

/// One run of a line. A single point is a dot.
fn line_path(points: &[Pt], width: f32, start: LineCap, end: LineCap) -> Option<Path<Pixels>> {
    let points = simplify(points, SIMPLIFY_TOLERANCE);
    let first = *points.first()?;
    let mut builder = stroke_builder_capped(width, start, end);
    builder.move_to(to_point(first));
    if points.len() == 1 {
        builder.line_to(to_point(Pt::new(first.x + 0.01, first.y)));
    }
    for &at in &points[1..] {
        builder.line_to(to_point(at));
    }
    builder.build().ok()
}

fn build_paths(shape: &Shape, tool: Tool) -> Vec<Path<Pixels>> {
    let width = tool.width();
    match shape {
        Shape::Line(points) => {
            let mut points = points.clone();
            let (mut from, mut paths) = (0, Vec::new());
            seal_runs(&mut points, &mut from, width, &mut paths);
            paths.extend(last_run(&points, from, width));
            paths
        }
        Shape::Arrow { from, to } => {
            let angle = f64::from((to.y - from.y).atan2(to.x - from.x));
            let head = crate::screenshot_annotations::arrow_head_points(
                f64::from(to.x),
                f64::from(to.y),
                angle,
                f64::from(width),
            );
            let corner = |(x, y): (f64, f64)| point(px(x as f32), px(y as f32));
            let mut shaft = stroke_builder(width);
            shaft.move_to(to_point(*from));
            shaft.line_to(corner(head.base));
            let mut tip = PathBuilder::fill();
            tip.move_to(corner(head.points[0]));
            tip.line_to(corner(head.points[1]));
            tip.line_to(corner(head.points[2]));
            tip.close();
            [shaft.build().ok(), tip.build().ok()]
                .into_iter()
                .flatten()
                .collect()
        }
        Shape::Rect { from, to } => {
            let mut builder = stroke_builder(width);
            builder.move_to(to_point(*from));
            builder.line_to(to_point(Pt::new(to.x, from.y)));
            builder.line_to(to_point(*to));
            builder.line_to(to_point(Pt::new(from.x, to.y)));
            builder.close();
            builder.build().ok().into_iter().collect()
        }
    }
}

fn paint_ink(ink: &Ink, window: &mut Window) {
    let now = Instant::now();
    let mut animating = false;
    for stroke in &ink.strokes {
        let opacity = if stroke.fades {
            match opacity_after(now.saturating_duration_since(stroke.done)) {
                Some(opacity) => {
                    animating |= opacity < 1.;
                    opacity
                }
                None => continue,
            }
        } else {
            1.
        };
        let color = ink_color(stroke.tool, stroke.color, opacity);
        for path in &stroke.paths {
            window.paint_path(path.clone(), color);
        }
    }
    if let Some(draft) = &ink.draft {
        draft.paint(window);
    }
    if animating {
        window.request_animation_frame();
    }
}

/// What the recording bar shows and the hotkey toggles.
#[derive(Default)]
pub struct DrawMode {
    pub drawing: bool,
    pub tool: Tool,
    pub color: usize,
    pub has_ink: bool,
}

struct InkCanvas {
    ink: Entity<Ink>,
}

impl Render for InkCanvas {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let ink = self.ink.clone();
        canvas(
            |_, _, _| {},
            move |_, _, window: &mut Window, cx: &mut App| paint_ink(ink.read(cx), window),
        )
        .size_full()
    }
}

struct DrawInput {
    ink: Entity<Ink>,
    mode: Entity<DrawMode>,
}

impl DrawInput {
    fn finish(&mut self, at: Pt, straight: bool, cx: &mut Context<Self>) {
        self.ink.update(cx, |ink, cx| {
            ink.extend(at, straight, cx);
            ink.commit(cx);
        });
        ink_changed(cx);
    }
}

fn pt(position: gpui::Point<gpui::Pixels>) -> Pt {
    Pt::new(f32::from(position.x), f32::from(position.y))
}

impl Render for DrawInput {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("live-draw-input")
            .size_full()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    platform::set_draw_cursor();
                    let (tool, color) = {
                        let mode = this.mode.read(cx);
                        (mode.tool, COLORS[mode.color % COLORS.len()])
                    };
                    let at = pt(event.position);
                    let straight = event.modifiers.shift;
                    this.ink
                        .update(cx, |ink, cx| ink.begin(tool, color, at, straight, cx));
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                platform::set_draw_cursor();
                let at = pt(event.position);
                let straight = event.modifiers.shift;
                if event.pressed_button == Some(MouseButton::Left) {
                    this.ink.update(cx, |ink, cx| ink.extend(at, straight, cx));
                } else if this.ink.read(cx).draft.is_some() {
                    this.finish(at, straight, cx);
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event: &MouseUpEvent, _, cx| {
                    this.finish(pt(event.position), event.modifiers.shift, cx);
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, event: &MouseUpEvent, _, cx| {
                    this.finish(pt(event.position), event.modifiers.shift, cx);
                }),
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct LiveDraw {
    mode: Entity<DrawMode>,
    ink: Entity<Ink>,
    canvas: Option<(WindowHandle<InkCanvas>, Frame)>,
    input: Option<WindowHandle<DrawInput>>,
}

impl Global for LiveDraw {}

fn global(cx: &mut App) -> &mut LiveDraw {
    if !cx.has_global::<LiveDraw>() {
        let mode = cx.new(|_| DrawMode::default());
        let ink = cx.new(|_| Ink::new());
        cx.set_global(LiveDraw {
            mode,
            ink,
            canvas: None,
            input: None,
        });
    }
    cx.global_mut::<LiveDraw>()
}

pub fn mode(cx: &mut App) -> Entity<DrawMode> {
    global(cx).mode.clone()
}

/// Whether the recording bar shows the draw button at all.
pub fn offered(session: &RecordingSession) -> bool {
    SUPPORTED
        && session.capture_target().is_some_and(|target| {
            !matches!(
                target,
                ScreenCaptureTarget::CameraOnly | ScreenCaptureTarget::AudioOnly
            )
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    NotRecording,
    WindowRecording,
}

pub fn availability(session: &RecordingSession) -> Result<(), Unavailable> {
    if !SUPPORTED || !matches!(session.phase, Phase::Recording { .. }) {
        return Err(Unavailable::NotRecording);
    }
    match session.capture_target() {
        Some(ScreenCaptureTarget::Display { .. } | ScreenCaptureTarget::Area { .. }) => Ok(()),
        Some(ScreenCaptureTarget::Window { .. }) => Err(Unavailable::WindowRecording),
        Some(ScreenCaptureTarget::CameraOnly | ScreenCaptureTarget::AudioOnly) | None => {
            Err(Unavailable::NotRecording)
        }
    }
}

pub fn is_drawing(cx: &App) -> bool {
    cx.try_global::<LiveDraw>()
        .is_some_and(|draw| draw.mode.read(cx).drawing)
}

pub fn toggle(cx: &mut App) {
    if is_drawing(cx) {
        stop(cx);
    } else {
        start(cx);
    }
}

fn recorded_display_frame(cx: &App) -> Option<Frame> {
    let session = RecordingSession::global(cx);
    let session = session.read(cx);
    availability(session).ok()?;
    let bounds = session
        .capture_target()?
        .display()?
        .raw_handle()
        .logical_bounds()?;
    Some(Frame {
        x: bounds.position().x(),
        y: bounds.position().y(),
        width: bounds.size().width(),
        height: bounds.size().height(),
    })
}

pub fn start(cx: &mut App) {
    if is_drawing(cx) {
        return;
    }
    let Some(frame) = recorded_display_frame(cx) else {
        return;
    };
    let draw = global(cx);
    let (ink, mode) = (draw.ink.clone(), draw.mode.clone());
    if draw.canvas.is_some_and(|(_, open)| open != frame) {
        close_canvas(cx);
    }
    if cx.global::<LiveDraw>().canvas.is_none() {
        let canvas_ink = ink.clone();
        let Some(canvas) = open_panel(
            frame,
            platform::recording_area_level() - 1,
            false,
            move |_, cx| {
                cx.observe(&canvas_ink, |_, _, cx| cx.notify()).detach();
                InkCanvas { ink: canvas_ink }
            },
            cx,
        ) else {
            return;
        };
        global(cx).canvas = Some((canvas, frame));
    }
    let input_mode = mode.clone();
    let Some(input) = open_panel(
        frame,
        platform::recording_area_level(),
        true,
        move |_, _| DrawInput {
            ink,
            mode: input_mode,
        },
        cx,
    ) else {
        ink_changed(cx);
        return;
    };
    global(cx).input = Some(input);
    platform::register_escape_hotkey();
    platform::set_draw_cursor();
    mode.update(cx, |mode, cx| {
        mode.drawing = true;
        cx.notify();
    });
    tracing::info!("drawing on screen started");
}

pub fn stop(cx: &mut App) {
    if !cx.has_global::<LiveDraw>() {
        return;
    }
    let draw = global(cx);
    let input = draw.input.take();
    let (ink, mode) = (draw.ink.clone(), draw.mode.clone());
    let was_drawing = mode.read(cx).drawing;
    if let Some(input) = input {
        input.update(cx, |_, window, _| window.remove_window()).ok();
    }
    ink.update(cx, |ink, cx| ink.commit(cx));
    mode.update(cx, |mode, cx| {
        if mode.drawing {
            mode.drawing = false;
            cx.notify();
        }
    });
    if was_drawing {
        if crate::target_overlay::TargetSelect::global(cx)
            .read(cx)
            .mode
            .is_none()
        {
            platform::unregister_escape_hotkey();
        }
        platform::reset_cursor();
        tracing::info!("drawing on screen stopped");
    }
    ink_changed(cx);
}

/// The recording is over: drawing stops and every stroke goes with it.
pub fn end(cx: &mut App) {
    if !cx.has_global::<LiveDraw>() {
        return;
    }
    stop(cx);
    let ink = global(cx).ink.clone();
    ink.update(cx, |ink, cx| ink.clear(cx));
    ink_changed(cx);
}

/// The global Escape, while drawing: back to clicking through.
pub fn escape(cx: &mut App) -> bool {
    if !is_drawing(cx) {
        return false;
    }
    stop(cx);
    true
}

pub fn set_tool(tool: Tool, cx: &mut App) {
    let mode = mode(cx);
    mode.update(cx, |mode, cx| {
        mode.tool = tool;
        cx.notify();
    });
}

pub fn set_color(index: usize, cx: &mut App) {
    let mode = mode(cx);
    mode.update(cx, |mode, cx| {
        mode.color = index % COLORS.len();
        cx.notify();
    });
}

pub fn undo(cx: &mut App) {
    let ink = global(cx).ink.clone();
    ink.update(cx, |ink, cx| ink.undo(cx));
    ink_changed(cx);
}

pub fn clear(cx: &mut App) {
    let ink = global(cx).ink.clone();
    ink.update(cx, |ink, cx| ink.clear(cx));
    ink_changed(cx);
}

/// Keeps the bar's undo and clear in step with the strokes, and closes the
/// canvas once it has nothing left to show.
fn ink_changed(cx: &mut App) {
    let draw = global(cx);
    let (ink, mode) = (draw.ink.clone(), draw.mode.clone());
    let has_ink = !ink.read(cx).strokes.is_empty();
    let drawing = mode.update(cx, |mode, cx| {
        if mode.has_ink != has_ink {
            mode.has_ink = has_ink;
            cx.notify();
        }
        mode.drawing
    });
    if !drawing && ink.read(cx).is_empty() {
        close_canvas(cx);
    }
}

fn close_canvas(cx: &mut App) {
    if let Some((canvas, _)) = global(cx).canvas.take() {
        canvas
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// A borderless panel over `frame`, at `level`. The input panel is kept out
/// of captures and takes the mouse; the canvas stays in captures and lets
/// every click through.
fn open_panel<V: Render + 'static>(
    frame: Frame,
    level: isize,
    input: bool,
    build: impl FnOnce(&mut Window, &mut Context<V>) -> V + 'static,
    cx: &mut App,
) -> Option<WindowHandle<V>> {
    let handle = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(gpui::Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(frame.width as f32), px(frame.height as f32)),
                })),
                titlebar: None,
                kind: WindowKind::PopUp,
                focus: false,
                show: false,
                is_resizable: false,
                is_minimizable: false,
                window_background: gpui::WindowBackgroundAppearance::Transparent,
                ..Default::default()
            },
            move |window, cx| cx.new(|cx| build(window, cx)),
        )
        .inspect_err(|error| tracing::warn!("drawing panel failed to open: {error:#}"))
        .ok()?;
    let close = |cx: &mut App| {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    };
    let Some(native) = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten()
    else {
        close(cx);
        return None;
    };
    let placed = if input {
        platform::set_window_capture_hidden(&native, true);
        platform::set_window_click_through(&native, false)
    } else {
        platform::set_window_click_through(&native, true)
    };
    if !placed {
        tracing::warn!(input, "drawing panel could not set its mouse handling");
        close(cx);
        return None;
    }
    // AppKit re-enters gpui as it orders the panel in, so that runs from a
    // fresh turn with nothing borrowed (see `platform::place_overlay_panel`).
    cx.spawn(async move |cx| {
        let open = cx.update(|cx| handle.update(cx, |_, _, _| ()).is_ok());
        if !open {
            return;
        }
        platform::place_overlay_panel(&native, frame.x, frame.y, frame.width, frame.height, level);
        // Opened hidden, the panel's display link never started; without
        // this the canvas keeps its first, empty frame.
        cx.update(|cx| {
            handle
                .update(cx, |_, window, _| platform::kick_display_link(window))
                .ok();
        });
    })
    .detach();
    Some(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Pt, b: Pt) -> bool {
        (a.x - b.x).abs() < 1e-3 && (a.y - b.y).abs() < 1e-3
    }

    #[test]
    fn shift_snaps_arrows_to_the_nearest_45_degrees() {
        let from = Pt::new(100., 100.);
        assert!(close(
            snap_to_45(from, Pt::new(200., 110.)),
            Pt::new(100. + 10_100f32.sqrt(), 100.)
        ));
        let diagonal = snap_to_45(from, Pt::new(170., 180.));
        assert!((diagonal.x - from.x - (diagonal.y - from.y)).abs() < 1e-3);
        assert!((from.distance(diagonal) - from.distance(Pt::new(170., 180.))).abs() < 1e-3);
        let up = snap_to_45(from, Pt::new(95., 20.));
        assert!((up.x - 100.).abs() < 1e-3 && up.y < 100.);
        assert_eq!(snap_to_45(from, from), from);
    }

    #[test]
    fn shift_makes_rectangles_square_in_the_drag_direction() {
        let from = Pt::new(50., 50.);
        assert!(close(
            square_corner(from, Pt::new(90., 60.)),
            Pt::new(90., 90.)
        ));
        assert!(close(
            square_corner(from, Pt::new(30., 0.)),
            Pt::new(0., 0.)
        ));
        assert!(close(
            square_corner(from, Pt::new(70., 20.)),
            Pt::new(80., 20.)
        ));
    }

    #[test]
    fn shift_turns_a_freehand_stroke_into_a_straight_line() {
        let points = [Pt::new(0., 0.), Pt::new(5., 9.), Pt::new(12., 3.)];
        let end = Pt::new(20., 20.);
        assert_eq!(
            shape(Tool::Pen, &points, end, true),
            Some(Shape::Line(vec![Pt::new(0., 0.), end]))
        );
        assert_eq!(
            shape(Tool::Highlighter, &points, end, false),
            Some(Shape::Line(vec![
                Pt::new(0., 0.),
                Pt::new(5., 9.),
                Pt::new(12., 3.),
                end
            ]))
        );
    }

    #[test]
    fn a_click_without_a_drag_draws_a_dot_but_no_shape() {
        let at = Pt::new(10., 10.);
        assert_eq!(
            shape(Tool::Pen, &[at], at, false),
            Some(Shape::Line(vec![at]))
        );
        assert_eq!(shape(Tool::Arrow, &[at], at, false), None);
        assert_eq!(
            shape(Tool::Rectangle, &[at], Pt::new(40., 11.), false),
            None
        );
        assert_eq!(shape(Tool::Pen, &[], at, false), None);
    }

    #[test]
    fn arrows_and_rectangles_use_the_constrained_end() {
        let from = Pt::new(0., 0.);
        let Some(Shape::Rect { to, .. }) =
            shape(Tool::Rectangle, &[from], Pt::new(30., -10.), true)
        else {
            panic!("expected a rectangle");
        };
        assert!(close(to, Pt::new(30., -30.)));
        let Some(Shape::Arrow { to, .. }) = shape(Tool::Arrow, &[from], Pt::new(50., 2.), true)
        else {
            panic!("expected an arrow");
        };
        assert!(to.y.abs() < 1e-3);
    }

    #[test]
    fn strokes_hold_then_fade_out() {
        assert_eq!(opacity_after(Duration::ZERO), Some(1.));
        assert_eq!(opacity_after(HOLD - Duration::from_millis(1)), Some(1.));
        let halfway = opacity_after(HOLD + FADE / 2).unwrap();
        assert!((halfway - 0.5).abs() < 0.01);
        let late = opacity_after(HOLD + FADE - Duration::from_millis(30)).unwrap();
        assert!(late < 0.05);
        assert_eq!(opacity_after(HOLD + FADE), None);
    }

    fn painted_area(paths: &[Path<Pixels>]) -> f32 {
        paths
            .iter()
            .flat_map(|path| path.vertices.chunks(3))
            .map(|triangle| {
                let [a, b, c] = [0, 1, 2].map(|i| triangle[i].xy_position);
                let (ab, ac) = (b - a, c - a);
                (f32::from(ab.x) * f32::from(ac.y) - f32::from(ab.y) * f32::from(ac.x)).abs() / 2.
            })
            .sum()
    }

    #[test]
    fn long_strokes_meet_on_seams_without_painting_twice() {
        let width = Tool::Highlighter.width();
        let points: Vec<Pt> = (0..600).map(|i| Pt::new(i as f32 * 2., 0.)).collect();
        let paths = build_paths(&Shape::Line(points.clone()), Tool::Highlighter);
        assert_eq!(paths.len(), 3);
        let whole = 1198. * width + std::f32::consts::PI * (width / 2.).powi(2);
        let painted = painted_area(&paths);
        assert!(
            (painted - whole).abs() < whole * 0.002,
            "painted {painted}, one stroke {whole}"
        );

        let mut seamed = points.clone();
        let (mut from, mut sealed) = (0, Vec::new());
        seal_runs(&mut seamed, &mut from, width, &mut sealed);
        assert_eq!(sealed.len(), 2);
        assert_eq!(seamed.len(), points.len() + 2);
        for seam in [CHUNK - 1, 2 * CHUNK - 2] {
            let (before, at, after) = (seamed[seam - 1], seamed[seam], seamed[seam + 1]);
            assert!(close(
                at,
                Pt::new((before.x + after.x) / 2., (before.y + after.y) / 2.)
            ));
        }
        assert_eq!(from, 2 * CHUNK - 2);
        assert_eq!(
            build_paths(&Shape::Line(vec![Pt::new(5., 5.)]), Tool::Pen).len(),
            1
        );
    }

    #[test]
    fn a_long_freehand_draft_seals_the_runs_a_full_repaint_would_draw() {
        let mut draft = Draft::new(Tool::Highlighter, COLORS[0], Pt::new(0., 0.), false);
        let mut points = vec![Pt::new(0., 0.)];
        for i in 1..600 {
            let at = Pt::new(i as f32 * 2., (i % 7) as f32);
            draft.current = at;
            append_point(&mut draft.points, at);
            append_point(&mut points, at);
            draft.seal();
        }
        assert_eq!(draft.sealed.len(), 2);
        let whole = build_paths(&Shape::Line(points), Tool::Highlighter);
        let drawn = draft.into_paths().expect("a stroke");
        assert_eq!(drawn.len(), whole.len());
        assert!((painted_area(&drawn) - painted_area(&whole)).abs() < 1.);
    }

    #[test]
    fn straight_drafts_and_shapes_are_built_whole() {
        let mut draft = Draft::new(Tool::Pen, COLORS[0], Pt::new(0., 0.), true);
        draft.current = Pt::new(40., 40.);
        assert_eq!(draft.into_paths().map(|paths| paths.len()), Some(1));
        let mut arrow = Draft::new(Tool::Arrow, COLORS[0], Pt::new(0., 0.), false);
        arrow.current = Pt::new(80., 10.);
        assert_eq!(arrow.into_paths().map(|paths| paths.len()), Some(2));
        let tap = Draft::new(Tool::Rectangle, COLORS[0], Pt::new(5., 5.), false);
        assert!(tap.into_paths().is_none());
    }

    #[test]
    fn simplifying_keeps_corners_and_drops_points_on_a_line() {
        let line: Vec<Pt> = (0..=100).map(|i| Pt::new(i as f32, 0.)).collect();
        assert_eq!(
            simplify(&line, 0.35),
            vec![Pt::new(0., 0.), Pt::new(100., 0.)]
        );
        let corner = [
            Pt::new(0., 0.),
            Pt::new(5., 0.1),
            Pt::new(10., 0.),
            Pt::new(10., 10.),
        ];
        assert_eq!(
            simplify(&corner, 0.35),
            vec![Pt::new(0., 0.), Pt::new(10., 0.), Pt::new(10., 10.)]
        );
        let wave: Vec<Pt> = (0..400)
            .map(|i| Pt::new(i as f32, (i as f32 / 12.).sin() * 30.))
            .collect();
        let kept = simplify(&wave, 0.35);
        assert!(
            kept.len() < wave.len() / 3,
            "{} of {}",
            kept.len(),
            wave.len()
        );
        for p in &wave {
            let near = kept.windows(2).any(|pair| {
                let (a, b) = (pair[0], pair[1]);
                let (dx, dy) = (b.x - a.x, b.y - a.y);
                let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)).clamp(0., 1.);
                Pt::new(a.x + dx * t, a.y + dy * t).distance(*p) <= 0.36
            });
            assert!(near, "{p:?} strayed");
        }
        let backtrack = [
            Pt::new(0., 0.),
            Pt::new(50., 0.),
            Pt::new(100., 0.),
            Pt::new(75., 0.),
            Pt::new(50., 0.),
        ];
        assert_eq!(
            simplify(&backtrack, 0.35),
            vec![Pt::new(0., 0.), Pt::new(100., 0.), Pt::new(50., 0.)]
        );
        let there_and_back = [
            Pt::new(0., 0.),
            Pt::new(40., 0.),
            Pt::new(80., 0.),
            Pt::new(40., 0.),
            Pt::new(0., 0.),
        ];
        assert_eq!(
            simplify(&there_and_back, 0.35),
            vec![Pt::new(0., 0.), Pt::new(80., 0.), Pt::new(0., 0.)]
        );
        assert_eq!(simplify(&[Pt::new(1., 1.)], 0.35), vec![Pt::new(1., 1.)]);
        assert!(simplify(&[], 0.35).is_empty());
    }

    #[test]
    fn freehand_skips_points_closer_than_a_step() {
        let mut points = vec![Pt::new(0., 0.)];
        for at in [
            Pt::new(0.5, 0.),
            Pt::new(1., 0.),
            Pt::new(2., 0.),
            Pt::new(2.5, 0.),
        ] {
            append_point(&mut points, at);
        }
        assert_eq!(points, vec![Pt::new(0., 0.), Pt::new(2., 0.)]);
    }
}
