use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

use cap_diarize::{Label, SpeakerId};
use serde::{Deserialize, Serialize};

pub use cap_diarize::SpeakerNames;

use crate::serde_util::{lenient, lenient_option};
use crate::text::{char_count, find_ci, fold_query, normalised_words, snippet};

#[cfg(test)]
mod tests;

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    #[default]
    Mic,
    System,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Utterance {
    pub id: String,
    #[serde(deserialize_with = "lenient")]
    pub source: Source,
    pub speaker: Option<String>,
    /// The voice that said it, when the meeting's voices were told apart.
    #[serde(
        deserialize_with = "lenient_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub speaker_id: Option<u32>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub is_final: bool,
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Header {
    pub title: String,
    pub date: Option<String>,
    pub participants: Vec<String>,
    pub self_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    pub source: Source,
    pub speaker: Option<String>,
    pub speaker_id: Option<u32>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub utterance_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinuteGroup {
    pub minute: u64,
    pub turns: Vec<Turn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptTranscript {
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub utterance_id: String,
    pub source: Source,
    pub start_ms: u64,
    pub byte_range: (usize, usize),
    pub snippet: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranscriptStats {
    pub utterances: usize,
    pub total_chars: usize,
    pub mic_speech_ms: u64,
    pub system_speech_ms: u64,
    pub last_speech_end_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EchoConfig {
    pub slack_ms: u64,
    pub min_containment: f64,
    pub max_mic_ratio: f64,
    pub max_words: usize,
    /// Also judge 1-3 word microphone lines. Only once this meeting's
    /// microphone is known to hear the call (`EchoReport::heard`): on a
    /// headset nothing comes back from the call, and someone answering
    /// "Yes." just as the other side says "Yes" is them.
    pub short_echoes: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EchoReport {
    pub removed: Vec<String>,
    /// A sentence of the call was removed: the speakers are playing into
    /// the microphone.
    pub heard: bool,
    /// Where each removed sentence of the call began on the microphone.
    pub heard_at_ms: Vec<u64>,
}

impl Default for EchoConfig {
    fn default() -> Self {
        Self {
            slack_ms: 1_500,
            min_containment: 0.7,
            max_mic_ratio: 1.3,
            max_words: 600,
            short_echoes: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum LogLine {
    Upsert {
        #[serde(default)]
        utterance: Utterance,
    },
    Delete {
        #[serde(default)]
        ids: Vec<String>,
    },
    RenameSpeaker {
        #[serde(default)]
        from: String,
        #[serde(default)]
        to: String,
    },
    SourceLabel {
        #[serde(default, deserialize_with = "lenient")]
        source: Source,
        #[serde(default)]
        label: Option<String>,
    },
    /// The end-of-meeting pass moved these utterances to another voice.
    Speakers {
        #[serde(default)]
        assign: Vec<(String, u32)>,
    },
    /// The meeting's names for its voices, replacing any earlier line.
    SpeakerNames {
        #[serde(default)]
        names: SpeakerNames,
    },
    /// Saved audio whose words have not landed yet; repair reads it back.
    Gap {
        #[serde(default)]
        gap: Gap,
    },
    /// Gaps whose audio was transcribed again (or held no speech).
    GapClosed {
        #[serde(default)]
        ids: Vec<String>,
    },
    /// A voice with no told-apart id left out of the notes (`out`), or put
    /// back in. `forget` takes the choice away instead (an undo back to no
    /// choice); `out` is then false, so versions before it put the voice
    /// back in, as they did. Told-apart voices keep this choice in
    /// `SpeakerNames`.
    LeaveOut {
        voice: Voice,
        #[serde(default)]
        out: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        forget: bool,
    },
}

/// A voice the transcript knows only by its track or a name on its lines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Voice {
    Source(Source),
    Named(String),
}

/// A stretch of one track's saved audio whose words did not land: a
/// segment dropped under load, a clip the cloud did not answer, the tail a
/// crash cut off. The audio is on disk, so it can be transcribed again.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Gap {
    pub id: String,
    #[serde(deserialize_with = "lenient")]
    pub source: Source,
    /// The meeting timeline, in 16 kHz samples.
    pub start_sample: u64,
    pub end_sample: u64,
    /// The exact speech segments (start, length) when they are known, so
    /// repaired lines keep their ids and replace any shown in their place.
    /// Empty: find the speech in the span again.
    pub segments: Vec<(u64, u64)>,
    pub reason: String,
}

impl Gap {
    pub fn id_for(source: Source, start_sample: u64) -> String {
        let tag = match source {
            Source::Mic => 'm',
            Source::System => 's',
        };
        format!("g{tag}{start_sample}")
    }
}

/// Who a line of the transcript belongs to, before the app words it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SpeakerLabel {
    /// A name: typed by the user or taken from the calendar.
    Named(String),
    /// The person using this computer.
    User,
    /// Someone else, numbered in order of first speech.
    Person(u32),
    /// Everyone on the computer's audio, when their voices were not told apart.
    Others,
}

impl SpeakerLabel {
    /// The label in English, as written into exports and prompts.
    pub fn english(&self, user_name: Option<&str>) -> String {
        match self {
            SpeakerLabel::Named(name) => name.clone(),
            SpeakerLabel::User => user_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("You")
                .to_string(),
            SpeakerLabel::Person(n) => format!("Person {n}"),
            SpeakerLabel::Others => "Others".to_string(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadReport {
    pub lines: usize,
    pub skipped: usize,
}

pub const TURN_GAP_MS: u64 = 2_000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Transcript {
    utterances: Vec<Utterance>,
    mic_label: Option<String>,
    system_label: Option<String>,
    names: Option<SpeakerNames>,
    gaps: Vec<Gap>,
    /// The person's choices on voices without a told-apart id: left out of
    /// the notes (true) or put back in (false). No entry: no choice.
    left_out: Vec<(Voice, bool)>,
}

impl LogLine {
    /// The line that records `choice` on a voice without a told-apart id:
    /// left out, put back in, or (`None`) no choice.
    pub fn leave_out(voice: Voice, choice: Option<bool>) -> Self {
        LogLine::LeaveOut {
            voice,
            out: choice == Some(true),
            forget: choice.is_none(),
        }
    }
}

fn order_key(u: &Utterance) -> (u64, Source, &str) {
    (u.start_ms, u.source, u.id.as_str())
}

impl Transcript {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn utterances(&self) -> &[Utterance] {
        &self.utterances
    }

    pub fn len(&self) -> usize {
        self.utterances.len()
    }

    pub fn is_empty(&self) -> bool {
        self.utterances.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&Utterance> {
        self.utterances.iter().find(|u| u.id == id)
    }

    pub fn utterance_at(&self, ms: u64) -> Option<&Utterance> {
        let upto = self.utterances.partition_point(|u| u.start_ms <= ms);
        let preceding = &self.utterances[..upto];
        preceding
            .iter()
            .rev()
            .find(|u| u.end_ms >= ms)
            .or_else(|| preceding.last())
    }

    pub fn range(&self, start_ms: u64, end_ms: u64) -> impl Iterator<Item = &Utterance> {
        self.utterances
            .iter()
            .filter(move |u| u.start_ms < end_ms && u.end_ms >= start_ms)
    }

    pub fn upsert(&mut self, mut utterance: Utterance) -> bool {
        if utterance.id.is_empty() {
            return false;
        }
        utterance.end_ms = utterance.end_ms.max(utterance.start_ms);
        if let Some(pos) = self.utterances.iter().position(|u| u.id == utterance.id) {
            let existing = &self.utterances[pos];
            if (existing.is_final && !utterance.is_final) || *existing == utterance {
                return false;
            }
            self.utterances.remove(pos);
        }
        let at = self
            .utterances
            .partition_point(|u| order_key(u) < order_key(&utterance));
        self.utterances.insert(at, utterance);
        true
    }

    pub fn retract_partials(&mut self, source: Source) -> usize {
        let before = self.utterances.len();
        self.utterances.retain(|u| u.is_final || u.source != source);
        before - self.utterances.len()
    }

    pub fn remove<S: AsRef<str>>(&mut self, ids: &[S]) -> usize {
        let before = self.utterances.len();
        self.utterances
            .retain(|u| !ids.iter().any(|id| id.as_ref() == u.id));
        before - self.utterances.len()
    }

    pub fn rename_speaker(&mut self, from: &str, to: &str) -> usize {
        let to = to.trim();
        // The name's choice goes with it; onto a name with a choice of its
        // own, left out wins, as when voices merge.
        if let Some(choice) = self.voice_choice(&Voice::Named(from.to_string())) {
            self.choose_voice(Voice::Named(from.to_string()), None);
            if !to.is_empty() {
                let target = Voice::Named(to.to_string());
                let merged = choice || self.voice_choice(&target).unwrap_or(false);
                self.choose_voice(target, Some(merged));
            }
        }
        let mut changed = 0;
        for u in &mut self.utterances {
            if u.speaker.as_deref() == Some(from) {
                u.speaker = (!to.is_empty()).then(|| to.to_string());
                changed += 1;
            }
        }
        changed
    }

    pub fn set_speaker_label_for_source(&mut self, source: Source, label: Option<String>) {
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty());
        match source {
            Source::Mic => self.mic_label = label,
            Source::System => self.system_label = label,
        }
    }

    pub fn speaker_label_for_source(&self, source: Source) -> Option<&str> {
        match source {
            Source::Mic => self.mic_label.as_deref(),
            Source::System => self.system_label.as_deref(),
        }
    }

    pub fn names(&self) -> Option<&SpeakerNames> {
        self.names.as_ref()
    }

    /// Records the person's choice on a voice without a told-apart id: left
    /// out (`Some(true)`), put back in (`Some(false)`), or none.
    pub fn choose_voice(&mut self, voice: Voice, choice: Option<bool>) {
        match (self.left_out.iter_mut().find(|(v, _)| *v == voice), choice) {
            (Some(entry), Some(out)) => entry.1 = out,
            (None, Some(out)) => self.left_out.push((voice, out)),
            (_, None) => self.left_out.retain(|(v, _)| *v != voice),
        }
    }

    /// The person's choice on a voice without a told-apart id, if any.
    pub fn voice_choice(&self, voice: &Voice) -> Option<bool> {
        self.left_out
            .iter()
            .find(|(v, _)| v == voice)
            .map(|(_, out)| *out)
    }

    /// Whether lines by this speaker are left out of the notes. The most
    /// specific choice decides: the line's own name, then its told-apart
    /// voice, then its track. So a line moved to a name keeps its voice's
    /// choice until the name has one, and a voice put back in stays in when
    /// its track is left out.
    pub fn is_left_out(
        &self,
        source: Source,
        speaker: Option<&str>,
        speaker_id: Option<u32>,
    ) -> bool {
        let named = speaker
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|name| {
                self.left_out.iter().find_map(|(v, out)| match v {
                    Voice::Named(n) if n == name => Some(*out),
                    _ => None,
                })
            });
        named
            .or_else(|| {
                let names = self.names.as_ref()?;
                names.left_out(SpeakerId(speaker_id?))
            })
            .or_else(|| self.voice_choice(&Voice::Source(source)))
            .unwrap_or(false)
    }

    /// Which lines are left out of the notes, as a short stamp: empty when
    /// none are. A summary or Ask answer made under another stamp may hold
    /// words the person has since left out.
    pub fn left_out_basis(&self) -> String {
        let mut ids: Vec<&str> = self
            .utterances
            .iter()
            .filter(|u| !u.text.trim().is_empty())
            .filter(|u| self.is_left_out(u.source, u.speaker.as_deref(), u.speaker_id))
            .map(|u| u.id.as_str())
            .collect();
        if ids.is_empty() {
            return String::new();
        }
        ids.sort_unstable();
        // FNV-1a: stable across builds, unlike the standard hasher.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for id in ids {
            for byte in id.bytes().chain([0]) {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        }
        format!("{hash:016x}")
    }

    pub fn turn_left_out(&self, turn: &Turn) -> bool {
        self.is_left_out(turn.source, turn.speaker.as_deref(), turn.speaker_id)
    }

    pub fn set_names(&mut self, names: SpeakerNames) {
        self.names = Some(names);
    }

    /// Moves utterances to the voices the end-of-meeting pass chose.
    pub fn assign_speakers(&mut self, assign: &[(String, u32)]) -> usize {
        let mut changed = 0;
        for (id, speaker) in assign {
            if let Some(u) = self.utterances.iter_mut().find(|u| &u.id == id)
                && u.speaker_id != Some(*speaker)
            {
                u.speaker_id = Some(*speaker);
                changed += 1;
            }
        }
        changed
    }

    /// Voices with at least one line of words, in order of their first line.
    pub fn speaking_ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = Vec::new();
        for u in &self.utterances {
            if let Some(id) = u.speaker_id
                && !u.text.trim().is_empty()
                && !ids.contains(&id)
            {
                ids.push(id);
            }
        }
        ids
    }

    /// The largest voice id in the transcript, so a resumed meeting numbers
    /// its new voices after the ones already there.
    pub fn max_speaker_id(&self) -> u32 {
        let in_names = self
            .names
            .as_ref()
            .and_then(|n| n.user())
            .map_or(0, |id| id.0);
        self.utterances
            .iter()
            .filter_map(|u| u.speaker_id)
            .max()
            .unwrap_or(0)
            .max(in_names)
    }

    /// Resolves who said a line: a name typed for that exact text first, then
    /// the voice's name or number, then a name typed for the whole track,
    /// then the user for the microphone and everyone else for the computer.
    pub fn speaker(
        &self,
        source: Source,
        speaker: Option<&str>,
        speaker_id: Option<u32>,
    ) -> SpeakerLabel {
        if let Some(speaker) = speaker.map(str::trim).filter(|s| !s.is_empty()) {
            return SpeakerLabel::Named(speaker.to_string());
        }
        if let (Some(id), Some(names)) = (speaker_id, self.names.as_ref())
            && let Some(label) = names.label(SpeakerId(id))
        {
            return match label {
                Label::User => match self.speaker_label_for_source(Source::Mic) {
                    Some(name) => SpeakerLabel::Named(name.to_string()),
                    None => SpeakerLabel::User,
                },
                Label::Named(name) => SpeakerLabel::Named(name),
                Label::Person(n) => SpeakerLabel::Person(n),
            };
        }
        if let Some(label) = self.speaker_label_for_source(source) {
            return SpeakerLabel::Named(label.to_string());
        }
        match source {
            Source::Mic => SpeakerLabel::User,
            Source::System => SpeakerLabel::Others,
        }
    }

    /// The label the user's own lines carry, as a prompt writes them: their
    /// voice's rename, else the microphone track's name, else `self_name`.
    /// None when those lines just say "You".
    pub fn user_label(&self, self_name: Option<&str>) -> Option<String> {
        let voice = self.names.as_ref().and_then(|n| n.user()).map(|id| id.0);
        match self.speaker(Source::Mic, None, voice) {
            SpeakerLabel::Named(name) => Some(name),
            SpeakerLabel::User => self_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            SpeakerLabel::Person(_) | SpeakerLabel::Others => None,
        }
    }

    pub fn turn_speaker(&self, turn: &Turn) -> SpeakerLabel {
        self.speaker(turn.source, turn.speaker.as_deref(), turn.speaker_id)
    }

    pub fn label(
        &self,
        source: Source,
        speaker: Option<&str>,
        speaker_id: Option<u32>,
        self_name: Option<&str>,
    ) -> String {
        self.speaker(source, speaker, speaker_id).english(self_name)
    }

    /// Everyone heard in the meeting by name, the user first, for the
    /// participant list of a prompt. Numbered voices are left out.
    pub fn named_speakers(&self, self_name: Option<&str>) -> Vec<(String, bool)> {
        let mut out: Vec<(String, bool)> = Vec::new();
        let mine = self.user_label(self_name);
        for turn in self.turns() {
            if self.turn_left_out(&turn) {
                continue;
            }
            let label = self.turn_speaker(&turn);
            let entry = match &label {
                SpeakerLabel::User => self_name
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|name| (name.to_string(), true)),
                SpeakerLabel::Named(name) => {
                    Some((name.clone(), mine.as_deref() == Some(name.as_str())))
                }
                SpeakerLabel::Person(_) | SpeakerLabel::Others => None,
            };
            if let Some(entry) = entry
                && !out.iter().any(|(name, _)| name.eq_ignore_ascii_case(&entry.0))
            {
                out.push(entry);
            }
        }
        out.sort_by_key(|(_, user)| !user);
        out
    }

    pub fn apply(&mut self, line: LogLine) {
        match line {
            LogLine::Upsert { utterance } => {
                self.upsert(utterance);
            }
            LogLine::Delete { ids } => {
                self.remove(&ids);
            }
            LogLine::RenameSpeaker { from, to } => {
                self.rename_speaker(&from, &to);
            }
            LogLine::SourceLabel { source, label } => {
                self.set_speaker_label_for_source(source, label);
            }
            LogLine::Speakers { assign } => {
                self.assign_speakers(&assign);
            }
            LogLine::SpeakerNames { names } => self.set_names(names),
            LogLine::Gap { gap } => self.open_gap(gap),
            LogLine::GapClosed { ids } => {
                self.close_gaps(&ids);
            }
            LogLine::LeaveOut { voice, out, forget } => {
                self.choose_voice(voice, (!forget).then_some(out))
            }
        }
    }

    /// Stretches of saved audio still waiting for their words.
    pub fn gaps(&self) -> &[Gap] {
        &self.gaps
    }

    pub fn open_gap(&mut self, gap: Gap) {
        if gap.id.is_empty() || gap.end_sample <= gap.start_sample {
            return;
        }
        match self.gaps.iter_mut().find(|g| g.id == gap.id) {
            Some(existing) => *existing = gap,
            None => self.gaps.push(gap),
        }
    }

    pub fn close_gaps<S: AsRef<str>>(&mut self, ids: &[S]) -> usize {
        let before = self.gaps.len();
        self.gaps.retain(|g| !ids.iter().any(|id| id.as_ref() == g.id));
        before - self.gaps.len()
    }

    pub fn turns(&self) -> Vec<Turn> {
        let mut turns: Vec<Turn> = Vec::new();
        for u in &self.utterances {
            let text = u.text.trim();
            if text.is_empty() {
                continue;
            }
            if let Some(last) = turns.last_mut()
                && last.source == u.source
                && last.speaker == u.speaker
                && last.speaker_id == u.speaker_id
                && u.start_ms.saturating_sub(last.end_ms) < TURN_GAP_MS
            {
                last.text.push(' ');
                last.text.push_str(text);
                last.end_ms = last.end_ms.max(u.end_ms);
                last.utterance_ids.push(u.id.clone());
                continue;
            }
            turns.push(Turn {
                source: u.source,
                speaker: u.speaker.clone(),
                speaker_id: u.speaker_id,
                start_ms: u.start_ms,
                end_ms: u.end_ms,
                text: text.to_string(),
                utterance_ids: vec![u.id.clone()],
            });
        }
        turns
    }

    pub fn minute_groups(&self) -> Vec<MinuteGroup> {
        let mut groups: Vec<MinuteGroup> = Vec::new();
        for turn in self.turns() {
            let minute = turn.start_ms / 60_000;
            match groups.last_mut() {
                Some(group) if group.minute == minute => group.turns.push(turn),
                _ => groups.push(MinuteGroup {
                    minute,
                    turns: vec![turn],
                }),
            }
        }
        groups
    }

    pub fn to_plain_text(&self, header: &Header) -> String {
        let mut out = String::new();
        let title = header.title.trim();
        if !title.is_empty() {
            out.push_str(title);
            out.push('\n');
        }
        if let Some(date) = header
            .date
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            out.push_str(date);
            out.push('\n');
        }
        let participants: Vec<&str> = header
            .participants
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();
        if !participants.is_empty() {
            out.push_str("Participants: ");
            out.push_str(&participants.join(", "));
            out.push('\n');
        }
        if !out.is_empty() {
            out.push('\n');
        }
        for turn in self.turns() {
            let label = self
                .turn_speaker(&turn)
                .english(header.self_name.as_deref());
            out.push_str(&format!(
                "[{}] {}: {}\n",
                format_timestamp(turn.start_ms),
                label,
                turn.text
            ));
        }
        out
    }

    pub fn labelled_for_prompt(
        &self,
        max_chars: usize,
        self_name: Option<&str>,
    ) -> PromptTranscript {
        let lines: Vec<String> = self
            .turns()
            .iter()
            .filter(|t| !self.turn_left_out(t))
            .map(|t| {
                format!("{}: {}", self.turn_speaker(t).english(self_name), t.text)
            })
            .collect();
        let mut kept: Vec<String> = Vec::new();
        let mut used = 0usize;
        let mut truncated = false;
        for line in lines.iter().rev() {
            let cost = char_count(line) + usize::from(!kept.is_empty());
            if used + cost <= max_chars {
                used += cost;
                kept.push(line.clone());
                continue;
            }
            truncated = true;
            let room = max_chars
                .saturating_sub(used)
                .saturating_sub(usize::from(!kept.is_empty()));
            if room > 1 {
                kept.push(tail_chars(line, room - 1));
            }
            break;
        }
        kept.reverse();
        PromptTranscript {
            text: kept.join("\n"),
            truncated,
        }
    }

    pub fn search(&self, query: &str) -> Vec<Hit> {
        let needle = fold_query(query);
        if needle.is_empty() {
            return Vec::new();
        }
        self.utterances
            .iter()
            .filter_map(|u| {
                find_ci(&u.text, &needle).map(|(start, end)| Hit {
                    utterance_id: u.id.clone(),
                    source: u.source,
                    start_ms: u.start_ms,
                    byte_range: (start, end),
                    snippet: snippet(&u.text, start, end, 40),
                })
            })
            .collect()
    }

    pub fn stats(&self) -> TranscriptStats {
        let mut stats = TranscriptStats {
            utterances: self.utterances.len(),
            ..TranscriptStats::default()
        };
        for u in &self.utterances {
            stats.total_chars = stats.total_chars.saturating_add(char_count(&u.text));
            let duration = u.end_ms.saturating_sub(u.start_ms);
            match u.source {
                Source::Mic => stats.mic_speech_ms = stats.mic_speech_ms.saturating_add(duration),
                Source::System => {
                    stats.system_speech_ms = stats.system_speech_ms.saturating_add(duration)
                }
            }
            if !u.text.trim().is_empty() {
                stats.last_speech_end_ms =
                    Some(stats.last_speech_end_ms.unwrap_or(0).max(u.end_ms));
            }
        }
        stats
    }

    pub fn suppress_echo(&mut self, config: &EchoConfig) -> Vec<String> {
        self.suppress_echo_report(config).removed
    }

    pub fn suppress_echo_report(&mut self, config: &EchoConfig) -> EchoReport {
        let everywhere = [(0, u64::MAX)];
        let spans: &[(u64, u64)] = if config.short_echoes {
            &everywhere
        } else {
            &[]
        };
        self.suppress_echo_in(config, spans)
    }

    /// As [`Self::suppress_echo_report`], with 1-3 word microphone lines
    /// judged only when they start inside one of `short_spans` (ms, end
    /// excluded): the stretches of the meeting where the microphone was
    /// known to hear the call. `config.short_echoes` is not read.
    pub fn suppress_echo_in(
        &mut self,
        config: &EchoConfig,
        short_spans: &[(u64, u64)],
    ) -> EchoReport {
        let mut heard_at_ms = Vec::new();
        let mut far: Vec<TimedWord> = self
            .utterances
            .iter()
            .filter(|u| u.source == Source::System)
            .flat_map(timed_words)
            .collect();
        far.sort_by_key(|w| w.start_ms);
        let mut echoes = Vec::new();
        for mic in self.utterances.iter().filter(|u| u.source == Source::Mic) {
            let words = timed_words(mic);
            if words.len() < ECHO_MIN_WORDS {
                let judged = short_spans
                    .iter()
                    .any(|&(from, until)| (from..until).contains(&mic.start_ms));
                if judged && short_echo(&words, &far) {
                    echoes.push(mic.id.clone());
                }
                continue;
            }
            if words.len() > config.max_words {
                continue;
            }
            let from = mic.start_ms.saturating_sub(config.slack_ms);
            let to = mic.end_ms.saturating_add(ECHO_EARLY_SLACK_MS);
            let first = far.partition_point(|w| w.start_ms < from);
            let overlapping: Vec<&TimedWord> = far[first..]
                .iter()
                .take_while(|w| w.start_ms <= to)
                .take(config.max_words.saturating_mul(2))
                .collect();
            if overlapping.is_empty()
                || words.len() as f64 > overlapping.len() as f64 * config.max_mic_ratio
            {
                continue;
            }
            let Some((common, (mic_first, far_first), far_last)) = align(&words, &overlapping)
            else {
                continue;
            };
            let start = words[mic_first].start_ms;
            let lags = start.saturating_add(ECHO_EARLY_SLACK_MS) >= overlapping[far_first].start_ms;
            // An echo starts while the call is still saying the sentence.
            // Someone reading it back ("four one five two nine") waits for
            // the end.
            let during = start < overlapping[far_last].start_ms;
            if lags && during && common as f64 >= config.min_containment * words.len() as f64 {
                heard_at_ms.push(mic.start_ms);
                echoes.push(mic.id.clone());
            }
        }
        self.remove(&echoes);
        EchoReport {
            removed: echoes,
            heard: !heard_at_ms.is_empty(),
            heard_at_ms,
        }
    }

    pub fn load_jsonl(path: &Path) -> io::Result<(Transcript, LoadReport)> {
        let mut transcript = Transcript::new();
        let mut report = LoadReport::default();
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((transcript, report)),
            Err(e) => return Err(e),
        };
        for chunk in BufReader::new(file).split(b'\n') {
            let chunk = chunk?;
            let line = String::from_utf8_lossy(&chunk);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            report.lines += 1;
            match parse_line(line) {
                Some(entry) => transcript.apply(entry),
                None => report.skipped += 1,
            }
        }
        Ok((transcript, report))
    }

    pub fn to_log_lines(&self) -> Vec<LogLine> {
        let mut lines: Vec<LogLine> = [Source::Mic, Source::System]
            .into_iter()
            .filter_map(|source| {
                self.speaker_label_for_source(source)
                    .map(|label| LogLine::SourceLabel {
                        source,
                        label: Some(label.to_string()),
                    })
            })
            .collect();
        if let Some(names) = &self.names {
            lines.push(LogLine::SpeakerNames {
                names: names.clone(),
            });
        }
        lines.extend(
            self.utterances
                .iter()
                .filter(|u| u.is_final)
                .map(|u| LogLine::Upsert {
                    utterance: u.clone(),
                }),
        );
        lines.extend(self.gaps.iter().map(|gap| LogLine::Gap { gap: gap.clone() }));
        lines.extend(
            self.left_out
                .iter()
                .map(|(voice, out)| LogLine::leave_out(voice.clone(), Some(*out))),
        );
        lines
    }
}

fn parse_line(line: &str) -> Option<LogLine> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    if object.contains_key("op") {
        return serde_json::from_value(value).ok();
    }
    let has_id = object
        .get("id")
        .and_then(|v| v.as_str())
        .is_some_and(|id| !id.is_empty());
    if !has_id {
        return None;
    }
    serde_json::from_value::<Utterance>(value)
        .ok()
        .map(|utterance| LogLine::Upsert { utterance })
}

pub fn append_jsonl(path: &Path, lines: &[LogLine]) -> io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)?;
    let mut buf = String::new();
    if file.metadata()?.len() > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            buf.push('\n');
        }
    }
    for line in lines {
        buf.push_str(&serde_json::to_string(line)?);
        buf.push('\n');
    }
    file.write_all(buf.as_bytes())?;
    file.flush()?;
    file.sync_data()
}

pub fn format_timestamp(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

fn tail_chars(line: &str, keep: usize) -> String {
    let total = char_count(line);
    let skip = total.saturating_sub(keep);
    let tail: String = line.chars().skip(skip).collect();
    let tail = match tail.find(char::is_whitespace) {
        Some(i) if skip > 0 && i < tail.len() / 2 => tail[i..].trim_start().to_string(),
        _ => tail,
    };
    format!("\u{2026}{tail}")
}

const ECHO_MIN_WORDS: usize = 4;
const ECHO_EARLY_SLACK_MS: u64 = 250;
/// How late a short echo may be heard after the call said it: laptop
/// speakers measured within 60 ms, and a Bluetooth speaker adds a couple of
/// hundred.
const SHORT_ECHO_LAG_MS: u64 = 300;

struct TimedWord {
    text: String,
    start_ms: u64,
    /// The time is the word's own, not spread over its line.
    exact: bool,
}

/// A line too short to compare as a sentence ("Merci.", "Soft heart,") is
/// the call coming out of the speakers when every word of it, in order, is
/// a word the call said at that same moment. Word times on both sides are
/// required: spread over a line they are too rough to tell an echo from
/// someone answering "Yes" while the other person talks.
fn short_echo(mic: &[TimedWord], far: &[TimedWord]) -> bool {
    if mic.is_empty() || mic.iter().any(|w| !w.exact) {
        return false;
    }
    let mut next = 0;
    for word in mic {
        let from = word.start_ms.saturating_sub(SHORT_ECHO_LAG_MS);
        let to = word.start_ms.saturating_add(ECHO_EARLY_SLACK_MS);
        let first = next.max(far.partition_point(|w| w.start_ms < from));
        let Some(found) = far[first..]
            .iter()
            .take_while(|w| w.start_ms <= to)
            .position(|w| w.exact && w.text == word.text)
        else {
            return false;
        };
        next = first + found + 1;
    }
    true
}

fn timed_words(u: &Utterance) -> Vec<TimedWord> {
    let timed: Vec<TimedWord> = u
        .words
        .iter()
        .flat_map(|w| {
            normalised_words(&w.text)
                .into_iter()
                .map(move |text| TimedWord {
                    text,
                    start_ms: w.start_ms,
                    exact: true,
                })
        })
        .collect();
    if !timed.is_empty() {
        return timed;
    }
    let words = normalised_words(&u.text);
    let count = words.len().max(1) as u64;
    let span = u.end_ms.saturating_sub(u.start_ms);
    words
        .into_iter()
        .enumerate()
        .map(|(i, text)| TimedWord {
            text,
            start_ms: u
                .start_ms
                .saturating_add(span / count * i as u64 + span % count * i as u64 / count),
            exact: false,
        })
        .collect()
}

/// The common words of `mic` and `far` in order: how many, where the first
/// pair is, and the index in `far` of the last one.
fn align(mic: &[TimedWord], far: &[&TimedWord]) -> Option<(usize, (usize, usize), usize)> {
    let width = far.len() + 1;
    let mut table = vec![0u16; (mic.len() + 1) * width];
    for i in (0..mic.len()).rev() {
        for j in (0..far.len()).rev() {
            table[i * width + j] = if mic[i].text == far[j].text {
                table[(i + 1) * width + j + 1].saturating_add(1)
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let common = usize::from(table[0]);
    let (mut i, mut j) = (0, 0);
    let mut first = None;
    let mut last = 0;
    while i < mic.len() && j < far.len() {
        if mic[i].text == far[j].text && table[i * width + j] == table[(i + 1) * width + j + 1] + 1
        {
            first.get_or_insert((i, j));
            last = j;
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    first.map(|first| (common, first, last))
}
