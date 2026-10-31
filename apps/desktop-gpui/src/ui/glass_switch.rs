//! The glass switch: the system switch's shape, measured from Apple's own
//! (`scripts/glass-reference`, the `controls` captures): a 54 x 24 track, a
//! 34 x 22 capsule knob inset a point, the accent colour when on. Pressed,
//! the knob swells into a Clear glass lens over the track, as the system's
//! does.

use std::time::{Duration, Instant};

use gpui::{
    App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    RenderOnce, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use super::glass::{self, GlassKind};
use crate::theme::Theme;

const TRACK: (f32, f32) = (54., 24.);
const KNOB: (f32, f32) = (34., 22.);
const KNOB_INSET: f32 = 1.;
/// The lens a pressed knob becomes, overhanging the track.
const LENS: (f32, f32) = (40., 28.);
const TRAVEL: Duration = Duration::from_millis(220);

#[derive(Default)]
struct SwitchState {
    pressed: bool,
    /// The position last drawn and when it changed, for the knob's slide.
    drawn: Option<bool>,
    changed_at: Option<Instant>,
}

#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    checked: bool,
    dark: bool,
    on_click: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>, checked: bool, dark: bool) -> Self {
        Self {
            id: id.into(),
            checked,
            dark,
            on_click: None,
        }
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

/// How far along its slide the knob is, 0 at the old end and 1 at the new.
fn travel(changed_at: Option<Instant>, now: Instant) -> f32 {
    let Some(changed_at) = changed_at else {
        return 1.;
    };
    let t = (now.saturating_duration_since(changed_at).as_secs_f32() / TRAVEL.as_secs_f32())
        .clamp(0., 1.);
    1. - (1. - t).powi(3)
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Switch {
            id,
            checked,
            dark,
            on_click,
        } = self;
        let state = window.use_keyed_state(id.clone(), cx, |_, _| SwitchState::default());
        let now = Instant::now();
        let (pressed, progress) = state.update(cx, |state, _| {
            if state.drawn.is_some_and(|drawn| drawn != checked) {
                state.changed_at = Some(now);
            }
            state.drawn = Some(checked);
            (state.pressed, travel(state.changed_at, now))
        });
        if progress < 1. {
            window.request_animation_frame();
        }

        let off = KNOB_INSET;
        let on = TRACK.0 - KNOB.0 - KNOB_INSET;
        let (from, to) = if checked { (off, on) } else { (on, off) };
        let knob_x = from + (to - from) * progress;
        let track_fill = if checked {
            gpui::rgb(Theme::SETTINGS_ACCENT).into()
        } else if dark {
            gpui::hsla(240. / 360., 0.03, 0.49, 0.36)
        } else {
            gpui::hsla(0., 0., 0., 0.105)
        };

        let knob = if pressed {
            let (width, height) = LENS;
            glass::pane(GlassKind::Clear, dark, height / 2.)
                .absolute()
                .left(px(knob_x + (KNOB.0 - width) / 2.))
                .top(px((TRACK.1 - height) / 2.))
                .w(px(width))
                .h(px(height))
        } else {
            div()
                .absolute()
                .left(px(knob_x))
                .top(px((TRACK.1 - KNOB.1) / 2.))
                .w(px(KNOB.0))
                .h(px(KNOB.1))
                .rounded(px(KNOB.1 / 2.))
                .bg(gpui::white())
                .border_1()
                .border_color(gpui::hsla(0., 0., 0., 0.06))
                .shadow(vec![gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 0., 0.22),
                    offset: gpui::point(px(0.), px(1.)),
                    blur_radius: px(3.),
                    spread_radius: px(0.),
                    inset: false,
                }])
        };

        let press = state.clone();
        let release = state.clone();
        let release_outside = state;
        div()
            .id(id)
            .role(gpui::Role::Switch)
            .aria_toggled(if checked {
                gpui::Toggled::True
            } else {
                gpui::Toggled::False
            })
            .relative()
            .flex_shrink_0()
            .w(px(TRACK.0))
            .h(px(TRACK.1))
            .rounded(px(TRACK.1 / 2.))
            .bg(track_fill)
            .cursor_pointer()
            .child(knob)
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                press.update(cx, |state, cx| {
                    state.pressed = true;
                    cx.notify();
                });
            })
            .on_mouse_up(MouseButton::Left, move |_, _, cx| {
                release.update(cx, |state, cx| {
                    state.pressed = false;
                    cx.notify();
                });
            })
            .on_mouse_up_out(MouseButton::Left, move |_, _, cx| {
                release_outside.update(cx, |state, cx| {
                    state.pressed = false;
                    cx.notify();
                });
            })
            .when_some(on_click, |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_knob_slides_from_end_to_end_and_settles() {
        let start = Instant::now();
        assert_eq!(travel(None, start), 1.);
        assert_eq!(travel(Some(start), start), 0.);
        let mut last = 0.;
        for ms in [20, 60, 110, 160, 219] {
            let t = travel(Some(start), start + Duration::from_millis(ms));
            assert!(t > last && t < 1., "{ms}ms -> {t}");
            last = t;
        }
        assert_eq!(travel(Some(start), start + TRAVEL), 1.);
        assert_eq!(travel(Some(start), start + TRAVEL * 2), 1.);
    }
}
