use std::time::Duration;

use gpui::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Task, Window,
    div, prelude::FluentBuilder, px,
};

use super::{MainWindow, Mode, TargetType};
use crate::{
    app_windows, mode_choice::ModeChoice, session::Phase, theme::Theme, ui,
    ux_walk_journal::Request,
};

pub(super) struct RecorderWalk {
    pub(super) selected: bool,
    pub(super) opening: bool,
    replacing_window: bool,
    window_id: Option<String>,
    generation: u64,
    notice: Option<String>,
    key_warning: Option<String>,
    topic: Entity<ui::TextInputState>,
    speakers: Entity<ui::TextInputState>,
    _topic_events: gpui::Subscription,
    _speaker_events: gpui::Subscription,
    _key_watch: Task<()>,
}

fn watch_transcription_key(cx: &mut Context<MainWindow>) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            let Ok(ready) = this.update(cx, |this, cx| {
                this.walk.selected && this.session.read(cx).phase == Phase::Idle
            }) else {
                return;
            };
            if ready {
                let warning = cx
                    .background_executor()
                    .spawn(async {
                        crate::ux_walk::load()
                            .ok()
                            .and_then(|settings| crate::ux_walk::missing_key_warning(&settings))
                    })
                    .await;
                let updated = this.update(cx, |this, cx| {
                    if this.walk.key_warning != warning {
                        this.walk.key_warning = warning;
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
        Self {
            selected: crate::store::ux_walk_selected(),
            opening: false,
            replacing_window: false,
            window_id: None,
            generation: 0,
            notice: None,
            key_warning: None,
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
            Self::Diatribe => crate::mode_choice::DIATRIBE_NAME,
        }
    }

    pub(super) fn header_title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.header_title(),
            Self::UxWalk => fork_brand::WALK_MODE_NAME,
            Self::Diatribe => crate::mode_choice::DIATRIBE_NAME,
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
        let generation = self.walk.generation;
        self.walk.opening = true;
        self.walk.notice = Some("Opening a new Chrome window…".into());
        self.target = Some(TargetType::Window);
        self.selected_window = None;
        cx.defer(crate::app_windows::dismiss_target_overlays);
        cx.defer(|cx| crate::tray::mode_changed(Mode::Studio, cx));
        cx.notify();
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
        } else if choice == ModeChoice::Diatribe {
            self.clear_mode_hover();
            cx.notify();
            self.start_diatribe(cx);
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

    /// Record Diatribe: no setup, an Instant recording of the display under the pointer with
    /// the selected microphone (else the system default), no camera, and system audio only
    /// when it is on. The recorder's mode, devices and walk selection stay as they were.
    pub(crate) fn start_diatribe(&mut self, cx: &mut Context<Self>) {
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
            this.update(cx, |this, cx| this.begin_diatribe(request, microphone, cx))
                .ok();
        })
        .detach();
    }

    fn begin_diatribe(
        &mut self,
        request: Request,
        microphone: Option<(String, bool)>,
        cx: &mut Context<Self>,
    ) {
        if self.diatribe_blocked(cx) {
            return;
        }
        let Some((microphone, selected)) = microphone else {
            self.session.update(cx, |session, cx| {
                session.error = Some(
                    "Record Diatribe needs a microphone. Connect one or choose it in the recorder, then try again."
                        .into(),
                );
                cx.notify();
            });
            cx.defer(app_windows::show_main_window);
            return;
        };
        let display = scap_targets::Display::get_containing_cursor()
            .unwrap_or_else(scap_targets::Display::primary);
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
        let excluded_windows = app_windows::camera_window_number(cx)
            .and_then(|number| number.to_string().parse().ok())
            .into_iter()
            .collect();
        let config = crate::recording::StartConfig {
            ux_walk: Some(request),
            mode: crate::recording::RecordingMode::Instant,
            target: cap_recording::sources::screen_capture::ScreenCaptureTarget::Display {
                id: display.id(),
            },
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

    pub(super) fn ux_walk_start_request(
        &mut self,
        editor_flow: bool,
        cx: &mut Context<Self>,
    ) -> Result<Option<Request>, ()> {
        if self.mode_choice(cx) != ModeChoice::UxWalk || editor_flow {
            return Ok(None);
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

    pub(super) fn ux_walk_setup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let selected = self.mode_choice(cx) == ModeChoice::UxWalk;
        let has_recent = selected && self.session.read(cx).walk.journal.is_some();
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
                .when(selected, |this| {
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
                .when(has_recent, |this| {
                    this.child(
                        ui::Button::body(
                            &theme,
                            "ux-walk-recent",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .label("Open recent walk")
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

    pub(super) fn ux_walk_start_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.panel.is_some() || self.mode_choice(cx) != ModeChoice::UxWalk {
            return None;
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
