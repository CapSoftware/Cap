use gpui::{IntoElement, ParentElement, Styled, div, px};

use super::ShortcutEffect;
use crate::{settings_window::SettingsWindow, ui};

const FORK: bool = cfg!(feature = "ux-walk");
const WALK_SHORTCUTS: bool = cfg!(all(target_os = "macos", feature = "ux-walk"));

pub(super) fn shortcut_label(action: &str) -> Option<&'static str> {
    match action {
        "openUxWalk" if WALK_SHORTCUTS => Some(fork_brand::mode_text_static("Open %walk%")),
        "openUxWalkNotes" if WALK_SHORTCUTS => Some("Open walk notes"),
        _ => None,
    }
}

pub(super) fn shortcut_effect(action: &str) -> Option<ShortcutEffect> {
    Some(match action {
        "openRecordingPickerArea" if crate::store::ux_walk_selected() => ShortcutEffect {
            phrase: || fork_brand::mode_text_static("select an area, then record it in %walk%"),
            sentence: || fork_brand::mode_text_static("Select an area, then record it in %walk%."),
        },
        "openRecordingPickerWindow" if crate::store::ux_walk_selected() => ShortcutEffect {
            phrase: || fork_brand::mode_text_static("choose a window, then record it in %walk%"),
            sentence: || fork_brand::mode_text_static("Choose a window, then record it in %walk%."),
        },
        "openRecordingPickerDisplay" if crate::store::ux_walk_selected() => ShortcutEffect {
            phrase: || fork_brand::mode_text_static("choose a display, then record it in %walk%"),
            sentence: || {
                fork_brand::mode_text_static("Choose a display, then record it in %walk%.")
            },
        },
        "startInstantRecording" if FORK => ShortcutEffect {
            phrase: || "record your selected screen or window in Instant mode, then save it locally when you stop",
            sentence: || "Record your selected screen or window in Instant mode, then save it locally when you stop.",
        },
        "openUxWalk" if WALK_SHORTCUTS => ShortcutEffect {
            phrase: || {
                fork_brand::mode_text_static(
                    "open %walk% setup with the recorder’s capture and audio controls",
                )
            },
            sentence: || {
                fork_brand::mode_text_static(
                    "Open %walk% setup with the recorder’s capture and audio controls.",
                )
            },
        },
        "openUxWalkNotes" if WALK_SHORTCUTS => ShortcutEffect {
            phrase: || {
                fork_brand::mode_text_static(
                    "open notes for your current or most recent %walk% recording",
                )
            },
            sentence: || {
                fork_brand::mode_text_static(
                    "Open notes for your current or most recent %walk% recording.",
                )
            },
        },
        _ => return None,
    })
}

pub(super) fn after_instant_title() -> &'static str {
    if FORK {
        "After sharing a video"
    } else {
        crate::i18n::tr::settings::shortcuts::after_instant::title()
    }
}

pub(super) fn after_instant_hint() -> &'static str {
    if FORK {
        "Recording saves locally. Share from Recordings when you choose."
    } else {
        crate::i18n::tr::settings::shortcuts::after_instant::hint()
    }
}

impl SettingsWindow {
    pub(super) fn render_fork_feedback(&self) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        vec![
            self.section(
                fork_brand::text_static("Cap feedback"),
                Some(fork_brand::text_static(
                    "Report a bug, suggest an improvement or share your workflow with the Cap project.",
                )),
                None,
                vec![
                    ui::Button::settings(
                        &theme,
                        "fork-feedback",
                        ui::ButtonVariant::Dark,
                        ui::ButtonSize::Sm,
                    )
                    .label("Open GitHub issues ↗")
                    .on_click(|_, _, cx| cx.open_url(fork_brand::FEEDBACK_URL))
                    .into_any_element(),
                ],
            )
            .into_any_element(),
        ]
    }

    pub(super) fn render_fork_changelog(&self) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let body = div()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(12.))
            .child(div().text_size(px(13.)).line_height(px(20.)).child(fork_brand::text(
                "This is a developer preview. Follow Cap releases and source changes on GitHub.",
            )))
            .child(
                ui::Button::settings(
                    &theme,
                    "fork-releases",
                    ui::ButtonVariant::Dark,
                    ui::ButtonSize::Sm,
                )
                .label(fork_brand::text("Cap releases ↗"))
                .on_click(|_, _, cx| cx.open_url(fork_brand::RELEASES_URL)),
            )
            .child(
                ui::Button::settings(
                    &theme,
                    "fork-changes",
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .label("View source changes ↗")
                .on_click(|_, _, cx| cx.open_url(fork_brand::CHANGES_URL)),
            );
        vec![
            self.section(
                fork_brand::text_static("Cap updates"),
                Some(fork_brand::mode_text_static(
                    "Native %walk% recording, notes, chapters, transcripts and explicit agent handoffs.",
                )),
                None,
                vec![self.card(true).child(body).into_any_element()],
            )
            .into_any_element(),
        ]
    }
}
