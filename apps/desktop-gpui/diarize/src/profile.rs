use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::cluster::{dot, normalize};

#[cfg(test)]
mod tests;

/// 2: profiles are only learnt from speech that holds together as one
/// voice. Version 1 could learn from several people heard as one, so those
/// are dropped and learnt again.
const VERSION: u32 = 2;
/// How much past speech keeps its weight when a new meeting refreshes the
/// profile, so the profile follows a changing microphone or room over time.
const MAX_HISTORY_MS: u64 = 10 * 60 * 1000;

/// The user's voice, learnt quietly from meetings where the microphone held
/// a single voice. A few kilobytes; deleting the file forgets it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfile {
    pub version: u32,
    pub model: String,
    pub embedding: Vec<f32>,
    pub speech_ms: u64,
    pub meetings: u32,
}

impl VoiceProfile {
    pub fn new(model: &str, embedding: &[f32], speech_ms: u64) -> Self {
        let mut embedding = embedding.to_vec();
        normalize(&mut embedding);
        Self {
            version: VERSION,
            model: model.to_string(),
            embedding,
            speech_ms,
            meetings: 1,
        }
    }

    pub fn load(path: &Path) -> Result<Self, Error> {
        let bytes = std::fs::read(path).map_err(|e| Error::Profile(e.to_string()))?;
        let profile: Self =
            serde_json::from_slice(&bytes).map_err(|e| Error::Profile(e.to_string()))?;
        if profile.version != VERSION || profile.embedding.is_empty() {
            return Err(Error::Profile("unsupported profile".into()));
        }
        Ok(profile)
    }

    /// The file was read but holds nothing this version can use: an older
    /// version's profile, an empty one or one that does not parse. Keeping it
    /// would only fail again at every meeting; dropping it lets the next
    /// meeting learn the voice afresh. False when the file cannot be read.
    pub fn unusable(path: &Path) -> bool {
        let Ok(bytes) = std::fs::read(path) else {
            return false;
        };
        serde_json::from_slice::<Self>(&bytes)
            .map_or(true, |p| p.version != VERSION || p.embedding.is_empty())
    }

    pub fn save(&self, path: &Path) -> Result<(), Error> {
        let bytes = serde_json::to_vec(self).map_err(|e| Error::Profile(e.to_string()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Profile(e.to_string()))?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes).map_err(|e| Error::Profile(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| Error::Profile(e.to_string()))
    }

    pub fn delete(path: &Path) -> Result<(), Error> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Profile(e.to_string())),
        }
    }

    pub fn usable_with(&self, model: &str, dim: usize) -> bool {
        self.model == model && self.embedding.len() == dim
    }

    pub fn similarity(&self, v: &[f32]) -> f32 {
        dot(&self.embedding, v)
    }

    /// Blends a new meeting's voice into the profile, weighting recent speech
    /// more as history grows.
    pub fn merged(&self, other: &VoiceProfile) -> VoiceProfile {
        if !other.usable_with(&self.model, self.embedding.len()) {
            return other.clone();
        }
        let old = self.speech_ms.min(MAX_HISTORY_MS) as f32;
        let new = other.speech_ms.min(MAX_HISTORY_MS) as f32;
        let mut embedding: Vec<f32> = self
            .embedding
            .iter()
            .zip(&other.embedding)
            .map(|(a, b)| a * old + b * new)
            .collect();
        normalize(&mut embedding);
        VoiceProfile {
            version: VERSION,
            model: self.model.clone(),
            embedding,
            speech_ms: self.speech_ms.saturating_add(other.speech_ms),
            meetings: self.meetings.saturating_add(1),
        }
    }
}
