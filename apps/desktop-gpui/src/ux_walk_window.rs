#[path = "ux_walk_window/filing.rs"]
mod filing;
#[path = "ux_walk_window/items.rs"]
mod items;

use crate::{
    session::{Phase, RecordingSession},
    theme::Theme,
    ui,
};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FontWeight, Global, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled, Window,
    WindowBounds, WindowHandle, WindowOptions, div, prelude::FluentBuilder as _, px, size,
};

#[derive(Default)]
struct WalkWindows(Option<WindowHandle<WalkWindow>>);
impl Global for WalkWindows {}

pub fn prepare(cx: &mut App) -> Result<isize, String> {
    let number = ensure(false, cx)?;
    reset_live(cx);
    Ok(number)
}
pub fn open(cx: &mut App) {
    let current_walk_present = RecordingSession::global(cx).read(cx).walk.journal.is_some();
    let settings = crate::store::store_section(crate::store::RECORDING_SETTINGS);
    if let crate::ux_walk_library::NotesSource::Saved(file) = crate::ux_walk_library::notes_source(
        current_walk_present,
        settings
            .get("lastNativeWalk")
            .and_then(serde_json::Value::as_str),
    ) {
        open_saved(file, cx);
        return;
    }
    if let Err(error) = ensure(true, cx) {
        tracing::error!(%error, "opening native walk notes");
    } else {
        reset_live(cx);
    }
}

fn reset_live(cx: &mut App) {
    if let Some(handle) = cx.global::<WalkWindows>().0 {
        handle
            .update(cx, |view, window, cx| {
                view.selection.choose(None);
                view.saved = None;
                view.saved_notes = None;
                view.current_notes = None;
                view.current_notes_loading = None;
                view.current_notes_revision = view.current_notes_revision.wrapping_add(1);
                view.summary = None;
                view.error = None;
                view.notice = None;
                view.poll = None;
                view.refresh_current_notes(window, cx);
                cx.notify();
            })
            .ok();
    }
}

pub fn open_recovery(cx: &mut App) {
    if ensure(true, cx).is_err() {
        return;
    }
    if let Some(handle) = cx.global::<WalkWindows>().0 {
        let _ = handle.update(cx, |view, window, cx| view.load_recoveries(window, cx));
    }
}

pub fn open_saved(file: std::path::PathBuf, cx: &mut App) {
    open_saved_on(file, None, cx);
}

pub fn open_saved_items(file: std::path::PathBuf, cx: &mut App) {
    open_saved_on(file, Some(items::Tab::Items), cx);
}

fn open_saved_on(file: std::path::PathBuf, tab: Option<items::Tab>, cx: &mut App) {
    if let Err(error) = ensure(true, cx) {
        tracing::error!(%error, "opening saved walk notes");
        return;
    }
    if let Some(handle) = cx.global::<WalkWindows>().0 {
        handle
            .update(cx, |view, window, cx| {
                if view.items.dirty() && !view.items.shows(&file) {
                    view.settle_items(
                        false,
                        Box::new(move |this, window, cx| {
                            this.items.forget();
                            this.show_saved(file, tab, window, cx);
                        }),
                        window,
                        cx,
                    );
                    return;
                }
                view.show_saved(file, tab, window, cx);
            })
            .ok();
    }
}

fn ensure(show: bool, cx: &mut App) -> Result<isize, String> {
    if !cx.has_global::<WalkWindows>() {
        cx.set_global(WalkWindows::default());
    }
    let handle = match cx.global::<WalkWindows>().0 {
        Some(handle) => handle,
        None => {
            let bounds = Bounds::centered(None, size(px(520.), px(550.)), cx);
            let handle = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(gpui::TitlebarOptions {
                            title: Some(fork_brand::text_static("Cap · Notes").into()),
                            ..Default::default()
                        }),
                        focus: show,
                        show,
                        is_resizable: true,
                        window_min_size: Some(size(px(440.), px(360.))),
                        ..Default::default()
                    },
                    |window, cx| cx.new(|cx| WalkWindow::new(window, cx)),
                )
                .map_err(|e| e.to_string())?;
            cx.global_mut::<WalkWindows>().0 = Some(handle);
            handle
        }
    };
    let (number, native) = handle
        .update(cx, |_, window, _| {
            let native = crate::platform::native_window(window);
            if let Some(native) = &native {
                crate::platform::set_window_capture_hidden(native, true);
            }
            (crate::platform::window_number(window), native)
        })
        .map_err(|e| e.to_string())?;
    let number = number
        .filter(|number| *number > 0)
        .ok_or_else(|| "Could not exclude the walk notes window from capture.".to_string())?;
    if show {
        // Native ordering re-enters GPUI; reveal outside the window borrow, like the editor.
        cx.spawn(async move |cx| {
            if let Some(native) = &native {
                crate::platform::show_native(native);
            }
            cx.update(|cx| {
                cx.activate(true);
                handle
                    .update(cx, |_, window, cx| {
                        window.activate_window();
                        crate::platform::kick_display_link(window);
                        cx.notify();
                        window.refresh();
                    })
                    .ok();
                crate::menus::schedule_dock_sync(cx);
            });
        })
        .detach();
    }
    Ok(number)
}

#[derive(Clone)]
struct LoadedNotes {
    file: std::path::PathBuf,
    events: Vec<crate::ux_walk_journal::Event>,
    evidence: String,
}

impl LoadedNotes {
    fn for_walk(
        summary: &crate::ux_walk_library::WalkSummary,
        journal: &crate::ux_walk_journal::Journal,
    ) -> Self {
        Self {
            file: summary.file.clone(),
            events: crate::ux_walk_library::view_events(summary, journal),
            evidence: if summary.report_ready() {
                crate::ux_walk_library::evidence_notice(&summary.directory)
            } else {
                "The agent prompt describes the browser evidence available for this walk.".into()
            },
        }
    }
}

struct WalkWindow {
    theme: Theme,
    session: Entity<RecordingSession>,
    input: Entity<ui::TextInputState>,
    selection: crate::ux_walk_library::WalkSelection,
    saved: Option<crate::ux_walk_journal::Journal>,
    saved_notes: Option<LoadedNotes>,
    current_notes: Option<LoadedNotes>,
    current_notes_loading: Option<std::path::PathBuf>,
    current_notes_revision: u64,
    summary: Option<crate::ux_walk_library::WalkSummary>,
    poll: Option<gpui::Task<()>>,
    action_revision: u64,
    recoveries: Vec<(String, String)>,
    recovery_origin: String,
    recovery_loading: bool,
    reprocessing: std::collections::BTreeSet<std::path::PathBuf>,
    notice: Option<String>,
    error: Option<String>,
    items: items::ItemsState,
    filing: filing::FilingState,
}

impl WalkWindow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let view = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            if view
                .upgrade()
                .is_some_and(|view| view.read(cx).items.dirty())
            {
                let view = view.clone();
                window.defer(cx, move |window, cx| {
                    let confirm = items::confirm(
                        "Discard unsaved item edits?",
                        "Your changes to this walk's items have not been saved.",
                        "Discard",
                        "Keep editing",
                        window,
                        cx,
                    );
                    window
                        .spawn(cx, async move |cx| {
                            if !confirm.await {
                                return;
                            }
                            view.update_in(cx, |this, window, cx| {
                                this.items.discard();
                                if let Some(native) = crate::platform::native_window(window) {
                                    crate::platform::hide_native(&native);
                                }
                                cx.notify();
                            })
                            .ok();
                        })
                        .detach();
                });
                return false;
            }
            if let Some(native) = crate::platform::native_window(window) {
                crate::platform::hide_native(&native);
            }
            false
        });
        let session = RecordingSession::global(cx);
        cx.observe_in(&session, window, |this, _, window, cx| {
            this.refresh_current_notes(window, cx);
            cx.notify();
            window.refresh();
        })
        .detach();
        let input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Add an observation or a chapter title");
            input
        });
        cx.subscribe(&input, |this, _, event, cx| {
            if matches!(event, ui::TextInputEvent::Changed) {
                let text = this.input.read(cx).text().to_string();
                this.session
                    .update(cx, |session, _| session.walk.note_draft = text);
            }
            if matches!(event, ui::TextInputEvent::Confirmed) {
                this.add("note", cx);
            }
        })
        .detach();
        let items = items::ItemsState::new(window, cx);
        Self {
            theme: Theme::for_window(window, cx, false),
            session,
            input,
            selection: Default::default(),
            saved: None,
            saved_notes: None,
            current_notes: None,
            current_notes_loading: None,
            current_notes_revision: 0,
            summary: None,
            poll: None,
            action_revision: 0,
            recoveries: Vec::new(),
            recovery_origin: String::new(),
            recovery_loading: false,
            reprocessing: Default::default(),
            notice: None,
            error: None,
            items,
            filing: Default::default(),
        }
    }

    fn show_saved(
        &mut self,
        file: std::path::PathBuf,
        tab: Option<items::Tab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.items.shows(&file) && !self.items.dirty() {
            self.items.forget();
        }
        if let Some(tab) = tab {
            self.items.tab = tab;
        } else if !self.items.dirty() {
            self.items.tab = items::Tab::Notes;
        }
        self.selection.choose(Some(file.clone()));
        self.saved = None;
        self.saved_notes = None;
        self.summary = None;
        self.error = None;
        self.notice = None;
        self.poll = None;
        self.load_saved(file.clone(), window, cx);
        if self.items.tab == items::Tab::Items {
            self.ensure_items(file, window, cx);
        }
    }

    fn handoff(
        &mut self,
        command: &'static str,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_items_then(
            file.clone(),
            Box::new(move |this, _, cx| this.action(command, file, cx)),
            window,
            cx,
        );
    }

    fn refresh_current_notes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let session = self.session.read(cx);
        let file = session
            .walk
            .journal
            .as_ref()
            .filter(|walk| walk.state == "complete")
            .map(|walk| walk.file());
        if session.walk.processing || file.is_none() {
            self.current_notes_revision = self.current_notes_revision.wrapping_add(1);
            self.current_notes = None;
            self.current_notes_loading = None;
            return;
        }
        let Some(file) = file else {
            return;
        };
        if self
            .current_notes
            .as_ref()
            .is_some_and(|notes| notes.file == file)
            || self.current_notes_loading.as_ref() == Some(&file)
        {
            return;
        }
        self.current_notes_revision = self.current_notes_revision.wrapping_add(1);
        let revision = self.current_notes_revision;
        self.current_notes_loading = Some(file.clone());
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk_library::read_walk(&file).map(|(summary, journal)| {
                        (
                            LoadedNotes::for_walk(&summary, &journal),
                            summary.items_editable(),
                        )
                    })
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.current_notes_revision != revision
                    || this.session.read(cx).walk.processing
                    || this
                        .session
                        .read(cx)
                        .walk
                        .journal
                        .as_ref()
                        .is_none_or(|walk| walk.file() != requested)
                {
                    return;
                }
                this.current_notes_loading = None;
                this.current_notes = match result {
                    Ok((notes, editable)) => {
                        if editable {
                            this.ensure_items(requested.clone(), window, cx);
                            this.load_filing(requested.clone(), window, cx);
                        }
                        Some(notes)
                    }
                    Err(_) => None,
                };
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn load_saved(
        &mut self,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let revision = self.selection.choose(Some(file.clone()));
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk_library::read_walk(&file).map(|(summary, journal)| {
                        let notes = LoadedNotes::for_walk(&summary, &journal);
                        (summary, journal, notes)
                    })
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if !this.selection.accepts(&requested, revision) {
                    return;
                }
                match result {
                    Ok((summary, journal, notes)) => {
                        if summary.items_editable() {
                            this.ensure_items(requested.clone(), window, cx);
                            this.ensure_filing(requested.clone(), window, cx);
                        }
                        this.saved_notes = Some(notes);
                        this.summary = Some(summary);
                        this.saved = Some(journal);
                        this.error = None;
                        if this
                            .summary
                            .as_ref()
                            .is_some_and(crate::ux_walk_library::WalkSummary::is_active)
                            || this.reprocessing.contains(&requested)
                        {
                            let file = requested.clone();
                            this.poll = Some(cx.spawn_in(window, async move |this, cx| {
                                cx.background_executor()
                                    .timer(std::time::Duration::from_secs(2))
                                    .await;
                                this.update_in(cx, |this, window, cx| {
                                    if this.selection.accepts(&file, revision) {
                                        this.load_saved(file, window, cx);
                                    }
                                })
                                .ok();
                            }));
                        } else {
                            this.poll = None;
                        }
                    }
                    Err(error) => {
                        this.error = Some(error);
                        this.notice = Some("Saved notes could not be opened.".into());
                        this.poll = None;
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn load_recoveries(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.recovery_loading {
            return;
        }
        self.recovery_loading = true;
        self.notice = Some("Loading private walk backups…".into());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx.background_executor().spawn(async move {
                let output = crate::ux_walk::run_engine("recovery-list", std::path::Path::new("-"))?;
                serde_json::from_str::<serde_json::Value>(&output).map_err(|error| error.to_string())
            }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.recovery_loading = false;
                match result {
                    Ok(value) => {
                        this.recovery_origin = value["server"].as_str().unwrap_or_default().to_string();
                        this.recoveries = value["recordings"].as_array().into_iter().flatten().filter_map(|record| Some((record["recordingId"].as_str()?.to_string(), record["title"].as_str()?.to_string()))).collect();
                        this.notice = Some(if this.recoveries.is_empty() { "No private walk backups are available on this server.".into() } else { "Choose a backup, then a folder for a new recovered copy. Recovered captures remain marked interrupted; a complete video may not exist.".into() });
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify(); window.refresh();
            });
        }).detach();
    }

    fn restore_backup(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.session.read(cx).phase != Phase::Idle || self.recovery_loading {
            return;
        }
        let origin = self.recovery_origin.clone();
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        self.recovery_loading = true;
        self.notice = Some("Choose a folder for recovered evidence.".into());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let selection = paths.await;
            let Ok(Ok(Some(paths))) = selection else { let _ = this.update_in(cx, |this, _, cx| { this.recovery_loading = false; cx.notify(); }); return; };
            let Some(parent) = paths.into_iter().next() else { let _ = this.update_in(cx, |this, _, cx| { this.recovery_loading = false; cx.notify(); }); return; };
            let result = cx.background_executor().spawn(async move {
                let destination = parent.join(format!("Recovered-walk-{}", crate::store::new_uuid_v4()));
                let request_file = std::env::temp_dir().join(format!("ux-walk-restore-{}.json", crate::store::new_uuid_v4()));
                let value = serde_json::json!({ "recordingId": id, "origin": origin, "destination": destination });
                std::fs::write(&request_file, serde_json::to_vec(&value).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
                let result = crate::ux_walk::run_engine("recovery-restore", &request_file);
                let _ = std::fs::remove_file(request_file);
                result?;
                crate::ux_walk_library::remember_journal(&destination.join("native-walk.json"))?;
                Ok::<std::path::PathBuf, String>(destination.join("native-walk.json"))
            }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.recovery_loading = false;
                match result { Ok(file) => { this.recoveries.clear(); this.selection.choose(Some(file.clone())); this.load_saved(file, window, cx); this.notice = Some("Recovered interrupted evidence. Open the report to read notes, speech and click/error logs.".into()); }, Err(error) => this.error = Some(error) }
                cx.notify(); window.refresh();
            });
        }).detach();
    }

    fn add(&mut self, kind: &str, cx: &mut Context<Self>) {
        if self.selection.file.is_some() {
            return;
        }
        let text = self.input.read(cx).text().to_string();
        match self
            .session
            .update(cx, |session, cx| session.add_walk_event(kind, &text, cx))
        {
            Ok(()) => {
                self.error = None;
                self.input.update(cx, |input, cx| input.set_text("", cx));
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }

    fn reprocess_saved(
        &mut self,
        file: std::path::PathBuf,
        full_transcription: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selection.file.as_ref() != Some(&file)
            || self.session.read(cx).phase != Phase::Idle
            || self.reprocessing.contains(&file)
        {
            return;
        }
        if self.items.dirty() && self.items.shows(&file) {
            self.save_items_then(
                file.clone(),
                Box::new(move |this, window, cx| {
                    this.reprocess_saved(file, full_transcription, window, cx)
                }),
                window,
                cx,
            );
            return;
        }
        if let Err(error) = crate::ux_walk_library::reprocess_allowed(&file) {
            self.error = Some(error);
            cx.notify();
            return;
        }
        self.reprocessing.insert(file.clone());
        self.error = None;
        self.notice = Some(
            "Preparing chapters, screenshots and transcript… Your notes remain available.".into(),
        );
        self.load_saved(file.clone(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let selected = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk_library::reprocess_allowed(&file)?;
                    crate::ux_walk::run_engine(
                        if full_transcription {
                            "process-full-transcript"
                        } else {
                            "process"
                        },
                        &file,
                    )
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.reprocessing.remove(&selected);
                if this
                    .session
                    .read(cx)
                    .walk
                    .journal
                    .as_ref()
                    .is_some_and(|walk| walk.file() == selected)
                {
                    this.current_notes = None;
                    this.current_notes_loading = None;
                    this.current_notes_revision = this.current_notes_revision.wrapping_add(1);
                    this.refresh_current_notes(window, cx);
                }
                if this.selection.file.as_ref() != Some(&selected) {
                    return;
                }
                this.notice = Some(match result {
                    Ok(_) => "Walk ready. Open the report or copy its agent prompt.".into(),
                    Err(error) => format!(
                        "Recording and notes are saved. Could not reprocess this walk: {error}"
                    ),
                });
                if this.items.shows(&selected) {
                    this.load_items(selected.clone(), window, cx);
                }
                if this.filing.shows(&selected) {
                    this.load_filing(selected.clone(), window, cx);
                }
                this.load_saved(selected, window, cx);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn action(&mut self, command: &'static str, file: std::path::PathBuf, cx: &mut Context<Self>) {
        self.action_revision = self.action_revision.wrapping_add(1);
        let revision = self.action_revision;
        let selection = self.selection.file.clone();
        self.notice = Some(
            if command == "checkpoint-resume" {
                "Resuming saved evidence and pending transcript jobs…"
            } else if command == "prompt" {
                "Preparing agent prompt…"
            } else {
                "Opening Claude in cmux…"
            }
            .into(),
        );
        cx.notify();
        cx.spawn(async move |this, cx| {
            let selected = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::run_engine(command, &file) })
                .await;
            this.update(cx, |this, cx| {
                if this.action_revision != revision || this.selection.file != selection {
                    return;
                }
                if selection.is_none()
                    && this
                        .session
                        .read(cx)
                        .walk
                        .journal
                        .as_ref()
                        .is_none_or(|walk| walk.file() != selected)
                {
                    return;
                }
                this.notice = Some(match result {
                    Ok(output) if command == "prompt" => {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(output));
                        "Agent prompt copied".into()
                    }
                    Ok(_) if command == "checkpoint-resume" => "Evidence sync attempted. Saved source data and ambiguous jobs remain retained; inspect checkpoint status in Show files.".into(),
                    Ok(_) => "Opened Claude in cmux with this walk’s prompt.".into(),
                    Err(error) => format!("Could not complete the action: {error}"),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for WalkWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let theme = self.theme;
        let saved_view = self.selection.file.is_some();
        let session = self.session.read(cx);
        let walk = if saved_view {
            self.saved.clone()
        } else {
            session.walk.journal.clone()
        };
        let notes = if saved_view {
            self.saved_notes.as_ref()
        } else {
            self.current_notes
                .as_ref()
                .filter(|notes| walk.as_ref().is_some_and(|walk| walk.file() == notes.file))
        };
        let events = notes.map(|notes| notes.events.clone()).unwrap_or_else(|| {
            walk.as_ref()
                .map(|walk| walk.events.clone())
                .unwrap_or_default()
        });
        let evidence = notes
            .map(|notes| notes.evidence.clone())
            .unwrap_or_else(|| {
                "Copy an agent prompt to review the browser evidence available for this walk."
                    .into()
            });
        let live = !saved_view
            && walk.as_ref().is_some_and(|walk| walk.state == "recording")
            && matches!(session.phase, Phase::Recording { .. });
        let capture_active = session.phase != Phase::Idle;
        let processing = if saved_view {
            self.summary
                .as_ref()
                .is_some_and(|walk| walk.status == crate::ux_walk_library::WalkStatus::Processing)
        } else {
            session.walk.processing || session.phase == Phase::Stopping
        };
        let checkpoint_notice = session.walk.checkpoint_notice.clone();
        let items_file = walk
            .as_ref()
            .filter(|walk| walk.state == "complete")
            .filter(|walk| {
                if saved_view {
                    self.summary
                        .as_ref()
                        .is_some_and(crate::ux_walk_library::WalkSummary::items_editable)
                } else {
                    !processing
                        && crate::ux_walk_library::processing_status(&walk.request.directory)
                            == crate::ux_walk_library::WalkStatus::Ready
                }
            })
            .map(|walk| walk.file());
        let show_items = items_file.is_some() && self.items.tab == items::Tab::Items;
        let notice = self.notice.clone().unwrap_or_else(|| {
            if saved_view {
                self.summary
                    .as_ref()
                    .map(|summary| summary.status.notice())
                    .unwrap_or_else(|| "Loading saved notes…".into())
            } else if session.walk.notice.is_empty() {
                fork_brand::mode_text(
                    "Start a %walk% recording from the recorder. Use its existing capture and audio controls.",
                )
            } else {
                session.walk.notice.clone()
            }
        });
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .gap(px(14.))
            .p(px(24.))
            .bg(theme.gray_1)
            .text_color(theme.text_primary)
            .font_family(crate::theme::UI_FONT)
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(
                        walk.as_ref()
                            .map(|walk| walk.request.topic.clone())
                            .unwrap_or_else(|| fork_brand::WALK_MODE_NAME.into()),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.gray_10)
                    .child(notice),
            )
            .when(!saved_view, |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(theme.gray_10)
                        .child(checkpoint_notice),
                )
            })
            .when_some(items_file.clone(), |this, file| {
                this.child(self.render_project_bar(file, cx))
            })
            .when_some(items_file.clone(), |this, file| {
                this.child(self.render_tabs(file, cx))
            })
            .when(!capture_active && !show_items, |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "walk-recover-private",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Sm,
                    )
                    .label("Recover private backup")
                    .disabled(self.recovery_loading)
                    .on_click(cx.listener(|this, _, window, cx| this.load_recoveries(window, cx))),
                )
            })
            .children(self.recoveries.clone().into_iter().map(|(id, title)| {
                ui::Button::plain(
                    &theme,
                    gpui::SharedString::from(format!("recover-walk-{id}")),
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .label(title)
                .disabled(capture_active || self.recovery_loading)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.restore_backup(id.clone(), window, cx)
                }))
            }))
            .when(live, |this| {
                this.child(ui::TextInput::settings(
                    &theme,
                    "walk-note-input",
                    &self.input,
                ))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-add-note",
                                ui::ButtonVariant::Blue,
                                ui::ButtonSize::Sm,
                            )
                            .label("Add note")
                            .on_click(cx.listener(|this, _, _, cx| this.add("note", cx))),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-add-chapter",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Sm,
                            )
                            .label("New chapter")
                            .on_click(cx.listener(|this, _, _, cx| this.add("chapter", cx))),
                        ),
                )
            })
            .when_some(self.error.clone(), |this, error| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.red_9)
                        .child(error),
                )
            })
            .when_some(items_file.clone().filter(|_| show_items), |this, file| {
                if self.items.shows(&file) || self.items.file.is_none() {
                    let editable = !self.reprocessing.contains(&file);
                    this.child(self.render_items(editable, cx))
                } else {
                    this.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .flex_1()
                            .min_h_0()
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.amber_11)
                                    .child("Another walk has unsaved item edits. Open it from Recordings to save them, or discard them here."),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-items-discard-other",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("Discard those edits")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.items.forget();
                                    this.load_items(file.clone(), window, cx);
                                })),
                            ),
                    )
                }
            })
            .when(!show_items, |this| this.child(
                div()
                    .id("walk-events")
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(items_file.clone().and_then(|file| self.render_glossary(file, cx)))
                    .children(events.into_iter().map(|event| {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .child(div().text_size(px(11.)).text_color(theme.gray_10).child(
                                format!(
                                    "{}:{:02} · {}",
                                    event.offset_ms / 60_000,
                                    (event.offset_ms / 1000) % 60,
                                    if event.kind == "chapter" {
                                        "Chapter"
                                    } else {
                                        "Note"
                                    }
                                ),
                            ))
                            .child(div().text_size(px(13.)).child(event.text.clone()))
                    })),
            ))
            .when_some(walk, |this, walk| {
                let file = walk.file();
                let folder = walk.request.directory.clone();
                let report = folder.join("report.html");
                let ready = (folder.join("recovery-ready.json").is_file() && report.is_file())
                    || if saved_view {
                        self.summary
                            .as_ref()
                            .is_some_and(crate::ux_walk_library::WalkSummary::report_ready)
                    } else {
                        !processing
                            && crate::ux_walk_library::processing_status(&walk.request.directory)
                                == crate::ux_walk_library::WalkStatus::Ready
                    };
                let saved_retry = file.clone();
                let full_retry = file.clone();
                let checkpoint_file = file.clone();
                let has_checkpoints = folder.join("checkpoints/identity.json").is_file();
                let recovery = crate::ux_walk_checkpoints::recovery_notice(&folder);
                let retry_disabled = capture_active
                    || (!saved_view && processing)
                    || self.reprocessing.contains(&file);
                let prompt_file = file.clone();
                let handoff_file = file.clone();
                let live_file = file.clone();
                let cmux = crate::ux_walk::load()
                    .is_ok_and(|settings| crate::ux_walk::text(&settings, "agent") == "cmux");
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme.gray_10)
                        .child(evidence),
                )
                .when_some(recovery, |this, recovery| {
                    this.child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme.amber_11)
                            .child(recovery),
                    )
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(8.))
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-open-folder",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Sm,
                            )
                            .label("Show files")
                            .on_click(move |_, _, cx| crate::library::reveal_path(&folder, cx)),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-open-report",
                                ui::ButtonVariant::Blue,
                                ui::ButtonSize::Sm,
                            )
                            .label("Open report")
                            .disabled(!ready)
                            .on_click(move |_, _, cx| {
                                if let Ok(url) = reqwest::Url::from_file_path(&report) {
                                    cx.open_url(url.as_str());
                                }
                            }),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-copy-prompt",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Sm,
                            )
                            .label("Copy agent prompt")
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.handoff("prompt", prompt_file.clone(), window, cx)
                                },
                            )),
                        )
                        .when(cmux, |this| {
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-open-claude",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("Open Claude in cmux")
                                .disabled(!ready)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.handoff("handoff", handoff_file.clone(), window, cx)
                                    },
                                )),
                            )
                        })
                        .when(saved_view && has_checkpoints, |this| {
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-resume-checkpoints",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("Resume evidence sync")
                                .disabled(capture_active)
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.action(
                                            "checkpoint-resume",
                                            checkpoint_file.clone(),
                                            cx,
                                        )
                                    },
                                )),
                            )
                        })
                        .when(
                            saved_view && walk.state == "complete" && has_checkpoints,
                            |this| {
                                this.child(
                                    ui::Button::plain(
                                        &theme,
                                        "walk-full-transcript",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Sm,
                                    )
                                    .label("Transcribe full audio again (provider charges)")
                                    .disabled(retry_disabled)
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            this.reprocess_saved(
                                                full_retry.clone(),
                                                true,
                                                window,
                                                cx,
                                            )
                                        },
                                    )),
                                )
                            },
                        )
                        .when(saved_view && walk.state == "complete", |this| {
                            this.child(
                                ui::Button::plain(
                                    &theme,
                                    "walk-reprocess-saved",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("Reprocess")
                                .disabled(retry_disabled)
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.reprocess_saved(saved_retry.clone(), false, window, cx)
                                    },
                                )),
                            )
                        })
                        .when(
                            !saved_view
                                && walk.state == "complete"
                                && !processing
                                && !walk.request.is_diatribe(),
                            |this| {
                                this.child(
                                    ui::Button::plain(
                                        &theme,
                                        "walk-edit-copy",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Sm,
                                    )
                                    .label("Edit a copy")
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.session
                                                .update(cx, |session, cx| session.edit_walk(cx));
                                        },
                                    )),
                                )
                            },
                        )
                        .when(
                            !saved_view && walk.state == "complete" && !processing,
                            |this| {
                                this.child(
                                    ui::Button::plain(
                                        &theme,
                                        "walk-retry",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Sm,
                                    )
                                    .label("Reprocess")
                                    .disabled(capture_active)
                                    .on_click(cx.listener(
                                        move |this, _, window, cx| {
                                            let file = live_file.clone();
                                            this.save_items_then(
                                                file.clone(),
                                                Box::new(move |this, _, cx| {
                                                    if this.items.shows(&file) {
                                                        this.items.forget();
                                                    }
                                                    this.session.update(cx, |session, cx| {
                                                        session.process_walk(cx)
                                                    });
                                                }),
                                                window,
                                                cx,
                                            );
                                        },
                                    )),
                                )
                            },
                        ),
                )
            })
            .children(self.render_item_menu(cx))
            .children(self.render_project_menu(cx))
    }
}
