//! Placeholder shapes for content that is still loading, so a window shows
//! where things will land instead of an empty or wrong state.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, Div, ElementId, IntoElement, Pixels, Styled, div, px,
};

use crate::theme::{RadiusToken, Theme, radius};

const PULSE_PERIOD: Duration = Duration::from_millis(1800);

/// One placeholder bar at a fixed size. Callers stretch it with `.w_full()` /
/// `.flex_1()` where the real content would.
pub fn skeleton_block(theme: &Theme, width: Pixels, height: Pixels) -> Div {
    div()
        .w(width)
        .h(height)
        .flex_none()
        .rounded(radius(RadiusToken::Compact))
        .bg(theme.hover_bg)
}

/// A placeholder bar for a line of text at `text_size`, which sits a little
/// shorter than the line it stands in for.
pub fn skeleton_text(theme: &Theme, width: Pixels, text_size: f32) -> Div {
    skeleton_block(theme, width, px((text_size * 0.75).round())).rounded(radius(RadiusToken::Small))
}

/// Breathes `content`'s opacity while it waits. Pass `animated: false` for a
/// placeholder that should sit still (one that is fading out over real
/// content, or one behind a failure).
pub fn skeleton_pulse(id: impl Into<ElementId>, content: Div, animated: bool) -> AnyElement {
    if !animated {
        return content.into_any_element();
    }
    content
        .with_animation(
            id,
            Animation::new(PULSE_PERIOD).repeat(),
            |element, progress| {
                element.opacity(0.78 + 0.22 * (progress * std::f32::consts::TAU).cos())
            },
        )
        .into_any_element()
}
