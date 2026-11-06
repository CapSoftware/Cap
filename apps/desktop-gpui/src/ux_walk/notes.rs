//! "Notes & action items" on an ordinary Studio or Instant recording. The recording finishes
//! exactly as it would without it; afterwards a notes journal (`Kind::Notes`) pointing at the
//! recording is processed in the background, like a diatribe, into notes, decisions and
//! action items in the walk recordings folder.

use std::path::{Path, PathBuf};

use crate::main_window::Mode;
use crate::mode_choice::ModeChoice;
use crate::ux_walk_journal::{Journal, Kind, Request};

pub const NAME: &str = "Notes & action items";
pub const MAKE: &str = "Make notes & action items";
const TOPIC: &str = "Notes";

/// Whether the next recording gets notes: the recorder's own toggle when it was flipped,
/// otherwise the Settings default.
pub fn wanted(default: bool, choice: Option<bool>) -> bool {
    choice.unwrap_or(default)
}

/// Notes ride on ordinary recordings only. Screenshots have nothing to transcribe, a walk or
/// diatribe always has notes, and recording into the editor adds to an existing project.
pub fn applies(choice: ModeChoice, editor_flow: bool) -> bool {
    !editor_flow && matches!(choice, ModeChoice::Capture(Mode::Studio | Mode::Instant))
}

/// The notes request for a recording that is about to start. Its topic becomes the
/// recording's name once the recording exists (`named`).
pub fn request(topic: &str) -> Result<Request, String> {
    let mut request = super::request(topic)?;
    request.kind = Kind::Notes;
    request.url.clear();
    Ok(request)
}

pub fn start_request() -> Result<Request, String> {
    request(TOPIC)
}

/// The recording's own name, the topic its notes are filed under.
pub fn recording_name(project: &Path) -> String {
    cap_project::RecordingMeta::load_for_project(project)
        .ok()
        .map(|meta| meta.pretty_name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            project
                .file_stem()
                .map(|stem| stem.to_string_lossy().trim().to_string())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| TOPIC.into())
}

pub fn named(mut request: Request, project: &Path) -> Request {
    request.topic = recording_name(project);
    request
}

fn probe_ms(path: &Path) -> Option<u64> {
    cap_enc_ffmpeg::remux::get_media_duration(path)
        .map(|duration| duration.as_millis() as u64)
        .filter(|ms| *ms > 0)
}

/// How long a finished recording runs, read from its media.
pub fn duration_ms(project: &Path) -> Result<u64, String> {
    let meta = cap_project::RecordingMeta::load_for_project(project)
        .map_err(|_| "Could not read this recording.".to_string())?;
    let measured = match &meta.inner {
        cap_project::RecordingMetaInner::Instant(_) => {
            probe_ms(&project.join("content/output.mp4"))
        }
        cap_project::RecordingMetaInner::Studio(studio) => {
            let segments: Option<u64> = match studio.as_ref() {
                cap_project::StudioRecordingMeta::SingleSegment { segment } => {
                    probe_ms(&meta.path(&segment.display.path))
                }
                cap_project::StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .map(|segment| probe_ms(&meta.path(&segment.display.path)))
                    .sum(),
            };
            segments.or_else(|| probe_ms(&meta.output_path()))
        }
    };
    measured.ok_or_else(|| "Could not measure this recording’s length.".into())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A completed notes journal for a recording made earlier, ready to process. The library
/// links the recording to these notes from now on.
pub fn for_recording(project: &Path) -> Result<PathBuf, String> {
    let project = project
        .canonicalize()
        .map_err(|_| "This recording could not be found.".to_string())?;
    let duration = duration_ms(&project)?;
    let journal = Journal::finished(
        request(&recording_name(&project))?,
        project.clone(),
        // The newest journal for a recording is the one its library row links to.
        now_ms(),
        duration,
    )?;
    if let Err(error) = crate::ux_walk_library::remember_journal(&journal.file()) {
        tracing::warn!(%error, "could not remember recording notes");
    }
    Ok(journal.file())
}

/// Copies the recording into the notes folder, then transcribes it and writes the brief.
/// Blocking: run it off the main thread. The recording itself is never changed.
pub fn process(file: &Path) -> Result<(), String> {
    super::run_engine("snapshot", file)?;
    super::run_engine("process", file).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recorder_toggle_overrides_the_default_for_the_next_recording() {
        assert!(!wanted(false, None));
        assert!(wanted(true, None));
        assert!(wanted(false, Some(true)));
        assert!(!wanted(true, Some(false)));
    }

    #[test]
    fn notes_apply_to_ordinary_studio_and_instant_recordings_only() {
        assert!(applies(ModeChoice::Capture(Mode::Studio), false));
        assert!(applies(ModeChoice::Capture(Mode::Instant), false));
        assert!(!applies(ModeChoice::Capture(Mode::Studio), true));
        assert!(!applies(ModeChoice::Capture(Mode::Screenshot), false));
        assert!(!applies(ModeChoice::UxWalk, false));
    }

    #[test]
    fn a_notes_request_has_no_browser_and_takes_the_recording_name() {
        let project = std::env::temp_dir().join(format!(
            "notes-name-{}-{}.cap",
            std::process::id(),
            crate::store::new_uuid_v4()
        ));
        std::fs::create_dir_all(&project).unwrap();
        let request = Request {
            directory: project.with_extension("notes"),
            topic: TOPIC.into(),
            url: String::new(),
            speakers: Vec::new(),
            kind: Kind::Notes,
            project: None,
        };
        assert!(!request.uses_browser());
        assert!(!request.opens_walk_window());
        let stem = project.file_stem().unwrap().to_string_lossy().to_string();
        assert_eq!(named(request.clone(), &project).topic, stem);
        std::fs::write(
            project.join("recording-meta.json"),
            r#"{"pretty_name":"Standup 4 Nov","fps":30,"sample_rate":48000}"#,
        )
        .unwrap();
        assert_eq!(named(request, &project).topic, "Standup 4 Nov");
        std::fs::remove_dir_all(&project).unwrap();
    }
}
