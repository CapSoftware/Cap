use cap_meetings::{
    detect::BrowserPolicy,
    prompt::AutoRecord,
    settings::{Engine, Language, Microphone},
};
use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use super::{
    CORNERS, Flag, MeetingsMenu, auto_record_label, corner_label, language_label, lead_label,
    retention_label, shared,
    shared::{Access, CloudState, ModelState, Palette, glyph},
    silence_label,
};
use crate::{
    i18n::tr,
    meetings::Meetings,
    settings_window::{MenuKind, SettingsWindow},
    ui,
};

/// The licence texts bundled with the app, for the speaker models it downloads.
const MODEL_LICENSES_URL: &str =
    "https://github.com/CapSoftware/Cap/tree/main/apps/desktop-gpui/licenses";

impl SettingsWindow {
    pub(crate) fn render_meetings(
        &self,
        _window: &Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        vec![
            self.meetings_overview(cx),
            self.meetings_notifications(cx),
            self.meetings_automation(cx),
            self.meetings_recording(cx),
            self.meetings_transcription(cx),
            self.meetings_notes(cx),
            self.meetings_calendars(cx),
        ]
    }

    fn meetings_select(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        menu: MeetingsMenu,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.select(id, label, MenuKind::Meetings(menu), cx)
            .into_any_element()
    }

    pub(super) fn meetings_flag(
        &self,
        id: &'static str,
        label: &'static str,
        flag: Flag,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.toggle(
            id,
            label,
            flag.get(&self.pages.meetings.settings),
            cx,
            move |this, cx| {
                this.meetings_toggle_flag(flag, cx);
            },
        )
        .into_any_element()
    }

    fn meetings_row(
        &self,
        label: &'static str,
        description: Option<impl Into<SharedString>>,
        control: AnyElement,
    ) -> AnyElement {
        let row = ui::SettingRow::settings(&self.theme, label, None, control);
        match description {
            Some(description) => row.description(description).into_any_element(),
            None => row.into_any_element(),
        }
    }

    /// One readiness line: a green tick and the state when it is fine, the
    /// state and a way into setup when it is not.
    fn meetings_status(
        &self,
        id: &'static str,
        status: SharedString,
        ok: bool,
        fix: Option<crate::meetings_ui::setup::Step>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = Palette::new(&self.theme);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.))
                    .text_size(px(12.))
                    .text_color(if ok { palette.green } else { palette.muted })
                    .when(ok, |el| {
                        el.child(glyph("icons/check.svg", 12., palette.green))
                    })
                    .child(status),
            )
            .children(fix.filter(|_| !ok).map(|step| {
                self.button(
                    id,
                    (ui::ButtonVariant::Gray, None),
                    tr::meeting_setup::ready::fix(),
                    false,
                    cx,
                    move |_, _, cx| {
                        cx.defer(move |cx| crate::meetings_ui::setup::open_at(Some(step), cx))
                    },
                )
            }))
            .into_any_element()
    }

    fn meetings_overview(&self, cx: &mut Context<Self>) -> AnyElement {
        use crate::meetings_ui::setup::Step;
        let palette = Palette::new(&self.theme);
        let state = &self.pages.meetings;
        let settings = &state.settings;
        let enabled = settings.enabled;
        let completed = settings.setup_completed;
        let mut rows = vec![
            self.setting_row(
                tr::settings::meetings::overview::enable(),
                Some(tr::settings::meetings::overview::enable_description()),
                self.toggle(
                    "meetings-enabled",
                    tr::settings::meetings::overview::enable(),
                    enabled,
                    cx,
                    |this, cx| {
                        let next = !this.pages.meetings.settings.enabled;
                        this.meetings_set_enabled(next, cx);
                    },
                )
                .into_any_element(),
            ),
        ];
        if !completed {
            rows.push(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(16.))
                    .min_h(px(46.))
                    .p(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(12.))
                            .text_color(palette.muted)
                            .child(tr::settings::meetings::overview::setup_needed()),
                    )
                    .child(self.button(
                        "meetings-run-setup",
                        (ui::ButtonVariant::Primary, None),
                        tr::settings::meetings::overview::start_setup(),
                        false,
                        cx,
                        |this, _, cx| this.meetings_run_setup(cx),
                    ))
                    .into_any_element(),
            );
            return self
                .section(
                    tr::settings::meetings::overview::title(),
                    Some(tr::settings::meetings::overview::description()),
                    None,
                    vec![self.rows(rows).into_any_element()],
                )
                .into_any_element();
        }
        let mic = shared::microphone_access(cx);
        let mic_status: SharedString = if mic.ready() {
            tr::meeting_setup::ready::allowed().into()
        } else {
            tr::meeting_setup::ready::not_allowed().into()
        };
        let (audio_status, audio_fix): (SharedString, bool) = match state.audio {
            Access::Granted | Access::NotNeeded => {
                (tr::meeting_setup::ready::allowed().into(), false)
            }
            Access::Unsupported => (tr::meeting_setup::ready::not_available().into(), false),
            Access::Denied | Access::NotDetermined => {
                (tr::meeting_setup::ready::not_allowed().into(), true)
            }
        };
        let (engine_status, engine_ok): (SharedString, bool) =
            match shared::effective_engine(&state.settings, state.cloud) {
                Engine::Cloud => (tr::settings::meetings::transcription::cloud().into(), true),
                Engine::Local if shared::local_ready(&state.settings) => {
                    (shared::local_label().into(), true)
                }
                Engine::Local => (
                    tr::settings::meetings::overview::engine_no_model().into(),
                    false,
                ),
            };
        let count = Meetings::try_global(cx).map_or(0, |m| m.read(cx).calendar_sources().len());
        let calendars: SharedString = if count == 0 {
            tr::settings::meetings::overview::no_calendars().into()
        } else {
            tr::settings::meetings::overview::calendars(count).into()
        };
        rows.push(self.setting_row(
            tr::meeting_setup::permissions::mic(),
            None,
            self.meetings_status(
                "meetings-fix-mic",
                mic_status,
                mic.ready(),
                Some(Step::Permissions),
                cx,
            ),
        ));
        rows.push(self.setting_row(
            tr::meeting_setup::permissions::audio(),
            None,
            self.meetings_status(
                "meetings-fix-audio",
                audio_status,
                !audio_fix,
                audio_fix.then_some(Step::Permissions),
                cx,
            ),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::transcription::title(),
            None,
            self.meetings_status(
                "meetings-fix-engine",
                engine_status,
                engine_ok,
                Some(Step::Transcription),
                cx,
            ),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::calendars::title(),
            None,
            self.meetings_status(
                "meetings-fix-calendars",
                calendars,
                count > 0,
                Some(Step::Calendar),
                cx,
            ),
        ));
        rows.push(
            self.setting_row(
                tr::settings::meetings::page::setup(),
                Some(tr::settings::meetings::page::setup_description()),
                self.button(
                    "meetings-run-setup",
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::overview::run_setup(),
                    false,
                    cx,
                    |this, _, cx| this.meetings_run_setup(cx),
                )
                .into_any_element(),
            ),
        );
        self.section(
            tr::settings::meetings::overview::title(),
            Some(tr::settings::meetings::overview::description()),
            None,
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }

    fn meetings_notifications(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let s = self.pages.meetings.settings.notifications.clone();
        let mut rows = vec![self.setting_row(
            tr::settings::meetings::notifications::scheduled(),
            Some(tr::settings::meetings::notifications::scheduled_description()),
            self.meetings_flag(
                "meetings-scheduled",
                tr::settings::meetings::notifications::scheduled(),
                Flag::Scheduled,
                cx,
            ),
        )];
        if s.scheduled {
            rows.push(self.setting_row(
                tr::settings::meetings::notifications::notify_me(),
                None,
                self.meetings_select(
                    "meetings-lead",
                    lead_label(s.lead_secs),
                    MeetingsMenu::Lead,
                    cx,
                ),
            ));
            rows.push(self.setting_row(
                tr::settings::meetings::notifications::show_join(),
                Some(tr::settings::meetings::notifications::show_join_description()),
                self.meetings_flag(
                    "meetings-join",
                    tr::settings::meetings::notifications::show_join(),
                    Flag::ShowJoin,
                    cx,
                ),
            ));
        }
        rows.push(self.setting_row(
            tr::settings::meetings::notifications::detected(),
            Some(tr::settings::meetings::notifications::detected_description()),
            self.meetings_flag(
                "meetings-detected",
                tr::settings::meetings::notifications::detected(),
                Flag::Detected,
                cx,
            ),
        ));

        let chips = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .children(s.muted_app_ids.iter().enumerate().map(|(index, id)| {
                let remove = id.clone();
                div()
                    .id(("meetings-muted", index))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.))
                    .h(px(24.))
                    .pl(px(10.))
                    .pr(px(7.))
                    .rounded_full()
                    .bg(palette.fill)
                    .border_1()
                    .border_color(palette.border)
                    .text_size(px(12.))
                    .cursor_pointer()
                    .hover(move |el| el.bg(palette.hover))
                    .child(super::app_name(id))
                    .child(glyph("icons/x.svg", 10., palette.muted))
                    .on_click(cx.listener(move |this, _, _, cx| this.meetings_unmute(&remove, cx)))
            }))
            .child(
                ui::Button::settings(
                    &self.theme,
                    "meetings-add-app",
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .label(tr::settings::meetings::notifications::add_app())
                .icon("icons/plus.svg")
                .on_click(cx.listener(
                    |this, event: &gpui::ClickEvent, window, cx| {
                        this.meetings_open_menu(MeetingsMenu::AddApp, event.position(), window, cx)
                    },
                )),
            );
        rows.push(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .p(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .child(tr::settings::meetings::notifications::muted()),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(palette.muted)
                                .child(tr::settings::meetings::notifications::muted_description()),
                        ),
                )
                .child(chips)
                .into_any_element(),
        );
        rows.push(self.meetings_row(
            tr::settings::meetings::notifications::position(),
            Some(corner_label(s.position)),
            self.meetings_corner_pad(s.position, cx),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::notifications::sound(),
            Some(tr::settings::meetings::notifications::sound_description()),
            self.meetings_flag(
                "meetings-sound",
                tr::settings::meetings::notifications::sound(),
                Flag::Sound,
                cx,
            ),
        ));
        self.section(
            tr::settings::meetings::notifications::title(),
            None,
            None,
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }

    fn meetings_corner_pad(
        &self,
        current: cap_meetings::settings::PromptPosition,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        use cap_meetings::settings::PromptPosition as P;
        let palette = Palette::new(&self.theme);
        div()
            .relative()
            .w(px(76.))
            .h(px(50.))
            .rounded(px(7.))
            .border_1()
            .border_color(palette.border)
            .bg(palette.fill)
            .children(CORNERS.iter().enumerate().map(|(index, corner)| {
                let corner = *corner;
                let selected = corner == current;
                let slot = div()
                    .id(("meetings-corner", index))
                    .absolute()
                    .w(px(30.))
                    .h(px(20.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(div().w(px(20.)).h(px(9.)).rounded(px(3.)).bg(if selected {
                        palette.accent
                    } else {
                        palette.border
                    }))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.meetings_set_corner(corner, cx)),
                    );
                match corner {
                    P::TopLeft => slot.top(px(2.)).left(px(2.)),
                    P::TopRight => slot.top(px(2.)).right(px(2.)),
                    P::BottomLeft => slot.bottom(px(2.)).left(px(2.)),
                    P::BottomRight => slot.bottom(px(2.)).right(px(2.)),
                }
            }))
            .into_any_element()
    }

    fn meetings_automation(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let s = self.pages.meetings.settings.automation.clone();
        let mut rows = vec![self.meetings_row(
            tr::settings::meetings::automation::auto_record(),
            Some(if s.auto_record == AutoRecord::Off {
                tr::settings::meetings::automation::never_description()
            } else {
                tr::settings::meetings::automation::on_description()
            }),
            self.meetings_select(
                "meetings-auto-record",
                auto_record_label(s.auto_record),
                MeetingsMenu::AutoRecord,
                cx,
            ),
        )];
        if s.auto_record != AutoRecord::Off {
            rows.push(self.setting_row(
                tr::settings::meetings::automation::countdown(),
                Some(tr::settings::meetings::automation::countdown_description()),
                self.meetings_select(
                    "meetings-countdown",
                    tr::settings::meetings::automation::seconds(s.countdown_secs as usize),
                    MeetingsMenu::Countdown,
                    cx,
                ),
            ));
        }
        rows.push(self.setting_row(
            tr::settings::meetings::automation::bring_forward(),
            Some(tr::settings::meetings::automation::bring_forward_description()),
            self.meetings_flag(
                "meetings-bring-forward",
                tr::settings::meetings::automation::bring_forward(),
                Flag::BringForward,
                cx,
            ),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::automation::show_cap(),
            Some(tr::settings::meetings::automation::show_cap_description()),
            self.meetings_flag(
                "meetings-show-cap",
                tr::settings::meetings::automation::show_cap(),
                Flag::ShowCap,
                cx,
            ),
        ));
        if cfg!(target_os = "macos") {
            let recognised = s.browser_policy == BrowserPolicy::RecognisedOnly;
            let segmented = ui::SegmentedControl::settings(
                &self.theme,
                "meetings-browsers",
                vec![
                    ui::SegmentOption::new(
                        tr::settings::meetings::automation::browsers_any(),
                        !recognised,
                    ),
                    ui::SegmentOption::new(
                        tr::settings::meetings::automation::browsers_recognised(),
                        recognised,
                    ),
                ],
            )
            .on_select(cx.listener(|this, index: &usize, _, cx| {
                let policy = if *index == 0 {
                    BrowserPolicy::Any
                } else {
                    BrowserPolicy::RecognisedOnly
                };
                this.meetings_set_browser_policy(policy, cx);
            }));
            let ax = self.pages.meetings.accessibility;
            let note = recognised.then(|| {
                let granted = ax == Access::Granted;
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .bg(palette.fill)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(12.))
                            .child(shared::status_dot(if granted {
                                palette.green
                            } else {
                                palette.amber
                            }))
                            .child(if granted {
                                tr::settings::meetings::automation::ax_granted()
                            } else {
                                tr::settings::meetings::automation::ax_missing()
                            }),
                    )
                    .when(!granted, |el| {
                        el.child(self.button(
                            "meetings-ax-grant",
                            (ui::ButtonVariant::Gray, None),
                            if self.pages.meetings.ax_requested {
                                tr::settings::meetings::automation::open_settings()
                            } else {
                                tr::settings::meetings::automation::grant()
                            },
                            false,
                            cx,
                            |this, _, cx| this.meetings_grant_accessibility(cx),
                        ))
                    })
            });
            rows.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(16.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .child(tr::settings::meetings::automation::browsers()),
                            )
                            .child(segmented),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .text_color(palette.muted)
                            .child(if recognised {
                                tr::settings::meetings::automation::browsers_recognised_description(
                                )
                            } else {
                                tr::settings::meetings::automation::browsers_any_description()
                            }),
                    )
                    .children(note)
                    .into_any_element(),
            );
        }
        self.section(
            tr::settings::meetings::automation::title(),
            None,
            None,
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }

    fn meetings_recording(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let s = self.pages.meetings.settings.recording.clone();
        let mut rows = vec![
            self.setting_row(
                tr::settings::meetings::recording::stop_on_end(),
                Some(tr::settings::meetings::recording::stop_on_end_description()),
                self.meetings_flag(
                    "meetings-stop-on-end",
                    tr::settings::meetings::recording::stop_on_end(),
                    Flag::StopOnEnd,
                    cx,
                ),
            ),
            self.setting_row(
                tr::settings::meetings::recording::silence(),
                Some(tr::settings::meetings::recording::silence_description()),
                self.meetings_select(
                    "meetings-silence",
                    silence_label(s.inactivity_minutes),
                    MeetingsMenu::Silence,
                    cx,
                ),
            ),
            self.setting_row(
                tr::settings::meetings::recording::keep_audio(),
                Some(if s.keep_audio {
                    tr::settings::meetings::recording::keep_audio_description()
                } else {
                    tr::settings::meetings::recording::keep_audio_off_description()
                }),
                self.meetings_flag(
                    "meetings-keep-audio",
                    tr::settings::meetings::recording::keep_audio(),
                    Flag::KeepAudio,
                    cx,
                ),
            ),
        ];
        if s.keep_audio {
            let path = crate::store::app_data_dir().join("documents");
            let reveal = path.clone();
            rows.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(16.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .child(tr::settings::meetings::recording::keep_for()),
                            )
                            .child(self.meetings_select(
                                "meetings-retention",
                                retention_label(s.audio_retention_days),
                                MeetingsMenu::Retention,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(px(12.))
                                    .text_color(palette.muted)
                                    .truncate()
                                    .child(tr::settings::meetings::recording::stored_at(
                                        path.display(),
                                    )),
                            )
                            .child(self.button(
                                "meetings-reveal",
                                (ui::ButtonVariant::Gray, None),
                                if cfg!(target_os = "macos") {
                                    tr::settings::meetings::recording::show_in_finder()
                                } else if cfg!(windows) {
                                    tr::settings::meetings::recording::show_in_explorer()
                                } else {
                                    tr::settings::meetings::recording::show_in_files()
                                },
                                false,
                                cx,
                                move |_, _, cx| {
                                    let _ = std::fs::create_dir_all(&reveal);
                                    crate::library::reveal_path(&reveal, cx);
                                },
                            )),
                    )
                    .into_any_element(),
            );
        }
        let mic_label: SharedString = match &s.microphone {
            Microphone::Auto => tr::settings::meetings::recording::mic_auto().into(),
            Microphone::Named(name) => name.clone().into(),
        };
        rows.push(self.setting_row(
            tr::settings::meetings::recording::microphone(),
            Some(tr::settings::meetings::recording::microphone_description()),
            self.meetings_select("meetings-mic", mic_label, MeetingsMenu::Microphone, cx),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::recording::indicator(),
            Some(tr::settings::meetings::recording::indicator_description()),
            self.meetings_flag(
                "meetings-indicator",
                tr::settings::meetings::recording::indicator(),
                Flag::Indicator,
                cx,
            ),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::recording::sounds(),
            None,
            self.meetings_flag(
                "meetings-sounds",
                tr::settings::meetings::recording::sounds(),
                Flag::Sounds,
                cx,
            ),
        ));
        self.section(
            tr::settings::meetings::recording::title(),
            None,
            None,
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }

    /// The one speech model Cap Notes needs: what it is, and where it is.
    pub(crate) fn meetings_model_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let notes = shared::notes_model(&self.pages.meetings.settings);
        let name = notes.model.name;
        let busy = shared::download_running();
        let deleting = self.pages.meetings.delete.is_some();
        let action: AnyElement = match notes.state.clone() {
            ModelState::Ready => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(5.))
                        .text_size(px(12.))
                        .text_color(palette.green)
                        .child(glyph("icons/check.svg", 12., palette.green))
                        .child(tr::settings::meetings::transcription::model_ready()),
                )
                .child(self.button(
                    gpui::ElementId::Name(format!("meetings-delete-model-{name}").into()),
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::transcription::delete(),
                    deleting,
                    cx,
                    move |this, window, cx| this.meetings_delete_model(name, window, cx),
                ))
                .into_any_element(),
            ModelState::Downloading(progress) => div()
                .flex()
                .flex_col()
                .items_end()
                .gap(px(4.))
                .w(px(120.))
                .child(div().text_size(px(11.)).text_color(palette.muted).child(
                    tr::settings::meetings::transcription::downloading(progress.round() as u32),
                ))
                .child(shared::progress_bar(palette, (progress / 100.) as f32))
                .into_any_element(),
            ModelState::Failed => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(palette.red)
                        .child(tr::settings::meetings::transcription::download_failed()),
                )
                .child(self.button(
                    gpui::ElementId::Name(format!("meetings-retry-model-{name}").into()),
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::transcription::retry(),
                    busy,
                    cx,
                    move |this, window, cx| this.meetings_download(name, window, cx),
                ))
                .into_any_element(),
            ModelState::Missing => self
                .button(
                    gpui::ElementId::Name(format!("meetings-download-model-{name}").into()),
                    (ui::ButtonVariant::Primary, Some("icons/download.svg")),
                    tr::settings::meetings::transcription::download(),
                    busy,
                    cx,
                    move |this, window, cx| this.meetings_download(name, window, cx),
                )
                .into_any_element(),
        };
        let slow = notes.why == shared::NotesModelWhy::Slow;
        let cap_ai = if slow {
            self.meetings_cloud_action(cx)
        } else {
            None
        };
        let body = match notes.why {
            shared::NotesModelWhy::Slow => tr::settings::meetings::transcription::slow_model(),
            shared::NotesModelWhy::Tuned => tr::settings::meetings::transcription::model_body(),
            shared::NotesModelWhy::NeedsAppleSilicon => {
                tr::settings::meetings::transcription::model_body_intel()
            }
            shared::NotesModelWhy::Language => {
                tr::settings::meetings::transcription::model_body_language()
            }
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .py(px(4.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_baseline()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(tr::settings::meetings::transcription::model_title()),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(palette.muted)
                                    .child(shared::mega_size(notes.model.size)),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(palette.muted)
                            .child(body),
                    )
                    .children(
                        cap_ai.map(|button| div().flex().flex_row().pt(px(6.)).child(button)),
                    ),
            )
            .child(action)
            .into_any_element()
    }

    pub(crate) fn meetings_cloud_note(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = Palette::new(&self.theme);
        let (text, action): (&'static str, Option<(&'static str, fn(&mut gpui::App))>) =
            match self.pages.meetings.cloud {
                CloudState::Available => return None,
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
        Some(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(7.))
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(palette.muted)
                        .child(glyph("icons/cloud.svg", 13., palette.muted))
                        .child(text),
                )
                .children(action.map(|(label, act)| {
                    self.button(
                        "meetings-cloud-action",
                        (ui::ButtonVariant::Primary, None),
                        label,
                        false,
                        cx,
                        move |_, _, cx| act(cx),
                    )
                }))
                .into_any_element(),
        )
    }

    /// Cap Cloud on a computer too slow for live local captions: say why the
    /// transcript shows the cloud's lines a moment late.
    fn meetings_slow_note(&self) -> AnyElement {
        let palette = Palette::new(&self.theme);
        div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(7.))
            .min_w_0()
            .text_size(px(12.))
            .line_height(px(17.))
            .text_color(palette.muted)
            .child(
                div()
                    .pt(px(2.))
                    .child(glyph("icons/cloud.svg", 13., palette.muted)),
            )
            .child(
                div()
                    .min_w_0()
                    .child(tr::settings::meetings::transcription::slow_device()),
            )
            .into_any_element()
    }

    /// A slow computer's model row: the Cap Cloud recommendation's action.
    fn meetings_cloud_action(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let action = shared::cloud_action(self.pages.meetings.cloud)?;
        Some(
            self.button(
                "meetings-slow-cloud",
                // Download stays the row's one primary action.
                (ui::ButtonVariant::Gray, None),
                action.label(),
                false,
                cx,
                move |this, _, cx| this.meetings_run_cloud_action(action, cx),
            )
            .into_any_element(),
        )
    }

    /// Whisper small from before, on a slow computer whose notes now use
    /// Whisper base: offer to delete it (never deleted unasked).
    fn meetings_old_model(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let notes = shared::notes_model(&self.pages.meetings.settings);
        let old = crate::meetings::NOTES_FALLBACK_MODEL;
        if notes.why != shared::NotesModelWhy::Slow || notes.model.name == old {
            return None;
        }
        let snapshot = crate::transcription::ui_snapshot(std::path::Path::new(""));
        if !snapshot.downloaded.contains(old) {
            return None;
        }
        let size = crate::editor_tabs::CAPTION_MODELS
            .iter()
            .find(|m| m.name == old)
            .map_or("", |m| m.size);
        Some(
            self.meetings_row(
                tr::settings::meetings::transcription::old_model(),
                Some(
                    tr::settings::meetings::transcription::old_model_description(
                        shared::mega_size(size),
                    ),
                ),
                self.button(
                    "meetings-delete-old-model",
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::transcription::delete(),
                    self.pages.meetings.delete.is_some(),
                    cx,
                    move |this, window, cx| this.meetings_delete_model(old, window, cx),
                )
                .into_any_element(),
            ),
        )
    }

    /// The live transcript switch: off by default with Cap Cloud on a
    /// computer too slow for live local captions, as chosen everywhere else.
    fn meetings_live_toggle(&self, cx: &mut Context<Self>) -> AnyElement {
        self.toggle(
            "meetings-live",
            tr::settings::meetings::transcription::live(),
            self.meetings_live(),
            cx,
            |this, cx| this.meetings_toggle_live(cx),
        )
        .into_any_element()
    }

    fn meetings_transcription(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let s = self.pages.meetings.settings.transcription.clone();
        let local = s.engine == Engine::Local;
        let engine_row = self.setting_row(
            tr::settings::meetings::page::engine(),
            Some(if local {
                tr::settings::meetings::transcription::local_description()
            } else {
                tr::settings::meetings::transcription::cloud_description()
            }),
            ui::SegmentedControl::settings(
                &self.theme,
                "meetings-engine",
                vec![
                    ui::SegmentOption::new(shared::local_label(), local),
                    ui::SegmentOption::new(tr::settings::meetings::transcription::cloud(), !local),
                ],
            )
            .on_select(cx.listener(move |this, index: &usize, _, cx| {
                let engine = if *index == 0 {
                    Engine::Local
                } else {
                    Engine::Cloud
                };
                this.meetings_set_engine(engine, cx);
            }))
            .into_any_element(),
        );
        let mut engine_rows = vec![engine_row];
        if !local && crate::meetings::device::slow() {
            engine_rows.push(
                div()
                    .px(px(12.))
                    .pt(px(10.))
                    .child(self.meetings_slow_note())
                    .into_any_element(),
            );
        }
        if local {
            engine_rows.push(
                div()
                    .px(px(12.))
                    .pt(px(10.))
                    .pb(px(6.))
                    .child(self.meetings_model_list(cx))
                    .into_any_element(),
            );
            if let Some(old) = self.meetings_old_model(cx) {
                engine_rows.push(old);
            }
        } else if let Some(note) = self.meetings_cloud_note(cx) {
            engine_rows.push(div().p(px(12.)).child(note).into_any_element());
        }
        let language: &'static str = match &s.language {
            Language::Auto => tr::editor::tabs::captions::language::auto(),
            Language::Code(code) => language_label(code),
        };

        let words = s.entries().len();
        let vocab = self.setting_row(
            tr::settings::dictionary::title(),
            Some(tr::settings::dictionary::row_description()),
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(palette.muted)
                        .whitespace_nowrap()
                        .child(tr::settings::dictionary::count(words)),
                )
                .child(self.button(
                    "meetings-dictionary",
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::dictionary::edit(),
                    false,
                    cx,
                    |this, window, cx| {
                        this.set_page(crate::settings_window::Page::Transcription, window, cx)
                    },
                ))
                .into_any_element(),
        );

        self.section(
            tr::settings::meetings::transcription::title(),
            None,
            None,
            vec![
                self.rows(engine_rows).into_any_element(),
                self.rows(vec![
                    self.setting_row(
                        tr::settings::meetings::transcription::language(),
                        Some(tr::settings::meetings::transcription::language_description()),
                        self.meetings_select(
                            "meetings-language",
                            language,
                            MeetingsMenu::Language,
                            cx,
                        ),
                    ),
                    vocab,
                    self.setting_row(
                        tr::settings::meetings::transcription::live(),
                        Some(tr::settings::meetings::transcription::live_description()),
                        self.meetings_live_toggle(cx),
                    ),
                ])
                .into_any_element(),
                self.meetings_voice(cx),
            ],
        )
        .into_any_element()
    }

    /// Learning the user's voice, forgetting what was learnt, and credit for
    /// the speaker models.
    pub(crate) fn meetings_voice(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut rows = vec![self.setting_row(
            tr::settings::meetings::transcription::voice(),
            Some(tr::settings::meetings::transcription::voice_description()),
            self.meetings_flag(
                "meetings-learn-voice",
                tr::settings::meetings::transcription::voice(),
                Flag::LearnVoice,
                cx,
            ),
        )];
        rows.push(self.setting_row(
            tr::settings::meetings::transcription::app_names(),
            Some(tr::settings::meetings::transcription::app_names_description()),
            self.meetings_flag(
                "meetings-app-names",
                tr::settings::meetings::transcription::app_names(),
                Flag::AppNames,
                cx,
            ),
        ));
        // From macOS 27.3 the grant lives under System & App Protection
        // Override, per meeting app (issue #4410): say so, and show how.
        if crate::permissions::grants_are_settings_only()
            && !cap_meeting_platform::accessibility_trusted()
        {
            rows.push(
                self.setting_row(
                    tr::settings::meetings::transcription::app_names_setup(),
                    Some(tr::settings::meetings::transcription::app_names_setup_description()),
                    self.button(
                        "meetings-app-names-setup",
                        (ui::ButtonVariant::Gray, None),
                        tr::settings::meetings::transcription::app_names_setup_button(),
                        false,
                        cx,
                        |_, _, cx| {
                            crate::permission_help::show(
                                crate::permission_help::Need::MeetingApps,
                                cx,
                            )
                        },
                    )
                    .into_any_element(),
                ),
            );
        }
        if let Some(state) = shared::speakers_model() {
            rows.push(self.setting_row(
                tr::settings::meetings::transcription::speakers_model(),
                Some(tr::settings::meetings::transcription::speakers_model_description()),
                self.meetings_speakers_model(state, cx),
            ));
        }
        rows.push(self.setting_row(
            tr::settings::meetings::transcription::model_credits(),
            Some(tr::settings::meetings::transcription::model_credits_description()),
            self.button(
                "meetings-model-licenses",
                (ui::ButtonVariant::Gray, None),
                tr::settings::meetings::transcription::licenses(),
                false,
                cx,
                |_, _, cx| cx.open_url(MODEL_LICENSES_URL),
            )
            .into_any_element(),
        ));
        if let Some(meetings) = self.pages.meetings.voice_meetings {
            rows.push(
                ui::SettingRow::settings(
                    &self.theme,
                    tr::settings::meetings::transcription::voice_learnt(meetings as usize),
                    None,
                    self.button(
                        "meetings-forget-voice",
                        (ui::ButtonVariant::Gray, None),
                        tr::settings::meetings::transcription::voice_forget(),
                        false,
                        cx,
                        |this, _, cx| this.meetings_forget_voice(cx),
                    )
                    .into_any_element(),
                )
                .into_any_element(),
            );
        }
        self.rows(rows).into_any_element()
    }

    /// Where the better speaker model is: ready, coming, or failed with a
    /// quiet way to try again.
    fn meetings_speakers_model(
        &self,
        state: shared::SpeakersModel,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = Palette::new(&self.theme);
        let fetch = |this: &mut Self, window: &mut Window, cx: &mut Context<Self>| {
            shared::start_speakers_download(cx);
            this.meetings_arm_download_tick(window, cx);
            cx.notify();
        };
        match state {
            shared::SpeakersModel::Ready => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.))
                .text_size(px(12.))
                .text_color(palette.green)
                .child(glyph("icons/check.svg", 12., palette.green))
                .child(tr::settings::meetings::transcription::model_ready())
                .into_any_element(),
            shared::SpeakersModel::Downloading(share) => div()
                .flex()
                .flex_col()
                .items_end()
                .gap(px(4.))
                .w(px(120.))
                .child(div().text_size(px(11.)).text_color(palette.muted).child(
                    tr::settings::meetings::transcription::downloading(
                        (share * 100.).round() as u32,
                    ),
                ))
                .child(shared::progress_bar(palette, share as f32))
                .into_any_element(),
            shared::SpeakersModel::Failed => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(palette.red)
                        .child(tr::settings::meetings::transcription::download_failed()),
                )
                .child(self.button(
                    "meetings-speakers-retry",
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::transcription::retry(),
                    false,
                    cx,
                    fetch,
                ))
                .into_any_element(),
            shared::SpeakersModel::Missing | shared::SpeakersModel::Unsupported => self
                .button(
                    "meetings-speakers-download",
                    (ui::ButtonVariant::Gray, None),
                    tr::settings::meetings::transcription::download(),
                    false,
                    cx,
                    fetch,
                )
                .into_any_element(),
        }
    }

    fn meetings_notes(&self, cx: &mut Context<Self>) -> AnyElement {
        let s = self.pages.meetings.settings.notes.clone();
        let template = self
            .pages
            .meetings
            .templates
            .iter()
            .find(|t| t.id == s.default_template_id)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| s.default_template_id.clone());
        let language: &'static str = match &s.summary_language {
            None => tr::settings::meetings::notes::same_as_meeting(),
            Some(code) => language_label(code),
        };
        let mut rows = vec![self.setting_row(
            tr::settings::meetings::notes::auto(),
            Some(tr::settings::meetings::notes::auto_description()),
            self.meetings_flag(
                "meetings-auto-notes",
                tr::settings::meetings::notes::auto(),
                Flag::AutoNotes,
                cx,
            ),
        )];
        if let Some(row) = self.cap_ai_row(cx) {
            rows.push(row);
        }
        rows.push(self.setting_row(
            tr::settings::meetings::notes::template(),
            None,
            self.meetings_select("meetings-template", template, MeetingsMenu::Template, cx),
        ));
        rows.push(self.setting_row(
            tr::settings::meetings::notes::language(),
            None,
            self.meetings_select(
                "meetings-notes-language",
                language,
                MeetingsMenu::NotesLanguage,
                cx,
            ),
        ));
        self.section(
            tr::settings::meetings::notes::title(),
            None,
            None,
            vec![self.rows(rows).into_any_element()],
        )
        .into_any_element()
    }
    fn cap_ai_row(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use crate::meetings::{AiAccess, Meetings};
        let meetings = Meetings::try_global(cx)?;
        let (access, trial) = {
            let m = meetings.read(cx);
            (m.ai_access(), m.trial_remaining())
        };
        let palette = Palette::new(&self.theme);
        let (text, action) = crate::meetings_ui::cap_ai::status_line(access, trial);
        let icon_color = if access == AiAccess::Ready {
            palette.green
        } else {
            palette.muted
        };
        let icon = if access == AiAccess::Ready {
            "icons/circle-check.svg"
        } else {
            "icons/file-text.svg"
        };
        Some(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .p(px(12.))
                .min_h(px(52.))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .min_w_0()
                        .text_size(px(12.5))
                        .line_height(px(17.))
                        .text_color(palette.muted)
                        .child(glyph(icon, 14., icon_color))
                        .child(div().min_w_0().child(text)),
                )
                .children(action.map(|(label, sign_in)| {
                    self.button(
                        "meetings-cap-ai",
                        (ui::ButtonVariant::Primary, None),
                        label,
                        false,
                        cx,
                        move |_, _, cx| {
                            if sign_in {
                                shared::sign_in(cx)
                            } else {
                                crate::meetings_ui::cap_ai::open_upgrade(
                                    None,
                                    crate::meetings_ui::cap_ai::Host::Window,
                                    cx,
                                )
                            }
                        },
                    )
                }))
                .into_any_element(),
        )
    }
}
