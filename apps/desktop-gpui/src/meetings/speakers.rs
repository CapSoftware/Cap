use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use cap_diarize::VoiceProfile;
use cap_meetings::library::DocMeta;
use serde_json::Value;

/// A speaker embedding model (CC BY 4.0), checked by size and hash. Without
/// it a meeting still records and transcribes, with the user on the
/// microphone and everyone else together on the computer's audio.
const MODEL_FILE: &str = "speaker-embedding-v1.onnx";
const MODEL_URL: &str = "https://github.com/CapSoftware/transcription-models/releases/download/speaker-v1/speaker-embedding-v1.onnx";
const MODEL_SHA256: &str = "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef";
const MODEL_BYTES: u64 = 29_292_684;
const PROFILE_FILE: &str = "voice-profile.json";
pub const USER_NAME_KEY: &str = "userName";
/// Names the meeting app's speaker highlight suggested for voices, by id,
/// when the evidence was not strong enough to use them by itself.
pub const APP_NAMES_KEY: &str = "appSpeakerNames";

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

/// NVIDIA Nemotron 3 Diarization (OpenMDW-1.1), int8 ONNX export
/// (onnx-community/Nemotron-3-Diarization-ONNX at 353b6f8): decides who is
/// who at the end of a meeting. Fetched on demand like the speaker model;
/// until it is here, or if it fails, the speaker model's labels are kept.
const NEMOTRON_DIR: &str = "nemotron-3-diarization";
const NEMOTRON_GRAPH: &str = "model_quantized.onnx";
const NEMOTRON_URL: &str = "https://github.com/CapSoftware/transcription-models/releases/download/speaker-v2";
const NEMOTRON_FILES: [(&str, &str, u64); 2] = [
    (NEMOTRON_GRAPH, "fff7d18c7439c9fdc1c6c4dfec924cb42d3344264ca879780dfaf7ee886e6c1e", 364_375),
    ("model_quantized.onnx_data", "002d7483e1c865c35c82220fdb378f185ff213c6d35922b38ae421c8ec72c338", 120_479_872),
];
/// The licence and notice that travel with the weights (OpenMDW-1.1 asks for both).
const NEMOTRON_LICENSE: &str = include_str!("../../licenses/nemotron-3-diarization/LICENSE-OpenMDW-1.1.txt");
const NEMOTRON_NOTICE: &str = include_str!("../../licenses/nemotron-3-diarization/NOTICE.txt");
static NEMOTRON_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static NEMOTRON_FAILED: AtomicBool = AtomicBool::new(false);
static NEMOTRON_RECEIVED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Where the second speaker model is, for the settings and setup screens.
/// Until it is `Ready`, meetings keep the speaker model's labels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NemotronState {
    /// This machine does not run the speaker models (no row to show).
    Unsupported,
    /// Not downloaded yet (it is fetched the first time meetings are on).
    Missing,
    /// Share of the 120 MB received, 0 to 1.
    Downloading(f64),
    Ready,
    /// The last download failed; `retry_nemotron` (or the next meeting)
    /// tries again.
    Failed,
}

impl NemotronState {
    /// Megabytes the download is, for the row's text.
    pub const MEGABYTES: u64 = 120;
}

/// Starts the download again now (the settings row's Retry). Nothing
/// happens when it is installed, already downloading, or unsupported here.
pub fn retry_nemotron(runtime: &tokio::runtime::Handle) {
    if supported() {
        ensure_model(runtime);
    }
}

pub fn nemotron_dir() -> PathBuf {
    crate::transcription::models_dir().join(NEMOTRON_DIR)
}

pub fn nemotron_installed(dir: &Path) -> bool {
    NEMOTRON_FILES
        .iter()
        .all(|(name, _, bytes)| std::fs::metadata(dir.join(name)).is_ok_and(|m| m.len() == *bytes))
}

pub fn nemotron_state() -> NemotronState {
    if !supported() {
        NemotronState::Unsupported
    } else if nemotron_installed(&nemotron_dir()) {
        NemotronState::Ready
    } else if NEMOTRON_DOWNLOADING.load(Ordering::Acquire) {
        let total: u64 = NEMOTRON_FILES.iter().map(|f| f.2).sum();
        NemotronState::Downloading(NEMOTRON_RECEIVED.load(Ordering::Acquire) as f64 / total as f64)
    } else if NEMOTRON_FAILED.load(Ordering::Acquire) {
        NemotronState::Failed
    } else {
        NemotronState::Missing
    }
}

/// Loads Nemotron for one meeting when it is installed. Runs on the
/// transcription thread; never fails the meeting (None keeps the speaker
/// model's labels).
pub fn load_nemotron() -> Option<Box<dyn cap_diarize::nemotron::NemoModel>> {
    let dir = nemotron_dir();
    if cfg!(test) || !supported() || !nemotron_installed(&dir) {
        return None;
    }
    if let Err(error) = cap_camera_effects::initialize_onnx_runtime() {
        tracing::warn!(error = %format!("{error:#}"), "Nemotron needs the ONNX runtime, keeping the speaker model's labels");
        return None;
    }
    match cap_diarize::nemotron::OnnxNemotron::load(&dir.join(NEMOTRON_GRAPH), 2) {
        Ok(model) => Some(Box::new(model)),
        Err(error) => {
            tracing::warn!(%error, "Nemotron could not load, keeping the speaker model's labels");
            None
        }
    }
}

/// Fetches Nemotron in the background when it is missing (after the speaker
/// model, at most one download at a time).
fn ensure_nemotron(runtime: &tokio::runtime::Handle) {
    let dir = nemotron_dir();
    if nemotron_installed(&dir) || cfg!(test) || NEMOTRON_DOWNLOADING.swap(true, Ordering::AcqRel) {
        return;
    }
    NEMOTRON_FAILED.store(false, Ordering::Release);
    NEMOTRON_RECEIVED.store(0, Ordering::Release);
    runtime.spawn(async move {
        tracing::info!("Downloading Nemotron 3 Diarization");
        let result = download_nemotron(&dir).await;
        if let Err(error) = &result {
            tracing::warn!("{error}");
        }
        NEMOTRON_FAILED.store(result.is_err(), Ordering::Release);
        NEMOTRON_DOWNLOADING.store(false, Ordering::Release);
    });
}

/// Where the weights come from. Debug-assertion builds can point it at a local
/// server to prove the download and its fallbacks.
fn nemotron_url() -> String {
    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var("CAP_DEV_NEMOTRON_URL") {
            return url;
        }
    }
    NEMOTRON_URL.to_string()
}

async fn download_nemotron(dir: &Path) -> Result<(), String> {
    use crate::transcription::fetch;
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {dir:?}: {e}"))?;
    let left: u64 = NEMOTRON_FILES
        .iter()
        .filter(|(name, _, bytes)| {
            !std::fs::metadata(dir.join(name)).is_ok_and(|m| m.len() == *bytes)
        })
        .map(|(name, _, bytes)| {
            let have =
                std::fs::metadata(dir.join(format!("{name}.downloading"))).map_or(0, |m| m.len());
            bytes.saturating_sub(if have <= *bytes { have } else { 0 })
        })
        .sum();
    if let Some(missing) = fetch::missing_space(dir, left) {
        return Err(format!(
            "Not enough free space for Nemotron ({} more needed)",
            fetch::size_label(missing)
        ));
    }
    for (name, sha, bytes) in NEMOTRON_FILES {
        let path = dir.join(name);
        if std::fs::metadata(&path).is_ok_and(|m| m.len() == bytes) {
            NEMOTRON_RECEIVED.fetch_add(bytes, Ordering::AcqRel);
            continue;
        }
        let staging = dir.join(format!("{name}.downloading"));
        let received = |n: i64| {
            if n >= 0 {
                NEMOTRON_RECEIVED.fetch_add(n as u64, Ordering::AcqRel);
            } else {
                let _ = NEMOTRON_RECEIVED.fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                    Some(v.saturating_sub(n.unsigned_abs()))
                });
            }
        };
        fetch::verified(
            &format!("{}/{name}", nemotron_url()),
            &staging,
            sha,
            Some(bytes),
            &received,
        )
        .await
        .map_err(|e| format!("Failed to download Nemotron ({name}): {e}"))?;
        std::fs::rename(&staging, &path).map_err(|e| format!("Failed to install Nemotron: {e}"))?;
    }
    std::fs::write(dir.join("LICENSE-OpenMDW-1.1.txt"), NEMOTRON_LICENSE)
        .map_err(|e| format!("Failed to write the Nemotron licence: {e}"))?;
    std::fs::write(dir.join("NOTICE.txt"), NEMOTRON_NOTICE)
        .map_err(|e| format!("Failed to write the Nemotron notice: {e}"))?;
    Ok(())
}

/// The ONNX Runtime the app ships for Intel Macs predates the fix for a leak
/// of a few megabytes on every inference, which this model would hit on
/// every speech segment.
pub fn supported() -> bool {
    crate::transcription::supports_parakeet()
}

pub fn model_path() -> PathBuf {
    crate::transcription::models_dir().join(MODEL_FILE)
}

pub fn model_installed(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() == MODEL_BYTES)
}

#[cfg(test)]
thread_local! {
    pub static TEST_PROFILE_PATH: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

pub fn profile_path() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_PROFILE_PATH.with(|p| p.borrow().clone()) {
        return path;
    }
    super::persist::meetings_dir().join(PROFILE_FILE)
}

pub fn load_profile() -> Option<VoiceProfile> {
    let path = profile_path();
    if !path.exists() {
        return None;
    }
    match VoiceProfile::load(&path) {
        Ok(profile) => Some(profile),
        // An older version's profile (or a broken one) can never load: drop
        // it once, quietly, so the next meeting where the microphone holds
        // only the user learns the voice again instead of every meeting
        // warning about the same file.
        Err(error) if VoiceProfile::unusable(&path) => {
            match VoiceProfile::delete(&path) {
                Ok(()) => tracing::info!(
                    %error,
                    "dropped a voice profile this version cannot use; the voice is learnt again"
                ),
                Err(error) => tracing::warn!(%error, "could not drop the old voice profile"),
            }
            None
        }
        Err(error) => {
            tracing::warn!(%error, "could not read the voice profile");
            None
        }
    }
}

/// Folds what this meeting learnt into the stored profile.
pub fn save_enrolment(enrolment: &VoiceProfile) -> Result<VoiceProfile, String> {
    let path = profile_path();
    let merged = match load_profile() {
        Some(existing) => existing.merged(enrolment),
        None => enrolment.clone(),
    };
    merged.save(&path).map_err(|e| e.to_string())?;
    Ok(merged)
}

pub fn forget_profile() -> Result<(), String> {
    VoiceProfile::delete(&profile_path()).map_err(|e| e.to_string())
}

/// Loads the model for one meeting. Runs on the transcription thread.
pub fn load_embedder(path: &Path) -> Result<Box<dyn cap_diarize::Embed>, String> {
    cap_camera_effects::initialize_onnx_runtime().map_err(|error| format!("{error:#}"))?;
    cap_diarize::OnnxEmbedder::load(path, 1, false)
        .map(|e| Box::new(e) as Box<dyn cap_diarize::Embed>)
        .map_err(|e| e.to_string())
}

/// Fetches the model in the background when it is missing, at most one
/// download at a time. Returns whether it is already there.
pub fn ensure_model(runtime: &tokio::runtime::Handle) -> bool {
    if !supported() {
        return false;
    }
    let path = model_path();
    if model_installed(&path) {
        ensure_nemotron(runtime);
        return true;
    }
    if cfg!(test) || DOWNLOADING.swap(true, Ordering::AcqRel) {
        return false;
    }
    runtime.spawn(async move {
        tracing::info!("Downloading the speaker model");
        if let Err(error) = download(&path).await {
            tracing::warn!("{error}");
        }
        DOWNLOADING.store(false, Ordering::Release);
    });
    false
}

async fn download(path: &Path) -> Result<(), String> {
    use crate::transcription::fetch;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create {parent:?}: {e}"))?;
    }
    let staging = path.with_extension("onnx.downloading");
    fetch::verified(
        MODEL_URL,
        &staging,
        MODEL_SHA256,
        Some(MODEL_BYTES),
        &|_| {},
    )
    .await
    .map_err(|e| format!("Failed to download the speaker model: {e}"))?;
    std::fs::rename(&staging, path).map_err(|e| format!("Failed to install the speaker model: {e}"))
}

fn clean(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|n| !n.is_empty() && !n.contains('@'))
        .map(str::to_string)
}

/// The signed-in Cap account's name, as the settings window last fetched it.
fn account_name() -> Option<String> {
    let token = crate::store::auth_snapshot().token;
    token.as_ref()?;
    let user_id = crate::store::store_section("auth")
        .get("user_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cached = crate::store::store_section("user_profile");
    let cached_user = match cached.get("userId")? {
        Value::Null => None,
        Value::String(id) => Some(id.clone()),
        _ => return None,
    };
    if cached_user != user_id {
        return None;
    }
    clean(cached.get("profile")?.get("name")?.as_str())
}

fn calendar_self_name(meta: &DocMeta) -> Option<String> {
    clean(
        meta.meeting
            .as_ref()?
            .event
            .as_ref()?
            .attendees
            .iter()
            .find(|a| a.is_self)?
            .name
            .as_deref(),
    )
}

/// The full name of this computer's account (the first field of the
/// password entry's comment, which is where macOS and Linux keep it).
#[cfg(unix)]
fn system_user_name() -> Option<String> {
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: getpwuid_r writes only into `entry` and `buf`, both alive for
    // the whole call, and `result` points at `entry` or is null.
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || entry.pw_gecos.is_null() {
        return None;
    }
    // SAFETY: pw_gecos is a NUL-terminated string inside `buf`.
    let gecos = unsafe { std::ffi::CStr::from_ptr(entry.pw_gecos) }.to_string_lossy();
    clean(gecos.split(',').next())
}

#[cfg(not(unix))]
fn system_user_name() -> Option<String> {
    None
}

/// The name the user's own lines carry, chosen when a meeting starts: the
/// Cap account's name, else their name on the calendar event, else the
/// computer's account name.
pub fn resolve_user_name(meta: &DocMeta) -> Option<String> {
    account_name()
        .or_else(|| calendar_self_name(meta))
        .or_else(system_user_name)
}

/// The user's name for a document: the one stored when it was recorded,
/// else their name on its calendar event.
pub fn user_name(meta: &DocMeta) -> Option<String> {
    meta.meeting
        .as_ref()
        .and_then(|m| m.extra.get(USER_NAME_KEY))
        .and_then(Value::as_str)
        .and_then(|n| clean(Some(n)))
        .or_else(|| calendar_self_name(meta))
}

/// The one person the calendar lists besides the user, whose name the call's
/// voice takes when the computer's audio holds a single voice.
pub fn other_attendee(meta: &DocMeta) -> Option<String> {
    let event = meta.meeting.as_ref()?.event.as_ref()?;
    let others: Vec<_> = event.attendees.iter().filter(|a| !a.is_self).collect();
    match others.as_slice() {
        [only] => clean(only.name.as_deref()),
        _ => None,
    }
}

/// Everyone the calendar lists for this meeting, by name.
pub fn attendee_names(meta: &DocMeta) -> Vec<String> {
    meta.meeting
        .as_ref()
        .and_then(|m| m.event.as_ref())
        .map(|event| {
            event
                .attendees
                .iter()
                .filter_map(|a| clean(a.name.as_deref()))
                .collect()
        })
        .unwrap_or_default()
}

/// Names for this meeting's numbered voices from what was said ("I'm
/// Kristen", "Jun?") and the calendar. Only voices still called "Person n"
/// are named; the user's own voice and anyone already named are left alone,
/// and nobody else is ever given the user's name.
pub fn name_guesses(
    transcript: &cap_meetings::transcript::Transcript,
    meta: &DocMeta,
) -> Vec<(u32, String, cap_meetings::names::Certainty)> {
    let Some(names) = transcript.names() else {
        return Vec::new();
    };
    let turns = transcript.turns();
    let keys: Vec<(String, &str)> = turns
        .iter()
        .filter_map(|t| t.speaker_id.map(|id| (id.to_string(), t.text.as_str())))
        .collect();
    let input: Vec<cap_meetings::names::Turn<'_>> = keys
        .iter()
        .map(|(speaker, text)| cap_meetings::names::Turn { speaker, text })
        .collect();
    let user = names.user().map(|id| id.0.to_string());
    let user_name = user_name(meta).map(|n| n.to_lowercase());
    cap_meetings::names::guess(&input, user.as_deref(), &attendee_names(meta))
        .into_iter()
        .filter_map(|g| {
            let id = g.speaker.parse::<u32>().ok()?;
            let numbered = matches!(
                names.label(cap_diarize::SpeakerId(id)),
                Some(cap_diarize::Label::Person(_))
            );
            let users = user_name.as_deref().is_some_and(|u| {
                let first = |s: &str| s.split_whitespace().next().unwrap_or("").to_string();
                first(u) == first(&g.name.to_lowercase())
            });
            (numbered && !users).then_some((id, g.name, g.certainty))
        })
        .chain(app_suggestions(meta).into_iter().filter_map(|(id, name)| {
            let numbered = matches!(
                names.label(cap_diarize::SpeakerId(id)),
                Some(cap_diarize::Label::Person(_))
            );
            numbered.then_some((id, name, cap_meetings::names::Certainty::Suggestion))
        }))
        .fold(
            Vec::new(),
            |mut out: Vec<(u32, String, cap_meetings::names::Certainty)>, g| {
                // The meeting app's word wins over a guess from the words.
                if let Some(at) = out.iter().position(|o| o.0 == g.0) {
                    if g.2 == cap_meetings::names::Certainty::Suggestion && out[at].1 != g.1 {
                        out[at] = g;
                    }
                } else {
                    out.push(g);
                }
                out
            },
        )
}

/// Keep the meeting app's weaker suggestions with the meeting, so the
/// transcript can offer them for one click.
/// Read again under the meta lock: the meta the speaker pass started from
/// can be older than an edit made since.
pub fn remember_suggestions(
    doc_id: &str,
    offered: &[(u32, String)],
    library: Option<&cap_meetings::library::Library>,
) {
    let Some(library) = library else {
        return;
    };
    let _lock = cap_meetings::library::lock_meta();
    let Ok(mut meta) = library.load(doc_id) else {
        return;
    };
    let Some(meeting) = meta.meeting.as_mut() else {
        return;
    };
    let map: serde_json::Map<String, Value> = offered
        .iter()
        .map(|(id, name)| (id.to_string(), Value::String(name.clone())))
        .collect();
    meeting
        .extra
        .insert(APP_NAMES_KEY.into(), Value::Object(map));
    if let Err(error) = library.save(&meta) {
        tracing::warn!(%error, "could not keep the meeting app's speaker names");
    }
}

fn app_suggestions(meta: &DocMeta) -> Vec<(u32, String)> {
    meta.meeting
        .as_ref()
        .and_then(|m| m.extra.get(APP_NAMES_KEY))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(id, name)| Some((id.parse().ok()?, clean(name.as_str())?)))
                .collect()
        })
        .unwrap_or_default()
}
