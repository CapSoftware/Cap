use std::time::{Duration, Instant};

use gpui::{App, ElementId, Entity, Hsla, Window};

const FADE_IN: Duration = Duration::from_millis(90);
const FADE_OUT: Duration = Duration::from_millis(220);

pub struct HoverFade {
    hovered: bool,
    from: f32,
    since: Option<Instant>,
}

impl HoverFade {
    fn level_at(&self, now: Instant) -> (f32, bool) {
        let target = if self.hovered { 1. } else { 0. };
        let Some(since) = self.since else {
            return (target, false);
        };
        let duration = if self.hovered { FADE_IN } else { FADE_OUT };
        let t = (now.saturating_duration_since(since).as_secs_f32() / duration.as_secs_f32())
            .clamp(0., 1.);
        let eased = 1. - (1. - t).powi(3);
        (self.from + (target - self.from) * eased, t < 1.)
    }

    pub fn set_hovered(&mut self, hovered: bool) {
        if hovered == self.hovered {
            return;
        }
        let now = Instant::now();
        self.from = self.level_at(now).0;
        self.hovered = hovered;
        self.since = Some(now);
    }
}

pub fn hover_fade(
    window: &mut Window,
    cx: &mut App,
    id: impl Into<ElementId>,
) -> (Entity<HoverFade>, f32) {
    let state = window.use_keyed_state(id, cx, |_, _| HoverFade {
        hovered: false,
        from: 0.,
        since: None,
    });
    if cx.reduce_motion() {
        let level = if state.read(cx).hovered { 1. } else { 0. };
        return (state, level);
    }
    let (level, animating) = state.read(cx).level_at(Instant::now());
    if animating {
        window.request_animation_frame();
    }
    (state, level)
}

pub fn blend(rest: Hsla, hover: Hsla, level: f32) -> Hsla {
    let rest = gpui::Rgba::from(rest);
    let hover = gpui::Rgba::from(hover);
    crate::theme::mix(rest, hover, level).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_control_rests_without_animating() {
        let fade = HoverFade {
            hovered: false,
            from: 0.,
            since: None,
        };
        assert_eq!(fade.level_at(Instant::now()), (0., false));
    }

    #[test]
    fn hovering_fades_in_and_settles_at_full() {
        let mut fade = HoverFade {
            hovered: false,
            from: 0.,
            since: None,
        };
        fade.set_hovered(true);
        let start = fade.since.unwrap();
        let (mid, animating) = fade.level_at(start + FADE_IN / 2);
        assert!(mid > 0. && mid < 1. && animating);
        assert_eq!(fade.level_at(start + FADE_IN * 2), (1., false));
    }

    #[test]
    fn leaving_mid_fade_starts_from_the_current_level() {
        let mut fade = HoverFade {
            hovered: false,
            from: 0.,
            since: None,
        };
        fade.set_hovered(true);
        let start = fade.since.unwrap();
        let level = fade.level_at(start + FADE_IN / 2).0;
        fade.hovered = false;
        fade.from = level;
        fade.since = Some(start + FADE_IN / 2);
        let (just_after, _) = fade.level_at(start + FADE_IN / 2);
        assert!((just_after - level).abs() < 1e-6);
    }
}
