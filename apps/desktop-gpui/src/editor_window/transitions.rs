//! Transitions between clips on the timeline.
//!
//! A transition overlaps two neighbouring clips. There are three ways to make
//! one: drag a clip's body left onto the clip before it (the original
//! gesture), click the `+` that appears at a cut while either clip is hovered,
//! or pick one from the clip menu. Clicking a transition opens a popover with
//! its kind and length; its two edges drag its length directly.

use super::*;
use cap_project::ClipTransitionType;
use cap_rendering::{TransitionComposite, TransitionDip, TransitionLayer};
use gpui::{AnyElement, Div};

const THUMBNAIL_WIDTH: f32 = 58.;
const THUMBNAIL_HEIGHT: f32 = 36.;
const THUMBNAIL_INSET: f32 = 5.;
const PREVIEW_LOOP: Duration = Duration::from_millis(1600);

pub(crate) fn transition_label(kind: ClipTransitionType) -> &'static str {
    match kind {
        ClipTransitionType::CrossFade => tr::editor::window::transition::cross_fade(),
        ClipTransitionType::FadeThroughBlack => {
            tr::editor::window::transition::fade_through_black()
        }
        ClipTransitionType::FadeThroughWhite => {
            tr::editor::window::transition::fade_through_white()
        }
        ClipTransitionType::PushLeft => tr::editor::window::transition::push_left(),
        ClipTransitionType::PushRight => tr::editor::window::transition::push_right(),
        ClipTransitionType::PushUp => tr::editor::window::transition::push_up(),
        ClipTransitionType::PushDown => tr::editor::window::transition::push_down(),
        ClipTransitionType::WipeLeft => tr::editor::window::transition::wipe_left(),
        ClipTransitionType::WipeRight => tr::editor::window::transition::wipe_right(),
        ClipTransitionType::WipeUp => tr::editor::window::transition::wipe_up(),
        ClipTransitionType::WipeDown => tr::editor::window::transition::wipe_down(),
        ClipTransitionType::Zoom => tr::editor::window::transition::zoom(),
    }
}

/// The preview loop: a beat on the outgoing clip, the transition, then a beat
/// on the incoming one.
fn preview_progress(loop_position: f32) -> f32 {
    ((loop_position - 0.2) / 0.6).clamp(0., 1.)
}

/// A small picture of `kind` at `progress`, drawn from the same geometry the
/// renderer uses, so the tile moves the way the export will.
fn transition_thumbnail(theme: &Theme, kind: ClipTransitionType, progress: f32) -> Div {
    let outgoing = Hsla::from(gpui::rgb(0x5b8def));
    let incoming = Hsla::from(gpui::rgb(0xf0a35e));
    let frame = div()
        .relative()
        .flex_none()
        .w(px(THUMBNAIL_WIDTH))
        .h(px(THUMBNAIL_HEIGHT))
        .rounded(px(5.))
        .overflow_hidden()
        .bg(Hsla::from(theme.editor.ctl_active));
    let fill = |color: Hsla, opacity: f32| {
        div()
            .absolute()
            .inset_0()
            .bg(color)
            .opacity(opacity.clamp(0., 1.))
    };
    let card = |color: Hsla, layer: TransitionLayer, origin: (f32, f32)| {
        let width = (THUMBNAIL_WIDTH - THUMBNAIL_INSET * 2.) * layer.scale;
        let height = (THUMBNAIL_HEIGHT - THUMBNAIL_INSET * 2.) * layer.scale;
        div()
            .absolute()
            .left(px((THUMBNAIL_WIDTH - width) / 2.
                + layer.offset[0] * THUMBNAIL_WIDTH
                - origin.0))
            .top(px((THUMBNAIL_HEIGHT - height) / 2.
                + layer.offset[1] * THUMBNAIL_HEIGHT
                - origin.1))
            .w(px(width))
            .h(px(height))
            .rounded(px(2.))
            .bg(color)
            .opacity(layer.opacity.clamp(0., 1.))
    };
    match TransitionComposite::at(kind, progress) {
        TransitionComposite::Frames {
            outgoing_weight,
            incoming_weight,
            dip,
        } => match dip {
            None => frame
                .child(fill(outgoing, 1.))
                .child(fill(incoming, incoming_weight)),
            Some(dip) => frame
                .child(fill(
                    match dip {
                        TransitionDip::Black => gpui::black(),
                        TransitionDip::White => gpui::white(),
                    },
                    1.,
                ))
                .child(fill(outgoing, outgoing_weight))
                .child(fill(incoming, incoming_weight)),
        },
        TransitionComposite::Layers {
            outgoing: outgoing_layer,
            incoming: incoming_layer,
            wipe,
        } => {
            let frame = frame.child(card(outgoing, outgoing_layer, (0., 0.)));
            let Some(wipe) = wipe else {
                return frame.child(card(incoming, incoming_layer, (0., 0.)));
            };
            let edge = wipe.edge.clamp(0., 1.);
            let (left, top, width, height) = match wipe.direction {
                [x, _] if x > 0. => (0., 0., edge * THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT),
                [x, _] if x < 0. => (
                    (1. - edge) * THUMBNAIL_WIDTH,
                    0.,
                    edge * THUMBNAIL_WIDTH,
                    THUMBNAIL_HEIGHT,
                ),
                [_, y] if y > 0. => (0., 0., THUMBNAIL_WIDTH, edge * THUMBNAIL_HEIGHT),
                _ => (
                    0.,
                    (1. - edge) * THUMBNAIL_HEIGHT,
                    THUMBNAIL_WIDTH,
                    edge * THUMBNAIL_HEIGHT,
                ),
            };
            frame.child(
                div()
                    .absolute()
                    .left(px(left))
                    .top(px(top))
                    .w(px(width))
                    .h(px(height))
                    .overflow_hidden()
                    .child(card(incoming, incoming_layer, (left, top))),
            )
        }
    }
}

impl EditorWindow {
    pub(crate) fn transition_popover_index(&self) -> Option<usize> {
        self.transition_popover.map(|popover| popover.index)
    }

    pub(super) fn open_transition_popover(
        &mut self,
        index: usize,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(clips) = self.project.timeline.as_ref().and_then(|timeline| {
            timeline.effective_transition(index)?;
            transition_clip_keys(timeline, index)
        }) else {
            return;
        };
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.clip_speed = None;
        self.text_menu = None;
        let placement = clip_menu_placement(
            index,
            origin,
            window.viewport_size(),
            TRANSITION_POPOVER_WIDTH,
        );
        self.transition_popover = Some(TransitionPopover {
            index,
            left: placement.left,
            anchor: placement.anchor,
            hovered: None,
            clips,
        });
        cx.notify();
    }

    /// The `+` at a cut, and the clip menu's transition row: a cross dissolve
    /// of the default length if the cut has no transition yet, then its
    /// popover.
    pub(super) fn edit_transition_at(
        &mut self,
        index: usize,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let existing = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.effective_transition(index));
        if existing.is_none() {
            self.set_clip_transition(
                index,
                Some((
                    ClipTransitionType::CrossFade,
                    DEFAULT_CLIP_TRANSITION_DURATION,
                )),
                window,
                cx,
            );
        }
        self.open_transition_popover(index, origin, window, cx);
    }

    /// `CAP_GPUI_AUTO_TRANSITION` (see `app_windows::drive_auto_sidebar`).
    pub(crate) fn auto_transition(
        &mut self,
        spec: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (index, kind) = match spec.split_once(':') {
            Some((index, kind)) => (index, ClipTransitionType::from_wire_name(kind)),
            None => (spec, None),
        };
        let index = index.parse::<usize>().unwrap_or(1);
        let Some(clip) = self.timeline.clips.get(index) else {
            return;
        };
        let viewport = window.viewport_size();
        let secs_per_pixel = self.secs_per_pixel(f32::from(viewport.width));
        let x = timeline::content_left()
            + ((clip.start - self.view.transform.position) / secs_per_pixel) as f32;
        let origin = point(px(x), viewport.height - px(120.));
        self.edit_transition_at(index, origin, window, cx);
        if let Some((kind, duration)) = kind.zip(
            self.project
                .timeline
                .as_ref()
                .and_then(|timeline| timeline.effective_transition(index))
                .map(|transition| transition.duration),
        ) {
            self.set_clip_transition(index, Some((kind, duration)), window, cx);
        }
    }

    /// A press on a clip's body. Dragged left onto the clip before it, it
    /// overlaps the two by a transition, or lengthens the one already there;
    /// dragged back it shortens it, and below half the minimum it is gone
    /// (`TL/ClipTrack.tsx:1263-1338`). A press that never travels 4px
    /// selects the clip on release, and a first move to the right with no
    /// transition yet never becomes a drag. Any two neighbouring clips work:
    /// two halves of a split, clips from different recordings, reordered
    /// clips.
    pub(super) fn press_clip_body(
        &mut self,
        index: usize,
        (start, end): (f64, f64),
        down_x: f32,
        (shift, multi): (bool, bool),
        press_time: f64,
        cx: &mut Context<Self>,
    ) {
        self.transition_drag_base = None;
        let transition_drag = self
            .project
            .timeline
            .as_ref()
            .filter(|timeline| {
                !shift && !multi && crate::editor_clips::can_add_transition(timeline, index)
            })
            .map(|timeline| {
                let current = timeline.effective_transition(index);
                DragKind::TransitionDuration {
                    index,
                    initial: current.map_or(0., |transition| transition.duration),
                    grow: -1.,
                    kind: current.map_or_else(Default::default, |transition| transition.kind),
                    from_body: true,
                }
            });
        self.drag = Some(Drag {
            track: TrackKind::Clip,
            index,
            kind: transition_drag.unwrap_or(DragKind::Move {
                start,
                end,
                bounds: DragBounds { min: 0., max: 0. },
            }),
            down_x,
            // Measured from the press, so the overlap grows from the first
            // pixel past the threshold rather than jumping by it.
            origin_x: transition_drag.map(|_| down_x),
            moved: false,
            // 4px, the clip body's own promotion (`TL/ClipTrack.tsx:875`).
            threshold: 4.,
            selects_on_click: true,
            shift,
            multi,
            press_time,
            paused: false,
        });
        cx.notify();
    }

    fn press_transition_edge(
        &mut self,
        index: usize,
        grow: f64,
        down_x: f32,
        cx: &mut Context<Self>,
    ) {
        let Some(current) = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.effective_transition(index))
        else {
            return;
        };
        self.transition_drag_base = None;
        self.transition_popover = None;
        self.drag = Some(Drag {
            track: TrackKind::Clip,
            index,
            kind: DragKind::TransitionDuration {
                index,
                initial: current.duration,
                grow,
                kind: current.kind,
                from_body: false,
            },
            down_x,
            origin_x: Some(down_x),
            moved: false,
            threshold: 0.,
            selects_on_click: false,
            shift: false,
            multi: false,
            press_time: self.playhead,
            paused: false,
        });
        cx.notify();
    }

    /// One step of a transition drag: the transition into clip `index`,
    /// `grow_by` output seconds longer than it started. The preview shows the
    /// middle of the transition while it is dragged.
    pub(super) fn drag_transition(
        &mut self,
        index: usize,
        (initial, grow_by): (f64, f64),
        kind: ClipTransitionType,
        cx: &mut Context<Self>,
    ) {
        if self.transition_drag_base.is_none() {
            self.transition_drag_base = self.project.timeline.clone();
            self.history.pause();
            if let Some(drag) = self.drag.as_mut() {
                drag.paused = true;
            }
        }
        let Some(base) = self.transition_drag_base.as_ref() else {
            return;
        };
        let maximum = crate::editor_clips::max_transition_duration(base, index);
        let duration = crate::editor_clips::dragged_transition_duration(initial, grow_by, maximum);
        let current = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.effective_transition(index))
            .map(|transition| transition.duration);
        if current == duration {
            return;
        }
        let next = crate::editor_clips::apply_dragged_transition(base, index, kind, duration);
        let Some(timeline) = self.project.timeline.as_mut() else {
            return;
        };
        *timeline = next;
        // The ripple moves caption boxes but not the words inside them, so
        // they are projected again from recording time, as `project_changed`
        // does for every other transition edit.
        self.synchronize_caption_track(false);
        self.history.record(&self.project);
        self.rebuild_timeline();
        self.publish_project();
        cx.notify();
        if let Some(clip) = self.timeline.clips.get(index) {
            self.set_preview_time(clip.start + duration.unwrap_or(0.) / 2.);
        }
    }

    pub(super) fn render_transition_overlays(
        &self,
        model: &timeline::TimelineModel,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let lane_width = timeline::content_width(viewport_width);
        let secs_per_pixel = self.view.transform.secs_per_pixel(lane_width);
        let position = self.view.transform.position;
        let open = self.transition_popover_index();
        let hovered = match self.hovered_segment {
            Some((TrackKind::Clip, _, index)) => Some(index),
            _ => None,
        };
        let quiet = self.drag.is_some() || self.split_mode;
        let accent = Hsla::from(theme.editor.accent);
        let mut layer = div()
            .absolute()
            .left(px(timeline::TRACK_GUTTER))
            .right_0()
            .top_0()
            .bottom_0()
            .overflow_hidden();
        let Some(project_timeline) = self.project.timeline.as_ref() else {
            return layer.into_any_element();
        };
        for (index, clip) in model.clips.iter().enumerate().skip(1) {
            let timeline::SegmentDetail::Clip { transition_in, .. } = &clip.detail else {
                continue;
            };
            let x = ((clip.start - position) / secs_per_pixel) as f32;
            match transition_in {
                Some(_) if self.split_mode => {}
                Some((seconds, kind)) => {
                    let width = (*seconds / secs_per_pixel) as f32;
                    let band_width = width.max(TRANSITION_EDGE_PX * 2. + 2.);
                    let left = x - (band_width - width) / 2.;
                    if left + band_width < 0. || left > lane_width {
                        continue;
                    }
                    let selected = open == Some(index);
                    let label = SharedString::from(format!(
                        "{} · {}",
                        transition_label(*kind),
                        tr::editor::window::clip_menu::transition_seconds(crate::i18n::decimal(
                            (*seconds * 100.).round() / 100.
                        ))
                    ));
                    let edge = |id: &'static str, grow: f64| {
                        div()
                            .id(gpui::ElementId::NamedInteger(id.into(), index as u64))
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .w(px(TRANSITION_EDGE_PX))
                            .when(grow < 0., |edge| edge.left_0())
                            .when(grow > 0., |edge| edge.right_0())
                            .cursor(gpui::CursorStyle::ResizeLeftRight)
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                                    cx.stop_propagation();
                                    this.press_transition_edge(
                                        index,
                                        grow,
                                        f32::from(event.position.x),
                                        cx,
                                    );
                                }),
                            )
                            .child(
                                div()
                                    .absolute()
                                    .top(px(6.))
                                    .bottom(px(6.))
                                    .w(px(2.))
                                    .rounded_full()
                                    .when(grow < 0., |bar| bar.left(px(1.)))
                                    .when(grow > 0., |bar| bar.right(px(1.)))
                                    .bg(accent),
                            )
                    };
                    layer = layer.child(
                        div()
                            .id(gpui::ElementId::NamedInteger(
                                "clip-transition".into(),
                                index as u64,
                            ))
                            .debug_selector(move || format!("clip-transition-{index}"))
                            .absolute()
                            .left(px(left))
                            .w(px(band_width))
                            .top(px(2.))
                            .bottom(px(2.))
                            .rounded(px(4.))
                            .border_1()
                            .cursor_pointer()
                            .border_color(accent.opacity(if selected { 1. } else { 0.45 }))
                            .bg(accent.opacity(if selected { 0.28 } else { 0.08 }))
                            .hover(|band| band.bg(accent.opacity(0.22)).border_color(accent))
                            .tooltip_show_delay(crate::ui::TOOLTIP_SHOW_DELAY)
                            .tooltip(move |_window, cx| {
                                ui::Tooltip::new(&theme, label.clone()).view(cx)
                            })
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|_, _, _, cx| cx.stop_propagation()),
                            )
                            .on_click(cx.listener(
                                move |this, event: &gpui::ClickEvent, window, cx| {
                                    if this.transition_popover_index() == Some(index) {
                                        this.transition_popover = None;
                                        cx.notify();
                                        return;
                                    }
                                    this.open_transition_popover(
                                        index,
                                        event.position(),
                                        window,
                                        cx,
                                    );
                                },
                            ))
                            .when(!quiet || selected, |band| {
                                band.child(edge("clip-transition-start", -1.))
                                    .child(edge("clip-transition-end", 1.))
                            }),
                    );
                }
                None => {
                    if quiet
                        || !(hovered == Some(index) || hovered == Some(index - 1))
                        || !crate::editor_clips::can_add_transition(project_timeline, index)
                    {
                        continue;
                    }
                    let left = x - TRANSITION_JOIN_CHIP / 2.;
                    if left + TRANSITION_JOIN_CHIP < 0. || left > lane_width {
                        continue;
                    }
                    layer = layer.child(
                        div()
                            .id(gpui::ElementId::NamedInteger(
                                "clip-transition-add".into(),
                                index as u64,
                            ))
                            .debug_selector(move || format!("clip-transition-add-{index}"))
                            .absolute()
                            .left(px(left))
                            .top(px(3.))
                            .size(px(TRANSITION_JOIN_CHIP))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .border_1()
                            .border_color(Hsla::from(theme.editor.line))
                            .bg(Hsla::from(theme.editor.card))
                            .shadow(theme.editor.pop_shadow())
                            .hover(|chip| {
                                chip.border_color(accent)
                                    .bg(Hsla::from(theme.editor.ctl_hover))
                            })
                            .tooltip_show_delay(crate::ui::TOOLTIP_SHOW_DELAY)
                            .tooltip(move |_window, cx| {
                                ui::Tooltip::new(&theme, tr::editor::window::transition::add())
                                    .view(cx)
                            })
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|_, _, _, cx| cx.stop_propagation()),
                            )
                            .on_click(cx.listener(
                                move |this, event: &gpui::ClickEvent, window, cx| {
                                    this.edit_transition_at(index, event.position(), window, cx);
                                },
                            ))
                            .child(
                                svg()
                                    .path("icons/plus.svg")
                                    .size(px(10.))
                                    .text_color(Hsla::from(theme.editor.text_1)),
                            ),
                    );
                }
            }
        }
        layer.into_any_element()
    }

    pub(super) fn render_transition_popover(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let popover = self.transition_popover?;
        let theme = self.theme;
        let timeline = self.project.timeline.as_ref()?;
        let index = popover.index;
        let current = timeline.effective_transition(index)?;
        let room = crate::editor_clips::max_transition_duration(timeline, index);
        let seconds = |value: f64| {
            tr::editor::window::clip_menu::transition_seconds(crate::i18n::decimal(
                (value * 100.).round() / 100.,
            ))
        };

        let tile = |kind: ClipTransitionType| {
            let selected = current.kind == kind;
            let animated = popover.hovered == Some(kind);
            let preview = if animated {
                div()
                    .child(transition_thumbnail(&theme, kind, 0.))
                    .with_animation(
                        gpui::ElementId::NamedInteger("transition-preview".into(), kind as u64),
                        Animation::new(PREVIEW_LOOP).repeat(),
                        move |_, delta| {
                            div().child(transition_thumbnail(&theme, kind, preview_progress(delta)))
                        },
                    )
                    .into_any_element()
            } else {
                transition_thumbnail(&theme, kind, 0.4).into_any_element()
            };
            div()
                .id(gpui::ElementId::NamedInteger(
                    "transition-kind".into(),
                    kind as u64,
                ))
                .debug_selector(move || format!("transition-kind-{}", kind.wire_name()))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .px(px(2.))
                .py(px(4.))
                .rounded(px(8.))
                .border_1()
                .cursor_pointer()
                .border_color(if selected {
                    Hsla::from(theme.editor.accent)
                } else {
                    gpui::transparent_black()
                })
                .when(selected, |tile| {
                    tile.bg(Hsla::from(theme.editor.ctl_active))
                })
                .hover(|tile| tile.bg(Hsla::from(theme.editor.ctl_hover)))
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if let Some(popover) = this.transition_popover.as_mut() {
                        if *hovered {
                            popover.hovered = Some(kind);
                        } else if popover.hovered == Some(kind) {
                            popover.hovered = None;
                        }
                        cx.notify();
                    }
                }))
                .on_click(cx.listener(move |this, _, window, cx| {
                    let Some(duration) = this
                        .project
                        .timeline
                        .as_ref()
                        .and_then(|timeline| timeline.effective_transition(index))
                        .map(|transition| transition.duration)
                    else {
                        return;
                    };
                    this.set_clip_transition(index, Some((kind, duration)), window, cx);
                }))
                .child(preview)
                .child(
                    div()
                        .w_full()
                        .text_center()
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .text_size(px(10.))
                        .text_color(Hsla::from(if selected {
                            theme.editor.text_1
                        } else {
                            theme.editor.text_2
                        }))
                        .child(transition_label(kind)),
                )
        };

        let chip = |value: f64| {
            let selected = (current.duration - value).abs() < 1e-3;
            div()
                .id(SharedString::from(format!("transition-duration-{value}")))
                .flex_1()
                .rounded(px(6.))
                .px(px(6.))
                .py(px(4.))
                .text_size(px(11.5))
                .text_center()
                .whitespace_nowrap()
                .cursor_pointer()
                .bg(if selected {
                    Hsla::from(theme.editor.ctl_active)
                } else {
                    gpui::transparent_black()
                })
                .text_color(Hsla::from(if selected {
                    theme.editor.text_1
                } else {
                    theme.editor.text_2
                }))
                .hover(|this| this.text_color(Hsla::from(theme.editor.text_1)))
                .child(seconds(value))
                .on_click(cx.listener(move |this, _, window, cx| {
                    let Some(kind) = this
                        .project
                        .timeline
                        .as_ref()
                        .and_then(|timeline| timeline.effective_transition(index))
                        .map(|transition| transition.kind)
                    else {
                        return;
                    };
                    this.set_clip_transition(index, Some((kind, value)), window, cx);
                }))
        };

        let mut card = div()
            .id("transition-popover")
            .debug_selector(|| "transition-popover".into())
            .absolute()
            .left(popover.left)
            .w(px(TRANSITION_POPOVER_WIDTH))
            .flex()
            .flex_col()
            .gap(px(10.))
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .bg(Hsla::from(theme.editor.card))
            .p(px(8.))
            .shadow(theme.editor.pop_shadow())
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.stop_propagation()),
            );
        card = match popover.anchor {
            ClipMenuAnchor::Above { bottom } => card.bottom(bottom),
            ClipMenuAnchor::Below { top } => card.top(top),
        };
        let card = card
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(4.))
                    .pt(px(2.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(tr::editor::window::transition::title()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(11.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(SharedString::from(format!(
                                "{} · {}",
                                transition_label(current.kind),
                                seconds(current.duration)
                            ))),
                    ),
            )
            .child(
                div()
                    .grid()
                    .grid_cols(4)
                    .gap(px(2.))
                    .children(ClipTransitionType::ALL.into_iter().map(tile)),
            )
            .child(div().h(px(1.)).bg(Hsla::from(theme.editor.line)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .px(px(4.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.editor.text_2))
                                    .child(tr::editor::window::transition::duration()),
                            )
                            .child(self.render_number_field(
                                crate::editor_panels::FieldKey::TransitionDuration(index),
                                tr::editor::window::transition::seconds_unit(),
                                64.,
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(2.))
                            .rounded(px(8.))
                            .bg(Hsla::from(theme.editor.ctl))
                            .p(px(2.))
                            .children(
                                CLIP_TRANSITION_DURATIONS
                                    .into_iter()
                                    .filter(|value| *value <= room + 1e-9)
                                    .map(chip),
                            ),
                    ),
            )
            .child(
                clip_menu_row(
                    &theme,
                    "transition-remove",
                    "icons/trash.svg",
                    tr::editor::window::transition::remove(),
                    ClipMenuTrailing::Kbd("backspace"),
                    true,
                    true,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.transition_popover = None;
                    this.set_clip_transition(index, None, window, cx);
                    cx.notify();
                })),
            );

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("transition-popover-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.transition_popover = None;
                            cx.notify();
                        })),
                )
                .child(card)
                .into_any_element(),
        )
    }
}
