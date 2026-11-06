use std::time::Duration;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Task, Window,
    div, prelude::FluentBuilder, px,
};

use super::{MainWindow, Mode, TargetType};
use crate::{
    app_windows, mode_choice::ModeChoice, session::Phase, theme::Theme, ui, ux_walk::notes,
    ux_walk_journal::Request,
};

pub(super) struct RecorderWalk {
    pub(super) selected: bool,
    /// Worm Mode's Diatribe choice: voice and screen only, no walk window or console.
    pub(super) diatribe: bool,
    pub(super) opening: bool,
    replacing_window: bool,
    window_id: Option<String>,
    generation: u64,
    notice: Option<String>,
    key_warning: Option<String>,
    /// The "Notes & action items" default from Settings, refreshed while idle.
    notes_default: bool,
    /// The recorder's own flip of that default, for the next recording only.
    notes_choice: Option<bool>,
    topic: Entity<ui::TextInputState>,
    speakers: Entity<ui::TextInputState>,
    _topic_events: gpui::Subscription,
    _speaker_events: gpui::Subscription,
    _key_watch: Task<()>,
}

fn watch_transcription_key(cx: &mut Context<MainWindow>) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            let Ok((idle, transcribes)) = this.update(cx, |this, cx| {
                (
                    this.session.read(cx).phase == Phase::Idle,
                    this.walk.selected || this.notes_on(cx),
                )
            }) else {
                return;
            };
            if idle {
                let (warning, notes_default) = cx
                    .background_executor()
                    .spawn(async move {
                        let settings = crate::ux_walk::load().ok();
                        (
                            settings
                                .as_ref()
                                .filter(|_| transcribes)
                                .and_then(crate::ux_walk::missing_key_warning),
                            settings.as_ref().is_some_and(|settings| {
                                crate::ux_walk::enabled(settings, crate::ux_walk::RECORDING_NOTES)
                            }),
                        )
                    })
                    .await;
                let updated = this.update(cx, |this, cx| {
                    if transcribes && this.walk.key_warning != warning {
                        this.walk.key_warning = warning;
                        cx.notify();
                    }
                    if this.walk.notes_default != notes_default {
                        this.walk.notes_default = notes_default;
                        cx.notify();
                    }
                });
                if updated.is_err() {
                    return;
                }
            }
            cx.background_executor().timer(Duration::from_secs(5)).await;
        }
    })
}

impl RecorderWalk {
    pub(super) fn new(window: &mut Window, cx: &mut Context<MainWindow>) -> Self {
        let topic = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("What are you walking through?");
            input.set_text(
                crate::store::store_section(crate::store::RECORDING_SETTINGS)
                    .get("uxWalkTopic")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                cx,
            );
            input
        });
        let topic_events = cx.subscribe(&topic, |_: &mut MainWindow, input, event, cx| {
            if matches!(
                event,
                ui::TextInputEvent::Confirmed | ui::TextInputEvent::Blurred
            ) {
                crate::store::set_store_setting(
                    crate::store::RECORDING_SETTINGS,
                    "uxWalkTopic",
                    serde_json::Value::String(input.read(cx).text().to_string()),
                );
            }
            cx.notify();
        });
        let speakers = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Speaker names, separated by commas");
            if let Ok(settings) = crate::ux_walk::load() {
                let speakers = crate::ux_walk::text(&settings, "speakers");
                input.set_text(
                    if speakers.is_empty() {
                        crate::ux_walk::text(&settings, "me")
                    } else {
                        speakers
                    }
                    .to_string(),
                    cx,
                );
            }
            input
        });
        let speaker_events = cx.subscribe(&speakers, |_: &mut MainWindow, input, event, cx| {
            if matches!(
                event,
                ui::TextInputEvent::Confirmed | ui::TextInputEvent::Blurred
            ) && let Err(error) = crate::ux_walk::save(
                "speakers",
                serde_json::Value::String(input.read(cx).text().to_string()),
            ) {
                tracing::warn!(%error, "saving speaker names");
            }
            cx.notify();
        });
        let notes_default = crate::ux_walk::load().is_ok_and(|settings| {
            crate::ux_walk::enabled(&settings, crate::ux_walk::RECORDING_NOTES)
        });
        Self {
            selected: crate::store::ux_walk_selected(),
            diatribe: crate::store::ux_walk_diatribe(),
            opening: false,
            replacing_window: false,
            window_id: None,
            generation: 0,
            notice: None,
            key_warning: None,
            notes_default,
            notes_choice: None,
            topic,
            speakers,
            _topic_events: topic_events,
            _speaker_events: speaker_events,
            _key_watch: watch_transcription_key(cx),
        }
    }
}

impl ModeChoice {
    pub(super) fn hover_title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.hover_title(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
        }
    }

    pub(super) fn header_title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.header_title(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
        }
    }
}

pub(super) fn system_audio_tooltip(
    theme: Theme,
) -> impl Fn(&mut Window, &mut gpui::App) -> gpui::AnyView + 'static {
    move |_, cx| {
        ui::Tooltip::new(
            &theme,
            "Record calls and sound from all apps, even when capturing one window. Microphone is separate.",
        )
        .view(cx)
    }
}

impl MainWindow {
    pub(crate) fn mode_choice(&self, cx: &gpui::App) -> ModeChoice {
        if self.walk.selected && self.session.read(cx).editor_recording_target().is_none() {
            ModeChoice::UxWalk
        } else {
            ModeChoice::Capture(self.effective_mode(cx))
        }
    }

    pub(super) fn diatribe_selected(&self, cx: &gpui::App) -> bool {
        self.walk.diatribe && self.mode_choice(cx) == ModeChoice::UxWalk
    }

    /// Selects Worm Mode. Its Worm choice opens a fresh walk window; Diatribe opens nothing.
    pub(crate) fn set_ux_walk(&mut self, cx: &mut Context<Self>) {
        if self.session.read(cx).phase != Phase::Idle
            || self.is_preparing_recording()
            || self.session.read(cx).editor_recording_target().is_some()
        {
            return;
        }
        self.walk.replacing_window = true;
        self.set_mode(Mode::Studio, cx);
        self.walk.replacing_window = false;
        self.walk.selected = true;
        crate::store::set_ux_walk_selected(true);
        self.walk.generation = self.walk.generation.wrapping_add(1);
        cx.defer(crate::app_windows::dismiss_target_overlays);
        cx.defer(|cx| crate::tray::mode_changed(Mode::Studio, cx));
        cx.notify();
        if self.walk.diatribe {
            self.walk.opening = false;
            self.walk.notice = None;
            return;
        }
        let generation = self.walk.generation;
        self.walk.opening = true;
        self.walk.notice = Some("Opening a new Chrome window…".into());
        self.target = Some(TargetType::Window);
        self.selected_window = None;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk_browser::open() })
                .await;
            let unused = result.as_ref().ok().map(|window| window.id.to_string());
            let close_unused = move || {
                if let Some(id) = &unused {
                    crate::ux_walk_browser::close_window(id);
                }
            };
            let late = close_unused.clone();
            let updated = this.update(cx, |this, cx| {
                if this.walk.generation != generation || !this.walk.selected {
                    close_unused();
                    return;
                }
                if this.session.read(cx).phase != Phase::Idle {
                    close_unused();
                    this.walk.opening = false;
                    this.walk.notice = None;
                    cx.notify();
                    return;
                }
                let main = cx.global::<app_windows::AppWindows>().main;
                cx.defer(move |cx| {
                    let current = main
                        .update(cx, |view, _, cx| {
                            view.walk.generation == generation
                                && view.walk.selected
                                && view.session.read(cx).phase == Phase::Idle
                        })
                        .unwrap_or(false);
                    if !current {
                        close_unused();
                        return;
                    }
                    // Restoring the recorder clears its old target; apply the new window afterwards.
                    app_windows::show_main_window(cx);
                    main.update(cx, |view, _, cx| {
                        view.walk.opening = false;
                        match result {
                            Ok(window) => {
                                view.devices.windows.retain(|known| known.id != window.id);
                                view.devices.windows.push(window.clone());
                                view.walk.window_id = Some(window.id.to_string());
                                view.selected_window = Some(window);
                                view.target = Some(TargetType::Window);
                                view.panel = None;
                                view.walk.notice = None;
                            }
                            Err(error) => view.walk.notice = Some(error),
                        }
                        cx.notify();
                    })
                    .ok();
                });
                cx.notify();
            });
            if updated.is_err() {
                late();
            }
        })
        .detach();
    }

    /// Worm Mode's choice between Worm and Diatribe, remembered for the next time.
    pub(super) fn set_walk_diatribe(&mut self, diatribe: bool, cx: &mut Context<Self>) {
        if self.walk.diatribe == diatribe
            || self.session.read(cx).phase != Phase::Idle
            || self.is_preparing_recording()
        {
            return;
        }
        self.walk.diatribe = diatribe;
        crate::store::set_ux_walk_diatribe(diatribe);
        if !diatribe {
            if self.walk.selected {
                self.set_ux_walk(cx);
            }
            return;
        }
        self.walk.generation = self.walk.generation.wrapping_add(1);
        self.walk.opening = false;
        crate::ux_walk_browser::close_prepared();
        self.walk_browser_closed();
        self.walk.notice = None;
        cx.notify();
    }

    /// The Diatribe shortcut: Worm Mode's Diatribe choice, recording at once.
    pub(crate) fn record_diatribe_now(&mut self, cx: &mut Context<Self>) {
        if self.diatribe_blocked(cx) {
            return;
        }
        self.set_walk_diatribe(true, cx);
        if self.mode_choice(cx) != ModeChoice::UxWalk {
            self.set_ux_walk(cx);
        }
        self.start_diatribe(None, cx);
    }

    pub(super) fn walk_browser_closed(&mut self) {
        let Some(id) = self.walk.window_id.as_deref() else {
            return;
        };
        if crate::ux_walk_browser::window_is_owned(id) {
            return;
        }
        if self
            .selected_window
            .as_ref()
            .is_some_and(|window| window.id.to_string() == id)
        {
            self.selected_window = None;
            if self.walk.selected {
                self.walk.notice = Some(
                    "The walk window closed with the walk. Use New walk window for the next one."
                        .into(),
                );
            }
        }
        self.walk.window_id = None;
    }

    pub(super) fn choose_mode_choice(&mut self, choice: ModeChoice, cx: &mut Context<Self>) {
        if self.is_preparing_recording()
            || self.session.read(cx).editor_recording_target().is_some()
        {
            return;
        }
        if let Some(mode) = choice.capture_mode() {
            self.set_mode(mode, cx);
            cx.defer(app_windows::refresh_target_overlays);
        } else {
            self.clear_mode_hover();
            cx.notify();
            self.set_ux_walk(cx);
        }
    }

    fn diatribe_blocked(&self, cx: &gpui::App) -> bool {
        self.session.read(cx).phase != Phase::Idle
            || self.is_preparing_recording()
            || self.session.read(cx).editor_recording_target().is_some()
    }

    /// A diatribe: an Instant recording of the chosen target (else the display under the
    /// pointer) with the selected microphone (else the system default), no camera, and system
    /// audio only when it is on.
    pub(super) fn start_diatribe(
        &mut self,
        target: Option<(ScreenCaptureTarget, Vec<scap_targets::WindowId>)>,
        cx: &mut Context<Self>,
    ) {
        if self.diatribe_blocked(cx) {
            return;
        }
        let request = match crate::ux_walk::diatribe_request() {
            Ok(request) => request,
            Err(error) => {
                self.session.update(cx, |session, cx| {
                    session.error = Some(error);
                    cx.notify();
                });
                cx.defer(app_windows::show_main_window);
                return;
            }
        };
        cx.defer(app_windows::dismiss_target_overlays);
        let selected = self.microphone.as_ref().map(|mic| mic.name.clone());
        cx.spawn(async move |this, cx| {
            let microphone = match selected {
                Some(name) => Some((name, true)),
                None => cx
                    .background_executor()
                    .spawn(async {
                        cap_recording::feeds::microphone::MicrophoneFeed::default_device()
                            .map(|(name, _, _)| name)
                    })
                    .await
                    .map(|name| (name, false)),
            };
            this.update(cx, |this, cx| {
                this.begin_diatribe(request, microphone, target, cx)
            })
            .ok();
        })
        .detach();
    }

    fn begin_diatribe(
        &mut self,
        request: Request,
        microphone: Option<(String, bool)>,
        target: Option<(ScreenCaptureTarget, Vec<scap_targets::WindowId>)>,
        cx: &mut Context<Self>,
    ) {
        if self.diatribe_blocked(cx) {
            return;
        }
        let Some((microphone, selected)) = microphone else {
            self.session.update(cx, |session, cx| {
                session.error = Some(
                    "A diatribe needs a microphone. Connect one or choose it in the recorder, then try again."
                        .into(),
                );
                cx.notify();
            });
            cx.defer(app_windows::show_main_window);
            return;
        };
        let (target, mut excluded_windows) = target.unwrap_or_else(|| {
            let display = scap_targets::Display::get_containing_cursor()
                .unwrap_or_else(scap_targets::Display::primary);
            (
                ScreenCaptureTarget::Display { id: display.id() },
                Vec::new(),
            )
        });
        let (mic_feed, mic_meter, mut input_readiness, device_settings) = {
            let feeds = crate::feeds::Feeds::global(cx).read(cx);
            (
                feeds.mic_actor(),
                feeds.mic_meter(),
                feeds.input_readiness(),
                feeds.requested_device_settings(),
            )
        };
        input_readiness.camera = None;
        if !selected {
            // The app's feed and its readiness belong to the selected microphone, not this one.
            input_readiness.microphone = None;
        }
        // An open camera bubble would land in an Instant frame; a diatribe has no camera.
        excluded_windows.extend(
            app_windows::camera_window_number(cx)
                .and_then(|number| number.to_string().parse().ok()),
        );
        let config = crate::recording::StartConfig {
            ux_walk: Some(request),
            mode: crate::recording::RecordingMode::Instant,
            target,
            device_settings,
            input_readiness,
            microphone: Some(microphone),
            camera: None,
            system_audio: self.system_audio,
            excluded_windows,
            camera_feed: None,
            mic_feed: mic_feed.filter(|_| selected),
            mic_meter,
            #[cfg(target_os = "linux")]
            linux_instant_camera: None,
            start_gate: None,
        };
        self.start_recording_config(config, cx);
    }

    pub(super) fn walk_deselect(&mut self, cx: &mut Context<Self>) {
        self.walk.selected = false;
        self.walk.generation = self.walk.generation.wrapping_add(1);
        self.walk.notice = None;
        crate::store::set_ux_walk_selected(false);
        if !self.walk.replacing_window && self.session.read(cx).phase == Phase::Idle {
            crate::ux_walk_browser::close_prepared();
            self.walk_browser_closed();
        }
    }

    /// Whether the recorder offers "Notes & action items" for its next recording.
    fn notes_offered(&self, cx: &gpui::App) -> bool {
        cfg!(all(target_os = "macos", feature = "ux-walk"))
            && notes::applies(
                self.mode_choice(cx),
                self.session.read(cx).editor_recording_target().is_some(),
            )
    }

    fn notes_on(&self, cx: &gpui::App) -> bool {
        self.notes_offered(cx) && notes::wanted(self.walk.notes_default, self.walk.notes_choice)
    }

    /// The notes request riding on an ordinary recording, when its switch is on. A notes
    /// folder that cannot be prepared never stops the recording; it records without notes.
    fn notes_start_request(
        &mut self,
        editor_flow: bool,
        cx: &mut Context<Self>,
    ) -> Option<Request> {
        if editor_flow || !self.notes_on(cx) {
            return None;
        }
        // The flip covers this one recording; the next one starts from the default again.
        self.walk.notes_choice = None;
        match notes::start_request() {
            Ok(request) => Some(request),
            Err(error) => {
                self.walk.notice = Some(format!("Recording without notes: {error}"));
                None
            }
        }
    }

    pub(super) fn ux_walk_start_request(
        &mut self,
        editor_flow: bool,
        cx: &mut Context<Self>,
    ) -> Result<Option<Request>, ()> {
        if self.mode_choice(cx) != ModeChoice::UxWalk || editor_flow {
            return Ok(self.notes_start_request(editor_flow, cx));
        }
        match crate::ux_walk::request(self.walk.topic.read(cx).text()) {
            Ok(mut request) => {
                let settings = crate::ux_walk::load().unwrap_or_default();
                if crate::ux_walk::enabled(&settings, "askSpeakers") {
                    request.speakers = self
                        .walk
                        .speakers
                        .read(cx)
                        .text()
                        .split(',')
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .collect();
                }
                Ok(Some(request))
            }
            Err(error) => {
                self.session.update(cx, |session, cx| {
                    session.error = Some(error);
                    cx.notify();
                });
                Err(())
            }
        }
    }

    /// The "Notes & action items" switch for an ordinary recording, and how the latest
    /// recording's notes are coming along.
    fn notes_setup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let offered = self.notes_offered(cx);
        let status = self.session.read(cx).walk.notes_status.clone();
        if !offered && status.is_none() {
            return None;
        }
        let theme = self.theme;
        let on = notes::wanted(self.walk.notes_default, self.walk.notes_choice);
        let muted = |text: String| {
            div()
                .text_size(px(11.))
                .text_color(theme.gray_10)
                .child(text)
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .when(offered, |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .min_w_0()
                                    .gap(px(2.))
                                    .child(div().text_size(px(12.)).child(notes::NAME))
                                    .child(muted(
                                        "After you stop, transcribe this recording and list its decisions and action items. The recording itself is unchanged."
                                            .into(),
                                    )),
                            )
                            .child(
                                ui::Toggle::glass(&theme, "recording-notes-toggle", on)
                                    .label(notes::NAME)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.walk.notes_choice = Some(!on);
                                        cx.notify();
                                    })),
                            ),
                    )
                })
                .when_some(
                    self.walk.key_warning.clone().filter(|_| offered && on),
                    |this, warning| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme.amber_11)
                                .child(warning),
                        )
                    },
                )
                .when_some(status, |this, status| {
                    let file = status.file.clone();
                    let viewable = status.viewable();
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .child(div().flex_1().min_w_0().child(muted(status.message())))
                            .when(viewable, |this| {
                                this.child(
                                    ui::Button::body(
                                        &theme,
                                        "recording-notes-view",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Sm,
                                    )
                                    .label("View notes")
                                    .on_click(move |_, _, cx| {
                                        let file = file.clone();
                                        cx.defer(move |cx| {
                                            crate::ux_walk_window::open_saved(file, cx)
                                        });
                                    }),
                                )
                            }),
                    )
                })
                .into_any_element(),
        )
    }

    pub(super) fn ux_walk_setup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let selected = self.mode_choice(cx) == ModeChoice::UxWalk;
        if !selected && let Some(notes) = self.notes_setup(cx) {
            return Some(match self.walk.notice.clone() {
                Some(notice) => div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(notes)
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(self.theme.gray_10)
                            .child(notice),
                    )
                    .into_any_element(),
                None => notes,
            });
        }
        let recent_diatribe = self
            .session
            .read(cx)
            .walk
            .journal
            .as_ref()
            .filter(|_| selected)
            .map(|journal| journal.request.is_diatribe());
        let diatribe = selected && self.walk.diatribe;
        if !selected && self.walk.notice.is_none() {
            return None;
        }
        let theme = self.theme;
        let label = |text: &'static str| {
            div()
                .text_size(px(11.))
                .text_color(theme.gray_10)
                .child(text)
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .when(selected, |this| this.child(self.walk_choice(cx)))
                .when(selected && !diatribe, |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(label("Walk topic"))
                            .child(ui::TextInput::settings(
                                &theme,
                                "ux-walk-topic",
                                &self.walk.topic,
                            ))
                            .when(
                                crate::ux_walk::load().is_ok_and(|settings| {
                                    crate::ux_walk::enabled(&settings, "askSpeakers")
                                }),
                                |this| {
                                    this.child(label("Who is speaking?")).child(
                                        ui::TextInput::settings(
                                            &theme,
                                            "ux-walk-speakers",
                                            &self.walk.speakers,
                                        ),
                                    )
                                },
                            )
                            .child(
                                ui::Button::body(
                                    &theme,
                                    "ux-walk-open-start",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("New walk window ↗")
                                .on_click(cx.listener(|this, _, _, cx| this.set_ux_walk(cx))),
                            ),
                    )
                })
                .when_some(
                    self.walk.key_warning.clone().filter(|_| selected),
                    |this, warning| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme.amber_11)
                                .child(warning),
                        )
                    },
                )
                .when_some(recent_diatribe, |this, recent_diatribe| {
                    this.child(
                        ui::Button::body(
                            &theme,
                            "ux-walk-recent",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .label(if recent_diatribe {
                            "Open recent diatribe"
                        } else {
                            "Open recent walk"
                        })
                        .on_click(|_, _, cx| cx.defer(crate::ux_walk_window::open)),
                    )
                })
                .when_some(self.walk.notice.clone(), |this, notice| {
                    this.child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme.gray_10)
                            .child(notice),
                    )
                })
                .into_any_element(),
        )
    }

    /// Worm Mode's one choice: a walk with its browser evidence, or a voice-only diatribe.
    fn walk_choice(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let diatribe = self.walk.diatribe;
        let option = |label: &'static str, icon: &'static str, selected: bool| ui::SegmentOption {
            label: Some(label.into()),
            icon: Some(icon.into()),
            selected,
            disabled: false,
        };
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                ui::SegmentedControl::settings(
                    &theme,
                    "ux-walk-choice",
                    vec![
                        option(fork_brand::APP_NAME, "icons/ux-walk.svg", !diatribe),
                        option(
                            crate::mode_choice::DIATRIBE_NAME,
                            crate::mode_choice::DIATRIBE_ICON,
                            diatribe,
                        ),
                    ],
                )
                .stretch()
                .on_select(cx.listener(|this, index: &usize, _, cx| {
                    this.set_walk_diatribe(*index == 1, cx);
                })),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme.gray_10)
                    .child(if diatribe {
                        "Just talk: your voice and screen, no browser window or console. You get notes and action items."
                    } else {
                        "A new Chrome window with its clicks, console and failed requests, plus your voice."
                    }),
            )
            .into_any_element()
    }

    pub(super) fn ux_walk_start_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.panel.is_some() || self.mode_choice(cx) != ModeChoice::UxWalk {
            return None;
        }
        if self.walk.diatribe {
            return Some(
                ui::Button::plain(
                    &self.theme,
                    "ux-walk-start-recording",
                    ui::ButtonVariant::Blue,
                    ui::ButtonSize::Lg,
                )
                .icon(crate::mode_choice::DIATRIBE_ICON)
                .label("Start Recording")
                .full_width()
                .disabled(self.is_preparing_recording())
                .on_click(cx.listener(|this, _, _, cx| this.start_diatribe(None, cx)))
                .into_any_element(),
            );
        }
        Some(
            ui::Button::plain(
                &self.theme,
                "ux-walk-start-recording",
                ui::ButtonVariant::Blue,
                ui::ButtonSize::Lg,
            )
            .icon("icons/ux-walk.svg")
            .label(if self.walk.opening {
                "Opening walk window…"
            } else {
                "Start Recording"
            })
            .full_width()
            .disabled(self.is_preparing_recording() || self.armed_target().is_none())
            .on_click(cx.listener(|this, _, window, cx| this.start_recording(window, cx)))
            .into_any_element(),
        )
    }
}
