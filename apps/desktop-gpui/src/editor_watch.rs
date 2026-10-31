//! This gpui rev has no backdrop blur, so the wash is a dim. The stage keeps
//! measuring its rect while hidden so the card can animate back to it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    Bounds, Context, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels, Render,
    SharedString, StatefulInteractiveElement, Styled, WeakEntity, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_window::{EditorPreviewFrame, EditorWindow, PREVIEW_RADIUS, PumpStats, ease_out_quint},
    ui,
};

pub(crate) const WATCH_OPEN_DURATION: Duration = Duration::from_millis(220);
pub(crate) const WATCH_CLOSE_DURATION: Duration = Duration::from_millis(180);
const WATCH_PADDING: f32 = 40.;
const WATCH_RADIUS: f32 = 16.;
const WATCH_BACKDROP_ALPHA: f32 = 0.62;

#[derive(Debug, Clone, Copy, PartialEq)]
enum WatchPhase {
    Opening,
    Closing { from_progress: f32 },
}

#[derive(Debug, Clone, Copy)]
struct WatchMotion {
    phase: WatchPhase,
    started: Instant,
    /// The stage's painted frame rect when the motion started, in window
    /// coordinates. `None` when the stage has not painted yet, in which case
    /// the card only fades.
    origin: Option<Bounds<Pixels>>,
}

impl WatchMotion {
    fn progress(&self, now: Instant, reduce_motion: bool) -> f32 {
        let elapsed = now.saturating_duration_since(self.started);
        watch_progress(self.phase, elapsed, reduce_motion)
    }

    fn settled(&self, now: Instant, reduce_motion: bool) -> bool {
        let elapsed = now.saturating_duration_since(self.started);
        reduce_motion || elapsed >= phase_duration(self.phase)
    }
}

fn phase_duration(phase: WatchPhase) -> Duration {
    match phase {
        WatchPhase::Opening => WATCH_OPEN_DURATION,
        WatchPhase::Closing { from_progress } => {
            WATCH_CLOSE_DURATION.mul_f32(from_progress.clamp(0., 1.))
        }
    }
}

fn watch_progress(phase: WatchPhase, elapsed: Duration, reduce_motion: bool) -> f32 {
    match phase {
        WatchPhase::Opening => {
            if reduce_motion {
                return 1.;
            }
            let t = (elapsed.as_secs_f32() / WATCH_OPEN_DURATION.as_secs_f32()).clamp(0., 1.);
            ease_out_quint(t)
        }
        WatchPhase::Closing { from_progress } => {
            let duration = phase_duration(phase);
            if reduce_motion || duration.is_zero() {
                return 0.;
            }
            let t = (elapsed.as_secs_f32() / duration.as_secs_f32()).clamp(0., 1.);
            from_progress * (1. - ease_out_quint(t))
        }
    }
}

fn watch_target(viewport: (f32, f32), frame: (f32, f32)) -> Bounds<Pixels> {
    let available = (
        (viewport.0 - WATCH_PADDING * 2.).max(0.),
        (viewport.1 - WATCH_PADDING * 2.).max(0.),
    );
    let (width, height) = contain(available, frame);
    Bounds {
        origin: gpui::point(
            px((viewport.0 - width) / 2.),
            px((viewport.1 - height) / 2.),
        ),
        size: gpui::size(px(width), px(height)),
    }
}

fn contain(available: (f32, f32), frame: (f32, f32)) -> (f32, f32) {
    let (width, height) = available;
    if width <= 0. || height <= 0. {
        return (0., 0.);
    }
    if frame.0 <= 0. || frame.1 <= 0. {
        return (width, height);
    }
    let aspect = frame.0 / frame.1;
    if aspect < width / height {
        (height * aspect, height)
    } else {
        (width, width / aspect)
    }
}

fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

fn lerp_bounds(from: Bounds<Pixels>, to: Bounds<Pixels>, t: f32) -> Bounds<Pixels> {
    let mix = |a: Pixels, b: Pixels| px(lerp(f32::from(a), f32::from(b), t));
    Bounds {
        origin: gpui::point(
            mix(from.origin.x, to.origin.x),
            mix(from.origin.y, to.origin.y),
        ),
        size: gpui::size(
            mix(from.size.width, to.size.width),
            mix(from.size.height, to.size.height),
        ),
    }
}

pub(crate) struct WatchView {
    editor: WeakEntity<EditorWindow>,
    frame: Option<EditorPreviewFrame>,
    frame_size: (f32, f32),
    motion: Option<WatchMotion>,
    stats: Option<Arc<PumpStats>>,
    frame_sequence: u64,
}

impl WatchView {
    pub(crate) fn new(editor: WeakEntity<EditorWindow>) -> Self {
        Self {
            editor,
            frame: None,
            frame_size: (1920., 1080.),
            motion: None,
            stats: None,
            frame_sequence: 0,
        }
    }

    fn open(
        &mut self,
        frame: EditorPreviewFrame,
        frame_size: (f32, f32),
        origin: Option<Bounds<Pixels>>,
        stats: Option<Arc<PumpStats>>,
        frame_sequence: u64,
        cx: &mut Context<Self>,
    ) {
        self.frame = Some(frame);
        self.frame_size = frame_size;
        self.stats = stats;
        self.frame_sequence = frame_sequence;
        self.motion = Some(WatchMotion {
            phase: WatchPhase::Opening,
            started: Instant::now(),
            origin,
        });
        cx.notify();
    }

    fn close(
        &mut self,
        origin: Option<Bounds<Pixels>>,
        reduce_motion: bool,
        cx: &mut Context<Self>,
    ) -> Duration {
        let now = Instant::now();
        let from_progress = self
            .motion
            .map_or(1., |motion| motion.progress(now, reduce_motion));
        let phase = WatchPhase::Closing { from_progress };
        self.motion = Some(WatchMotion {
            phase,
            started: now,
            origin: origin.or(self.motion.and_then(|motion| motion.origin)),
        });
        cx.notify();
        if reduce_motion {
            Duration::ZERO
        } else {
            phase_duration(phase)
        }
    }

    pub(crate) fn set_frame(
        &mut self,
        frame: EditorPreviewFrame,
        frame_size: (f32, f32),
        stats: Option<Arc<PumpStats>>,
        frame_sequence: u64,
        cx: &mut Context<Self>,
    ) {
        self.frame = Some(frame);
        self.frame_size = frame_size;
        self.stats = stats;
        self.frame_sequence = frame_sequence;
        cx.notify();
    }

    fn clear(&mut self, cx: &mut Context<Self>) {
        self.frame = None;
        self.motion = None;
        self.stats = None;
        cx.notify();
    }
}

impl Render for WatchView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (Some(motion), Some(frame)) = (self.motion, self.frame.clone()) else {
            return div().into_any_element();
        };
        let reduce_motion = cx.reduce_motion();
        let now = Instant::now();
        let progress = motion.progress(now, reduce_motion);
        if !motion.settled(now, reduce_motion) {
            window.request_animation_frame();
        }

        let viewport = window.viewport_size();
        let target = watch_target(
            (f32::from(viewport.width), f32::from(viewport.height)),
            self.frame_size,
        );
        let card = lerp_bounds(motion.origin.unwrap_or(target), target, progress);
        let card_opacity = if motion.origin.is_some() {
            1.
        } else {
            progress
        };
        let radius = px(lerp(PREVIEW_RADIUS, WATCH_RADIUS, progress));
        let shadow = crate::theme::preview_shadow();
        let editor = self.editor.clone();
        let painted = self.stats.clone();
        let frame_sequence = self.frame_sequence;

        div()
            .absolute()
            .inset_0()
            .occlude()
            .child(
                div()
                    .id("watch-preview-backdrop")
                    .absolute()
                    .inset_0()
                    .occlude()
                    .bg(gpui::hsla(0., 0., 0., WATCH_BACKDROP_ALPHA * progress))
                    .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                    .on_click(move |_, window, cx| {
                        editor
                            .update(cx, |editor, cx| editor.close_watch_preview(window, cx))
                            .ok();
                    }),
            )
            .child(
                div()
                    .id("watch-preview-card")
                    .absolute()
                    .left(card.origin.x)
                    .top(card.origin.y)
                    .w(card.size.width)
                    .h(card.size.height)
                    .occlude()
                    .opacity(card_opacity)
                    .child(
                        gpui::canvas(
                            |bounds, _window, _cx| bounds,
                            move |_, bounds, window, _cx| {
                                let corners = gpui::Corners::all(radius);
                                window.paint_drop_shadows(bounds, corners, &shadow);
                                window.paint_quad(
                                    gpui::fill(bounds, gpui::black()).corner_radii(radius),
                                );
                                frame.paint(bounds, radius, window);
                                window.paint_quad(gpui::quad(
                                    bounds,
                                    corners,
                                    gpui::transparent_black(),
                                    gpui::Edges::all(px(1.)),
                                    gpui::hsla(0., 0., 1., 0.08),
                                    gpui::BorderStyle::Solid,
                                ));
                                if let Some(stats) = &painted {
                                    stats.record_paint(frame_sequence);
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
            .into_any_element()
    }
}

impl EditorWindow {
    pub(crate) fn watch_preview_expanded(&self) -> bool {
        self.watch_preview_open && self.watch_preview_closing.is_none()
    }

    pub(crate) fn toggle_watch_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.watch_preview_expanded() {
            self.close_watch_preview(window, cx);
        } else if !self.watch_preview_open {
            self.open_watch_preview(window, cx);
        }
    }

    fn open_watch_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.watch_preview_open || self.crop.is_some() || !self.project_ready() {
            return;
        }
        let Some(frame) = self.latest_frame.clone() else {
            return;
        };
        let frame_size = self
            .frame_layout
            .map(|layout| (layout.output_size[0] as f32, layout.output_size[1] as f32))
            .unwrap_or((1920., 1080.));
        let origin = self.player_frame_rect.get().map(|player| player.frame);

        self.end_field_edit(cx);
        self.close_color_picker(cx);
        self.dismiss_frame_controls(cx);
        self.dismiss_watch_preview_menus();
        window.focus(&self.focus, cx);

        self.watch_preview_open = true;
        let (stats, frame_sequence) = self.watch_paint_counters(cx);
        self.watch_preview.update(cx, |watch, cx| {
            watch.open(frame, frame_size, origin, stats, frame_sequence, cx)
        });
        self.set_stage_frame_hidden(true, cx);
        cx.notify();
    }

    pub(crate) fn close_watch_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.watch_preview_expanded() {
            return;
        }
        let origin = self.player_frame_rect.get().map(|player| player.frame);
        let reduce_motion = cx.reduce_motion();
        let remaining = self
            .watch_preview
            .update(cx, |watch, cx| watch.close(origin, reduce_motion, cx));
        self.watch_preview_closing = Some(cx.spawn_in(window, async move |this, cx| {
            if !remaining.is_zero() {
                cx.background_executor().timer(remaining).await;
            }
            this.update(cx, |this, cx| this.finish_watch_preview(cx))
                .ok();
        }));
        cx.notify();
    }

    pub(crate) fn dismiss_watch_preview(&mut self, cx: &mut Context<Self>) {
        if self.watch_preview_open {
            self.finish_watch_preview(cx);
        }
    }

    fn finish_watch_preview(&mut self, cx: &mut Context<Self>) {
        self.watch_preview_closing = None;
        self.watch_preview_open = false;
        self.watch_preview.update(cx, |watch, cx| watch.clear(cx));
        self.set_stage_frame_hidden(false, cx);
        cx.notify();
    }

    pub(crate) fn render_watch_preview_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.watch_preview_expanded();
        let enabled = self.project_ready() && self.latest_frame.is_some();
        let (icon, label) = if expanded {
            ("icons/minimize.svg", "Exit preview")
        } else {
            ("icons/enlarge.svg", "Watch preview")
        };
        let group = SharedString::from("transport-watch-preview-group");
        div()
            .id("transport-watch-preview")
            .group(group.clone())
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.))
            .flex_none()
            .rounded(px(7.))
            .when(!enabled, |this| this.opacity(0.5))
            .when(enabled, |this| {
                this.cursor_pointer()
                    .hover(|style| style.bg(Hsla::from(theme.editor.ctl_hover)))
                    .active(|style| style.bg(Hsla::from(theme.editor.ctl_active)))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_watch_preview(window, cx);
                    }))
            })
            .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
            .tooltip(move |_window, cx| {
                let tooltip = ui::Tooltip::new(&theme, label);
                if expanded {
                    tooltip.keys(["escape"]).view(cx)
                } else {
                    tooltip.view(cx)
                }
            })
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .group_hover(group, move |style| {
                        style.text_color(Hsla::from(theme.editor.text_1))
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(bounds: Bounds<Pixels>) -> (f32, f32, f32, f32) {
        (
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        )
    }

    #[test]
    fn a_wide_frame_fills_the_padded_width_and_centres_vertically() {
        let (x, y, w, h) = rect(watch_target((1280., 800.), (1920., 1080.)));
        assert_eq!((x, w), (40., 1200.));
        assert!((h - 675.).abs() < 0.01);
        assert!((y - (800. - 675.) / 2.).abs() < 0.01);
    }

    #[test]
    fn a_tall_frame_fills_the_padded_height_and_centres_horizontally() {
        let (x, y, w, h) = rect(watch_target((1280., 800.), (1080., 1920.)));
        assert_eq!((y, h), (40., 720.));
        assert!((w - 405.).abs() < 0.01);
        assert!((x - (1280. - 405.) / 2.).abs() < 0.01);
    }

    #[test]
    fn a_square_frame_is_bounded_by_the_shorter_side() {
        let (x, y, w, h) = rect(watch_target((1280., 800.), (1080., 1080.)));
        assert_eq!((w, h), (720., 720.));
        assert_eq!((x, y), (280., 40.));
    }

    #[test]
    fn a_window_smaller_than_the_padding_collapses_instead_of_going_negative() {
        let (_, _, w, h) = rect(watch_target((60., 60.), (1920., 1080.)));
        assert_eq!((w, h), (0., 0.));
    }

    #[test]
    fn opening_runs_from_the_stage_to_the_target() {
        let opening = WatchPhase::Opening;
        assert_eq!(watch_progress(opening, Duration::ZERO, false), 0.);
        assert_eq!(watch_progress(opening, WATCH_OPEN_DURATION, false), 1.);
        assert_eq!(watch_progress(opening, WATCH_OPEN_DURATION * 2, false), 1.);
        assert_eq!(watch_progress(opening, Duration::from_secs(60), false), 1.);
        assert_eq!(watch_progress(opening, Duration::ZERO, true), 1.);
    }

    #[test]
    fn closing_returns_from_wherever_the_open_had_reached() {
        let full = WatchPhase::Closing { from_progress: 1. };
        assert_eq!(watch_progress(full, Duration::ZERO, false), 1.);
        assert_eq!(watch_progress(full, WATCH_CLOSE_DURATION, false), 0.);

        let partial = WatchPhase::Closing { from_progress: 0.5 };
        assert!(
            phase_duration(partial).abs_diff(WATCH_CLOSE_DURATION / 2) <= Duration::from_nanos(10)
        );
        assert_eq!(watch_progress(partial, Duration::ZERO, false), 0.5);
        assert_eq!(watch_progress(partial, WATCH_CLOSE_DURATION, false), 0.);

        assert_eq!(watch_progress(full, Duration::ZERO, true), 0.);
    }

    #[test]
    fn bounds_interpolate_between_both_ends() {
        let from = Bounds {
            origin: gpui::point(px(100.), px(200.)),
            size: gpui::size(px(400.), px(225.)),
        };
        let to = Bounds {
            origin: gpui::point(px(40.), px(62.5)),
            size: gpui::size(px(1200.), px(675.)),
        };
        assert_eq!(lerp_bounds(from, to, 0.), from);
        assert_eq!(lerp_bounds(from, to, 1.), to);
        assert_eq!(rect(lerp_bounds(from, to, 0.5)), (70., 131.25, 800., 450.));
    }
}
