use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use cap_meetings::{
    library::{AudioTrack, DocKind, DocMeta, Library, ListFilter, TrashFilter},
    session::StopReason,
    settings::MeetingSettings,
    transcript::{Gap, LogLine, Source, Transcript, append_jsonl},
};
use chrono::{Duration, Utc};

use super::{audio_file, capture, engine::AudioPart, timeline};

pub const SETTINGS_FILE: &str = "settings.json";
pub const CALENDARS_FILE: &str = "calendars.json";
pub const CALENDAR_CACHE_FILE: &str = "calendar-cache.json";
pub const TEMPLATES_FILE: &str = "templates.json";
pub const AUDIO_PARTS_KEY: &str = "audioParts";
/// Set while a meeting's ledger still holds audio to transcribe again.
pub const REPAIR_KEY: &str = "repairPending";
/// Set on a meeting closed after Cap quit unexpectedly, until shown.
pub const RECOVERED_KEY: &str = "recovered";
/// The meeting does not keep its audio, so a scratch copy outside the note
/// stands in until the meeting is complete (only repair reads it).
pub const SCRATCH_KEY: &str = "scratchAudio";
pub const SCRATCH_PARTS_KEY: &str = "scratchParts";
const SCRATCH_DIR: &str = "scratch-audio";

/// Where scratch copies live: the app's own data, never a note's folder,
/// so nothing lists, plays or uploads them.
pub fn scratch_root() -> PathBuf {
    meetings_dir().join(SCRATCH_DIR)
}

pub fn scratch_dir_in(root: &Path, doc_id: &str) -> PathBuf {
    let safe: String = doc_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    root.join(safe)
}

pub fn scratch_dir(doc_id: &str) -> PathBuf {
    scratch_dir_in(&scratch_root(), doc_id)
}

/// Deletes a meeting's scratch copy and forgets it.
pub fn drop_scratch_in(root: &Path, meta: &mut DocMeta) {
    let dir = scratch_dir_in(root, &meta.id);
    if dir.exists()
        && let Err(error) = fs::remove_dir_all(&dir)
    {
        tracing::warn!(%error, "could not delete a meeting's scratch audio");
        return;
    }
    set_flag(meta, SCRATCH_KEY, false);
    if let Some(meeting) = meta.meeting.as_mut() {
        meeting.extra.remove(SCRATCH_PARTS_KEY);
    }
}

/// A scratch copy written to this recently may belong to a meeting that is
/// recording right now (its files change every 2 s).
const SCRATCH_IN_USE: std::time::Duration = std::time::Duration::from_secs(120);

/// When the copy's files were last written (the folder's own time when it
/// holds none).
fn newest_write(dir: &Path) -> Option<std::time::SystemTime> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
        .or_else(|| fs::metadata(dir).ok()?.modified().ok())
}

/// Scratch copies nobody needs any more (their meeting is gone, or has
/// nothing left to repair, and nothing has written to them for a while):
/// deleted. Returns the ids removed.
pub fn drop_stale_scratch_in(root: &Path, needed: impl Fn(&str) -> bool) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let recent = newest_write(&entry.path())
            .and_then(|at| at.elapsed().ok())
            .is_none_or(|age| age < SCRATCH_IN_USE);
        if needed(&name) || recent {
            continue;
        }
        match fs::remove_dir_all(entry.path()) {
            Ok(()) => removed.push(name),
            Err(error) => tracing::warn!(%error, "could not delete stale scratch audio"),
        }
    }
    removed
}

/// Set when a repair added words after the notes were written.
pub const NOTES_STALE_KEY: &str = "notesStale";
/// A repair that adds this many characters is worth new notes.
pub const NOTES_STALE_CHARS: usize = 80;

/// The gaps a meeting can still fill: their track's audio was kept.
pub fn repairable(gaps: &[Gap], parts: &[AudioPart]) -> Vec<Gap> {
    gaps.iter()
        .filter(|g| parts.iter().any(|p| p.source == g.source))
        .cloned()
        .collect()
}
/// Recorded audio after the last line this close is left alone: it is the
/// end of a line already written, not speech nobody transcribed.
const TAIL_MARGIN_MS: u64 = 300;
const TAIL_MIN_MS: u64 = 500;

pub fn meetings_dir() -> PathBuf {
    crate::store::app_data_dir().join("meetings")
}

pub fn documents_dir() -> PathBuf {
    crate::store::app_data_dir().join("documents")
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn load_settings() -> MeetingSettings {
    let json = fs::read_to_string(meetings_dir().join(SETTINGS_FILE)).ok();
    let mut settings = json
        .as_deref()
        .map_or_else(MeetingSettings::default, MeetingSettings::from_json);
    if !has_dictionary(json.as_deref()) {
        settings.transcription.adopt_hints(&saved_caption_words(
            crate::store::transcription_hints_saved(),
        ));
    }
    settings
}

/// Settings written before the dictionary existed (or none at all).
fn has_dictionary(json: Option<&str>) -> bool {
    json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .is_some_and(|value| value["transcription"].get("dictionary").is_some())
}

/// Caption words someone chose; Cap's own example list is not a choice.
pub fn saved_caption_words(saved: Option<Vec<String>>) -> Vec<String> {
    match saved {
        Some(words)
            if words
                != crate::store::DEFAULT_TRANSCRIPTION_HINTS
                    .iter()
                    .map(|w| (*w).to_string())
                    .collect::<Vec<_>>() =>
        {
            words
        }
        _ => Vec::new(),
    }
}

pub fn save_settings(settings: &MeetingSettings) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(settings)?;
    atomic_write(&meetings_dir().join(SETTINGS_FILE), &bytes)
}

pub fn entropy() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    nanos ^ (u64::from(std::process::id()) << 32) ^ TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
}

pub fn audio_tracks(library: &Library, id: &str) -> Vec<AudioTrack> {
    let Ok(dir) = library.audio_dir(id) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".ogg") && !n.starts_with('.'))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|name| {
            let source = if name.starts_with(capture::audio_stem(Source::System)) {
                Source::System
            } else {
                Source::Mic
            };
            let duration_ms = audio_file::probe_duration_ms(&dir.join(&name)).unwrap_or(0);
            AudioTrack {
                source,
                file: format!("{}/{name}", cap_meetings::library::AUDIO_DIR),
                codec: "opus".into(),
                duration_ms,
            }
        })
        .collect()
}

/// The meeting's saved files and where each starts on its timeline.
pub fn audio_parts(library: &Library, meta: &DocMeta) -> Vec<AudioPart> {
    audio_parts_with(library, meta, &scratch_root())
}

/// The kept files (relative to the note) and any scratch copy (relative to
/// its scratch folder).
pub fn audio_parts_with(library: &Library, meta: &DocMeta, scratch_root: &Path) -> Vec<AudioPart> {
    let mut parts = Vec::new();
    if let Some(base) = library.audio_dir(&meta.id).ok().and_then(|d| d.parent().map(Path::to_path_buf)) {
        parts.extend(parts_under(meta, AUDIO_PARTS_KEY, &base));
    }
    parts.extend(parts_under(meta, SCRATCH_PARTS_KEY, &scratch_dir_in(scratch_root, &meta.id)));
    parts
}

fn parts_under(meta: &DocMeta, key: &str, base: &Path) -> Vec<AudioPart> {
    meta.meeting
        .as_ref()
        .and_then(|m| m.extra.get(key))
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    let file = part.get("file")?.as_str()?;
                    // Only files inside the meeting's own folder.
                    if file.contains("..")
                        || Path::new(file).is_absolute()
                        || Path::new(file).has_root()
                    {
                        return None;
                    }
                    let source: Source = serde_json::from_value(part.get("source")?.clone()).ok()?;
                    let offset_ms = part.get("offsetMs").and_then(|v| v.as_u64()).unwrap_or(0);
                    Some(AudioPart {
                        source,
                        path: base.join(file),
                        offset_samples: timeline::ms_to_samples(offset_ms),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What each track recorded after its last written line: the part a crash
/// cut off before it was transcribed.
fn tail_gaps(library: &Library, meta: &DocMeta, transcript: &Transcript) -> Vec<Gap> {
    let parts = audio_parts(library, meta);
    let mut gaps = Vec::new();
    for source in [Source::Mic, Source::System] {
        let Some(last) = parts
            .iter()
            .filter(|p| p.source == source)
            .max_by_key(|p| p.offset_samples)
        else {
            continue;
        };
        let Some(duration_ms) = audio_file::probe_duration_ms(&last.path) else {
            continue;
        };
        let written_ms = transcript
            .utterances()
            .iter()
            .filter(|u| u.source == source && u.is_final)
            .map(|u| u.end_ms)
            .max()
            .map_or(0, |end| end + TAIL_MARGIN_MS);
        let start = timeline::ms_to_samples(written_ms).max(last.offset_samples);
        let end = last.offset_samples + timeline::ms_to_samples(duration_ms);
        let covered = transcript
            .gaps()
            .iter()
            .any(|g| g.source == source && g.start_sample <= start && g.end_sample >= end);
        if covered || end <= start || timeline::samples_to_ms(end - start) < TAIL_MIN_MS {
            continue;
        }
        gaps.push(Gap {
            id: Gap::id_for(source, start),
            source,
            start_sample: start,
            end_sample: end,
            segments: Vec::new(),
            reason: super::engine::reason::TAIL.into(),
        });
    }
    gaps
}

/// Meetings whose ledger still holds audio to transcribe again.
pub fn pending_repairs(library: &Library) -> Vec<String> {
    let Ok(listing) = library.list(&ListFilter {
        kind: Some(DocKind::Meeting),
        trash: TrashFilter::Exclude,
        folder_id: None,
    }) else {
        return Vec::new();
    };
    listing
        .docs
        .into_iter()
        .filter(|meta| {
            meta.meeting
                .as_ref()
                .and_then(|m| m.extra.get(REPAIR_KEY))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .map(|meta| meta.id)
        .collect()
}

pub fn flag(meta: &DocMeta, key: &str) -> bool {
    meta.meeting
        .as_ref()
        .and_then(|m| m.extra.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn set_flag(meta: &mut DocMeta, key: &str, on: bool) -> bool {
    let Some(meeting) = meta.meeting.as_mut() else {
        return false;
    };
    let was = meeting.extra.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    if on {
        meeting.extra.insert(key.into(), serde_json::Value::Bool(true));
    } else {
        meeting.extra.remove(key);
    }
    was != on
}

pub fn recover_unfinished(library: &Library, skip: Option<&str>) -> Vec<String> {
    let Ok(listing) = library.list(&ListFilter {
        kind: Some(DocKind::Meeting),
        trash: TrashFilter::Include,
        folder_id: None,
    }) else {
        return Vec::new();
    };
    let mut recovered = Vec::new();
    for mut meta in listing.docs {
        if Some(meta.id.as_str()) == skip {
            continue;
        }
        let Some(meeting) = meta.meeting.as_mut() else {
            continue;
        };
        let Some(started_at) = meeting.started_at else {
            continue;
        };
        if meeting.ended_at.is_some() {
            continue;
        }
        let transcript = library
            .transcript_path(&meta.id)
            .ok()
            .and_then(|p| Transcript::load_jsonl(&p).ok())
            .map(|(t, _)| t)
            .unwrap_or_default();
        let stats = transcript.stats();
        let tracks = audio_tracks(library, &meta.id);
        let audio_ms = tracks.iter().map(|t| t.duration_ms).max().unwrap_or(0);
        let duration_ms = meeting
            .duration_ms
            .max(stats.last_speech_end_ms.unwrap_or(0))
            .max(audio_ms);
        meeting.duration_ms = duration_ms;
        meeting.ended_at = Some(started_at + Duration::milliseconds(duration_ms as i64));
        meeting.stop_reason = Some(StopReason::Error);
        meeting.transcript_chars = stats.total_chars as u64;
        if !tracks.is_empty() {
            meeting.audio = tracks;
        }
        // What was recorded but never transcribed goes in the ledger, so the
        // repair after launch finishes the meeting.
        // The repair after launch also writes the notes the meeting missed.
        let tail = tail_gaps(library, &meta, &transcript);
        if !tail.is_empty() {
            let lines: Vec<LogLine> = tail.into_iter().map(|gap| LogLine::Gap { gap }).collect();
            let written = library
                .transcript_path(&meta.id)
                .map_err(|e| e.to_string())
                .and_then(|path| append_jsonl(&path, &lines).map_err(|e| e.to_string()));
            if let Err(error) = written {
                tracing::warn!(%error, "could not note the untranscribed end of a recovered meeting");
            }
        }
        set_flag(&mut meta, REPAIR_KEY, true);
        set_flag(&mut meta, RECOVERED_KEY, true);
        meta.updated_at = Utc::now();
        if library.save(&meta).is_ok() {
            recovered.push(meta.id.clone());
        }
    }
    recovered
}
