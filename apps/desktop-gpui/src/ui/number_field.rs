//! `NumberField` -- Kobalte's, as the config sidebar uses it twice: the
//! Camera3D transition durations (`ConfigSidebar.tsx:4614-4640`) and the clip
//! audio-sync offset (`:6197-6214`).
//!
//! **It is not scrubbable.** Both call sites were read: neither wires a
//! click-drag gesture, and neither renders Kobalte's increment/decrement
//! triggers, so the control is a plain bordered text box (`w-20 p-1.5 border
//! rounded-lg bg-gray-1`) plus Kobalte's own keyboard stepping. Adding a
//! drag-scrub would be a nicer control and a worse transcription; it is left
//! out deliberately.
//!
//! The load-bearing half is the **dual value/rawValue state**. `value` is the
//! text the user is typing and `rawValue` the number the project holds, and
//! they are deliberately allowed to disagree: an in-progress `"-"` or `""` must
//! not clobber the number, and only on blur does the field give up and revert
//! to `"0"` (which both call sites spell out identically). [`NumberFieldState`]
//! is that state machine, pure and unit-tested; the element below just draws
//! it.

use gpui::{
    App, FocusHandle, Hsla, IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Styled,
    Window, div, prelude::FluentBuilder, px,
};

use crate::theme::Theme;

/// The limits a `NumberField.Root` carries: `minValue` / `maxValue` / `step`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NumberLimits {
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

impl NumberLimits {
    pub fn new(min: f64, max: f64, step: f64) -> Self {
        Self { min, max, step }
    }

    /// `Math.min(Math.max(value, min), max)` -- the clamp the transition-duration
    /// call site applies in `onRawValueChange` (`ConfigSidebar.tsx:4617-4623`).
    pub fn clamp(&self, value: f64) -> f64 {
        value.max(self.min).min(self.max)
    }
}

impl Default for NumberLimits {
    fn default() -> Self {
        Self {
            min: f64::NEG_INFINITY,
            max: f64::INFINITY,
            step: 1.,
        }
    }
}

/// What a text change did to the number behind it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NumberChange {
    /// The text parsed: here is the clamped number to write.
    Committed(f64),
    /// The text is a legal work in progress (`""`, `"-"`, `"1."`). The number
    /// is untouched, which is the whole point of the dual state.
    Pending,
}

/// The value/rawValue pair.
#[derive(Debug, Clone)]
pub struct NumberFieldState {
    text: String,
    value: f64,
    limits: NumberLimits,
}

impl NumberFieldState {
    pub fn new(value: f64, limits: NumberLimits) -> Self {
        Self {
            text: format_number(value),
            value,
            limits,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn value(&self) -> f64 {
        self.value
    }

    /// Re-seed from the project when the field is not being typed into --
    /// `createWritableMemo(() => props.value.toString())` re-runs when the
    /// prop changes.
    pub fn sync(&mut self, value: f64) {
        if (value - self.value).abs() > f64::EPSILON {
            self.value = value;
            self.text = format_number(value);
        }
    }

    /// One keystroke's worth of text.
    pub fn set_text(&mut self, text: impl Into<String>) -> NumberChange {
        self.text = text.into();
        match parse_number(&self.text) {
            Some(parsed) => {
                let clamped = self.limits.clamp(parsed);
                self.value = clamped;
                NumberChange::Committed(clamped)
            }
            None => NumberChange::Pending,
        }
    }

    /// `onBlur`: `if (text === "" || Number.isNaN(value)) { setText("0");
    /// onChange(0) }`. Anything that did parse is left exactly as typed --
    /// the source does not re-format it either.
    pub fn blur(&mut self) -> Option<f64> {
        if parse_number(&self.text).is_none() {
            self.text = "0".to_string();
            self.value = 0.;
            return Some(0.);
        }
        None
    }

    /// Kobalte's Arrow Up / Arrow Down, and the `-100 / -10 / +10 / +100` nudge
    /// buttons beside the sync-offset field, which are the same operation with
    /// a bigger delta.
    pub fn nudge(&mut self, delta: f64) -> f64 {
        let next = self.limits.clamp(self.value + delta);
        self.value = next;
        self.text = format_number(next);
        next
    }

    pub fn step(&mut self, up: bool) -> f64 {
        let step = if self.limits.step > 0. {
            self.limits.step
        } else {
            1.
        };
        self.nudge(if up { step } else { -step })
    }
}

/// `Number(text)` as the browser does it for a number field: whitespace is
/// trimmed, and anything that is not a finite number is "still typing" rather
/// than a value. `""`, `"-"` and `"."` all fall in that bucket, which is what
/// keeps a half-typed negative from writing zero into the project.
pub fn parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// `value.toString()`: an integral value prints without a decimal point, which
/// is what makes the offset field read `-100` rather than `-100.0`.
pub fn format_number(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.6}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// The drawn field: `w-20 p-1.5 border rounded-lg bg-gray-1`, with an optional
/// unit label beside it (`s` / `ms` at both call sites).
#[derive(IntoElement)]
pub struct NumberField {
    text: SharedString,
    unit: Option<SharedString>,
    focus: Option<FocusHandle>,
    focused: bool,
    width: Pixels,
    bg: Hsla,
    border: Hsla,
    text_color: Hsla,
    unit_color: Hsla,
}

impl NumberField {
    /// The editor surface. Tailwind v4's bare `border` is `currentColor`, and
    /// this project sets no compat default, so the box's hairline really is the
    /// text colour rather than a gray step.
    pub fn plain(theme: &Theme, text: impl Into<SharedString>) -> Self {
        Self {
            text: text.into(),
            unit: None,
            focus: None,
            focused: false,
            // `w-20`
            width: px(80.),
            bg: Hsla::from(theme.gray_1),
            border: Hsla::from(theme.gray_12),
            text_color: Hsla::from(theme.gray_12),
            unit_color: Hsla::from(theme.gray_11),
        }
    }

    pub fn unit(mut self, unit: impl Into<SharedString>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    pub fn focus(mut self, focus: &FocusHandle, focused: bool) -> Self {
        self.focus = Some(focus.clone());
        self.focused = focused;
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.width = width;
        self
    }
}

impl RenderOnce for NumberField {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let NumberField {
            text,
            unit,
            focus,
            focused,
            width,
            bg,
            border,
            text_color,
            unit_color,
        } = self;

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .child(
                div()
                    .when_some(focus.as_ref(), |this, focus| {
                        gpui::InteractiveElement::track_focus(this, focus)
                    })
                    .flex()
                    .flex_row()
                    .items_center()
                    .w(width)
                    // `p-1.5`
                    .p(px(6.))
                    .rounded(px(8.))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .text_color(text_color)
                    .child(div().flex_1().min_w_0().truncate().child(text))
                    .when(focused, |this| {
                        this.child(div().w(px(1.)).h(px(14.)).flex_shrink_0().bg(text_color))
                    }),
            )
            .children(unit.map(|unit| div().text_color(unit_color).child(unit)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_half_typed_number_does_not_clobber_the_value() {
        let mut state = NumberFieldState::new(0.5, NumberLimits::new(0., 2., 0.05));
        assert_eq!(state.text(), "0.5");
        assert_eq!(state.set_text("-"), NumberChange::Pending);
        assert_eq!(state.value(), 0.5);
        assert_eq!(state.set_text(""), NumberChange::Pending);
        assert_eq!(state.value(), 0.5);
        assert_eq!(state.set_text("1.25"), NumberChange::Committed(1.25));
        assert_eq!(state.value(), 1.25);
    }

    #[test]
    fn typed_values_clamp_to_the_limits() {
        // `CAMERA3D_TRANSITION_LIMITS` is `{min: 0, max: 2, step: 0.05}`.
        let mut state = NumberFieldState::new(0.5, NumberLimits::new(0., 2., 0.05));
        assert_eq!(state.set_text("9"), NumberChange::Committed(2.));
        assert_eq!(state.set_text("-4"), NumberChange::Committed(0.));
    }

    #[test]
    fn blur_reverts_an_unparseable_field_to_zero() {
        let mut state = NumberFieldState::new(3., NumberLimits::default());
        state.set_text("");
        assert_eq!(state.blur(), Some(0.));
        assert_eq!(state.text(), "0");
        assert_eq!(state.value(), 0.);

        // A field that parsed is left exactly as typed.
        let mut state = NumberFieldState::new(3., NumberLimits::default());
        state.set_text("007");
        assert_eq!(state.blur(), None);
        assert_eq!(state.text(), "007");
        assert_eq!(state.value(), 7.);
    }

    #[test]
    fn nudging_steps_and_clamps() {
        // The sync-offset field's four buttons, in milliseconds.
        let mut state = NumberFieldState::new(0., NumberLimits::new(-500., 500., 1.));
        assert_eq!(state.nudge(100.), 100.);
        assert_eq!(state.nudge(-10.), 90.);
        assert_eq!(state.text(), "90");
        assert_eq!(state.nudge(1000.), 500.);

        let mut state = NumberFieldState::new(1.0, NumberLimits::new(0., 2., 0.05));
        assert!((state.step(true) - 1.05).abs() < 1e-9);
        assert!((state.step(false) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn numbers_print_the_way_tostring_does() {
        assert_eq!(format_number(0.), "0");
        assert_eq!(format_number(-100.), "-100");
        assert_eq!(format_number(0.05), "0.05");
        assert_eq!(format_number(1.5), "1.5");
    }

    #[test]
    fn parsing_rejects_the_work_in_progress_strings() {
        assert_eq!(parse_number("  12 "), Some(12.));
        assert_eq!(parse_number("-3.5"), Some(-3.5));
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("-"), None);
        assert_eq!(parse_number("abc"), None);
        assert_eq!(parse_number("inf"), None);
    }

    #[test]
    fn syncing_from_the_project_replaces_the_text() {
        let mut state = NumberFieldState::new(1., NumberLimits::default());
        state.sync(1.);
        assert_eq!(state.text(), "1");
        state.sync(2.5);
        assert_eq!(state.text(), "2.5");
        assert_eq!(state.value(), 2.5);
    }
}
