use std::time::Instant;

use cap_meetings::library::DocMeta;
use gpui::{
    AnyElement, App, ClickEvent, FontWeight, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use super::{
    ask::AskChip,
    style::{self, Palette},
};
use crate::{i18n::tr, meetings::AiAccess};

pub const DISMISSED_KEY: &str = "capAiCardDismissed";
pub const LIVE_DISMISSED_KEY: &str = "capAiLiveLineDismissed";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardKind {
    SignIn,
    Upgrade,
    Spent,
    Write { trial: Option<u32> },
    Unavailable,
}

/// What the quiet line in a live note says when Cap AI will not write the
/// notes at the end of the meeting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveLine {
    SignIn,
    Upgrade,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placeholder {
    WrittenAtEnd,
    Own,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoteState {
    pub meeting: bool,
    pub trashed: bool,
    pub recording: bool,
    pub has_transcript: bool,
    pub has_notes: bool,
    pub generating: bool,
    pub dismissed: bool,
    pub failed: bool,
    pub too_short: bool,
}

impl NoteState {
    fn finished_with_transcript(self) -> bool {
        self.meeting && !self.trashed && !self.recording && self.has_transcript
    }
}

/// An ended meeting with no Cap AI notes shows what Cap captured, the
/// transcript, instead of an empty page.
pub fn shows_transcript(note: NoteState) -> bool {
    note.finished_with_transcript() && !note.has_notes && !note.generating
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Footer {
    Left(u32),
    Last,
}

pub fn card_kind(
    access: AiAccess,
    trial_remaining: Option<u32>,
    note: NoteState,
) -> Option<CardKind> {
    if !shows_transcript(note) {
        return None;
    }
    if access == AiAccess::Unavailable {
        return Some(CardKind::Unavailable);
    }
    if note.dismissed {
        return None;
    }
    Some(match access {
        AiAccess::Ready | AiAccess::Trial { .. } if note.failed || note.too_short => return None,
        AiAccess::Ready => CardKind::Write { trial: None },
        AiAccess::Trial { remaining } => CardKind::Write {
            trial: Some(remaining),
        },
        AiAccess::NeedsSignIn => CardKind::SignIn,
        _ if trial_remaining == Some(0) => CardKind::Spent,
        _ => CardKind::Upgrade,
    })
}

pub fn live_line(access: AiAccess, recording: bool, dismissed: bool) -> Option<LiveLine> {
    if !recording || dismissed {
        return None;
    }
    match access {
        AiAccess::NeedsSignIn => Some(LiveLine::SignIn),
        AiAccess::NeedsUpgrade => Some(LiveLine::Upgrade),
        AiAccess::Unavailable => Some(LiveLine::Unavailable),
        AiAccess::Ready | AiAccess::Trial { .. } => None,
    }
}

/// "Cap writes the notes when the meeting ends" is only true before the
/// meeting ends, and only when Cap AI will write them.
pub fn placeholder(access: AiAccess, note: NoteState) -> Placeholder {
    if access.writes_notes() && !note.has_notes && (note.recording || !note.has_transcript) {
        Placeholder::WrittenAtEnd
    } else {
        Placeholder::Own
    }
}

pub fn ask_visible(access: AiAccess) -> bool {
    access != AiAccess::Unavailable
}

/// The only chip beside Ask: "Write notes" once the offer above the
/// transcript is put away. Suggestions show above the field on focus, so the
/// field itself is never squeezed.
pub fn chip(access: AiAccess, note: NoteState) -> Option<AskChip> {
    if !note.finished_with_transcript() || note.generating || note.has_notes {
        return None;
    }
    match access {
        AiAccess::Ready | AiAccess::Trial { .. } if note.dismissed => Some(AskChip::WriteNotes),
        _ => None,
    }
}

pub fn footer(
    access: AiAccess,
    trial_remaining: Option<u32>,
    written_on_trial: bool,
    has_notes: bool,
    generating: bool,
) -> Option<Footer> {
    if !has_notes || generating {
        return None;
    }
    match access {
        AiAccess::Trial { remaining } => Some(Footer::Left(remaining)),
        AiAccess::NeedsUpgrade if written_on_trial && trial_remaining == Some(0) => {
            Some(Footer::Last)
        }
        _ => None,
    }
}

pub fn is_dismissed(meta: &DocMeta) -> bool {
    flag(meta, DISMISSED_KEY)
}

pub fn live_line_dismissed(meta: &DocMeta) -> bool {
    flag(meta, LIVE_DISMISSED_KEY)
}

fn flag(meta: &DocMeta, key: &str) -> bool {
    meta.extra
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub type Handler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// The card's heading names the meeting when Cap knows its length, so the
/// offer is about this call rather than a feature list.
pub fn card_title(kind: CardKind, minutes: Option<u64>, people: Option<String>) -> String {
    match kind {
        CardKind::Spent => tr::cap_ai::card::spent_title().into(),
        CardKind::Unavailable => tr::cap_ai::card::unavailable_title().into(),
        _ => match (minutes, people) {
            (Some(minutes), Some(names)) => tr::cap_ai::card::title_people(minutes as usize, names),
            (Some(minutes), None) => tr::cap_ai::card::title_call(minutes as usize),
            (None, _) => tr::cap_ai::card::title().into(),
        },
    }
}

/// The offer above an ended meeting's transcript: one line that names the
/// meeting, one action, and a way to put it away. Never a wall.
pub fn render_card(
    palette: &Palette,
    kind: CardKind,
    title: String,
    _shown_at: Instant,
    primary: Handler,
    not_now: Handler,
) -> AnyElement {
    let palette = *palette;
    let action: Option<&'static str> = match kind {
        CardKind::SignIn => Some(tr::cap_ai::card::sign_in()),
        CardKind::Upgrade | CardKind::Spent => Some(tr::cap_ai::card::get_pro()),
        CardKind::Write { .. } => Some(tr::documents::bar::write_notes()),
        CardKind::Unavailable => None,
    };
    let trial = match kind {
        CardKind::Write {
            trial: Some(remaining),
        } => Some(tr::cap_ai::card::free_left(remaining.max(1) as usize)),
        _ => None,
    };
    div()
        .id("cap-ai-card")
        .mt(px(14.))
        .min_h(px(48.))
        .pl(px(16.))
        .pr(px(8.))
        .py(px(7.))
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(10.))
        .rounded(px(14.))
        .border(px(1.5))
        .border_color(palette.track)
        .child(
            div()
                .flex_1()
                .min_w(px(180.))
                .text_size(px(14.))
                .line_height(px(20.))
                .text_color(palette.text)
                .child(title)
                .children(trial.map(|trial| {
                    div()
                        .text_size(px(12.5))
                        .text_color(palette.muted)
                        .child(trial)
                })),
        )
        .child(
            div()
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(4.))
                .children(action.map(|action| {
                    style::ink_pill(&palette, "cap-ai-card-primary")
                        .h(px(32.))
                        .px(px(14.))
                        .child(action)
                        .on_click(primary)
                }))
                .when(kind != CardKind::Unavailable, |el| {
                    el.child(
                        style::icon_button(&palette, "cap-ai-card-not-now", "icons/x.svg", 28.)
                            .tooltip(|_, cx| {
                                crate::ui::Tooltip::new(
                                    &crate::theme::Theme::new(crate::theme::Appearance::Dark),
                                    tr::cap_ai::card::not_now(),
                                )
                                .view(cx)
                            })
                            .on_click(not_now),
                    )
                }),
        )
        .into_any_element()
}

pub fn dock_line(
    palette: &Palette,
    text: String,
    action: Option<(&'static str, Handler)>,
    dismiss: Option<Handler>,
) -> AnyElement {
    let palette = *palette;
    let trailing = action.is_some() || dismiss.is_some();
    div()
        .flex()
        .justify_center()
        .child(
            div()
                .h(px(30.))
                .max_w_full()
                .pl(px(14.))
                .pr(px(if trailing { 4. } else { 14. }))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded_full()
                .border(px(1.5))
                .border_color(palette.track)
                .bg(palette.content)
                .text_size(px(12.5))
                .text_color(palette.muted)
                .child(div().min_w_0().truncate().child(text))
                .when_some(action, |el, (label, handler)| {
                    el.child(
                        div()
                            .id("cap-ai-dock-action")
                            .h(px(22.))
                            .px(px(9.))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .text_color(palette.text)
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(move |s| s.bg(palette.hover))
                            .child(label)
                            .on_click(handler),
                    )
                })
                .when_some(dismiss, |el, handler| {
                    el.child(
                        div()
                            .id("cap-ai-dock-dismiss")
                            .size(px(22.))
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .cursor_pointer()
                            .hover(move |s| s.bg(palette.hover))
                            .child(
                                gpui::svg()
                                    .path("icons/x.svg")
                                    .size(px(11.))
                                    .text_color(palette.faint),
                            )
                            .on_click(handler),
                    )
                }),
        )
        .into_any_element()
}

pub fn live_line_text(line: LiveLine) -> (&'static str, Option<&'static str>) {
    match line {
        LiveLine::SignIn => (
            tr::cap_ai::live::sign_in(),
            Some(tr::cap_ai::card::sign_in()),
        ),
        LiveLine::Upgrade => (
            tr::cap_ai::live::upgrade(),
            Some(tr::cap_ai::card::get_pro()),
        ),
        LiveLine::Unavailable => (tr::cap_ai::live::unavailable(), None),
    }
}

pub fn footer_text(footer: Footer) -> String {
    match footer {
        Footer::Left(n) => tr::cap_ai::footer::left(n as usize),
        Footer::Last => tr::cap_ai::footer::last().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ended(has_notes: bool) -> NoteState {
        NoteState {
            meeting: true,
            has_transcript: true,
            has_notes,
            ..NoteState::default()
        }
    }

    #[test]
    fn write_notes_shows_only_when_it_is_the_next_step() {
        // The card holds "Write notes"; the chip takes over once it is put away.
        assert_eq!(chip(AiAccess::Ready, ended(false)), None);
        let put_away = NoteState {
            dismissed: true,
            ..ended(false)
        };
        assert_eq!(chip(AiAccess::Ready, put_away), Some(AskChip::WriteNotes));
        assert_eq!(
            chip(AiAccess::Trial { remaining: 2 }, put_away),
            Some(AskChip::WriteNotes)
        );
        assert_eq!(
            chip(AiAccess::Ready, ended(true)),
            None,
            "no chip squeezing Ask"
        );
        assert_eq!(chip(AiAccess::NeedsUpgrade, ended(false)), None);
        assert_eq!(chip(AiAccess::NeedsSignIn, ended(false)), None);
        assert_eq!(chip(AiAccess::Unavailable, ended(false)), None);
        let writing = NoteState {
            generating: true,
            ..ended(false)
        };
        assert_eq!(chip(AiAccess::Ready, writing), None);
        let live = NoteState {
            recording: true,
            ..ended(false)
        };
        assert_eq!(chip(AiAccess::Ready, live), None);
        let empty = NoteState {
            has_transcript: false,
            ..ended(false)
        };
        assert_eq!(chip(AiAccess::Ready, empty), None);
    }

    /// The server sets how many meetings are free and may have spent them on
    /// another computer, so the spent card states only that they are used.
    #[test]
    fn the_spent_card_claims_no_count_of_meetings() {
        let title = card_title(CardKind::Spent, Some(42), Some("Ana".into()));
        assert!(!title.chars().any(|c| c.is_ascii_digit()), "{title}");
        assert_eq!(title, "You've used your free Cap AI notes");
    }

    #[test]
    fn the_card_shows_for_locked_notes_until_dismissed() {
        assert_eq!(
            card_kind(AiAccess::NeedsSignIn, None, ended(false)),
            Some(CardKind::SignIn)
        );
        assert_eq!(
            card_kind(AiAccess::NeedsUpgrade, None, ended(false)),
            Some(CardKind::Upgrade)
        );
        assert_eq!(
            card_kind(AiAccess::NeedsUpgrade, Some(0), ended(false)),
            Some(CardKind::Spent)
        );
        assert_eq!(
            card_kind(AiAccess::Ready, None, ended(false)),
            Some(CardKind::Write { trial: None })
        );
        assert_eq!(
            card_kind(AiAccess::Trial { remaining: 1 }, Some(1), ended(false)),
            Some(CardKind::Write { trial: Some(1) })
        );
        assert_eq!(card_kind(AiAccess::NeedsUpgrade, None, ended(true)), None);
        let dismissed = NoteState {
            dismissed: true,
            ..ended(false)
        };
        assert_eq!(card_kind(AiAccess::NeedsUpgrade, None, dismissed), None);
        let other_note = NoteState {
            dismissed: false,
            ..ended(false)
        };
        assert_eq!(
            card_kind(AiAccess::NeedsUpgrade, None, other_note),
            Some(CardKind::Upgrade)
        );
    }

    #[test]
    fn every_access_state_gets_one_card_after_a_meeting() {
        let note = ended(false);
        let cards: Vec<_> = [
            (AiAccess::NeedsSignIn, None),
            (AiAccess::NeedsUpgrade, None),
            (AiAccess::NeedsUpgrade, Some(0)),
            (AiAccess::Ready, None),
            (AiAccess::Trial { remaining: 2 }, Some(2)),
            (AiAccess::Unavailable, None),
        ]
        .into_iter()
        .map(|(access, trial)| card_kind(access, trial, note))
        .collect();
        assert_eq!(
            cards,
            vec![
                Some(CardKind::SignIn),
                Some(CardKind::Upgrade),
                Some(CardKind::Spent),
                Some(CardKind::Write { trial: None }),
                Some(CardKind::Write { trial: Some(2) }),
                Some(CardKind::Unavailable),
            ]
        );
    }

    #[test]
    fn unavailable_says_so_even_after_not_now_and_offers_no_button() {
        let dismissed = NoteState {
            dismissed: true,
            ..ended(false)
        };
        assert_eq!(
            card_kind(AiAccess::Unavailable, None, dismissed),
            Some(CardKind::Unavailable)
        );
        assert_eq!(chip(AiAccess::Unavailable, ended(false)), None);
        assert!(!ask_visible(AiAccess::Unavailable));
        for access in [
            AiAccess::Ready,
            AiAccess::Trial { remaining: 1 },
            AiAccess::NeedsUpgrade,
            AiAccess::NeedsSignIn,
        ] {
            assert!(ask_visible(access));
        }
    }

    #[test]
    fn write_card_steps_aside_for_errors_and_short_calls() {
        let failed = NoteState {
            failed: true,
            ..ended(false)
        };
        let short = NoteState {
            too_short: true,
            ..ended(false)
        };
        assert_eq!(card_kind(AiAccess::Ready, None, failed), None);
        assert_eq!(card_kind(AiAccess::Ready, None, short), None);
        assert_eq!(
            card_kind(AiAccess::NeedsSignIn, None, failed),
            Some(CardKind::SignIn)
        );
    }

    #[test]
    fn an_ended_meeting_without_notes_shows_its_transcript() {
        assert!(shows_transcript(ended(false)));
        assert!(!shows_transcript(ended(true)));
        let writing = NoteState {
            generating: true,
            ..ended(false)
        };
        assert!(!shows_transcript(writing));
        let live = NoteState {
            recording: true,
            ..ended(false)
        };
        assert!(!shows_transcript(live));
        let silent = NoteState {
            has_transcript: false,
            ..ended(false)
        };
        assert!(!shows_transcript(silent));
        let trashed = NoteState {
            trashed: true,
            ..ended(false)
        };
        assert!(!shows_transcript(trashed));
        let dismissed = NoteState {
            dismissed: true,
            ..ended(false)
        };
        assert!(shows_transcript(dismissed));
        assert!(!shows_transcript(NoteState::default()));
    }

    #[test]
    fn the_live_line_shows_only_when_no_notes_will_be_written() {
        assert_eq!(
            live_line(AiAccess::NeedsSignIn, true, false),
            Some(LiveLine::SignIn)
        );
        assert_eq!(
            live_line(AiAccess::NeedsUpgrade, true, false),
            Some(LiveLine::Upgrade)
        );
        assert_eq!(
            live_line(AiAccess::Unavailable, true, false),
            Some(LiveLine::Unavailable)
        );
        assert_eq!(live_line(AiAccess::Ready, true, false), None);
        assert_eq!(live_line(AiAccess::Trial { remaining: 1 }, true, false), None);
        assert_eq!(live_line(AiAccess::NeedsSignIn, false, false), None);
        assert_eq!(live_line(AiAccess::NeedsSignIn, true, true), None);
        for line in [LiveLine::SignIn, LiveLine::Upgrade] {
            assert!(live_line_text(line).1.is_some());
        }
        assert!(live_line_text(LiveLine::Unavailable).1.is_none());
    }

    #[test]
    fn the_placeholder_promises_notes_only_when_they_will_come() {
        let live = NoteState {
            recording: true,
            ..ended(false)
        };
        let upcoming = NoteState {
            meeting: true,
            ..NoteState::default()
        };
        assert_eq!(
            placeholder(AiAccess::Ready, live),
            Placeholder::WrittenAtEnd
        );
        assert_eq!(
            placeholder(AiAccess::Trial { remaining: 1 }, upcoming),
            Placeholder::WrittenAtEnd
        );
        assert_eq!(placeholder(AiAccess::Ready, ended(false)), Placeholder::Own);
        assert_eq!(placeholder(AiAccess::Ready, ended(true)), Placeholder::Own);
        for access in [
            AiAccess::NeedsSignIn,
            AiAccess::NeedsUpgrade,
            AiAccess::Unavailable,
        ] {
            assert_eq!(placeholder(access, live), Placeholder::Own);
            assert_eq!(placeholder(access, upcoming), Placeholder::Own);
            assert_eq!(placeholder(access, ended(false)), Placeholder::Own);
        }
    }

    #[test]
    fn card_titles_name_the_call_when_cap_knows_it() {
        let call = card_title(CardKind::SignIn, Some(36), Some("Hana and Jun".into()));
        assert!(call.contains("36") && call.contains("Hana and Jun"), "{call}");
        let short = card_title(CardKind::Write { trial: None }, Some(4), None);
        assert!(short.contains('4'), "{short}");
        assert_eq!(
            card_title(CardKind::Upgrade, None, None),
            tr::cap_ai::card::title()
        );
        assert_eq!(
            card_title(CardKind::Unavailable, Some(36), None),
            tr::cap_ai::card::unavailable_title()
        );
    }

    #[test]
    fn the_live_line_is_put_away_per_note() {
        let mut meta = DocMeta::new(
            "a".into(),
            cap_meetings::library::DocKind::Meeting,
            chrono::Utc::now(),
        );
        assert!(!live_line_dismissed(&meta));
        meta.extra
            .insert(LIVE_DISMISSED_KEY.into(), serde_json::Value::Bool(true));
        assert!(live_line_dismissed(&meta));
        assert!(!is_dismissed(&meta));
    }

    #[test]
    fn not_now_is_remembered_on_the_note() {
        let mut meta = DocMeta::new(
            "a".into(),
            cap_meetings::library::DocKind::Meeting,
            chrono::Utc::now(),
        );
        assert!(!is_dismissed(&meta));
        meta.extra
            .insert(DISMISSED_KEY.into(), serde_json::Value::Bool(true));
        assert!(is_dismissed(&meta));
        let json = serde_json::to_string(&meta).unwrap();
        let back: DocMeta = serde_json::from_str(&json).unwrap();
        assert!(is_dismissed(&back));
    }

    #[test]
    fn the_trial_footer_counts_down_then_says_last() {
        assert_eq!(
            footer(AiAccess::Trial { remaining: 2 }, Some(2), true, true, false),
            Some(Footer::Left(2))
        );
        assert_eq!(
            footer(AiAccess::NeedsUpgrade, Some(0), true, true, false),
            Some(Footer::Last)
        );
        assert_eq!(
            footer(AiAccess::NeedsUpgrade, Some(0), false, true, false),
            None
        );
        assert_eq!(footer(AiAccess::Ready, None, false, true, false), None);
        assert_eq!(
            footer(
                AiAccess::Trial { remaining: 2 },
                Some(2),
                true,
                false,
                false
            ),
            None
        );
        assert_eq!(
            footer(AiAccess::Trial { remaining: 2 }, Some(2), true, true, true),
            None
        );
    }
}
