mod animated_gradient;
mod caption_timing;
pub mod caption_words;
#[cfg(test)]
mod config_write_tests;
mod configuration;
pub mod cursor;
pub mod keyboard;
mod meta;

pub use animated_gradient::*;
pub use caption_timing::{
    derive_caption_track_segments, source_caption_id, synchronize_captions,
    transcription_ranges_cover, transcription_source_ranges,
};
pub use caption_words::{
    MAX_CAPTION_WORD_DURATION, MAX_CAPTION_WORDS_PER_SEGMENT, MIN_FINAL_CAPTION_WORDS,
    TARGET_CAPTION_WORDS_PER_SEGMENT, caption_boundary_word_is_weak, caption_text_from_words,
    caption_word_chunks, normalize_caption_words,
};
pub use configuration::*;
pub use cursor::*;
pub use keyboard::*;
pub use meta::*;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub resolution: Resolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
        }
    }
}
