use chrono::Utc;
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use super::{
    Flag, MeetingsMenu,
    accounts::{self, Phase},
    shared::{self, Access, Palette, SourcePhase, glyph},
};
use crate::{
    i18n::tr,
    meetings::{CalendarSource, Meetings, SourceConfig, SyncErrorKind},
    settings_window::SettingsWindow,
    ui,
};

pub(crate) struct SourceView {
    pub source: CalendarSource,
    pub phase: SourcePhase,
    pub upcoming: usize,
}

pub(crate) fn source_views(cx: &gpui::App) -> (Vec<SourceView>, bool) {
    let Some(meetings) = Meetings::try_global(cx) else {
        return (Vec::new(), false);
    };
    let m = meetings.read(cx);
    let syncing = m.calendar_syncing();
    let views = m
        .calendar_sources()
        .iter()
        .map(|source| SourceView {
            source: source.clone(),
            phase: shared::source_phase(source, syncing),
            upcoming: m.upcoming_count(&source.id),
        })
        .collect();
    (views, syncing)
}

impl SettingsWindow {
    fn meetings_source_row(
        &self,
        index: usize,
        view: SourceView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let state = &self.pages.meetings;
        let source = view.source;
        let id = source.id.clone();
        let system = matches!(source.config, SourceConfig::System);
        let just_added = state.added.as_deref() == Some(id.as_str());
        let meta: AnyElement = match view.phase {
            SourcePhase::Syncing => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .child(shared::spinner("meetings-calendar-spinner", palette.muted))
                .child(tr::settings::meetings::calendars::syncing())
                .into_any_element(),
            SourcePhase::Failed(SyncErrorKind::AccessDenied)
                if state.calendar == Access::NotDetermined =>
            {
                div()
                    .child(tr::settings::meetings::calendars::access_needed())
                    .into_any_element()
            }
            SourcePhase::Failed(kind) => div()
                .text_color(palette.red)
                .child(shared::sync_error_text(kind))
                .into_any_element(),
            SourcePhase::Synced if just_added => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.))
                .text_color(palette.green)
                .child(glyph("icons/check.svg", 12., palette.green))
                .child(tr::settings::meetings::calendars::found(view.upcoming))
                .into_any_element(),
            SourcePhase::Synced => {
                let mut parts = vec![source_kind_label(&source).to_string()];
                if let Some(at) = source.status.last_sync {
                    parts.push(shared::synced_text(at, Utc::now()));
                }
                parts.push(tr::settings::meetings::calendars::upcoming(view.upcoming));
                div().child(parts.join(" · ")).into_any_element()
            }
        };
        let failed = matches!(view.phase, SourcePhase::Failed(_));
        let denied = matches!(view.phase, SourcePhase::Failed(SyncErrorKind::AccessDenied));
        let calendars = source.status.calendars.clone();
        let expanded = system && state.expanded_system && !calendars.is_empty();
        let hidden = state.settings.calendar.hidden_calendar_ids.clone();
        let remove_id = id.clone();
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.))
                    .p(px(12.))
                    .child(
                        div()
                            .size(px(28.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(7.))
                            .bg(palette.fill)
                            .child(glyph(source_icon(&source), 14., palette.text)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .truncate()
                                    .child(shared::source_title(&source)),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(palette.muted)
                                    .child(meta),
                            )
                            .when(system && !calendars.is_empty(), |el| {
                                el.child(
                                    div()
                                        .id(("meetings-system-toggle", index))
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(3.))
                                        .mt(px(2.))
                                        .text_size(px(12.))
                                        .text_color(palette.accent)
                                        .cursor_pointer()
                                        .child(tr::settings::meetings::calendars::choose_calendars(
                                            calendars.len(),
                                        ))
                                        .child(glyph(
                                            if expanded {
                                                "icons/chevron-up.svg"
                                            } else {
                                                "icons/chevron-down.svg"
                                            },
                                            11.,
                                            palette.accent,
                                        ))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.pages.meetings.expanded_system =
                                                !this.pages.meetings.expanded_system;
                                            cx.notify();
                                        })),
                                )
                            }),
                    )
                    .when(denied && state.calendar == Access::NotDetermined, |el| {
                        el.child(self.button(
                            ("meetings-calendar-allow", index),
                            (ui::ButtonVariant::Primary, None),
                            tr::settings::meetings::calendars::allow_access(),
                            state.calendar_requesting,
                            cx,
                            |this, window, cx| this.meetings_add_system(window, cx),
                        ))
                    })
                    .when(denied && state.calendar != Access::NotDetermined, |el| {
                        el.child(self.button(
                            ("meetings-calendar-settings", index),
                            (ui::ButtonVariant::Gray, None),
                            tr::settings::meetings::calendars::open_settings(),
                            false,
                            cx,
                            |_, _, _| shared::open_calendar_settings(),
                        ))
                    })
                    .when(failed && !denied, |el| {
                        el.child(self.button(
                            ("meetings-calendar-retry", index),
                            (ui::ButtonVariant::Gray, None),
                            tr::settings::meetings::calendars::retry(),
                            false,
                            cx,
                            |this, _, cx| this.meetings_retry_calendars(cx),
                        ))
                    })
                    .child(self.button(
                        ("meetings-calendar-remove", index),
                        (ui::ButtonVariant::Gray, None),
                        tr::settings::meetings::calendars::remove(),
                        false,
                        cx,
                        move |this, _, cx| this.meetings_remove_calendar(&remove_id, cx),
                    )),
            )
            .when(expanded, |el| {
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .pl(px(50.))
                        .pr(px(12.))
                        .pb(px(8.))
                        .children(calendars.into_iter().enumerate().map(|(row, calendar)| {
                            let shown = !hidden.contains(&calendar.id);
                            let calendar_id = calendar.id.clone();
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .justify_between()
                                .gap(px(12.))
                                .py(px(5.))
                                .border_t_1()
                                .border_color(palette.border)
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .truncate()
                                        .child(calendar.title.clone()),
                                )
                                .child(self.toggle(
                                    gpui::ElementId::Name(format!("meetings-subcal-{row}").into()),
                                    calendar.title,
                                    shown,
                                    cx,
                                    move |this, cx| this.meetings_toggle_calendar(&calendar_id, cx),
                                ))
                        })),
                )
            })
            .into_any_element()
    }

    fn meetings_account_row(
        &self,
        row: accounts::AccountRow,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let provider = row.provider;
        let detail = accounts::detail(&row);
        let detail_color = match &row.phase {
            Phase::Failed(_) => palette.red,
            _ => palette.muted,
        };
        let busy = matches!(row.phase, Phase::Waiting | Phase::Finishing);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .p(px(12.))
            .child(
                div()
                    .size(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(7.))
                    .bg(palette.fill)
                    .child(glyph(accounts::icon(provider), 14., palette.text)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .truncate()
                            .child(accounts::name(provider)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(detail_color)
                            .when(busy, |el| {
                                el.child(shared::spinner("meetings-account-spinner", palette.muted))
                            })
                            .child(detail),
                    ),
            )
            .children(accounts::action(&row.phase).map(|action| {
                self.button(
                    gpui::ElementId::Name(
                        format!("meetings-account-{}", accounts::slug(provider)).into(),
                    ),
                    (
                        if action == accounts::Action::Connect {
                            ui::ButtonVariant::Primary
                        } else {
                            ui::ButtonVariant::Gray
                        },
                        None,
                    ),
                    accounts::action_label(action),
                    row.phase == Phase::Blocked,
                    cx,
                    move |_, _, cx| accounts::run(action, provider, cx),
                )
            }))
            .into_any_element()
    }

    fn meetings_link_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let state = &self.pages.meetings;
        state.url_input.update(cx, |i, _| {
            i.set_placeholder(tr::settings::meetings::calendars::link_placeholder())
        });
        state.name_input.update(cx, |i, _| {
            i.set_placeholder(tr::settings::meetings::calendars::name_placeholder())
        });
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(tr::settings::meetings::calendars::link()),
            )
            .child(ui::TextInput::settings(
                &self.theme,
                "meetings-link-url",
                &state.url_input,
            ))
            .child(ui::TextInput::settings(
                &self.theme,
                "meetings-link-name",
                &state.name_input,
            ))
            .children(state.add_error.as_ref().map(|error| {
                div()
                    .text_size(px(12.))
                    .text_color(palette.red)
                    .child(shared::add_error_text(error))
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.))
                    .child(self.button(
                        "meetings-link-cancel",
                        (ui::ButtonVariant::Gray, None),
                        tr::settings::meetings::calendars::cancel(),
                        false,
                        cx,
                        |this, _, cx| {
                            this.pages.meetings.link_form = false;
                            this.pages.meetings.add_error = None;
                            cx.notify();
                        },
                    ))
                    .child(self.button(
                        "meetings-link-connect",
                        (ui::ButtonVariant::Primary, None),
                        tr::settings::meetings::calendars::connect(),
                        state.url_draft.trim().is_empty(),
                        cx,
                        |this, _, cx| this.meetings_add_link(cx),
                    )),
            )
            .into_any_element()
    }

    fn meetings_help(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let open = self.pages.meetings.help_open;
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .px(px(4.))
            .child(
                div()
                    .id("meetings-calendar-help")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .text_size(px(12.))
                    .text_color(palette.accent)
                    .cursor_pointer()
                    .child(glyph(
                        if open {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        },
                        11.,
                        palette.accent,
                    ))
                    .child(tr::settings::meetings::calendars::help())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.pages.meetings.help_open = !this.pages.meetings.help_open;
                        cx.notify();
                    })),
            )
            .when(open, |el| {
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .pl(px(15.))
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(palette.muted)
                        .child(tr::settings::meetings::calendars::help_google())
                        .child(tr::settings::meetings::calendars::help_outlook())
                        .child(tr::settings::meetings::calendars::help_icloud()),
                )
            })
            .into_any_element()
    }

    pub(super) fn meetings_calendars(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let (views, _) = source_views(cx);
        let state = &self.pages.meetings;

        let add = ui::Button::settings(
            &self.theme,
            "meetings-add-calendar",
            ui::ButtonVariant::Gray,
            ui::ButtonSize::Sm,
        )
        .label(tr::settings::meetings::calendars::add())
        .icon("icons/plus.svg")
        .disabled_settings(&self.theme, state.calendar_requesting)
        .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
            if super::add_choices(this.meetings_has_system(cx)).len() == 1 {
                this.meetings_choose(MeetingsMenu::AddCalendar, 0, window, cx);
            } else {
                this.meetings_open_menu(MeetingsMenu::AddCalendar, event.position(), window, cx);
            }
        }))
        .into_any_element();

        let account_rows: Vec<AnyElement> = accounts::rows(cx)
            .into_iter()
            .filter(|row| !matches!(row.phase, Phase::Connected(_)))
            .map(|row| self.meetings_account_row(row, cx))
            .collect();
        let empty = views.is_empty() && account_rows.is_empty();
        let mut list: Vec<AnyElement> = account_rows;
        list.extend(if empty {
            vec![
                div()
                    .p(px(12.))
                    .text_size(px(12.))
                    .text_color(palette.muted)
                    .child(tr::settings::meetings::calendars::empty())
                    .into_any_element(),
            ]
        } else {
            views
                .into_iter()
                .enumerate()
                .map(|(index, view)| self.meetings_source_row(index, view, cx))
                .collect()
        });
        if state.calendar_requesting {
            list.push(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .p(px(12.))
                    .text_size(px(12.))
                    .text_color(palette.muted)
                    .child(shared::spinner("meetings-calendar-request", palette.muted))
                    .child(tr::settings::meetings::calendars::waiting_for_access())
                    .into_any_element(),
            );
        } else if cfg!(target_os = "macos")
            && state.calendar == Access::Denied
            && !self.meetings_has_system(cx)
        {
            list.push(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .p(px(12.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(palette.muted)
                            .child(tr::settings::meetings::calendars::error_access()),
                    )
                    .child(self.button(
                        "meetings-calendar-denied",
                        (ui::ButtonVariant::Gray, None),
                        tr::settings::meetings::calendars::open_settings(),
                        false,
                        cx,
                        |_, _, _| shared::open_calendar_settings(),
                    ))
                    .into_any_element(),
            );
        }
        if state.link_form {
            list.push(self.meetings_link_form(cx));
        }

        let mut options = vec![
            self.setting_row(
                tr::settings::meetings::calendars::hide_declined(),
                None,
                self.meetings_flag(
                    "meetings-hide-declined",
                    tr::settings::meetings::calendars::hide_declined(),
                    Flag::HideDeclined,
                    cx,
                ),
            ),
            self.setting_row(
                tr::settings::meetings::calendars::hide_all_day(),
                None,
                self.meetings_flag(
                    "meetings-hide-all-day",
                    tr::settings::meetings::calendars::hide_all_day(),
                    Flag::HideAllDay,
                    cx,
                ),
            ),
            self.setting_row(
                tr::settings::meetings::calendars::hide_solo(),
                None,
                self.meetings_flag(
                    "meetings-hide-solo",
                    tr::settings::meetings::calendars::hide_solo(),
                    Flag::HideSolo,
                    cx,
                ),
            ),
        ];
        // macOS shows the next meeting beside the menu bar icon, Windows in
        // the tray icon's tooltip; Linux has no tray to show it in.
        let menu_bar = if cfg!(target_os = "macos") {
            Some(tr::settings::meetings::calendars::menu_bar())
        } else if cfg!(target_os = "windows") {
            Some(tr::settings::meetings::calendars::menu_bar_tray())
        } else {
            None
        };
        if let Some(label) = menu_bar {
            options.push(self.setting_row(
                label,
                None,
                self.meetings_flag("meetings-menu-bar", label, Flag::MenuBar, cx),
            ));
        }

        self.section(
            tr::settings::meetings::calendars::title(),
            Some(tr::settings::meetings::calendars::description()),
            Some(add),
            vec![
                self.rows(list).into_any_element(),
                self.meetings_help(cx),
                self.rows(options).into_any_element(),
            ],
        )
        .into_any_element()
    }

    pub(crate) fn meetings_has_system(&self, cx: &gpui::App) -> bool {
        Meetings::try_global(cx).is_some_and(|m| {
            m.read(cx)
                .calendar_sources()
                .iter()
                .any(|s| matches!(s.config, SourceConfig::System))
        })
    }
}

fn source_kind_label(source: &CalendarSource) -> &'static str {
    use cap_calendar::SourceKind;
    match source.config.kind() {
        SourceKind::System => tr::settings::meetings::calendars::kind_system(),
        SourceKind::Google => tr::settings::meetings::accounts::google(),
        SourceKind::Microsoft => tr::settings::meetings::accounts::outlook(),
        SourceKind::Ics => tr::settings::meetings::calendars::kind_link(),
    }
}

fn source_icon(source: &CalendarSource) -> &'static str {
    use cap_calendar::SourceKind;
    match source.config.kind() {
        SourceKind::System => "icons/laptop.svg",
        SourceKind::Google => "icons/google.svg",
        SourceKind::Microsoft => "icons/microsoft.svg",
        SourceKind::Ics => "icons/calendar.svg",
    }
}
