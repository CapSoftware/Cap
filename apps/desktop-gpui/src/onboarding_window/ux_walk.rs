use gpui::{AnyElement, App, FontWeight, Hsla, IntoElement, ParentElement, Styled, div, img, px};

use super::{MODES, ModeDetail, copy, stage};
use crate::{mode_choice::ModeChoice, theme::Theme};

pub(super) const DETAIL: ModeDetail = ModeDetail {
    mode: ModeChoice::UxWalk,
    title: || fork_brand::WALK_MODE_NAME,
    tagline: || "Record, note & review",
    description: || "Walk through your product in a fresh browser window, or choose Diatribe and just talk. Either way your agent gets notes and transcripts.",
    icon: "icons/ux-walk.svg",
    features: [
        || "A fresh browser window",
        || "Or Diatribe: just talk",
        || "Timestamped notes & chapters",
        || "Transcripts for your agent",
    ],
};

pub(super) const CARDS_W: gpui::Pixels = px(if cfg!(target_os = "macos") {
    720.
} else {
    540.
});

pub(super) fn set_recording_mode(mode: ModeChoice, cx: &mut App) {
    if let Some(mode) = mode.capture_mode() {
        crate::app_windows::set_recording_mode(mode, cx);
    }
}

pub(super) fn finish_onboarding(walk_chosen: bool) -> impl FnOnce(&mut App) + 'static {
    move |cx| {
        crate::app_windows::onboarding_finished(cx);
        if walk_chosen {
            ModeChoice::UxWalk.activate(cx);
        }
    }
}

pub(super) fn wordmark(ink: Hsla) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(img("branding/app-icon.png").size(px(36.)))
        .child(copy(fork_brand::APP_NAME, 28., ink).font_weight(FontWeight::SEMIBOLD))
}

pub(super) fn demo(index: usize, theme: &Theme) -> Option<AnyElement> {
    if MODES.get(index)?.mode != ModeChoice::UxWalk {
        return None;
    }
    let paper = stage::Paper::new(theme);
    Some(
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(18.))
            .children(
                [
                    (
                        "1",
                        fork_brand::mode_text_static("Choose %app% or Diatribe"),
                        fork_brand::mode_text_static(
                            "%app% opens a fresh browser window. Diatribe just listens.",
                        ),
                    ),
                    (
                        "2",
                        "Walk through it, or just talk",
                        "Add notes and chapters as you go.",
                    ),
                    (
                        "3",
                        "Hand off to your agent",
                        "It gets the notes and transcripts.",
                    ),
                ]
                .into_iter()
                .map(|(number, title, description)| {
                    div()
                        .flex()
                        .items_start()
                        .gap(px(12.))
                        .child(copy(number, 16., paper.accent).font_weight(FontWeight::BOLD))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(copy(title, 13., paper.ink).font_weight(FontWeight::MEDIUM))
                                .child(copy(description, 11., paper.soft).line_height(px(16.))),
                        )
                }),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::main_window::Mode;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_walk_detail_follows_the_three_upstream_modes() {
        assert_eq!(MODES.len(), 4);
        assert!(MODES[3].mode == ModeChoice::UxWalk);
        assert!(demo(3, &Theme::light()).is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn every_picker_choice_has_its_own_detail() {
        for choice in ModeChoice::ALL.iter().copied() {
            assert!(
                super::super::mode_detail(choice).mode == choice,
                "{choice:?}"
            );
        }
    }

    #[test]
    fn capture_modes_keep_their_upstream_details() {
        for (index, mode) in [Mode::Instant, Mode::Studio, Mode::Screenshot]
            .into_iter()
            .enumerate()
        {
            assert!(MODES[index].mode == ModeChoice::Capture(mode));
        }
    }
}
