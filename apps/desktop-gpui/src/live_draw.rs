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
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PathBuilder, PathStyle, Render,
    Styled as _, Task, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions, canvas, div,
    point, px, size,
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

/// Runs of at most [`CHUNK`] points that overlap by one, so the painted line
/// stays continuous.
fn chunks(points: &[Pt]) -> impl Iterator<Item = &[Pt]> {
    let mut start = 0;
    std::iter::from_fn(move || {
        if start >= points.len() {
            return None;
        }
        let end = (start + CHUNK).min(points.len());
        let run = &points[start..end];
        start = if end == points.len() { end } else { end - 1 };
        Some(run)
    })
}

struct Stroke {
    tool: Tool,
    color: u32,
    shape: Shape,
    done: Instant,
    fades: bool,
}

struct Draft {
    tool: Tool,
    color: u32,
    points: Vec<Pt>,
    current: Pt,
    straight: bool,
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
        self.draft = Some(Draft {
            tool,
            color,
            points: vec![at],
            current: at,
            straight,
        });
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
        }
        cx.notify();
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.draft.take() else {
            return;
        };
        if let Some(shape) = shape(draft.tool, &draft.points, draft.current, draft.straight) {
            if self.strokes.len() >= MAX_STROKES {
                self.strokes.remove(0);
            }
            self.strokes.push(Stroke {
                tool: draft.tool,
                color: draft.color,
                shape,
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
    PathBuilder::stroke(px(width)).with_style(PathStyle::Stroke(
        StrokeOptions::default()
            .with_line_width(width)
            .with_line_cap(LineCap::Round)
            .with_line_join(LineJoin::Round),
    ))
}

fn paint_shape(shape: &Shape, tool: Tool, color: u32, opacity: f32, window: &mut Window) {
    let mut color: Hsla = gpui::rgb(color).into();
    color.a = tool.opacity() * opacity;
    let width = tool.width();
    match shape {
        Shape::Line(points) => {
            for run in chunks(points) {
                let mut builder = stroke_builder(width);
                builder.move_to(to_point(run[0]));
                if run.len() == 1 {
                    builder.line_to(to_point(Pt::new(run[0].x + 0.01, run[0].y)));
                }
                for &at in &run[1..] {
                    builder.line_to(to_point(at));
                }
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            }
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
            if let Ok(path) = shaft.build() {
                window.paint_path(path, color);
            }
            let mut tip = PathBuilder::fill();
            tip.move_to(corner(head.points[0]));
            tip.line_to(corner(head.points[1]));
            tip.line_to(corner(head.points[2]));
            tip.close();
            if let Ok(path) = tip.build() {
                window.paint_path(path, color);
            }
        }
        Shape::Rect { from, to } => {
            let mut builder = stroke_builder(width);
            builder.move_to(to_point(*from));
            builder.line_to(to_point(Pt::new(to.x, from.y)));
            builder.line_to(to_point(*to));
            builder.line_to(to_point(Pt::new(from.x, to.y)));
            builder.close();
            if let Ok(path) = builder.build() {
                window.paint_path(path, color);
            }
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
        paint_shape(&stroke.shape, stroke.tool, stroke.color, opacity, window);
    }
    if let Some(draft) = &ink.draft
        && let Some(shape) = shape(draft.tool, &draft.points, draft.current, draft.straight)
    {
        paint_shape(&shape, draft.tool, draft.color, 1., window);
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
        && session
            .capture_target()
            .is_some_and(|target| !matches!(target, ScreenCaptureTarget::CameraOnly))
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
        Some(ScreenCaptureTarget::CameraOnly) | None => Err(Unavailable::NotRecording),
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
            platform::target_overlay_level() - 1,
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
        platform::target_overlay_level(),
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
        input
            .update(cx, |_, window, _| window.remove_window())
            .ok();
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
        if open {
            platform::place_overlay_panel(
                &native,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                level,
            );
        }
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
        assert_eq!(shape(Tool::Rectangle, &[at], Pt::new(40., 11.), false), None);
        assert_eq!(shape(Tool::Pen, &[], at, false), None);
    }

    #[test]
    fn arrows_and_rectangles_use_the_constrained_end() {
        let from = Pt::new(0., 0.);
        let Some(Shape::Rect { to, .. }) = shape(Tool::Rectangle, &[from], Pt::new(30., -10.), true)
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

    #[test]
    fn long_strokes_paint_in_overlapping_runs() {
        let points: Vec<Pt> = (0..600).map(|i| Pt::new(i as f32, 0.)).collect();
        let runs: Vec<&[Pt]> = chunks(&points).collect();
        assert_eq!(runs.len(), 3);
        assert!(runs.iter().all(|run| run.len() <= CHUNK));
        assert_eq!(runs[0].last(), runs[1].first());
        assert_eq!(runs[1].last(), runs[2].first());
        assert_eq!(runs[2].last(), points.last());
        assert_eq!(chunks(&points[..1]).count(), 1);
        assert_eq!(chunks(&[]).count(), 0);
    }

    #[test]
    fn freehand_skips_points_closer_than_a_step() {
        let mut points = vec![Pt::new(0., 0.)];
        for at in [Pt::new(0.5, 0.), Pt::new(1., 0.), Pt::new(2., 0.), Pt::new(2.5, 0.)] {
            append_point(&mut points, at);
        }
        assert_eq!(points, vec![Pt::new(0., 0.), Pt::new(2., 0.)]);
    }
}
