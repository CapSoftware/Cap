//! Walks started by another app (Z3's composer, `cap-cli walk start`). The caller picks an id
//! and sends a `start_walk` deep link; the walk then runs exactly as one started from the
//! recorder (same recording, same `native-walk.mjs` snapshot and processing), and every step
//! is written to `<walk settings folder>/external-walks/<id>.json` for the caller to read.
//! `apps/cli/src/walk.rs` reads the same file; keep the two in step.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// A walk: a fresh Chrome window with its evidence, narrated. Its wire value is kept stable.
    #[serde(rename = "worm")]
    Walk,
    /// Talking a topic through: screen and microphone, no browser.
    Diatribe,
}

/// Where an outside walk stands. `Ready` and `Failed` are final.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Starting,
    Recording,
    Stopping,
    Processing,
    Ready,
    Failed,
}

impl State {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Ready | Self::Failed)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub schema_version: u8,
    pub id: String,
    pub mode: Mode,
    pub topic: String,
    pub state: State,
    /// What is happening now, in words for the person.
    pub step: String,
    /// The walk folder, once the recording has started.
    pub folder: Option<PathBuf>,
    pub error: Option<String>,
    pub updated_at_ms: u64,
}

/// Ids name files, so only short plain ids are accepted (a UUID fits).
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn directory() -> PathBuf {
    super::config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join("external-walks")
}

fn file_in(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid walk id.".into());
    }
    Ok(directory.join(format!("{id}.json")))
}

pub fn read_in(directory: &Path, id: &str) -> Option<Status> {
    let bytes = std::fs::read(file_in(directory, id).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn read(id: &str) -> Option<Status> {
    read_in(&directory(), id)
}

pub fn write_in(directory: &Path, status: &Status) -> Result<(), String> {
    let file = file_in(directory, &status.id)?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".{}.{}.tmp", status.id, std::process::id()));
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(status).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Status {
    pub fn starting(id: &str, mode: Mode, topic: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            mode,
            topic: topic.into(),
            state: State::Starting,
            step: match mode {
                Mode::Walk => "Opening a new Chrome window…".into(),
                Mode::Diatribe => "Starting the diatribe…".into(),
            },
            folder: None,
            error: None,
            updated_at_ms: now_millis(),
        }
    }

    /// The next step, unless the walk already ended: a final state is never overwritten.
    pub fn advance(&mut self, state: State, step: &str, folder: Option<&Path>) -> bool {
        if self.state.is_final() {
            return false;
        }
        self.state = state;
        self.step = step.into();
        if let Some(folder) = folder {
            self.folder = Some(folder.to_path_buf());
        }
        self.updated_at_ms = now_millis();
        true
    }

    pub fn fail(&mut self, error: &str) -> bool {
        if !self.advance(State::Failed, error, None) {
            return false;
        }
        self.error = Some(error.into());
        true
    }
}

/// Starts tracking a new outside walk. An id already in use is refused, so a repeated deep
/// link cannot restart a walk.
pub fn begin(id: &str, mode: Mode, topic: &str) -> Result<Status, String> {
    if !valid_id(id) {
        return Err("Invalid walk id.".into());
    }
    if read(id).is_some() {
        return Err("That walk id is already in use.".into());
    }
    let status = Status::starting(id, mode, topic);
    write_in(&directory(), &status)?;
    Ok(status)
}

/// Moves an outside walk on, if `id` names one. Errors are logged, never raised: the walk
/// itself must not fail because its status file could not be written.
pub fn update(id: Option<&str>, change: impl FnOnce(&mut Status) -> bool) {
    let Some(id) = id else {
        return;
    };
    let Some(mut status) = read(id) else {
        return;
    };
    if change(&mut status)
        && let Err(error) = write_in(&directory(), &status)
    {
        tracing::warn!(%error, "could not save outside walk status");
    }
}

pub fn fail(id: Option<&str>, error: &str) {
    update(id, |status| status.fail(error));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("external-walks-{}", crate::store::new_uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_are_plain_file_names() {
        assert!(valid_id("3f1c2b9e-0d7a-4c55-9d1e-2b8f3a6c7d10"));
        assert!(valid_id("z3_run-1"));
        for bad in ["", "../x", "a/b", "a.json", "has space", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn status_round_trips_in_the_shape_callers_read() {
        let dir = scratch();
        let mut status = Status::starting("abc", Mode::Diatribe, "Pricing");
        assert!(status.advance(
            State::Recording,
            "Recording",
            Some(Path::new("/walks/2026-11-06_10-00-Pricing-x"))
        ));
        write_in(&dir, &status).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("abc.json")).unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["mode"], "diatribe");
        assert_eq!(value["state"], "recording");
        assert_eq!(value["folder"], "/walks/2026-11-06_10-00-Pricing-x");
        assert!(value["error"].is_null());
        assert_eq!(read_in(&dir, "abc"), Some(status));
        assert!(read_in(&dir, "../abc").is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_finished_walk_keeps_its_result() {
        let mut status = Status::starting("abc", Mode::Walk, "Checkout");
        assert!(status.advance(State::Ready, "Walk ready", Some(Path::new("/w"))));
        assert!(!status.fail("late error"));
        assert!(!status.advance(State::Processing, "again", None));
        assert_eq!(status.state, State::Ready);
        assert_eq!(status.error, None);

        let mut failed = Status::starting("abc", Mode::Walk, "Checkout");
        assert!(failed.fail("Chrome did not open"));
        assert_eq!(failed.state, State::Failed);
        assert_eq!(failed.error.as_deref(), Some("Chrome did not open"));
        assert!(!failed.advance(State::Recording, "Recording", None));
    }
}
