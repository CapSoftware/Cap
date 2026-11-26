//! Who said what: separates the voices inside each meeting track.
//!
//! The app feeds every speech segment of a track (16 kHz mono) as it closes.
//! Each segment comes back with one or more spans, each carrying a speaker id
//! that never changes meaning while the meeting runs. When the meeting ends,
//! [`MeetingDiarizer::finish`] revisits every segment with full context and
//! reports the corrected labels plus which live ids were folded into which, so
//! stored utterances can be relabelled without losing renames.

mod cluster;
mod diarizer;
pub mod hybrid;
pub mod nemotron;
pub mod embed;
pub mod fbank;
mod names;
mod profile;

use serde::{Deserialize, Serialize};

pub use diarizer::{Config, LateNemotron, MeetingDiarizer, Segment, Stats};
pub use embed::{Embed, ModelInfo};
#[cfg(feature = "onnx")]
pub use embed::OnnxEmbedder;
pub use names::{Label, NameChange, SpeakerNames};
pub use profile::VoiceProfile;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Track {
    Mic,
    System,
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SpeakerId(pub u32);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: SpeakerId,
    /// The voice belongs to the other track's speaker and reached this track
    /// through the room or the speakers: a duplicate, not a new person.
    pub echo: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentLabels {
    pub track: Track,
    pub key: u64,
    pub spans: Vec<Span>,
}

impl SegmentLabels {
    /// The speaker holding most of the segment, ignoring echoes when anyone
    /// else is in it.
    pub fn main_speaker(&self) -> Option<SpeakerId> {
        let mut totals: Vec<(SpeakerId, bool, u64)> = Vec::new();
        for span in &self.spans {
            let len = span.end_ms.saturating_sub(span.start_ms);
            match totals
                .iter_mut()
                .find(|(id, echo, _)| *id == span.speaker && *echo == span.echo)
            {
                Some(entry) => entry.2 += len,
                None => totals.push((span.speaker, span.echo, len)),
            }
        }
        let direct = totals.iter().filter(|t| !t.1).max_by_key(|t| t.2);
        direct
            .or_else(|| totals.iter().max_by_key(|t| t.2))
            .map(|t| t.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerInfo {
    pub id: SpeakerId,
    pub track: Track,
    pub first_ms: u64,
    pub speech_ms: u64,
    pub is_user: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalPass {
    /// Every segment the diarizer saw, with its final spans.
    pub segments: Vec<SegmentLabels>,
    /// Live ids that no longer exist, each with the id that absorbed it.
    pub merged: Vec<(SpeakerId, SpeakerId)>,
    pub speakers: Vec<SpeakerInfo>,
    pub user: Option<SpeakerId>,
    /// A refreshed voice profile when the microphone held a single voice for
    /// long enough to learn from.
    pub enrolment: Option<VoiceProfile>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("speaker model runtime: {0}")]
    Runtime(String),
    #[error("speaker model: {0}")]
    Model(String),
    #[error("audio is too short to embed")]
    TooShort,
    #[error("voice profile: {0}")]
    Profile(String),
}

impl Error {
    #[cfg(feature = "onnx")]
    pub(crate) fn runtime(error: impl std::fmt::Display) -> Self {
        Self::Runtime(error.to_string())
    }
}
