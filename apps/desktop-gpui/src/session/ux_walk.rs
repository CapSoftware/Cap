use std::time::Duration;

use gpui::{Context, Task};

use super::{Phase, RecordingSession};
use crate::recording::StartConfig;
use crate::ux_walk_journal::Journal;

pub struct WalkState {
    pub journal: Option<Journal>,
    /// "Notes & action items" for the ordinary recording in progress. Kept apart from
    /// `journal` so the recording keeps its normal controls, editor and share flow.
    pub notes: Option<Journal>,
    /// The latest notes job: its journal and where it stands, shown in the recorder.
    pub notes_status: Option<NotesStatus>,
    pub processing: bool,
    pub notice: String,
    pub checkpoint_notice: String,
    pub note_draft: String,
    pub(super) restarting: bool,
    checkpoint_monitor: Option<Task<()>>,
}

impl WalkState {
    pub(super) fn restore() -> Self {
        let journal = crate::store::store_section(crate::store::RECORDING_SETTINGS)
            .get("lastNativeWalk")
            .and_then(serde_json::Value::as_str)
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).ok());
        Self {
            journal,
            notes: None,
            notes_status: None,
            processing: false,
            notice: "Saved walk. Open its report, or reprocess it if preparation was interrupted."
                .into(),
            checkpoint_notice: String::new(),
            note_draft: String::new(),
            restarting: false,
            checkpoint_monitor: None,
        }
    }

    /// A walk or diatribe in progress. Notes on an ordinary recording are not one, so the
    /// recording keeps its normal controls and Studio still opens its editor.
    pub(super) fn active(&self) -> bool {
        self.journal.is_some()
    }

    /// Whether stopping hands the finish to the walk (snapshot, processing, walk window)
    /// instead of the recording's own Studio editor or Instant share flow. Notes never do.
    pub(super) fn owns_finish(&self) -> bool {
        self.notes.is_none() && self.journal.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotesStatus {
    pub file: std::path::PathBuf,
    pub topic: String,
    pub stage: NotesStage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesStage {
    Processing,
    Ready,
    Failed(String),
}

impl NotesStatus {
    /// Finished one way or the other, with a notes folder to open.
    pub fn viewable(&self) -> bool {
        !self.file.as_os_str().is_empty() && self.stage != NotesStage::Processing
    }

    pub fn message(&self) -> String {
        match &self.stage {
            NotesStage::Processing => format!(
                "Making notes & action items for “{}” in the background…",
                self.topic
            ),
            NotesStage::Ready => format!("Notes & action items are ready for “{}”.", self.topic),
            NotesStage::Failed(error) => format!(
                "“{}” is saved. Its notes need attention: {error}",
                self.topic
            ),
        }
    }
}

/// The browser half of a walk: its Chrome, evidence collector, health checks and abort. A
/// diatribe has none, so every browser call goes through here and skips it.
fn browser(walk: &Journal) -> Option<&Journal> {
    walk.request.uses_browser().then_some(walk)
}

fn begin_browser(walk: &Journal, window_id: Option<String>) -> Result<(), String> {
    match browser(walk) {
        Some(walk) => crate::ux_walk_browser::begin(walk, window_id),
        None => Ok(()),
    }
}

fn end_browser(walk: &Journal, aborted: bool) {
    if let Some(walk) = browser(walk) {
        crate::ux_walk_browser::end_walk(walk, aborted);
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl RecordingSession {
    pub(super) fn walk_prepare_start(&mut self, mut config: StartConfig) -> StartConfig {
        if let Some(request) = &mut config.ux_walk
            && request.directory.exists()
        {
            *request = request.for_restart(&crate::store::new_uuid_v4());
        }
        // An Instant restart (a diatribe's) starts again without passing through `finish`, so
        // the discarded take's journal is closed here; a Studio restart already closed it.
        self.walk_abort();
        self.walk.journal = None;
        self.walk.notes = None;
        self.walk.processing = false;
        self.walk.notice.clear();
        config
    }

    pub(super) fn begin_walk(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(request) = self
            .last_config
            .as_ref()
            .and_then(|config| config.ux_walk.clone())
        else {
            return true;
        };
        if request.is_notes() {
            self.begin_notes(request);
            return true;
        }
        let journal = match Journal::begin(
            request,
            self.active.as_ref().unwrap().project_dir.clone(),
            now_millis(),
        ) {
            Ok(journal) => journal,
            Err(error) => {
                self.error = Some(format!("Could not create the walk journal: {error}"));
                self.stop(cx);
                return false;
            }
        };
        crate::store::set_store_setting(
            crate::store::RECORDING_SETTINGS,
            "lastNativeWalk",
            serde_json::Value::String(journal.file().to_string_lossy().into_owned()),
        );
        let diatribe = journal.request.is_diatribe();
        self.walk.notice = if diatribe {
            "Recording your diatribe. Notes save as you add them; stop when you are done.".into()
        } else {
            "Recording. Notes and chapters save as you add them.".into()
        };
        if let Err(error) = crate::ux_walk_library::remember_journal(&journal.file()) {
            tracing::warn!(%error, "could not remember saved walk");
        }
        let window_id = self
            .last_config
            .as_ref()
            .and_then(|config| match &config.target {
                cap_recording::sources::screen_capture::ScreenCaptureTarget::Window { id } => {
                    Some(id.to_string())
                }
                _ => None,
            });
        if let Err(error) = begin_browser(&journal, window_id) {
            self.walk.notice =
                format!("Recording and notes are saving. Browser evidence is unavailable: {error}");
            self.error = Some("Browser evidence is unavailable. Video and notes are still recording. Open the notes for details.".into());
        }
        self.walk.journal = Some(journal);
        // Evidence checkpoints read Studio segments; an Instant diatribe has none, and its
        // transcript comes from the finished video when it stops.
        if diatribe {
            self.walk.checkpoint_notice.clear();
            self.walk.note_draft.clear();
        } else {
            self.start_walk_checkpoints(cx);
        }
        true
    }

    fn start_walk_checkpoints(&mut self, cx: &mut Context<Self>) {
        let Some(journal) = self.walk.journal.clone() else {
            return;
        };
        let file = journal.file();
        let generation = self.recording_generation;
        self.walk.note_draft.clear();
        self.walk.checkpoint_notice = "Starting evidence checkpoints…".into();
        self.walk.checkpoint_monitor =
            Some(
                cx.spawn(async move |this, cx| {
                    let mut started = false;
                    let mut clock = 0;
                    loop {
                        let snapshot = this
                            .update(cx, |this, _| {
                                if this.recording_generation != generation
                                    || this
                                        .walk
                                        .journal
                                        .as_ref()
                                        .is_none_or(|walk| walk.file() != file)
                                {
                                    return None;
                                }
                                let journal = this.walk.journal.as_ref().unwrap().clone();
                                let elapsed = this.elapsed().as_millis() as u64;
                                let paused = this.is_paused()
                                    || this.phase != (Phase::Recording { paused: false });
                                let microphone = this
                                    .last_config
                                    .as_ref()
                                    .is_some_and(|config| config.microphone.is_some());
                                let system_audio = this
                                    .last_config
                                    .as_ref()
                                    .is_some_and(|config| config.system_audio);
                                Some((
                                    journal,
                                    elapsed,
                                    paused,
                                    this.walk.note_draft.clone(),
                                    microphone,
                                    system_audio,
                                    this.phase == Phase::Idle,
                                ))
                            })
                            .ok()
                            .flatten();
                        let Some((
                            journal,
                            elapsed,
                            paused,
                            draft,
                            microphone,
                            system_audio,
                            terminal,
                        )) = snapshot
                        else {
                            return;
                        };
                        clock = crate::ux_walk_checkpoints::heartbeat_clock(
                            clock,
                            elapsed,
                            journal.duration_ms,
                        );
                        let status = cx
                            .background_executor()
                            .spawn(async move {
                                crate::ux_walk_checkpoints::heartbeat(
                                    &journal,
                                    generation,
                                    clock,
                                    paused,
                                    &draft,
                                    microphone,
                                    system_audio,
                                    terminal,
                                )?;
                                if !started {
                                    crate::ux_walk_checkpoints::start(&journal)?;
                                }
                                Ok::<String, String>(crate::ux_walk_checkpoints::notice(
                                    &journal.request.directory,
                                ))
                            })
                            .await;
                        started = status.is_ok();
                        let _ = this.update(cx, |this, cx| {
                            if this.recording_generation != generation {
                                return;
                            }
                            this.walk.checkpoint_notice = status.unwrap_or_else(|error| {
                        format!("Checkpoint saving needs attention: {error}. Recording continues.")
                    });
                            cx.notify();
                        });
                        if terminal {
                            return;
                        }
                        cx.background_executor().timer(Duration::from_secs(1)).await;
                    }
                }),
            );
    }

    pub(super) fn walk_health_tick(&mut self, cx: &mut Context<Self>) -> bool {
        if let Some(walk) = self.walk.journal.as_ref().and_then(browser)
            && let Some(reason) = crate::ux_walk_browser::health(walk)
        {
            self.walk.notice = reason;
            if self.error.is_none() {
                self.error = Some("Browser evidence stopped. Video and notes are still recording. Open the notes for details.".into());
                cx.notify();
            }
        }
        true
    }

    pub(super) fn walk_clock(&self, paused: bool) {
        if let Some(walk) = self.walk.journal.as_ref().and_then(browser) {
            crate::ux_walk_browser::clock(walk, self.elapsed().as_millis() as u64, paused);
        }
    }

    pub(super) fn walk_pause_unconfirmed(&self) {
        if let Some(walk) = self.walk.journal.as_ref().and_then(browser) {
            crate::ux_walk_browser::interrupt(
                walk,
                "Capture pause state is unconfirmed; browser collection stopped",
            );
        }
    }

    pub(super) fn walk_abort(&mut self) {
        if let Some(notes) = self.walk.notes.as_mut()
            && notes.state == "recording"
            && let Err(error) = notes.abort()
        {
            tracing::error!(%error, "saving interrupted recording notes journal");
        }
        if let Some(walk) = self.walk.journal.as_mut()
            && walk.state == "recording"
        {
            // Restart records the same Chrome window again, so it has to stay open.
            if let Some(walk) = browser(walk) {
                if self.walk.restarting {
                    crate::ux_walk_browser::finish(walk, true);
                } else {
                    crate::ux_walk_browser::end_walk(walk, true);
                }
            }
            if let Err(error) = walk.abort() {
                tracing::error!(%error, "saving interrupted walk journal");
            }
            self.walk.notice =
                "Recording ended without a completed walk. Your notes are saved in its folder."
                    .into();
        }
    }

    pub fn add_walk_event(
        &mut self,
        kind: &str,
        text: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        if !matches!(self.phase, Phase::Recording { .. }) {
            return Err("Start a walk before adding notes.".into());
        }
        let elapsed = self.elapsed().as_millis() as u64;
        self.walk
            .journal
            .as_mut()
            .ok_or(fork_brand::mode_text_static(
                "This recording is not a %walk% recording.",
            ))?
            .add(kind, text, elapsed)?;
        cx.notify();
        Ok(())
    }

    pub(super) fn complete_walk(&mut self, cx: &mut Context<Self>) -> bool {
        let elapsed = self.elapsed().as_millis() as u64;
        // Notes never take over the finish: the recording ends exactly as it would without
        // them and its notes are made in the background.
        if !self.walk.owns_finish() {
            self.complete_notes(elapsed, cx);
            return false;
        }
        let Some(walk) = self.walk.journal.as_mut() else {
            return false;
        };
        if let Err(error) = walk.complete(elapsed) {
            self.walk.notice = format!("Walk files saved; could not finish the journal: {error}");
            self.finish(cx);
            cx.defer(crate::ux_walk_window::open);
            return true;
        }
        let file = walk.file();
        let browser_journal = walk.clone();
        let generation = self.recording_generation;
        self.walk.notice = "Saving an independent copy of the Cap project…".into();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    end_browser(&browser_journal, false);
                    crate::ux_walk::run_engine("snapshot", &file)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.recording_generation != generation || this.phase != Phase::Stopping {
                    return;
                }
                this.finish(cx);
                match result {
                    Ok(_) => this.process_walk(cx),
                    Err(error) => {
                        this.walk.notice = format!(
                            "Your recording and notes are saved. Could not prepare the walk: {error}"
                        )
                    }
                }
                cx.defer(crate::ux_walk_window::open);
                cx.notify();
            })
            .ok();
        })
        .detach();
        true
    }

    /// Notes for an ordinary recording: a journal beside the recording, no browser, no
    /// checkpoints, no walk window. A journal that cannot be written costs the notes only.
    fn begin_notes(&mut self, request: crate::ux_walk_journal::Request) {
        let project = self.active.as_ref().unwrap().project_dir.clone();
        let request = crate::ux_walk::notes::named(request, &project);
        let topic = request.topic.clone();
        match Journal::begin(request, project, now_millis()) {
            Ok(journal) => {
                if let Err(error) = crate::ux_walk_library::remember_journal(&journal.file()) {
                    tracing::warn!(%error, "could not remember recording notes");
                }
                self.walk.notes = Some(journal);
            }
            Err(error) => {
                tracing::warn!(%error, "could not start recording notes");
                self.walk.notes_status = Some(NotesStatus {
                    file: Default::default(),
                    topic,
                    stage: NotesStage::Failed(format!("could not start its notes: {error}")),
                });
            }
        }
    }

    fn complete_notes(&mut self, elapsed: u64, cx: &mut Context<Self>) {
        let Some(mut notes) = self.walk.notes.take() else {
            return;
        };
        let file = notes.file();
        let topic = notes.request.topic.clone();
        if let Err(error) = notes.complete(elapsed) {
            let _ = notes.abort();
            self.walk.notes_status = Some(NotesStatus {
                file,
                topic,
                stage: NotesStage::Failed(error),
            });
            return;
        }
        self.run_notes(file, topic, cx);
    }

    /// Processes a completed notes journal off the main thread and reports where it got to.
    /// Independent of the recording: a new recording can start while it runs.
    pub fn run_notes(&mut self, file: std::path::PathBuf, topic: String, cx: &mut Context<Self>) {
        self.walk.notes_status = Some(NotesStatus {
            file: file.clone(),
            topic: topic.clone(),
            stage: NotesStage::Processing,
        });
        cx.notify();
        cx.spawn(async move |this, cx| {
            let job = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::notes::process(&job) })
                .await;
            this.update(cx, |this, cx| {
                if this
                    .walk
                    .notes_status
                    .as_ref()
                    .is_some_and(|status| status.file == file)
                {
                    this.walk.notes_status = Some(NotesStatus {
                        file,
                        topic,
                        stage: match result {
                            Ok(()) => NotesStage::Ready,
                            Err(error) => NotesStage::Failed(error),
                        },
                    });
                }
                crate::app_sounds::play_notification();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn edit_walk(&mut self, cx: &mut Context<Self>) {
        // A diatribe is an Instant video, which the editor does not open.
        let Some(walk) = self
            .walk
            .journal
            .as_ref()
            .filter(|walk| walk.state == "complete" && !walk.request.is_diatribe())
        else {
            return;
        };
        let file = walk.file();
        let completed = file.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk::run_engine("prepare-edit", &file).and_then(|output| {
                        serde_json::from_str::<std::path::PathBuf>(&output)
                            .map_err(|e| e.to_string())
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if this.phase != Phase::Idle
                    || this
                        .walk
                        .journal
                        .as_ref()
                        .is_none_or(|walk| walk.file() != completed)
                {
                    return;
                }
                match result {
                    Ok(path) => cx.defer(move |cx| crate::app_windows::open_editor(path, cx)),
                    Err(error) => {
                        this.walk.notice = format!("Could not prepare an editing copy: {error}");
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn process_walk(&mut self, cx: &mut Context<Self>) {
        let Some(walk) = self
            .walk
            .journal
            .as_ref()
            .filter(|walk| walk.state == "complete")
        else {
            return;
        };
        if self.walk.processing {
            return;
        }
        let file = walk.file();
        let diatribe = walk.request.is_diatribe();
        self.walk.processing = true;
        self.walk.notice = if diatribe {
            "Transcribing and organizing your notes, decisions and action items…".into()
        } else {
            "Preparing chapters, screenshots and transcript…".into()
        };
        cx.notify();
        cx.spawn(async move |this, cx| {
            let completed = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::run_engine("process", &file) })
                .await;
            this.update(cx, |this, cx| {
                if this
                    .walk
                    .journal
                    .as_ref()
                    .is_none_or(|walk| walk.file() != completed)
                {
                    return;
                }
                this.walk.processing = false;
                this.walk.notice = match result {
                    Ok(_) if diatribe => {
                        "Diatribe ready. Open the notes or copy the agent prompt.".into()
                    }
                    Ok(_) => {
                        "Walk ready. Open the report or copy its location for your agent.".into()
                    }
                    Err(error) => {
                        format!("Recording and notes saved. Processing needs attention: {error}")
                    }
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ux_walk_journal::{Kind, Request};

    fn journal(kind: Kind) -> Journal {
        let directory = std::env::temp_dir().join(format!(
            "ux-walk-session-{kind:?}-{}-{}",
            std::process::id(),
            crate::store::new_uuid_v4()
        ));
        Journal::begin(
            Request {
                directory: directory.clone(),
                topic: "Diatribe".into(),
                url: String::new(),
                speakers: Vec::new(),
                kind,
                project: None,
            },
            directory.with_extension("cap"),
            100_000,
        )
        .unwrap()
    }

    fn state() -> WalkState {
        WalkState {
            journal: None,
            notes: None,
            notes_status: None,
            processing: false,
            notice: String::new(),
            checkpoint_notice: String::new(),
            note_draft: String::new(),
            restarting: false,
            checkpoint_monitor: None,
        }
    }

    #[test]
    fn notes_keep_the_normal_studio_and_instant_finish() {
        let mut walk = state();
        assert!(!walk.active() && !walk.owns_finish());
        let notes = journal(Kind::Notes);
        let directory = notes.request.directory.clone();
        walk.notes = Some(notes);
        // Not a walk: Studio opens its editor, Instant shares, and stop is not taken over.
        assert!(!walk.active());
        assert!(!walk.owns_finish());
        std::fs::remove_dir_all(directory).unwrap();
        for kind in [Kind::Walk, Kind::Diatribe] {
            let mut walk = state();
            let journal = journal(kind);
            let directory = journal.request.directory.clone();
            walk.journal = Some(journal);
            assert!(walk.active() && walk.owns_finish());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn notes_never_reach_the_browser() {
        let notes = journal(Kind::Notes);
        assert!(browser(&notes).is_none());
        assert!(!notes.request.opens_walk_window());
        begin_browser(&notes, Some("1".into())).unwrap();
        end_browser(&notes, true);
        assert!(
            !notes
                .request
                .directory
                .join("browser-evidence.json")
                .exists()
        );
        std::fs::remove_dir_all(&notes.request.directory).unwrap();
    }

    #[test]
    fn notes_status_reads_where_the_job_stands() {
        let mut status = NotesStatus {
            file: "/notes/native-walk.json".into(),
            topic: "Standup".into(),
            stage: NotesStage::Processing,
        };
        assert!(!status.viewable());
        assert!(status.message().contains("Standup"));
        status.stage = NotesStage::Failed("No transcription key".into());
        assert!(status.viewable());
        assert!(status.message().contains("is saved"));
        assert!(status.message().contains("No transcription key"));
        status.stage = NotesStage::Ready;
        assert!(status.viewable());
        status.file = Default::default();
        assert!(!status.viewable());
    }

    #[test]
    fn a_diatribe_never_reaches_the_browser() {
        let diatribe = journal(Kind::Diatribe);
        assert!(browser(&diatribe).is_none());
        // A walk with no prepared Chrome records why its evidence is missing; a diatribe has
        // no browser half to report on, so nothing is started, written or closed for it.
        begin_browser(&diatribe, Some("1".into())).unwrap();
        end_browser(&diatribe, true);
        assert!(
            !diatribe
                .request
                .directory
                .join("browser-evidence.json")
                .exists()
        );
        std::fs::remove_dir_all(&diatribe.request.directory).unwrap();

        let walk = journal(Kind::Walk);
        assert!(browser(&walk).is_some());
        begin_browser(&walk, Some("1".into())).unwrap();
        assert_eq!(
            cfg!(target_os = "macos"),
            walk.request
                .directory
                .join("browser-evidence.json")
                .exists()
        );
        std::fs::remove_dir_all(&walk.request.directory).unwrap();
    }
}
