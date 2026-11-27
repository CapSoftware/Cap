use std::time::{Duration, Instant};

use cap_meetings::{prompt::AutoRecord, settings::Engine};
use chrono::Utc;
use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, Div, FontWeight, Hsla, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder, px, svg,
};

use super::{Mark, SetupMenu, SetupWindow, Step, permissions::left_heading};

#[derive(Clone, Copy)]
enum Fix {
    Go(Step),
    /// Sign in (`true`) or Get Cap Pro, with the link's label.
    CapAi(&'static str, bool),
}
use crate::{
    doodle::{self, Doodle},
    i18n::tr,
    meetings::{Meetings, SourceConfig},
    meetings_ui::{
        doodles,
        settings::{
            accounts::{self, Phase},
            auto_record_label, lead_label,
            shared::{self, Access, CloudState, ModelState, SourcePhase},
        },
    },
    onboarding_window::{Paper, close_dot, pager, paper_card, paper_heading, primary_pill},
    theme::LocaleFont as _,
    ui,
};

const HEADER_H: f32 = crate::onboarding_window::ONBOARDING_HEADER_HEIGHT;

fn ease(value: f32) -> f32 {
    value * value * (3. - 2. * value)
}

fn glyph(path: &'static str, size: f32, color: Hsla) -> gpui::Svg {
    svg()
        .path(path)
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

fn text(content: impl Into<SharedString>, size: f32, line: f32, color: Hsla) -> Div {
    div()
        .text_size(px(size))
        .line_height(px(line))
        .font_weight(FontWeight::NORMAL)
        .text_color(color)
        .child(content.into())
}

/// A compact ink pill for actions inside cards; `primary` fills it.
fn small_button(
    paper: &Paper,
    id: impl Into<gpui::ElementId>,
    label: &'static str,
    primary: bool,
    enabled: bool,
) -> gpui::Stateful<Div> {
    let paper = *paper;
    let (bg, fg, border) = if primary {
        (paper.ink, paper.bg, paper.ink)
    } else {
        (gpui::transparent_black(), paper.ink, paper.track)
    };
    div()
        .id(id.into())
        .role(gpui::Role::Button)
        .aria_label(label)
        .when(paper.keyboard && enabled, crate::ui::keyboard_nav::stop)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .h(px(32.))
        .px(px(14.))
        .rounded_full()
        .border(px(1.5))
        .border_color(border)
        .bg(bg)
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .whitespace_nowrap()
        .child(label)
        .when(!enabled, |button| button.opacity(0.45))
        .when(enabled, |button| {
            button.cursor_pointer().hover(move |button| {
                if primary {
                    button.opacity(0.88)
                } else {
                    button.border_color(paper.soft)
                }
            })
        })
}

fn quiet_link(
    paper: &Paper,
    id: impl Into<gpui::ElementId>,
    label: &'static str,
) -> gpui::Stateful<Div> {
    let paper = *paper;
    div()
        .id(id.into())
        .role(gpui::Role::Link)
        .aria_label(label)
        .when(paper.keyboard, crate::ui::keyboard_nav::stop)
        .text_size(px(13.))
        .text_color(paper.soft)
        .cursor_pointer()
        .hover(move |el| el.text_color(paper.ink))
        .child(label)
}

impl SetupWindow {
    fn paper(&self) -> Paper {
        Paper {
            keyboard: self.keyboard,
            ..Paper::new(&self.theme)
        }
    }

    fn doodle(
        &self,
        art: &'static Doodle,
        delay: u64,
        width: f32,
        height: f32,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let paper = self.paper();
        div().flex_none().child(doodle::doodle(
            art,
            paper.palette(),
            self.step_at + Duration::from_millis(delay),
            self.still(cx),
            width,
            height,
        ))
    }

    fn mark(&self, mark: Mark, at: Instant, size: f32, cx: &Context<Self>) -> impl IntoElement {
        doodle::doodle(
            mark.doodle(),
            self.paper().palette(),
            at,
            self.still(cx),
            size,
            size,
        )
    }

    /// Cards rise 16px and fade in, staggered by 100ms, like the overview's.
    fn rise(
        &self,
        el: impl IntoElement + 'static,
        key: &'static str,
        index: usize,
        cx: &Context<Self>,
    ) -> AnyElement {
        let el = div().w_full().flex_1().flex().flex_col().child(el);
        if self.still(cx) {
            return el.into_any_element();
        }
        el.with_animation(
            (key, self.step_revision * 10 + index),
            Animation::new(Duration::from_millis(700 + index as u64 * 100)),
            move |el, t| {
                let delay = index as f32 * 100. / (700. + index as f32 * 100.);
                let t = ease(((t - delay) / (1. - delay)).clamp(0., 1.));
                el.relative().top(px(16. * (1. - t))).opacity(t)
            },
        )
        .into_any_element()
    }

    fn heading(&self, title: &'static str, subtitle: &'static str, cx: &Context<Self>) -> Div {
        paper_heading(
            &self.paper(),
            title,
            Some(subtitle.into()),
            self.step_at,
            self.still(cx),
        )
    }

    fn page(&self) -> Div {
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(48.))
            .py(px(24.))
            .gap(px(32.))
    }

    fn render_welcome(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let ideas: [(&'static Doodle, &'static str, &'static str); 3] = [
            (
                &doodles::CALL,
                tr::meeting_setup::welcome::notices_title(),
                tr::meeting_setup::welcome::notices_body(),
            ),
            (
                &doodles::RECORD,
                tr::meeting_setup::welcome::records_title(),
                tr::meeting_setup::welcome::records_body(),
            ),
            (
                &doodles::NOTES,
                tr::meeting_setup::welcome::notes_title(),
                tr::meeting_setup::welcome::notes_body(),
            ),
        ];
        let cards: Vec<AnyElement> = ideas
            .into_iter()
            .enumerate()
            .map(|(index, (art, title, body))| {
                let card = paper_card(&paper)
                    .w_full()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(10.))
                    .px(px(18.))
                    .pt(px(22.))
                    .pb(px(24.))
                    .child(self.doodle(art, index as u64 * 180, 96., 84., cx))
                    .child(
                        div()
                            .mt(px(4.))
                            .text_size(px(15.))
                            .line_height(px(20.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .text_center()
                            .child(title),
                    )
                    .child(text(body, 12., 17., paper.soft).text_center());
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(self.rise(card, "meeting-welcome-card", index, cx))
                    .into_any_element()
            })
            .collect();
        self.page()
            .child(self.heading(
                tr::meeting_setup::welcome::title(),
                tr::meeting_setup::welcome::subtitle(),
                cx,
            ))
            .child(
                div()
                    .flex()
                    .gap(px(16.))
                    .w_full()
                    .max_w(px(600.))
                    .children(cards),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(glyph("icons/lock.svg", 13., paper.soft))
                    .child(text(
                        tr::meeting_setup::welcome::privacy(),
                        13.,
                        18.,
                        paper.soft,
                    )),
            )
            .into_any_element()
    }

    fn engine_footer_local(&self, selected: bool, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let notes = shared::notes_model(&self.settings);
        let column = div().flex().flex_col().items_center().gap(px(8.)).w_full();
        let name = notes.model.name;
        let state = notes.state.clone();
        let size = notes.model.size;
        let note = match notes.why {
            // Said once, under the two cards (`slow_device_note`).
            shared::NotesModelWhy::Tuned | shared::NotesModelWhy::Slow => None,
            shared::NotesModelWhy::NeedsAppleSilicon => {
                Some(tr::meeting_setup::transcription::intel_note())
            }
            shared::NotesModelWhy::Language => {
                Some(tr::meeting_setup::transcription::language_note())
            }
        };
        let control: AnyElement = match state {
            ModelState::Downloading(progress) => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(7.))
                .w_full()
                .child(
                    div()
                        .h(px(6.))
                        .w_full()
                        .max_w(px(200.))
                        .rounded_full()
                        .bg(paper.track)
                        .overflow_hidden()
                        .child(
                            div()
                                .h_full()
                                .w(gpui::relative(((progress / 100.) as f32).clamp(0.02, 1.)))
                                .rounded_full()
                                .bg(paper.accent),
                        ),
                )
                .child(text(
                    tr::settings::meetings::transcription::downloading(progress.round() as u32),
                    12.,
                    16.,
                    paper.ink,
                ))
                .child(
                    text(
                        tr::meeting_setup::transcription::continue_note(),
                        12.,
                        16.,
                        paper.soft,
                    )
                    .text_center(),
                )
                .into_any_element(),
            ModelState::Ready => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .child(self.mark(Mark::Granted, self.step_at, 20., cx))
                .child(text(
                    tr::meeting_setup::transcription::ready(),
                    13.,
                    18.,
                    paper.green,
                ))
                .into_any_element(),
            ModelState::Failed => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .child(text(
                    tr::meeting_setup::transcription::failed(),
                    12.,
                    16.,
                    paper.red,
                ))
                .child(
                    small_button(
                        &paper,
                        "meeting-setup-retry-download",
                        tr::meeting_setup::transcription::retry(),
                        false,
                        true,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.download(name, window, cx)
                    })),
                )
                .into_any_element(),
            _ => div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .child(
                    text(
                        tr::meeting_setup::transcription::download_note(shared::mega_size(size)),
                        12.,
                        16.,
                        paper.soft,
                    )
                    .text_center(),
                )
                .child(
                    small_button(
                        &paper,
                        "meeting-setup-download",
                        tr::meeting_setup::transcription::download(),
                        selected,
                        true,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.download(name, window, cx)
                    })),
                )
                .into_any_element(),
        };
        column
            .child(control)
            .children(note.map(|note| text(note, 12., 17., paper.soft).text_center()))
            .into_any_element()
    }

    fn engine_footer_cloud(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let (note, action): (&'static str, Option<(&'static str, fn(&mut gpui::App))>) =
            match self.cloud {
                CloudState::Available => {
                    return div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .child(self.mark(Mark::Granted, self.step_at, 20., cx))
                        .child(text(
                            tr::meeting_setup::transcription::cloud_ready(),
                            13.,
                            18.,
                            paper.green,
                        ))
                        .into_any_element();
                }
                CloudState::SignedOut => (
                    tr::settings::meetings::transcription::cloud_signed_out(),
                    Some((
                        tr::settings::meetings::transcription::sign_in(),
                        shared::sign_in,
                    )),
                ),
                CloudState::Free => (
                    tr::settings::meetings::transcription::cloud_free(),
                    Some((
                        tr::settings::meetings::transcription::upgrade(),
                        shared::upgrade,
                    )),
                ),
                CloudState::Checking => (
                    tr::settings::meetings::transcription::cloud_checking(),
                    None,
                ),
                CloudState::Unavailable => (
                    tr::settings::meetings::transcription::cloud_unavailable(),
                    None,
                ),
                CloudState::Offline => (
                    tr::settings::meetings::transcription::cloud_offline(),
                    Some((
                        tr::settings::meetings::transcription::retry(),
                        shared::retry_capabilities,
                    )),
                ),
            };
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .child(text(note, 12., 16., paper.soft).text_center())
            .children(action.map(|(label, act)| {
                small_button(&paper, "meeting-setup-cloud-action", label, false, true).on_click(
                    cx.listener(move |_, _, _, cx| {
                        cx.stop_propagation();
                        act(cx)
                    }),
                )
            }))
            .into_any_element()
    }

    fn engine_card(
        &self,
        index: usize,
        art: &'static Doodle,
        title: &'static str,
        body: &'static str,
        selected: bool,
        enabled: bool,
        footer: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let paper = self.paper();
        let engine = if index == 0 {
            Engine::Cloud
        } else {
            Engine::Local
        };
        let (mark, mark_at) = if selected {
            (Mark::Active, self.step_at)
        } else {
            (Mark::Pending, self.step_at)
        };
        let card = paper_card(&paper)
            .id(("meeting-setup-engine", index))
            .role(gpui::Role::RadioButton)
            .when(paper.keyboard && enabled, crate::ui::keyboard_nav::stop)
            .aria_label(title)
            .aria_description(body)
            .aria_toggled(if selected {
                gpui::Toggled::True
            } else {
                gpui::Toggled::False
            })
            .relative()
            .w_full()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .px(px(22.))
            .pt(px(24.))
            .pb(px(22.))
            .border_color(if selected { paper.ink } else { paper.track })
            .when(enabled && !selected, |el| {
                el.cursor_pointer()
                    .hover(move |el| el.border_color(paper.soft))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.update_settings(cx, |s| s.transcription.engine = engine)
                    }))
            })
            .child(
                div()
                    .absolute()
                    .top(px(14.))
                    .right(px(14.))
                    .child(self.mark(mark, mark_at, 26., cx)),
            )
            .child(self.doodle(art, index as u64 * 180, 104., 90., cx))
            .child(
                div()
                    .mt(px(2.))
                    .text_size(px(17.))
                    .line_height(px(22.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(paper.ink)
                    .child(title),
            )
            .child(
                text(body, 13., 19., paper.soft)
                    .text_center()
                    .max_w(px(220.)),
            )
            .child(
                div()
                    .mt(px(10.))
                    .pt(px(14.))
                    .w_full()
                    .min_h(px(70.))
                    .border_t(px(1.5))
                    .border_color(paper.track)
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(footer),
            );
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(self.rise(card, "meeting-engine-card", index, cx))
            .into_any_element()
    }

    /// A computer too slow for live local captions, said once under the
    /// choice: with this computer's model, that it is the only compatible
    /// one and Cap Cloud is recommended (switch to it when the account has
    /// it; the card offers sign in and upgrade);
    /// with Cap Cloud, that its lines come a moment after speech.
    fn slow_device_note(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let local = self.settings.transcription.engine == Engine::Local;
        let (note, action) = if local {
            (
                tr::settings::meetings::transcription::slow_model(),
                // Sign in and upgrade sit on the Cap Cloud card already.
                shared::cloud_action(self.cloud)
                    .filter(|action| *action == shared::CloudAction::UseCloud),
            )
        } else {
            (tr::settings::meetings::transcription::slow_device(), None)
        };
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .max_w(px(460.))
            .child(text(note, 12., 17., paper.soft).text_center())
            .children(action.map(|action| {
                quiet_link(&paper, "meeting-setup-slow-device", action.label())
                    .text_color(paper.accent)
                    .on_click(cx.listener(move |this, _, _, cx| this.run_cloud_action(action, cx)))
            }))
            .into_any_element()
    }

    /// The slow computer note's action: switch to Cap Cloud (sign in and
    /// upgrade are on the Cap Cloud card).
    pub(crate) fn run_cloud_action(&mut self, action: shared::CloudAction, cx: &mut Context<Self>) {
        match action {
            shared::CloudAction::SignIn => cx.defer(crate::meetings_ui::cap_ai::sign_in),
            shared::CloudAction::Upgrade => cx.defer(|cx| {
                crate::meetings_ui::cap_ai::open_upgrade(
                    None,
                    crate::meetings_ui::cap_ai::Host::Window,
                    cx,
                )
            }),
            shared::CloudAction::UseCloud => {
                self.update_settings(cx, |s| s.transcription.engine = Engine::Cloud)
            }
        }
    }

    fn render_transcription(&self, cx: &mut Context<Self>) -> AnyElement {
        let engine = self.settings.transcription.engine;
        let cloud_footer = self.engine_footer_cloud(cx);
        let local_footer = self.engine_footer_local(engine == Engine::Local, cx);
        let cloud = self.engine_card(
            0,
            &doodles::CLOUD,
            tr::settings::meetings::transcription::cloud(),
            tr::meeting_setup::transcription::cloud_body(),
            engine == Engine::Cloud,
            self.cloud.selectable(),
            cloud_footer,
            cx,
        );
        let local = self.engine_card(
            1,
            &doodles::LAPTOP,
            shared::local_label(),
            tr::meeting_setup::transcription::local_body(),
            engine == Engine::Local,
            true,
            local_footer,
            cx,
        );
        self.page()
            .child(self.heading(
                tr::meeting_setup::transcription::title(),
                tr::meeting_setup::transcription::subtitle(),
                cx,
            ))
            .child(
                div()
                    .flex()
                    .gap(px(16.))
                    .w_full()
                    .max_w(px(580.))
                    .child(cloud)
                    .child(local),
            )
            .when(crate::meetings::device::slow(), |page| {
                page.child(self.slow_device_note(cx))
            })
            .into_any_element()
    }

    fn calendar_row(
        &self,
        first: bool,
        icon: &'static str,
        title: SharedString,
        detail: SharedString,
        detail_color: Hsla,
        trailing: AnyElement,
    ) -> Div {
        let paper = self.paper();
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(14.))
            .px(px(18.))
            .py(px(14.))
            .when(!first, |el| el.border_t(px(1.5)).border_color(paper.track))
            .child(
                div()
                    .size(px(36.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border(px(1.5))
                    .border_color(paper.track)
                    .child(glyph(icon, 16., paper.ink)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(19.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .truncate()
                            .child(title),
                    )
                    .child(text(detail, 12., 16., detail_color)),
            )
            .child(div().flex_none().child(trailing))
    }

    fn connected_mark(&self, cx: &Context<Self>) -> AnyElement {
        let paper = self.paper();
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.))
            .child(self.mark(Mark::Granted, self.step_at, 22., cx))
            .child(text(
                tr::meeting_setup::calendar::connected(),
                13.,
                18.,
                paper.green,
            ))
            .into_any_element()
    }

    fn render_calendar(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let meetings = Meetings::global(cx);
        let (links, syncing, total, has_system) = {
            let m = meetings.read(cx);
            let syncing = m.calendar_syncing();
            let links: Vec<_> = m
                .calendar_sources()
                .iter()
                .filter(|s| matches!(s.config, SourceConfig::Ics { .. }))
                .map(|s| {
                    (
                        shared::source_title(s),
                        shared::source_phase(s, syncing),
                        m.upcoming_count(&s.id),
                    )
                })
                .collect();
            let total = m
                .upcoming_events(Utc::now(), chrono::Duration::days(14))
                .len();
            let has_system = m
                .calendar_sources()
                .iter()
                .any(|s| matches!(s.config, SourceConfig::System));
            (links, syncing, total, has_system)
        };
        let account_rows = accounts::rows(cx);
        let mut rows: Vec<Div> = Vec::new();
        for row in account_rows {
            let provider = row.provider;
            let detail = accounts::detail(&row);
            let detail_color = match &row.phase {
                Phase::Failed(_) => paper.red,
                Phase::Waiting | Phase::Finishing => paper.accent,
                _ => paper.soft,
            };
            let trailing: AnyElement = match accounts::action(&row.phase) {
                None => self.connected_mark(cx),
                Some(action) => small_button(
                    &paper,
                    gpui::ElementId::Name(
                        format!("meeting-setup-account-{}", accounts::slug(provider)).into(),
                    ),
                    accounts::action_label(action),
                    action != accounts::Action::Cancel,
                    row.phase != Phase::Blocked,
                )
                .when(row.phase != Phase::Blocked, |el| {
                    el.on_click(cx.listener(move |_, _, _, cx| {
                        accounts::run(action, provider, cx);
                    }))
                })
                .into_any_element(),
            };
            rows.push(self.calendar_row(
                rows.is_empty(),
                accounts::icon(provider),
                accounts::name(provider).into(),
                detail.into(),
                detail_color,
                trailing,
            ));
        }
        if cfg!(target_os = "macos") {
            let (detail, color): (&'static str, Hsla) = if self.calendar_requesting {
                (tr::meeting_setup::calendar::system_waiting(), paper.accent)
            } else if self.calendar == Access::Denied && !has_system {
                (tr::settings::meetings::calendars::error_access(), paper.red)
            } else {
                (
                    tr::meeting_setup::calendar::system_description(),
                    paper.soft,
                )
            };
            let trailing: AnyElement = if has_system {
                self.connected_mark(cx)
            } else if self.calendar_requesting {
                div().into_any_element()
            } else if self.calendar == Access::Denied {
                small_button(
                    &paper,
                    "meeting-setup-calendar-settings",
                    tr::settings::meetings::calendars::open_settings(),
                    false,
                    true,
                )
                .on_click(cx.listener(|_, _, _, _| shared::open_calendar_settings()))
                .into_any_element()
            } else {
                small_button(
                    &paper,
                    "meeting-setup-calendar-connect",
                    tr::meeting_setup::calendar::connect(),
                    true,
                    true,
                )
                .on_click(cx.listener(|this, _, window, cx| this.connect_system(window, cx)))
                .into_any_element()
            };
            rows.push(self.calendar_row(
                rows.is_empty(),
                "icons/calendar.svg",
                tr::settings::meetings::calendars::system().into(),
                detail.into(),
                color,
                trailing,
            ));
        }

        let link_toggle = quiet_link(
            &paper,
            "meeting-setup-link-toggle",
            tr::meeting_setup::calendar::link_toggle(),
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.))
        .child(glyph(
            if self.link_open {
                "icons/chevron-down.svg"
            } else {
                "icons/chevron-right.svg"
            },
            12.,
            paper.soft,
        ))
        .on_click(cx.listener(|this, _, window, cx| {
            this.link_open = !this.link_open;
            if this.link_open {
                let input = this.url_input.clone();
                input.update(cx, |i, cx| i.focus_and_select_all(window, cx));
            }
            cx.notify();
        }));
        self.url_input.update(cx, |i, _| {
            i.set_placeholder(tr::settings::meetings::calendars::link_placeholder())
        });
        let link_form = self.link_open.then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .w_full()
                .child(text(
                    tr::meeting_setup::calendar::link_body(),
                    12.,
                    17.,
                    paper.soft,
                ))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .child(div().flex_1().min_w_0().child(ui::TextInput::settings(
                            &self.theme,
                            "meeting-setup-link",
                            &self.url_input,
                        )))
                        .child({
                            let enabled = !self.url_draft.trim().is_empty();
                            small_button(
                                &paper,
                                "meeting-setup-link-connect",
                                tr::settings::meetings::calendars::connect(),
                                true,
                                enabled,
                            )
                            .when(enabled, |el| {
                                el.on_click(cx.listener(|this, _, _, cx| this.add_link(cx)))
                            })
                        }),
                )
                .children(
                    self.add_error
                        .as_ref()
                        .map(|error| text(shared::add_error_text(error), 12., 16., paper.red)),
                )
        });

        let links_list = (!links.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .w_full()
                .children(links.into_iter().map(|(title, phase, upcoming)| {
                    let (status, color) = match phase {
                        SourcePhase::Syncing => (
                            tr::settings::meetings::calendars::syncing().to_string(),
                            paper.soft,
                        ),
                        SourcePhase::Failed(kind) => {
                            (shared::sync_error_text(kind).to_string(), paper.red)
                        }
                        SourcePhase::Synced => (
                            tr::settings::meetings::calendars::upcoming(upcoming),
                            paper.soft,
                        ),
                    };
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .child(self.mark(
                            if matches!(phase, SourcePhase::Failed(_)) {
                                Mark::Pending
                            } else {
                                Mark::Granted
                            },
                            self.step_at,
                            20.,
                            cx,
                        ))
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(paper.ink)
                                .truncate()
                                .child(title),
                        )
                        .child(text(status, 12., 16., color).truncate())
                }))
        });

        let summary: Div = if Meetings::global(cx).read(cx).calendar_sources().is_empty() {
            text(
                tr::meeting_setup::calendar::skip_note(),
                13.,
                18.,
                paper.soft,
            )
            .text_center()
        } else if syncing {
            text(
                tr::settings::meetings::calendars::syncing(),
                13.,
                18.,
                paper.soft,
            )
        } else {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.))
                .child(self.doodle(&doodles::CALENDAR, 200, 46., 40., cx))
                .child(text(
                    tr::settings::meetings::calendars::found(total),
                    13.,
                    18.,
                    paper.ink,
                ))
        };

        self.page()
            .gap(px(28.))
            .child(self.heading(
                tr::meeting_setup::calendar::title(),
                tr::meeting_setup::calendar::subtitle(),
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(16.))
                    .w_full()
                    .max_w(px(540.))
                    .child(self.rise(
                        paper_card(&paper).w_full().overflow_hidden().children(rows),
                        "meeting-calendar-card",
                        0,
                        cx,
                    ))
                    .children(links_list)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_start()
                            .gap(px(10.))
                            .w_full()
                            .px(px(4.))
                            .child(link_toggle)
                            .children(link_form),
                    )
                    .child(div().pt(px(4.)).child(summary)),
            )
            .into_any_element()
    }

    fn behavior_card(
        &self,
        index: usize,
        art: &'static Doodle,
        title: &'static str,
        body: SharedString,
        control: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let paper = self.paper();
        let card = paper_card(&paper)
            .rounded(px(18.))
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(16.))
            .pl(px(14.))
            .pr(px(20.))
            .py(px(12.))
            .child(self.doodle(art, index as u64 * 160, 64., 56., cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(15.))
                            .line_height(px(20.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .child(title),
                    )
                    .child(text(body, 13., 18., paper.soft)),
            )
            .child(div().flex_none().child(control));
        self.rise(card, "meeting-behavior-card", index, cx)
    }

    fn render_behavior(&self, cx: &mut Context<Self>) -> AnyElement {
        let notifications = self.settings.notifications.clone();
        let auto = self.settings.automation.auto_record;
        let scheduled_control = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .when(notifications.scheduled, |el| {
                el.child(
                    ui::Select::settings(
                        &self.theme,
                        "meeting-setup-lead",
                        lead_label(notifications.lead_secs),
                    )
                    .on_click(cx.listener(
                        |this, event: &gpui::ClickEvent, window, cx| {
                            this.open_menu(SetupMenu::Lead, event.position(), window, cx)
                        },
                    )),
                )
            })
            .child(
                ui::Toggle::settings(
                    &self.theme,
                    "meeting-setup-scheduled",
                    notifications.scheduled,
                )
                .label(tr::meeting_setup::behavior::remind_title())
                .on_click(cx.listener(|this, _, _, cx| {
                    this.update_settings(cx, |s| {
                        s.notifications.scheduled = !s.notifications.scheduled
                    })
                })),
            )
            .into_any_element();
        let detected_control = ui::Toggle::settings(
            &self.theme,
            "meeting-setup-detected",
            notifications.detected,
        )
        .label(tr::meeting_setup::behavior::detect_title())
        .on_click(cx.listener(|this, _, _, cx| {
            this.update_settings(cx, |s| s.notifications.detected = !s.notifications.detected)
        }))
        .into_any_element();
        let auto_control =
            ui::Select::settings(&self.theme, "meeting-setup-auto", auto_record_label(auto))
                .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                    this.open_menu(SetupMenu::AutoRecord, event.position(), window, cx)
                }))
                .into_any_element();
        let auto_body: SharedString = if auto == AutoRecord::Off {
            tr::meeting_setup::behavior::auto_off().into()
        } else {
            tr::meeting_setup::behavior::auto_on(self.settings.automation.countdown_secs as usize)
                .into()
        };
        self.page()
            .child(self.heading(
                tr::meeting_setup::behavior::title(),
                tr::meeting_setup::behavior::subtitle(),
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .w_full()
                    .max_w(px(560.))
                    .child(self.behavior_card(
                        0,
                        &doodles::BELL,
                        tr::meeting_setup::behavior::remind_title(),
                        tr::meeting_setup::behavior::remind_body().into(),
                        scheduled_control,
                        cx,
                    ))
                    .child(self.behavior_card(
                        1,
                        &doodles::CALL,
                        tr::meeting_setup::behavior::detect_title(),
                        tr::meeting_setup::behavior::detect_body().into(),
                        detected_control,
                        cx,
                    ))
                    .child(self.behavior_card(
                        2,
                        &doodles::RECORD,
                        tr::meeting_setup::behavior::auto_title(),
                        auto_body,
                        auto_control,
                        cx,
                    )),
            )
            .into_any_element()
    }

    /// Says up front whether Cap AI will write the notes, so nobody finds
    /// out only after their first meeting.
    fn cap_ai_row(&self, index: usize, cx: &mut Context<Self>) -> Option<AnyElement> {
        let meetings = Meetings::try_global(cx)?;
        let (access, trial) = {
            let m = meetings.read(cx);
            (m.ai_access(), m.trial_remaining())
        };
        let (status, action) = crate::meetings_ui::cap_ai::status_line(access, trial);
        Some(self.summary_row(
            index,
            tr::meeting_setup::ready::cap_ai(),
            status.into(),
            access.writes_notes(),
            action.map(|(label, sign_in)| Fix::CapAi(label, sign_in)),
            cx,
        ))
    }

    fn summary_row(
        &self,
        index: usize,
        title: &'static str,
        status: SharedString,
        ok: bool,
        fix: Option<Fix>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let paper = self.paper();
        let mark = if ok { Mark::Granted } else { Mark::Skipped };
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .h(px(52.))
            .px(px(12.))
            .child(self.mark(
                mark,
                self.step_at + Duration::from_millis(200 + index as u64 * 140),
                30.,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(paper.ink)
                            .truncate()
                            .child(title),
                    )
                    .child(
                        text(status, 12., 16., if ok { paper.green } else { paper.soft })
                            .truncate(),
                    ),
            )
            .children(fix.filter(|_| !ok).map(|fix| {
                let label = match fix {
                    Fix::Go(_) => tr::meeting_setup::ready::fix(),
                    Fix::CapAi(label, _) => label,
                };
                quiet_link(&paper, ("meeting-setup-fix", index), label)
                    .text_color(paper.accent)
                    .on_click(cx.listener(move |this, _, window, cx| match fix {
                        Fix::Go(step) => this.go_to(step, window, cx),
                        Fix::CapAi(_, true) => cx.defer(crate::meetings_ui::cap_ai::sign_in),
                        Fix::CapAi(_, false) => cx.defer(|cx| {
                            crate::meetings_ui::cap_ai::open_upgrade(
                                None,
                                crate::meetings_ui::cap_ai::Host::Window,
                                cx,
                            )
                        }),
                    }))
            }))
            .into_any_element()
    }

    fn render_ready(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let calendars = Meetings::global(cx).read(cx).calendar_sources().len();
        let audio_status: SharedString = match self.audio {
            Access::Granted | Access::NotNeeded => tr::meeting_setup::ready::allowed().into(),
            Access::Unsupported => tr::meeting_setup::ready::not_available().into(),
            _ => tr::meeting_setup::ready::only_you().into(),
        };
        let engine = shared::effective_engine(&self.settings, self.cloud);
        let (engine_status, engine_ok): (SharedString, bool) = match engine {
            Engine::Cloud => (tr::settings::meetings::transcription::cloud().into(), true),
            Engine::Local if shared::local_ready(&self.settings) => {
                (shared::local_label().into(), true)
            }
            Engine::Local if shared::download_running() => {
                (tr::meeting_setup::ready::downloading().into(), true)
            }
            Engine::Local => (
                tr::settings::meetings::overview::engine_no_model().into(),
                false,
            ),
        };
        let items = vec![
            self.summary_row(
                0,
                tr::meeting_setup::permissions::mic(),
                if self.mic.ready() {
                    tr::meeting_setup::ready::allowed().into()
                } else {
                    tr::meeting_setup::ready::not_allowed().into()
                },
                self.mic.ready(),
                Some(Fix::Go(Step::Permissions)),
                cx,
            ),
            self.summary_row(
                1,
                tr::meeting_setup::permissions::audio(),
                audio_status,
                self.audio.ready(),
                (self.audio != Access::Unsupported).then_some(Fix::Go(Step::Permissions)),
                cx,
            ),
            self.summary_row(
                2,
                tr::settings::meetings::transcription::title(),
                engine_status,
                engine_ok,
                Some(Fix::Go(Step::Transcription)),
                cx,
            ),
            self.summary_row(
                3,
                tr::settings::meetings::calendars::title(),
                if calendars == 0 {
                    tr::meeting_setup::ready::no_calendar().into()
                } else {
                    tr::settings::meetings::overview::calendars(calendars).into()
                },
                calendars > 0,
                Some(Fix::Go(Step::Calendar)),
                cx,
            ),
        ];
        let items = items.into_iter().chain(self.cap_ai_row(4, cx));
        let still = self.still(cx);
        let left = div()
            .flex()
            .flex_col()
            .w(px(296.))
            .flex_none()
            .child(left_heading(
                &paper,
                tr::meeting_setup::ready::title(),
                self.step_at,
                still,
            ))
            .child(text(tr::meeting_setup::ready::subtitle(), 14., 21., paper.soft).mt(px(10.)))
            .child(
                div()
                    .mt(px(22.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .children(items),
            );
        let stage = div()
            .id("meeting-setup-try-card")
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .w(px(420.))
            .flex_none()
            .min_h(px(420.))
            .px(px(36.))
            .py(px(30.))
            .rounded(px(24.))
            .border(px(1.5))
            .border_color(paper.track)
            .bg(paper.card)
            .child(self.doodle(&doodles::NOTES, 0, 168., 146., cx))
            .child(
                div()
                    .mt(px(22.))
                    .text_size(px(22.))
                    .line_height(px(28.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(paper.ink)
                    .text_center()
                    .child(tr::meeting_setup::ready::try_title()),
            )
            .child(
                text(tr::meeting_setup::ready::try_body(), 14., 21., paper.soft)
                    .mt(px(8.))
                    .max_w(px(320.))
                    .text_center(),
            )
            .child(
                div().mt(px(24.)).child(
                    crate::onboarding_window::paper_button(
                        &paper,
                        "meeting-setup-try",
                        tr::meeting_setup::ready::try_it(),
                        false,
                        true,
                        cx.listener(|this, _, _, cx| this.try_it(cx)),
                    )
                    .gap(px(8.))
                    .child(glyph("icons/microphone.svg", 14., paper.ink)),
                ),
            )
            .when(self.try_error, |el| {
                el.child(
                    text(tr::meeting_setup::ready::try_failed(), 12., 17., paper.red)
                        .mt(px(14.))
                        .max_w(px(320.))
                        .text_center(),
                )
            });
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .min_h_full()
            .px(px(40.))
            .py(px(24.))
            .gap(px(44.))
            .child(left)
            .child(div().flex_none().w(px(420.)).child(self.rise(
                stage,
                "meeting-ready-card",
                0,
                cx,
            )))
            .into_any_element()
    }

    fn render_navigation(&self, cx: &mut Context<Self>) -> AnyElement {
        let paper = self.paper();
        let current = self.step.index();
        let disabled = !self.can_continue();
        let has_calendar = !Meetings::global(cx).read(cx).calendar_sources().is_empty();
        let (label, icon): (&'static str, &'static str) = match self.step {
            Step::Welcome => (
                tr::meeting_setup::nav::get_started(),
                "icons/move-right.svg",
            ),
            Step::Calendar if !has_calendar => {
                (tr::meeting_setup::nav::skip(), "icons/move-right.svg")
            }
            Step::Ready => (tr::meeting_setup::nav::done(), "icons/check.svg"),
            _ => (tr::meeting_setup::nav::next(), "icons/move-right.svg"),
        };
        let hint: &'static str = if disabled {
            tr::meeting_setup::nav::mic_needed()
        } else if self.step == Step::Permissions
            && !self.audio.ready()
            && self.audio != Access::Unsupported
        {
            tr::meeting_setup::nav::audio_missing()
        } else if self.step == Step::Behavior {
            tr::meeting_setup::nav::later()
        } else {
            tr::onboarding::nav::keyboard_hint()
        };
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(10.))
            .px(px(36.))
            .pb(px(18.))
            .pt(px(8.))
            .flex_shrink_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .w_full()
                    .child(div().flex_1().when(current > 0, |el| {
                        el.child(
                            quiet_link(&paper, "meeting-setup-back", tr::onboarding::nav::back())
                                .on_click(cx.listener(|this, _, window, cx| this.back(window, cx))),
                        )
                    }))
                    .child(pager(&paper, Step::ALL.len(), current))
                    .child(div().flex_1().flex().justify_end().child(
                        primary_pill(&paper, "meeting-setup-continue", label, icon, disabled).when(
                            !disabled,
                            |el| {
                                el.on_click(cx.listener(|this, _, window, cx| {
                                    if this.step == Step::Ready {
                                        this.finish(cx)
                                    } else {
                                        this.next(window, cx)
                                    }
                                }))
                            },
                        ),
                    )),
            )
            .child(text(hint, 11., 14., paper.soft))
            .into_any_element()
    }

    fn render_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref()?;
        let kind = menu.kind;
        Some(
            ui::Menu::settings(
                &self.theme,
                "meeting-setup-menu",
                self.menu_items(kind),
                &menu.state,
            )
            .on_select(cx.listener(move |this, index: &usize, _, cx| this.choose(kind, *index, cx)))
            .on_dismiss(cx.listener(|this, _, _, cx| {
                this.menu = None;
                cx.notify();
            }))
            .into_any_element(),
        )
    }
}

impl Render for SetupWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.keyboard = crate::ui::keyboard_nav::active(window, cx);
        #[cfg(not(test))]
        self.theme.refresh(window, cx, true);
        if self.step == Step::Permissions {
            self.sync_stage(window, cx);
        }
        #[cfg(target_os = "windows")]
        let theme = self.theme;
        let paper = self.paper();
        let content = match self.step {
            Step::Welcome => self.render_welcome(cx),
            Step::Permissions => self.render_permissions(cx),
            Step::Transcription => self.render_transcription(cx),
            Step::Calendar => self.render_calendar(cx),
            Step::Behavior => self.render_behavior(cx),
            Step::Ready => self.render_ready(cx),
        };
        let content = div().relative().min_h_full().w_full().child(content);
        let content = if self.still(cx) {
            content.into_any_element()
        } else {
            let direction = self.direction;
            content
                .with_animation(
                    ("meeting-setup-step", self.step_revision),
                    Animation::new(Duration::from_millis(500)),
                    move |el, t| {
                        let t = ease(t);
                        el.left(px(direction * 24. * (1. - t))).opacity(t)
                    },
                )
                .into_any_element()
        };
        let header = div()
            .id("meeting-setup-header")
            .h(px(HEADER_H))
            .flex_shrink_0()
            .w_full()
            .flex()
            .items_center()
            .justify_between()
            .bg(paper.bg)
            .window_control_area(gpui::WindowControlArea::Drag);
        #[cfg(target_os = "windows")]
        let header = header.justify_end().child(ui::windows_caption_controls(
            theme,
            window.is_window_active(),
            false,
            true,
            false,
        ));
        #[cfg(not(target_os = "windows"))]
        let header = header
            .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                window.start_window_move()
            })
            .child(
                close_dot("meeting-setup-close")
                    .on_click(cx.listener(|_, _, _, cx| cx.defer(super::close))),
            );
        div()
            .id("meeting-setup")
            .track_focus(self.focus_handle())
            .child(crate::ui::keyboard_nav::pointer_watcher())
            .key_context("MeetingSetup")
            .on_key_down(cx.listener(Self::on_key))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(16.))
            .bg(paper.bg)
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .font_weight(FontWeight::MEDIUM)
            .text_color(paper.ink)
            .child(header)
            .child(
                div()
                    .id("meeting-setup-scroll")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    .child(content),
            )
            .child(self.render_navigation(cx))
            .children(self.render_menu(cx))
    }
}
