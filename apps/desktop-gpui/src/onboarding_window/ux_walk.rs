use gpui::{AnyElement, App, FontWeight, Hsla, IntoElement, ParentElement, Styled, div, img, px};

use super::{MODES, ModeDetail, copy, stage};
use crate::{mode_choice::ModeChoice, theme::Theme};

pub(super) const DETAIL: ModeDetail = ModeDetail {
    mode: ModeChoice::UxWalk,
    title: || fork_brand::WALK_MODE_NAME,
    tagline: || "Record, note & review",
    description: || "Open a fresh browser window, already selected for recording. Walk through your product with native capture controls, notes, chapters and transcripts.",
    icon: "icons/ux-walk.svg",
    features: [
        || "Fresh browser window, ready to record",
        || "Timestamped notes & chapters",
        || "Your transcription provider",
        || "Evidence for your agent",
    ],
};

/// Mode-info details for actions that are not onboarding cards.
pub(super) static ACTIONS: &[ModeDetail] = &[
    #[cfg(target_os = "macos")]
    ModeDetail {
        mode: ModeChoice::Diatribe,
        title: || crate::mode_choice::DIATRIBE_NAME,
        tagline: || "Talk it through",
        description: || "Talk it through; get notes and action items. Recording starts at once on the screen under your pointer, with your microphone, and stops when you say so.",
        icon: crate::mode_choice::DIATRIBE_ICON,
        features: [
            || "Starts recording right away",
            || "Screen and microphone, no camera",
            || "Notes, decisions and questions",
            || "Action items for your agent",
        ],
    },
];

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
                        "Open your walk window",
                        "A new browser window is selected for recording.",
                    ),
                    (
                        "2",
                        "Add notes and chapters",
                        "Keep observations beside the recording.",
                    ),
                    (
                        "3",
                        "Review and hand off",
                        "Give your agent the evidence and context.",
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
    fn every_picker_choice_has_its_own_detail_but_only_modes_are_onboarding_cards() {
        for choice in ModeChoice::ALL.iter().copied() {
            assert!(
                super::super::mode_detail(choice).mode == choice,
                "{choice:?}"
            );
        }
        assert_eq!(
            (super::super::mode_detail(ModeChoice::Diatribe).title)(),
            "Record Diatribe"
        );
        assert!(MODES.iter().all(|detail| detail.mode.selectable()));
        assert!(!ModeChoice::Diatribe.selectable());
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
