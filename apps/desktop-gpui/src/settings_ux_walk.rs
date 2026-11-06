use gpui::{AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Window, div, px};
use serde_json::{Map, Value};

use crate::{
    settings_window::{MenuKind, SettingsWindow},
    ui, ux_walk,
};

const FIELDS: &[(&str, &str)] = &[
    ("me", "Your name"),
    ("url", "Start page"),
    ("outDir", "Walk recordings folder"),
    ("language", "Language code"),
    ("glossary", "Glossaries"),
    ("speakers", "Speaker names"),
    ("sourceRoot", "Product source folder"),
];

pub(crate) struct UxWalkSettings {
    values: Map<String, Value>,
    inputs: Vec<Entity<ui::TextInputState>>,
    notice: Option<String>,
    key_status: &'static str,
    key_busy: bool,
    pub(crate) projects: crate::settings_ux_walk_projects::ProjectsSettings,
    _subscriptions: Vec<gpui::Subscription>,
}

impl UxWalkSettings {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<SettingsWindow>) -> Self {
        let loaded = ux_walk::load();
        let notice = loaded.as_ref().err().cloned();
        let values = loaded.unwrap_or_default();
        let mut subscriptions = Vec::new();
        let inputs = FIELDS
            .iter()
            .enumerate()
            .map(|(index, (key, label))| {
                let input = cx.new(|cx| {
                    let mut input = ui::TextInputState::single_line(window, cx);
                    input.set_placeholder(*label);
                    input.set_text(ux_walk::text(&values, key).to_string(), cx);
                    input
                });
                subscriptions.push(cx.subscribe(&input, move |this, _, event, cx| match event {
                    ui::TextInputEvent::Changed => cx.notify(),
                    ui::TextInputEvent::Confirmed | ui::TextInputEvent::Blurred => {
                        this.ux_walk_save_field(index, cx);
                    }
                    _ => {}
                }));
                input
            })
            .collect();
        Self {
            values,
            inputs,
            notice,
            key_status: "Checking Keychain…",
            key_busy: false,
            projects: crate::settings_ux_walk_projects::ProjectsSettings::new(window, cx),
            _subscriptions: subscriptions,
        }
    }
}

impl SettingsWindow {
    pub(crate) fn ux_walk_refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match ux_walk::load() {
            Ok(values) => {
                self.ux_walk.values = values;
                self.ux_walk.notice = None;
                for (index, (key, _)) in FIELDS.iter().enumerate() {
                    let text = ux_walk::text(&self.ux_walk.values, key).to_string();
                    self.ux_walk.inputs[index].update(cx, |input, cx| input.set_text(text, cx));
                }
            }
            Err(error) => self.ux_walk.notice = Some(error),
        }
        self.ux_walk_refresh_key(window, cx);
        self.ux_walk_projects_refresh(window, cx);
    }

    fn ux_walk_refresh_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let values = self.ux_walk.values.clone();
        let provider = ux_walk::provider(&values);
        self.ux_walk.key_status = "Checking Keychain…";
        cx.spawn_in(window, async move |this, cx| {
            let status = cx
                .background_executor()
                .spawn(async move {
                    provider.map_or("Choose a supported provider", |provider| {
                        ux_walk::key_status(&values, provider)
                    })
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if ux_walk::provider(&this.ux_walk.values).map(|provider| provider.id)
                    == provider.map(|provider| provider.id)
                {
                    this.ux_walk.key_status = status;
                    cx.notify();
                    window.refresh();
                }
            })
            .ok();
        })
        .detach();
    }

    fn ux_walk_write(&mut self, key: &str, value: Value, cx: &mut Context<Self>) {
        if key == "outDir"
            && let Err(error) =
                crate::ux_walk_library::remember_root(ux_walk::text(&self.ux_walk.values, "outDir"))
        {
            self.ux_walk.notice = Some(error);
            cx.notify();
            return;
        }
        match ux_walk::save(key, value) {
            Ok(values) => {
                self.ux_walk.values = values;
                self.ux_walk.notice = Some("Saved".into());
            }
            Err(error) => self.ux_walk.notice = Some(error),
        }
        cx.notify();
    }

    fn ux_walk_save_field(&mut self, index: usize, cx: &mut Context<Self>) {
        let key = FIELDS[index].0;
        let value = self.ux_walk.inputs[index]
            .read(cx)
            .text()
            .trim()
            .to_string();
        if value != ux_walk::text(&self.ux_walk.values, key) {
            self.ux_walk_write(key, Value::String(value), cx);
        }
    }

    pub(crate) fn ux_walk_menu_items(&self, kind: MenuKind) -> Vec<ui::MenuItem> {
        let values = &self.ux_walk.values;
        match kind {
            MenuKind::UxWalkProvider => ux_walk::PROVIDERS
                .iter()
                .map(|provider| {
                    ui::MenuItem::new(
                        provider.label,
                        provider.id == ux_walk::text(values, "transcriber"),
                    )
                })
                .collect(),
            MenuKind::UxWalkHandoff => ux_walk::HANDOFFS
                .iter()
                .map(|(value, label)| {
                    ui::MenuItem::new(*label, *value == ux_walk::text(values, "agent"))
                })
                .collect(),
            MenuKind::UxWalkProjects(menu) => self.ux_walk_projects_menu_items(menu),
            _ => Vec::new(),
        }
    }

    pub(crate) fn ux_walk_choose(
        &mut self,
        kind: MenuKind,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            MenuKind::UxWalkProvider => {
                if let Some(provider) = ux_walk::PROVIDERS.get(index) {
                    self.ux_walk_write("transcriber", Value::String(provider.id.into()), cx);
                    self.ux_walk_refresh_key(window, cx);
                }
            }
            MenuKind::UxWalkHandoff => {
                if let Some((value, _)) = ux_walk::HANDOFFS.get(index) {
                    self.ux_walk_write("agent", Value::String((*value).into()), cx);
                }
            }
            MenuKind::UxWalkProjects(menu) => {
                self.ux_walk_projects_choose(menu, index, window, cx);
            }
            _ => {}
        }
    }

    fn ux_walk_field(&self, index: usize, cx: &mut Context<Self>) -> gpui::AnyElement {
        let (key, label) = FIELDS[index];
        let input = &self.ux_walk.inputs[index];
        let changed = input.read(cx).text().trim() != ux_walk::text(&self.ux_walk.values, key);
        let controls = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .w(px(290.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(ui::TextInput::settings(&self.theme, key, input)),
            )
            .child(self.button(
                ("ux-walk-save", index),
                (ui::ButtonVariant::Gray, None),
                "Save",
                !changed,
                cx,
                move |this, _, cx| this.ux_walk_save_field(index, cx),
            ));
        self.setting_row(label, None, controls.into_any_element())
    }

    fn ux_walk_toggle(
        &self,
        key: &'static str,
        label: &'static str,
        description: &'static str,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let enabled = ux_walk::enabled(&self.ux_walk.values, key);
        self.setting_row(
            label,
            Some(description),
            self.toggle(key, label, enabled, cx, move |this, cx| {
                this.ux_walk_write(key, Value::Bool(!enabled), cx);
            })
            .into_any_element(),
        )
    }

    fn ux_walk_notice(&self) -> gpui::AnyElement {
        self.note_box()
            .text_size(px(12.))
            .text_color(self.theme.settings_muted())
            .child(self.ux_walk.notice.clone().unwrap_or_else(|| {
                fork_brand::mode_text("Shared with %walk% and the UX Walk CLI. Environment variables and command-line options override these defaults.").into()
            }))
            .into_any_element()
    }

    pub(crate) fn render_ux_walk_general(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        // The notes switch is its own section beside the walk defaults; the page spaces
        // sections 28px apart and this keeps the same rhythm.
        div()
            .flex()
            .flex_col()
            .gap(px(28.))
            .child(self.render_ux_walk_defaults(cx))
            .child(self.render_recording_notes(cx))
            .child(self.render_ux_walk_projects(cx))
            .child(self.render_ux_walk_trackers(cx))
            .into_any_element()
    }

    fn render_recording_notes(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        self.section(
            ux_walk::notes::NAME,
            Some("For ordinary Studio and Instant recordings. Walks and diatribes always have notes."),
            None,
            vec![
                self.rows(vec![self.ux_walk_toggle(
                    ux_walk::RECORDING_NOTES,
                    "Make notes for new recordings",
                    "After a recording stops, transcribe it in the background and list its notes, decisions and action items in your walk recordings folder. The recording opens, shares and saves as usual. Turn it on or off for one recording in the recorder.",
                    cx,
                )])
                .into_any_element(),
            ],
        )
        .into_any_element()
    }

    fn render_ux_walk_defaults(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let handoff = ux_walk::HANDOFFS
            .iter()
            .find(|(value, _)| *value == ux_walk::text(&self.ux_walk.values, "agent"))
            .map_or("Choose an action", |(_, label)| *label);
        self.section(
            fork_brand::WALK_MODE_NAME,
            Some("Defaults for narrated walkthroughs, notes and agent handoffs."),
            Some(
                self.button(
                    "ux-walk-start",
                    (ui::ButtonVariant::Primary, None),
                    fork_brand::mode_text_static("Open %walk%"),
                    false,
                    cx,
                    |_, _, cx| ux_walk::start(cx),
                )
                .into_any_element(),
            ),
            vec![
                self.rows(vec![
                    self.ux_walk_field(0, cx),
                    self.ux_walk_field(1, cx),
                    self.ux_walk_field(5, cx),
                    self.ux_walk_toggle(
                        "askSpeakers",
                        "Ask who is speaking",
                        "Confirm speaker names before each walk.",
                        cx,
                    ),
                    self.setting_row(
                        "Agent handoff",
                        None,
                        self.select("ux-walk-handoff", handoff, MenuKind::UxWalkHandoff, cx)
                            .into_any_element(),
                    ),
                    self.ux_walk_toggle(
                        "brief",
                        "Generate chapter briefs",
                        "Use your configured Claude CLI to summarize each processed chapter.",
                        cx,
                    ),
                    self.ux_walk_field(6, cx),
                    self.setting_row("Browser evidence", Some(fork_brand::text_static("Walks in the browser opened by Cap include clicks, page errors and failed requests alongside your video and notes. Other capture sources keep video and notes; each walk’s report shows the evidence available.")), div().into_any_element()),
                ])
                .into_any_element(),
                self.ux_walk_notice(),
            ],
        )
        .into_any_element()
    }

    pub(crate) fn render_ux_walk_recordings(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        self.section(
            fork_brand::mode_text_static("%walk% recordings"),
            Some("Walks and diatribes keep their video, notes, chapters and reports together in this folder."),
            None,
            vec![
                self.rows(vec![self.ux_walk_field(2, cx)])
                    .into_any_element(),
                self.ux_walk_notice(),
            ],
        )
        .into_any_element()
    }

    pub(crate) fn render_ux_walk_transcription(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let provider = ux_walk::provider(&self.ux_walk.values);
        let label = provider.map_or("Choose a provider", |provider| provider.label);
        let mut rows = vec![
            self.setting_row(
                "Provider",
                Some(fork_brand::mode_text_static("Used for %walk% recordings.")),
                self.select("ux-walk-provider", label, MenuKind::UxWalkProvider, cx)
                    .into_any_element(),
            ),
        ];
        if provider.is_some_and(|provider| provider.id != "none") {
            rows.push(
                self.setting_row(
                    "API key",
                    Some(self.ux_walk.key_status),
                    self.button(
                        "ux-walk-provider-key",
                        (ui::ButtonVariant::Gray, None),
                        "Add or Replace Key…",
                        self.ux_walk.key_busy || !cfg!(target_os = "macos"),
                        cx,
                        |this, window, cx| this.ux_walk_edit_key(window, cx),
                    )
                    .into_any_element(),
                ),
            );
            rows.push(self.ux_walk_toggle("liveTranscription", "Transcribe while recording", "Send audio to the selected provider in roughly five-minute chunks, then finish the short remaining tail after Stop. Speaker labels may change between chunks. Descript and unsupported live audio finish after recording stops.", cx));
            rows.push(self.ux_walk_field(3, cx));
            rows.push(self.ux_walk_field(4, cx));
            rows.push(self.ux_walk_toggle(
                "screenNames",
                "Use names shown on screen",
                "Improve transcript spellings using names visible during the walk.",
                cx,
            ));
        }
        self.section(
            fork_brand::mode_text_static("%walk% transcription"),
            Some(fork_brand::text_static("Cloud providers receive recording audio when transcription runs. Cap editor captions keep their existing local models.")),
            None,
            vec![self.rows(rows).into_any_element(), self.ux_walk_notice()],
        ).into_any_element()
    }

    fn ux_walk_edit_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = ux_walk::provider(&self.ux_walk.values) else {
            return;
        };
        if self.ux_walk.key_busy {
            return;
        }
        self.ux_walk.key_busy = true;
        let values = self.ux_walk.values.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let secret = ux_walk::prompt_key(provider.label);
            let result = if let Some(secret) = secret {
                Some(
                    cx.background_executor()
                        .spawn(async move { ux_walk::save_key(&values, provider, &secret) })
                        .await,
                )
            } else {
                None
            };
            this.update_in(cx, |this, window, cx| {
                this.ux_walk.key_busy = false;
                if let Some(result) = result {
                    this.ux_walk.notice = Some(match result {
                        Ok(()) => "API key saved in Keychain".into(),
                        Err(error) => error,
                    });
                }
                this.ux_walk_refresh_key(window, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
