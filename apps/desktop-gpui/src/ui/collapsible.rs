//! `Collapsible` -- Kobalte's, with the height animation the Solid app defines
//! in `packages/ui-solid/src/main.css`:
//!
//! ```css
//! @keyframes collapsible-down { from { height: 0 } to { height: var(--kb-collapsible-content-height) } }
//! ```
//!
//! `--kb-collapsible-content-height` is set at runtime by Kobalte, from the
//! content's *measured* natural height. That measurement is the load-bearing
//! half: animating a canned duration against a guessed height reflows the
//! surrounding page wrongly for one frame, every frame.
//!
//! gpui's equivalent of "measure the content" is a [`gpui::canvas`] laid over
//! it, whose prepaint bounds land in a cell -- the same trick the sliders use
//! for their tracks. The content is rendered at its natural size inside a
//! clipped container whose height is animated; until the first measurement
//! lands the container is unconstrained, so the very first expand is a single
//! instant frame rather than a collapse-to-zero flash.
//!
//! The `filter: blur(5px) -> blur(0)` cross-fade in the same keyframe is not
//! reproduced: this gpui rev has no per-element blur (the same gap the
//! teleprompter's vignette and the recording overlay's backdrop have).

use std::{cell::Cell, rc::Rc, time::Instant};

use gpui::{
    AnyElement, App, IntoElement, ParentElement, Pixels, RenderOnce, Styled, Window, canvas, div,
    prelude::FluentBuilder, px,
};

/// `0.2s ease-out`, from the two keyframes.
pub const COLLAPSIBLE_DURATION_SECS: f32 = 0.2;

/// The measured height and the in-flight animation for one collapsible.
///
/// Windows own one per collapsible and drive `tick` from their own frame loop
/// (or simply flip `open` and let the instant path run -- see
/// [`CollapsibleState::height_for`]).
#[derive(Debug, Clone)]
pub struct CollapsibleState {
    open: bool,
    /// The content's natural height, written from prepaint.
    measured: Rc<Cell<Option<Pixels>>>,
    /// When the current open/close transition started, and the height it
    /// started from. `None` once it has settled.
    ///
    /// A `Cell` so `height_for` can retire a finished transition from `&self`:
    /// the windows that own these call it from a `&self` render helper.
    transition: Cell<Option<(Instant, f32)>>,
}

impl Default for CollapsibleState {
    fn default() -> Self {
        Self::new(false)
    }
}

impl CollapsibleState {
    pub fn new(open: bool) -> Self {
        Self {
            open,
            measured: Rc::new(Cell::new(None)),
            transition: Cell::new(None),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// The cell the content's `canvas` writes its prepaint bounds into.
    pub fn measure_cell(&self) -> Rc<Cell<Option<Pixels>>> {
        self.measured.clone()
    }

    /// The natural height, once one frame has been laid out.
    pub fn measured_height(&self) -> Option<Pixels> {
        self.measured.get()
    }

    /// Flip the panel, starting a transition from wherever it is now.
    pub fn toggle(&mut self) {
        self.set_open(!self.open);
    }

    pub fn set_open(&mut self, open: bool) {
        if self.open == open {
            return;
        }
        let from = self.current_height();
        self.open = open;
        // With no measurement yet there is nothing to animate towards, so the
        // first expand of a never-rendered panel is instant.
        self.transition
            .set(self.measured.get().map(|_| (Instant::now(), from)));
    }

    /// Whether a transition is still in flight, i.e. whether the panel has to
    /// stay mounted even though it is on its way out.
    pub fn is_animating(&self) -> bool {
        self.transition.get().is_some()
    }

    /// The height to give the container this frame, and whether another frame
    /// is needed. `None` means "unconstrained": either fully open with no
    /// measurement yet, or fully open with the animation finished, where
    /// pinning a height would stop the panel reflowing if its content changes.
    pub fn height_for(&self, now: Instant) -> (Option<Pixels>, bool) {
        let Some(target) = self.measured.get().map(f32::from) else {
            return (if self.open { None } else { Some(px(0.)) }, false);
        };
        let target = if self.open { target } else { 0. };

        let Some((started, from)) = self.transition.get() else {
            return (
                if self.open { None } else { Some(px(0.)) },
                false,
            );
        };

        let elapsed = now.duration_since(started).as_secs_f32();
        let t = (elapsed / COLLAPSIBLE_DURATION_SECS).clamp(0., 1.);
        // `ease-out`, the same cubic the window resize uses.
        let eased = 1. - (1. - t).powi(3);
        let height = from + (target - from) * eased;

        if t >= 1. {
            self.transition.set(None);
            return (if self.open { None } else { Some(px(0.)) }, false);
        }
        (Some(px(height)), true)
    }

    fn current_height(&self) -> f32 {
        match (self.transition.get(), self.measured.get()) {
            (Some((started, from)), Some(measured)) => {
                let target = if self.open { f32::from(measured) } else { 0. };
                let t = (started.elapsed().as_secs_f32() / COLLAPSIBLE_DURATION_SECS).clamp(0., 1.);
                let eased = 1. - (1. - t).powi(3);
                from + (target - from) * eased
            }
            (None, Some(measured)) if self.open => f32::from(measured),
            (None, Some(_)) => 0.,
            _ => 0.,
        }
    }
}

/// The clipped container. Give it the height [`CollapsibleState::height_for`]
/// returned and the content to measure.
#[derive(IntoElement)]
pub struct Collapsible {
    height: Option<Pixels>,
    measure: Rc<Cell<Option<Pixels>>>,
    content: Option<AnyElement>,
}

impl Collapsible {
    pub fn new(height: Option<Pixels>, measure: Rc<Cell<Option<Pixels>>>) -> Self {
        Self {
            height,
            measure,
            content: None,
        }
    }

    pub fn content(mut self, content: impl IntoElement) -> Self {
        self.content = Some(content.into_any_element());
        self
    }
}

impl RenderOnce for Collapsible {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Collapsible {
            height,
            measure,
            content,
        } = self;

        div()
            .overflow_hidden()
            .when_some(height, |this, height| this.h(height))
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .child(
                        // The measurement. It is inside the natural-size stack
                        // rather than around it, so it reports the content's
                        // height and not the clipped container's.
                        canvas(
                            move |bounds, _window, _cx| measure.set(Some(bounds.size.height)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .children(content),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn measured(state: &CollapsibleState, height: f32) {
        state.measure_cell().set(Some(px(height)));
    }

    #[test]
    fn a_closed_panel_is_zero_high() {
        let state = CollapsibleState::new(false);
        measured(&state, 120.);
        assert_eq!(state.height_for(Instant::now()), (Some(px(0.)), false));
    }

    /// Open and settled means *unconstrained*, not "pinned at the last
    /// measurement" -- otherwise content that grows after the animation ends
    /// would be clipped forever.
    #[test]
    fn a_settled_open_panel_takes_its_natural_height() {
        let state = CollapsibleState::new(true);
        measured(&state, 120.);
        assert_eq!(state.height_for(Instant::now()), (None, false));
    }

    #[test]
    fn the_first_expand_of_an_unmeasured_panel_is_instant() {
        let mut state = CollapsibleState::new(false);
        state.toggle();
        assert!(state.is_open());
        // No measurement yet, so no transition was started and nothing has to
        // be animated.
        assert_eq!(state.height_for(Instant::now()), (None, false));
    }

    #[test]
    fn expanding_animates_from_zero_to_the_measured_height() {
        let mut state = CollapsibleState::new(false);
        measured(&state, 200.);
        state.toggle();

        let start = Instant::now();
        let (height, more) = state.height_for(start);
        assert!(more, "an in-flight transition asks for another frame");
        let height = f32::from(height.expect("mid-transition height"));
        assert!((0. ..200.).contains(&height), "{height}");

        let (height, more) = state.height_for(start + Duration::from_millis(100));
        let height = f32::from(height.expect("mid-transition height"));
        assert!(more);
        // Ease-out is past halfway at the halfway point.
        assert!(height > 100. && height < 200., "{height}");

        let (height, more) = state.height_for(start + Duration::from_millis(220));
        assert!(!more, "the transition has finished");
        assert_eq!(height, None, "and hands the panel back its natural height");
    }

    #[test]
    fn collapsing_animates_back_down_to_zero() {
        let mut state = CollapsibleState::new(true);
        measured(&state, 200.);
        state.toggle();
        assert!(!state.is_open());

        let start = Instant::now();
        let (height, more) = state.height_for(start);
        assert!(more);
        assert!(f32::from(height.expect("height")) > 0.);

        let (height, more) = state.height_for(start + Duration::from_millis(220));
        assert!(!more);
        assert_eq!(height, Some(px(0.)));
    }

    #[test]
    fn re_opening_mid_collapse_starts_from_where_it_is() {
        let mut state = CollapsibleState::new(true);
        measured(&state, 200.);
        state.toggle();
        // Interrupt immediately: the panel is still near its full height, so
        // the re-open must not snap to zero first.
        state.set_open(true);
        let (height, _) = state.height_for(Instant::now());
        let height = f32::from(height.expect("height"));
        assert!(height > 150., "restarted from {height}, not from the top");
    }

    #[test]
    fn setting_the_state_it_already_has_does_nothing() {
        let mut state = CollapsibleState::new(true);
        measured(&state, 200.);
        state.set_open(true);
        assert_eq!(state.height_for(Instant::now()), (None, false));
    }
}
