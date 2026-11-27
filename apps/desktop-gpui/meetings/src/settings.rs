use serde::{Deserialize, Serialize};

use crate::detect::{BrowserPolicy, DetectConfig};
use crate::dictionary::{self, Entry};
use crate::prompt::{AutoRecord, PromptConfig};
use crate::serde_util::lenient;
use crate::session::SessionConfig;

#[cfg(test)]
mod tests;

pub const MAX_LEAD_SECS: u32 = 900;
pub const MAX_VOCABULARY: usize = 200;
pub const MAX_VOCABULARY_TERM_CHARS: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptPosition {
    #[default]
    TopRight,
    TopLeft,
    BottomRight,
    BottomLeft,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "camelCase")]
pub enum Microphone {
    #[default]
    Auto,
    Named(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    #[default]
    Local,
    Cloud,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "code", rename_all = "camelCase")]
pub enum Language {
    #[default]
    Auto,
    Code(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotificationSettings {
    pub scheduled: bool,
    pub lead_secs: u32,
    pub detected: bool,
    pub muted_app_ids: Vec<String>,
    #[serde(deserialize_with = "lenient")]
    pub position: PromptPosition,
    pub sound: bool,
    pub show_join: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            scheduled: true,
            lead_secs: 60,
            detected: true,
            muted_app_ids: Vec::new(),
            position: PromptPosition::TopRight,
            sound: true,
            show_join: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutomationSettings {
    #[serde(deserialize_with = "lenient")]
    pub auto_record: AutoRecord,
    pub countdown_secs: u32,
    pub bring_up_window: bool,
    /// Closing the notes window brings Cap's window back.
    pub show_cap_on_close: bool,
    #[serde(deserialize_with = "lenient")]
    pub browser_policy: BrowserPolicy,
}

impl Default for AutomationSettings {
    fn default() -> Self {
        Self {
            auto_record: AutoRecord::Off,
            countdown_secs: 5,
            bring_up_window: true,
            show_cap_on_close: true,
            browser_policy: BrowserPolicy::Any,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordingSettings {
    pub stop_when_call_ends: bool,
    pub inactivity_minutes: Option<u32>,
    pub keep_audio: bool,
    pub audio_retention_days: Option<u32>,
    #[serde(deserialize_with = "lenient")]
    pub microphone: Microphone,
    pub show_indicator: bool,
    pub sounds: bool,
    pub pause_media_on_join: bool,
}

impl Default for RecordingSettings {
    fn default() -> Self {
        Self {
            stop_when_call_ends: true,
            inactivity_minutes: Some(10),
            keep_audio: true,
            audio_retention_days: None,
            microphone: Microphone::Auto,
            show_indicator: true,
            sounds: true,
            pause_media_on_join: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TranscriptionSettings {
    #[serde(deserialize_with = "lenient")]
    pub engine: Engine,
    pub local_model: String,
    #[serde(deserialize_with = "lenient")]
    pub language: Language,
    /// The spellings of `dictionary`, kept for older builds and every
    /// consumer that only needs the words (cloud keywords, notes, Ask).
    pub vocabulary: Vec<String>,
    /// One dictionary for all of Cap. Absent in settings written before it
    /// existed; `validate` builds it from `vocabulary` then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dictionary: Option<Vec<Entry>>,
    /// Built-in entries already added once, so removing one sticks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub builtins_added: Vec<String>,
    pub live: bool,
    /// The live transcript with Cap Cloud on a computer too slow to show it
    /// (see `live_for`): off until the user turns it on. `None` until they
    /// choose, so the default can stay off there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_on_slow_cloud: Option<bool>,
    /// Learn the user's voice from meetings where only they spoke into the
    /// microphone, so their lines carry their name in rooms with others.
    pub learn_voice: bool,
    /// While recording, read who the meeting app shows as speaking (local
    /// only) and name the voices to match. Off by default: no call app is
    /// known to say who is talking in a way Cap can read yet.
    pub name_speakers_from_apps: bool,
}

pub const DEFAULT_LOCAL_MODEL: &str = "default";

impl TranscriptionSettings {
    /// The dictionary, built from the old word list the first time, with
    /// built-ins added once, cleaned, and mirrored into `vocabulary`.
    fn normalize_dictionary(&mut self) {
        let mut entries = self.dictionary.take().unwrap_or_else(|| {
            self.vocabulary
                .iter()
                .map(|term| Entry::new(term.clone()))
                .collect()
        });
        for builtin in dictionary::builtins() {
            if self.builtins_added.contains(&builtin.spelling) {
                continue;
            }
            self.builtins_added.push(builtin.spelling.clone());
            match entries
                .iter_mut()
                .find(|e| e.spelling.eq_ignore_ascii_case(&builtin.spelling))
            {
                Some(existing) => existing.sounds_like.extend(builtin.sounds_like),
                None => entries.insert(0, builtin),
            }
        }
        let entries = dictionary::normalize(entries);
        self.vocabulary = dictionary::spellings(&entries)
            .into_iter()
            .take(MAX_VOCABULARY)
            .collect();
        self.dictionary = Some(entries);
    }

    /// Whether the transcript shows live with `engine` on this computer
    /// (`slow`: too slow for live local captions). As chosen everywhere,
    /// except Cap Cloud on a slow computer: off there unless turned on, the
    /// cloud's lines arriving a few seconds after speech instead.
    pub fn live_for(&self, engine: Engine, slow: bool) -> bool {
        if slow && engine == Engine::Cloud {
            self.live_on_slow_cloud.unwrap_or(false)
        } else {
            self.live
        }
    }

    /// The switch for `live_for`, keeping the slow computer's Cap Cloud
    /// choice apart from everyone else's.
    pub fn set_live_for(&mut self, engine: Engine, slow: bool, on: bool) {
        if slow && engine == Engine::Cloud {
            self.live_on_slow_cloud = Some(on);
        } else {
            self.live = on;
        }
    }

    pub fn entries(&self) -> &[Entry] {
        self.dictionary.as_deref().unwrap_or(&[])
    }

    /// The entries someone added: Cap's built-in spellings and their
    /// sounds-like forms come out, so a dictionary nobody touched is empty.
    /// A form someone taught a built-in spelling stays.
    pub fn user_entries(&self) -> Vec<Entry> {
        let builtins = dictionary::builtins();
        self.entries()
            .iter()
            .filter_map(|entry| {
                let Some(builtin) = builtins
                    .iter()
                    .find(|b| b.spelling.eq_ignore_ascii_case(&entry.spelling))
                else {
                    return Some(entry.clone());
                };
                let taught: Vec<String> = entry
                    .sounds_like
                    .iter()
                    .filter(|form| {
                        !builtin
                            .sounds_like
                            .iter()
                            .any(|b| b.eq_ignore_ascii_case(form))
                    })
                    .cloned()
                    .collect();
                (!taught.is_empty()).then(|| Entry {
                    spelling: entry.spelling.clone(),
                    sounds_like: taught,
                })
            })
            .collect()
    }

    /// Words a user saved for Cap's captions before there was one
    /// dictionary join it once. The examples Cap shipped are not words
    /// anyone chose, so they stay out.
    pub fn adopt_hints(&mut self, hints: &[String]) {
        const EXAMPLES: [&str; 2] = ["My Brand Name", "mywebsite.com"];
        let entries = self.dictionary.get_or_insert_with(Vec::new);
        for hint in hints {
            if !EXAMPLES.contains(&hint.trim()) {
                entries.push(Entry::new(hint.clone()));
            }
        }
        self.normalize_dictionary();
    }
}

impl Default for TranscriptionSettings {
    fn default() -> Self {
        Self {
            engine: Engine::Local,
            local_model: DEFAULT_LOCAL_MODEL.to_string(),
            language: Language::Auto,
            vocabulary: dictionary::spellings(&dictionary::builtins()),
            dictionary: Some(dictionary::builtins()),
            builtins_added: dictionary::builtins()
                .into_iter()
                .map(|e| e.spelling)
                .collect(),
            live: true,
            live_on_slow_cloud: None,
            learn_voice: true,
            name_speakers_from_apps: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotesSettings {
    pub auto_generate: bool,
    pub default_template_id: String,
    pub summary_language: Option<String>,
    /// What the Start button does in one click: the last choice made from it.
    #[serde(deserialize_with = "lenient_start")]
    pub start: StartChoice,
}

impl Default for NotesSettings {
    fn default() -> Self {
        Self {
            auto_generate: true,
            default_template_id: crate::templates::DEFAULT_TEMPLATE_ID.to_string(),
            summary_language: None,
            start: StartChoice::default(),
        }
    }
}

/// A value this build does not know (written by a newer one) reads as the
/// default instead of failing the whole settings file.
fn lenient_start<'de, D: serde::Deserializer<'de>>(d: D) -> Result<StartChoice, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// The two ways to start a note.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartChoice {
    /// Record the meeting, transcribe it and let Cap AI write the summary.
    #[default]
    Record,
    /// A blank note, nothing recorded.
    Blank,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CalendarSettings {
    pub show_next_in_menu_bar: bool,
    pub hide_declined: bool,
    pub hide_all_day: bool,
    pub hide_without_participants: bool,
    pub hidden_calendar_ids: Vec<String>,
}

impl Default for CalendarSettings {
    fn default() -> Self {
        Self {
            show_next_in_menu_bar: true,
            hide_declined: true,
            hide_all_day: true,
            hide_without_participants: false,
            hidden_calendar_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MeetingSettings {
    pub enabled: bool,
    pub setup_completed: bool,
    #[serde(deserialize_with = "lenient")]
    pub notifications: NotificationSettings,
    #[serde(deserialize_with = "lenient")]
    pub automation: AutomationSettings,
    #[serde(deserialize_with = "lenient")]
    pub recording: RecordingSettings,
    #[serde(deserialize_with = "lenient")]
    pub transcription: TranscriptionSettings,
    #[serde(deserialize_with = "lenient")]
    pub notes: NotesSettings,
    #[serde(deserialize_with = "lenient")]
    pub calendar: CalendarSettings,
}

impl MeetingSettings {
    pub fn from_json(json: &str) -> Self {
        let mut settings: Self = serde_json::from_str(json).unwrap_or_default();
        settings.validate();
        settings
    }

    pub fn validate(&mut self) {
        let n = &mut self.notifications;
        n.lead_secs = n.lead_secs.min(MAX_LEAD_SECS);
        dedupe(&mut n.muted_app_ids);

        let a = &mut self.automation;
        a.countdown_secs = a.countdown_secs.clamp(1, 30);

        let r = &mut self.recording;
        r.inactivity_minutes = r.inactivity_minutes.map(|m| m.clamp(1, 240));
        r.audio_retention_days = r.audio_retention_days.map(|d| d.clamp(1, 3650));
        if let Microphone::Named(name) = &r.microphone
            && name.trim().is_empty()
        {
            r.microphone = Microphone::Auto;
        }

        let t = &mut self.transcription;
        if t.local_model.trim().is_empty() {
            t.local_model = DEFAULT_LOCAL_MODEL.to_string();
        }
        if let Language::Code(code) = &t.language {
            let code = code.trim();
            t.language = if code.is_empty() || code.eq_ignore_ascii_case("auto") {
                Language::Auto
            } else {
                Language::Code(code.to_string())
            };
        }
        t.normalize_dictionary();

        let notes = &mut self.notes;
        if notes.default_template_id.trim().is_empty() {
            notes.default_template_id = crate::templates::DEFAULT_TEMPLATE_ID.to_string();
        }
        notes.summary_language = notes
            .summary_language
            .take()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty());

        dedupe(&mut self.calendar.hidden_calendar_ids);
    }

    pub fn detect_config(&self) -> DetectConfig {
        DetectConfig {
            browser_policy: self.automation.browser_policy,
            ..DetectConfig::default()
        }
    }

    pub fn prompt_config(&self) -> PromptConfig {
        PromptConfig {
            detected_enabled: self.enabled && self.notifications.detected,
            scheduled_enabled: self.enabled && self.notifications.scheduled,
            muted_app_ids: self.notifications.muted_app_ids.clone(),
            auto_record: if self.enabled {
                self.automation.auto_record
            } else {
                AutoRecord::Off
            },
            auto_record_countdown_ms: u64::from(self.automation.countdown_secs.clamp(1, 30)) * 1000,
            lead_ms: u64::from(self.notifications.lead_secs.min(MAX_LEAD_SECS)) * 1000,
            ..PromptConfig::default()
        }
    }

    pub fn session_config(&self) -> SessionConfig {
        SessionConfig {
            stop_when_call_ends: self.recording.stop_when_call_ends,
            inactivity_warn_ms: self
                .recording
                .inactivity_minutes
                .map(|m| u64::from(m.max(1)) * 60_000),
            auto_generate_notes: self.notes.auto_generate,
            ..SessionConfig::default()
        }
    }
}

fn dedupe(ids: &mut Vec<String>) {
    let mut seen: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids.drain(..) {
        let id = id.trim().to_string();
        if !id.is_empty() && !seen.contains(&id) {
            seen.push(id);
        }
    }
    *ids = seen;
}
