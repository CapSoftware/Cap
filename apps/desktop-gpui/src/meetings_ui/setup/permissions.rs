//! The permissions step, laid out like the onboarding window's: the list on
//! the left with hand-drawn marks, one permission at a time on a paper card
//! on the right.

use std::time::Instant;

use gpui::{
    AnyElement, Context, Div, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use super::{Ask, SetupWindow};
use crate::{
    doodle::{self, Doodle},
    i18n::tr,
    meetings_ui::{doodles, settings::shared::Access},
    onboarding_doodles as art,
    onboarding_window::{Paper, paper_button},
};

const LIST_W: f32 = 296.;
const STAGE_W: f32 = 420.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Perm {
    Microphone,
    Audio,
    Accessibility,
}

/// Setup asks for Accessibility (speaker names from meeting apps) only on a
/// macOS that can still grant it from a prompt or the Accessibility list:
/// from 27.3 neither works for Cap (issue #4410), so the step would only
/// lead to System & App Protection Override.
pub(crate) fn accessibility_step_shown(on_macos: bool, settings_only: bool) -> bool {
    on_macos && !settings_only
}

impl Perm {
    pub(crate) const ALL: [Perm; 3] = [Perm::Microphone, Perm::Audio, Perm::Accessibility];

    pub(crate) fn index(self) -> usize {
        self as usize
    }

    pub(crate) fn required(self) -> bool {
        self != Perm::Accessibility
    }

    pub(crate) fn slug(self) -> &'static str {
        match self {
            Perm::Microphone => "mic",
            Perm::Audio => "audio",
            Perm::Accessibility => "ax",
        }
    }

    pub(crate) fn from_slug(slug: &str) -> Option<Perm> {
        Self::ALL.into_iter().find(|perm| perm.slug() == slug)
    }

    fn name(self) -> &'static str {
        match self {
            Perm::Microphone => tr::meeting_setup::permissions::mic(),
            Perm::Audio => tr::meeting_setup::permissions::audio(),
            Perm::Accessibility => tr::meeting_setup::permissions::ax(),
        }
    }

    fn doodle(self) -> &'static Doodle {
        match self {
            Perm::Microphone => &art::MICROPHONE,
            Perm::Audio => &doodles::SPEAKER,
            Perm::Accessibility => &doodles::BROWSER,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    Pending,
    Active,
    Granted,
    Skipped,
}

impl Mark {
    pub(crate) fn doodle(self) -> &'static Doodle {
        match self {
            Mark::Pending => &art::MARK_PENDING,
            Mark::Active => &art::MARK_ACTIVE,
            Mark::Granted => &art::MARK_GRANTED,
            Mark::Skipped => &art::MARK_SKIPPED,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stage {
    Permission(Perm),
    AllSet,
}

impl SetupWindow {
    pub(crate) fn access(&self, perm: Perm) -> Access {
        match perm {
            Perm::Microphone => self.mic,
            Perm::Audio => self.audio,
            Perm::Accessibility => self.accessibility,
        }
    }

    pub(crate) fn shown_perms(&self) -> Vec<Perm> {
        let ax = accessibility_step_shown(
            cfg!(target_os = "macos"),
            crate::permissions::grants_are_settings_only(),
        );
        Perm::ALL
            .into_iter()
            .filter(|perm| *perm != Perm::Accessibility || ax)
            .collect()
    }

    fn settled(&self, perm: Perm) -> bool {
        let access = self.access(perm);
        access.ready()
            || access == Access::Unsupported
            || (perm == Perm::Accessibility && self.ax_skipped)
    }

    pub(crate) fn current_stage(&self) -> Stage {
        let shown = self.shown_perms();
        if let Some(focused) = self.focused
            && shown.contains(&focused)
        {
            return Stage::Permission(focused);
        }
        shown
            .into_iter()
            .find(|perm| !self.settled(*perm))
            .map(Stage::Permission)
            .unwrap_or(Stage::AllSet)
    }

    fn mark_for(&self, perm: Perm, stage: Stage) -> Mark {
        let access = self.access(perm);
        if access.ready() {
            Mark::Granted
        } else if access == Access::Unsupported || (perm == Perm::Accessibility && self.ax_skipped)
        {
            Mark::Skipped
        } else if stage == Stage::Permission(perm) {
            Mark::Active
        } else {
            Mark::Pending
        }
    }

    /// Fold the latest grants into marks, focus and the card's entrance
    /// clock. Called from `render`, so every path that changes access is
    /// covered.
    pub(crate) fn sync_stage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        for perm in self.shown_perms() {
            let granted = self.access(perm).ready();
            let was = self.marks[perm.index()].0 == Mark::Granted;
            if granted && !was {
                self.asks[perm.index()] = Ask::Idle;
                let on_screen = self.shown.map(|(stage, _)| stage);
                if on_screen == Some(Stage::Permission(perm)) {
                    self.hold_granted(perm, window, cx);
                }
            }
        }
        let stage = self.current_stage();
        let done = match stage {
            Stage::Permission(perm) => self.access(perm).ready(),
            Stage::AllSet => true,
        };
        if self.shown != Some((stage, done)) {
            if self.shown.is_none_or(|(previous, _)| previous != stage) {
                self.shown_at = now;
            }
            self.shown = Some((stage, done));
        }
        for perm in Perm::ALL {
            let mark = self.mark_for(perm, stage);
            if self.marks[perm.index()].0 != mark {
                self.marks[perm.index()] = (mark, now);
            }
        }
    }

    pub(super) fn render_permissions(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = Paper::new(&self.theme);
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(40.))
            .py(px(24.))
            .gap(px(44.))
            .child(self.render_checklist(&paper, cx))
            .child(self.render_stage(&paper, cx))
            .into_any_element()
    }

    fn render_checklist(&self, paper: &Paper, cx: &mut Context<Self>) -> Div {
        let stage = self.current_stage();
        let still = self.still(cx);
        div()
            .flex()
            .flex_col()
            .w(px(LIST_W))
            .flex_none()
            .child(left_heading(
                paper,
                tr::meeting_setup::permissions::title(),
                self.step_at,
                still,
            ))
            .child(
                div()
                    .mt(px(10.))
                    .text_size(px(14.))
                    .line_height(px(21.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(paper.soft)
                    .child(tr::meeting_setup::permissions::lede()),
            )
            .child(div().mt(px(26.)).flex().flex_col().gap(px(6.)).children(
                self.shown_perms().into_iter().map(|perm| {
                    self.render_check_row(paper, perm, stage == Stage::Permission(perm), cx)
                }),
            ))
    }

    fn caption(&self, perm: Perm, paper: &Paper, mic_requesting: bool) -> (&'static str, Hsla) {
        let access = self.access(perm);
        let ask = self.asks[perm.index()];
        match access {
            Access::Granted => (tr::meeting_setup::permissions::allowed(), paper.green),
            Access::NotNeeded => (tr::meeting_setup::permissions::ready(), paper.green),
            Access::Unsupported => (tr::meeting_setup::permissions::unavailable(), paper.soft),
            _ if perm == Perm::Accessibility && self.ax_skipped => {
                (tr::meeting_setup::permissions::skipped(), paper.soft)
            }
            _ if ask == Ask::Waiting
                || ask == Ask::InSettings
                || (perm == Perm::Microphone && mic_requesting) =>
            {
                (tr::meeting_setup::permissions::waiting(), paper.accent)
            }
            Access::Denied => (tr::meeting_setup::permissions::off(), paper.red),
            _ if perm.required() => (tr::meeting_setup::permissions::required(), paper.soft),
            _ => (tr::meeting_setup::permissions::optional(), paper.soft),
        }
    }

    fn render_check_row(
        &self,
        paper: &Paper,
        perm: Perm,
        active: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (mark, mark_at) = self.marks[perm.index()];
        let mic_requesting = crate::media_access::MediaAccess::global(cx)
            .read(cx)
            .requesting(crate::permissions::OSPermission::Microphone);
        let (caption, caption_color) = self.caption(perm, paper, mic_requesting);
        let paper = *paper;
        div()
            .id(SharedString::from(format!(
                "meeting-perm-row-{}",
                perm.slug()
            )))
            .role(gpui::Role::Button)
            .aria_label(perm.name())
            .aria_description(caption)
            .when(paper.keyboard && !active, crate::ui::keyboard_nav::stop)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(56.))
            .px(px(12.))
            .rounded(px(14.))
            .border(px(1.5))
            .border_color(if active {
                paper.ink
            } else {
                gpui::transparent_black()
            })
            .when(active, |row| row.bg(paper.card))
            .when(!active, |row| {
                row.cursor_pointer()
                    .hover(move |row| row.bg(paper.card))
                    .on_click(cx.listener(move |this, _, _, cx| this.focus_permission(perm, cx)))
            })
            .child(doodle::doodle(
                mark.doodle(),
                paper.palette(),
                mark_at,
                self.still(cx),
                30.,
                30.,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .truncate()
                            .child(perm.name()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(caption_color)
                            .truncate()
                            .child(caption),
                    ),
            )
            .into_any_element()
    }

    fn render_stage(&self, paper: &Paper, cx: &mut Context<Self>) -> AnyElement {
        let stage = self.current_stage();
        let still = self.still(cx);
        let card = div()
            .id("meeting-perm-stage")
            .flex()
            .flex_col()
            .items_center()
            .w(px(STAGE_W))
            .flex_none()
            .min_h(px(420.))
            .justify_center()
            .px(px(36.))
            .py(px(30.))
            .rounded(px(24.))
            .border(px(1.5))
            .border_color(paper.track)
            .bg(paper.card);
        let card = match stage {
            Stage::AllSet => card
                .child(doodle::doodle(
                    &art::ALL_SET,
                    paper.palette(),
                    self.shown_at,
                    still,
                    168.,
                    146.,
                ))
                .child(stage_title(
                    paper,
                    tr::meeting_setup::permissions::done_title(),
                ))
                .child(stage_body(
                    paper,
                    if self.audio.ready() {
                        tr::meeting_setup::permissions::done_body()
                    } else {
                        tr::meeting_setup::permissions::done_mic_only()
                    },
                )),
            Stage::Permission(perm) => {
                let card = card.child(doodle::doodle(
                    perm.doodle(),
                    paper.palette(),
                    self.shown_at,
                    still,
                    168.,
                    146.,
                ));
                self.render_stage_body(card, paper, perm, cx)
            }
        };
        card.into_any_element()
    }

    fn render_stage_body(
        &self,
        card: gpui::Stateful<Div>,
        paper: &Paper,
        perm: Perm,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<Div> {
        let access = self.access(perm);
        let ask = self.asks[perm.index()];
        let still = self.still(cx);
        let mic_requesting = perm == Perm::Microphone
            && crate::media_access::MediaAccess::global(cx)
                .read(cx)
                .requesting(crate::permissions::OSPermission::Microphone);
        if access.ready() {
            return card
                .child(stage_title(paper, done_title(perm)))
                .child(stage_body(paper, done_body(perm)))
                .child(allowed_pill(paper, self.marks[perm.index()].1, still));
        }
        if access == Access::Unsupported {
            let body = if cfg!(target_os = "linux") {
                tr::meeting_setup::permissions::audio_linux()
            } else {
                tr::meeting_setup::permissions::audio_old_macos()
            };
            return card
                .child(stage_title(paper, title(perm)))
                .child(stage_body(paper, body));
        }
        let waiting_prompt = ask == Ask::Waiting || mic_requesting;
        let in_settings = ask == Ask::InSettings;
        let (heading, body) = if waiting_prompt {
            (
                tr::meeting_setup::permissions::prompt_title(),
                tr::meeting_setup::permissions::prompt_body(),
            )
        } else if in_settings {
            (
                tr::meeting_setup::permissions::settings_title(),
                settings_body(perm),
            )
        } else if ask == Ask::NoAnswer {
            (title(perm), tr::meeting_setup::permissions::no_answer())
        } else if access == Access::Denied {
            (title(perm), denied_body(perm))
        } else {
            (title(perm), reason(perm))
        };
        let card = card
            .child(stage_title(paper, heading))
            .child(stage_body(paper, body));
        if waiting_prompt {
            return card.child(waiting(
                paper,
                self.shown_at,
                still,
                tr::meeting_setup::permissions::prompt_waiting(),
            ));
        }
        let primary: (&'static str, bool) = if in_settings {
            (tr::meeting_setup::permissions::open_settings_again(), false)
        } else if ask == Ask::NoAnswer {
            (tr::meeting_setup::permissions::try_again(), true)
        } else if access == Access::Denied {
            (tr::meeting_setup::permissions::open_settings(), true)
        } else {
            (allow_label(perm), true)
        };
        let paper_copy = *paper;
        let row = div()
            .mt(px(24.))
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .justify_center()
            .gap(px(10.))
            .child(paper_button(
                paper,
                SharedString::from(format!("meeting-perm-action-{}", perm.slug())),
                primary.0,
                primary.1,
                true,
                cx.listener(move |this, _, window, cx| this.act(perm, window, cx)),
            ))
            .when(ask == Ask::NoAnswer, |row| {
                row.child(paper_button(
                    &paper_copy,
                    SharedString::from(format!("meeting-perm-settings-{}", perm.slug())),
                    tr::meeting_setup::permissions::open_settings(),
                    false,
                    true,
                    cx.listener(move |this, _, _, cx| this.open_settings_for(perm, cx)),
                ))
            })
            .when(!perm.required(), |row| {
                row.child(paper_button(
                    &paper_copy,
                    "meeting-perm-skip-ax",
                    tr::meeting_setup::permissions::skip(),
                    false,
                    true,
                    cx.listener(|this, _, _, cx| this.skip_accessibility(cx)),
                ))
            });
        let card = card.child(row);
        if in_settings {
            card.child(waiting(
                paper,
                self.shown_at,
                still,
                tr::meeting_setup::permissions::settings_waiting(),
            ))
        } else {
            card
        }
    }

    pub(crate) fn act(&mut self, perm: Perm, window: &mut Window, cx: &mut Context<Self>) {
        let ask = self.asks[perm.index()];
        match perm {
            Perm::Microphone => self.request_microphone(cx),
            Perm::Audio if ask == Ask::InSettings => self.open_audio_settings(cx),
            Perm::Audio => {
                if ask == Ask::NoAnswer {
                    self.asks[perm.index()] = Ask::Idle;
                }
                self.request_audio(window, cx)
            }
            Perm::Accessibility => self.request_accessibility(cx),
        }
    }

    fn open_settings_for(&mut self, perm: Perm, cx: &mut Context<Self>) {
        match perm {
            Perm::Microphone => {
                self.asks[perm.index()] = Ask::InSettings;
                crate::permissions::open_permission_settings(
                    crate::permissions::OSPermission::Microphone,
                );
                cx.notify();
            }
            Perm::Audio => self.open_audio_settings(cx),
            Perm::Accessibility => self.request_accessibility(cx),
        }
    }
}

fn title(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_title(),
        Perm::Audio => tr::meeting_setup::permissions::audio_title(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_title(),
    }
}

fn reason(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_body(),
        Perm::Audio => tr::meeting_setup::permissions::audio_body(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_body(),
    }
}

fn done_title(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_done(),
        Perm::Audio => tr::meeting_setup::permissions::audio_done(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_done(),
    }
}

fn done_body(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_done_body(),
        Perm::Audio => tr::meeting_setup::permissions::audio_done_body(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_done_body(),
    }
}

fn allow_label(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::allow_mic(),
        Perm::Audio => tr::meeting_setup::permissions::allow_audio(),
        Perm::Accessibility => tr::meeting_setup::permissions::allow_ax(),
    }
}

fn denied_body(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_denied(),
        Perm::Audio => tr::meeting_setup::permissions::audio_denied(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_body(),
    }
}

fn settings_body(perm: Perm) -> &'static str {
    match perm {
        Perm::Microphone => tr::meeting_setup::permissions::mic_settings(),
        Perm::Audio => tr::meeting_setup::permissions::audio_settings(),
        Perm::Accessibility => tr::meeting_setup::permissions::ax_settings(),
    }
}

/// A heading set flush left, for the two-column steps.
pub(super) fn left_heading(
    paper: &Paper,
    title: &'static str,
    shown_at: Instant,
    still: bool,
) -> Div {
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(28.))
                .line_height(px(34.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(paper.ink)
                .child(title),
        )
        .child(div().mt(px(2.)).child(doodle::doodle(
            &art::UNDERLINE,
            paper.palette(),
            shown_at,
            still,
            132.,
            12.,
        )))
}

fn stage_title(paper: &Paper, title: &'static str) -> Div {
    div()
        .mt(px(22.))
        .text_size(px(22.))
        .line_height(px(28.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(paper.ink)
        .text_center()
        .child(title)
}

fn stage_body(paper: &Paper, body: &'static str) -> Div {
    div()
        .mt(px(8.))
        .max_w(px(320.))
        .text_size(px(14.))
        .line_height(px(21.))
        .font_weight(FontWeight::NORMAL)
        .text_color(paper.soft)
        .text_center()
        .child(body)
}

fn waiting(paper: &Paper, shown_at: Instant, still: bool, hint: &'static str) -> Div {
    div()
        .mt(px(18.))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(4.))
        .child(doodle::doodle(
            &art::WAITING,
            paper.palette(),
            shown_at,
            still,
            150.,
            16.,
        ))
        .child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::NORMAL)
                .text_color(paper.soft)
                .child(hint),
        )
}

pub(super) fn allowed_pill(paper: &Paper, shown_at: Instant, still: bool) -> Div {
    div()
        .mt(px(24.))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .h(px(42.))
        .px(px(18.))
        .rounded_full()
        .border(px(1.5))
        .border_color(paper.green)
        .text_size(px(14.))
        .text_color(paper.green)
        .child(doodle::doodle(
            &art::MARK_GRANTED,
            paper.palette(),
            shown_at,
            still,
            22.,
            22.,
        ))
        .child(tr::meeting_setup::permissions::allowed())
}
