use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};

/// What a native recording is. A walk records a fresh browser window with its evidence; a
/// diatribe is the owner talking a topic through (screen and microphone, no browser), which
/// the engine turns into notes and action items (`kind: "diatribe"` in its session files).
/// Notes is an ordinary Studio or Instant recording with "Notes & action items" on: it
/// finishes like any recording and is then processed in the background like a diatribe.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Walk,
    Diatribe,
    Notes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub directory: PathBuf,
    pub topic: String,
    pub url: String,
    pub speakers: Vec<String>,
    /// Absent in journals written before diatribes existed: those are walks.
    #[serde(default)]
    pub kind: Kind,
    /// The project this recording belongs to (`<configDir>/projects/<id>.json`). Absent in
    /// journals written before projects existed, and when the recording has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

impl Request {
    pub fn for_restart(&self, unique: &str) -> Self {
        let prefix = match self.kind {
            Kind::Walk => "walk",
            Kind::Diatribe => "diatribe",
            Kind::Notes => "notes",
        };
        Self {
            directory: self.directory.with_file_name(format!("{prefix}-{unique}")),
            ..self.clone()
        }
    }

    pub fn is_diatribe(&self) -> bool {
        self.kind == Kind::Diatribe
    }

    /// Notes ride along with an ordinary recording, which finishes the normal way.
    pub fn is_notes(&self) -> bool {
        self.kind == Kind::Notes
    }

    /// Walks and diatribes open the walk window while recording; notes never do.
    pub fn opens_walk_window(&self) -> bool {
        self.kind != Kind::Notes
    }

    /// Only a walk owns a browser window, its evidence collector and their health checks.
    pub fn uses_browser(&self) -> bool {
        self.kind == Kind::Walk
    }
}

/// Whether a recording start opens the walk window: walks and diatribes do, notes do not.
pub fn opens_walk_window(request: Option<&Request>) -> bool {
    request.is_some_and(Request::opens_walk_window)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: String,
    pub text: String,
    pub offset_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub schema_version: u8,
    pub request: Request,
    pub source_project: PathBuf,
    pub started_at_ms: u64,
    pub state: String,
    pub duration_ms: Option<u64>,
    pub events: Vec<Event>,
}

impl Journal {
    pub fn begin(
        request: Request,
        source_project: PathBuf,
        started_at_ms: u64,
    ) -> Result<Self, String> {
        if request.topic.trim().is_empty() {
            return Err("Give this walk a topic.".into());
        }
        fs::create_dir_all(request.directory.parent().ok_or("Invalid walk folder.")?)
            .map_err(|e| e.to_string())?;
        fs::create_dir(&request.directory).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            if let Some(parent) = request.directory.parent() {
                fs::File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| error.to_string())?;
            }
        }
        let journal = Self {
            schema_version: 1,
            request,
            source_project,
            started_at_ms,
            state: "recording".into(),
            duration_ms: None,
            events: Vec::new(),
        };
        journal.save()?;
        Ok(journal)
    }

    pub fn file(&self) -> PathBuf {
        self.request.directory.join("native-walk.json")
    }

    fn save(&self) -> Result<(), String> {
        let temporary = self.request.directory.join(".native-walk.json.tmp");
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(temporary, self.file()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            fs::File::open(&self.request.directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// A completed journal for a recording that already exists, so notes can be made from
    /// it after the fact. The recording's length is its capture clock.
    pub fn finished(
        request: Request,
        source_project: PathBuf,
        started_at_ms: u64,
        duration_ms: u64,
    ) -> Result<Self, String> {
        if duration_ms == 0 {
            return Err("This recording has no length to take notes from.".into());
        }
        let mut journal = Self::begin(request, source_project, started_at_ms)?;
        if let Err(error) = journal.complete(duration_ms) {
            let _ = journal.abort();
            return Err(error);
        }
        Ok(journal)
    }

    pub fn add(&mut self, kind: &str, text: &str, offset_ms: u64) -> Result<(), String> {
        if self.state != "recording"
            || !matches!(kind, "note" | "chapter")
            || text.trim().is_empty()
        {
            return Err("Enter a note or chapter title while recording.".into());
        }
        if self
            .events
            .last()
            .is_some_and(|last| offset_ms < last.offset_ms)
        {
            return Err("The recording clock moved backwards.".into());
        }
        self.events.push(Event {
            kind: kind.into(),
            text: text.trim().into(),
            offset_ms,
        });
        if let Err(error) = self.save() {
            let _ = self.events.pop();
            return Err(error);
        }
        Ok(())
    }

    pub fn complete(&mut self, duration_ms: u64) -> Result<(), String> {
        if self.state != "recording"
            || duration_ms == 0
            || self
                .events
                .last()
                .is_some_and(|last| last.offset_ms > duration_ms)
        {
            return Err("Walk completion is not confirmed.".into());
        }
        self.state = "complete".into();
        self.duration_ms = Some(duration_ms);
        if let Err(error) = self.save() {
            self.state = "recording".into();
            self.duration_ms = None;
            return Err(error);
        }
        Ok(())
    }

    pub fn abort(&mut self) -> Result<(), String> {
        if self.state == "recording" {
            self.state = "aborted".into();
            self.save()?;
        }
        Ok(())
    }
}
