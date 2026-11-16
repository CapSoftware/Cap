use serde::{Deserialize, Serialize};
use specta::Type;

use crate::audio::{AUDIO_EXPORT_FPS, AudioExportSettings};
use crate::gif::GifExportSettings;
use crate::mov::MovExportSettings;
use crate::mp4::Mp4ExportSettings;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Type)]
#[serde(tag = "format")]
pub enum ExportSettings {
    #[serde(alias = "mp4")]
    Mp4(Mp4ExportSettings),
    #[serde(alias = "gif")]
    Gif(GifExportSettings),
    #[serde(alias = "mov")]
    Mov(MovExportSettings),
    #[serde(alias = "audio")]
    Audio(AudioExportSettings),
}

impl ExportSettings {
    pub fn fps(&self) -> u32 {
        match self {
            Self::Mp4(s) => s.fps,
            Self::Gif(s) => s.fps,
            Self::Mov(s) => s.fps,
            Self::Audio(_) => AUDIO_EXPORT_FPS,
        }
    }

    pub fn force_ffmpeg_decoder(&self) -> bool {
        match self {
            Self::Mp4(s) => s.force_ffmpeg_decoder,
            Self::Gif(_) | Self::Mov(_) | Self::Audio(_) => false,
        }
    }

    pub fn cursor_only(&self) -> bool {
        match self {
            Self::Mov(s) => s.cursor_only,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{AudioExportFormat, AudioSource};

    #[test]
    fn audio_settings_round_trip_through_the_export_tag() {
        let settings = ExportSettings::Audio(AudioExportSettings {
            source: AudioSource::Mic,
            audio_format: AudioExportFormat::Mp3,
        });

        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(value["format"], "Audio");
        assert_eq!(value["source"], "mic");
        assert_eq!(value["audioFormat"], "mp3");
        assert!(value.get("audio_format").is_none());

        let restored: ExportSettings = serde_json::from_value(value).unwrap();
        let ExportSettings::Audio(restored) = restored else {
            panic!("expected audio settings");
        };
        assert_eq!(restored.source, AudioSource::Mic);
        assert_eq!(restored.audio_format, AudioExportFormat::Mp3);
    }

    #[test]
    fn the_audio_alias_and_defaults_are_accepted() {
        let restored: ExportSettings =
            serde_json::from_value(serde_json::json!({ "format": "audio" })).unwrap();
        let ExportSettings::Audio(restored) = restored else {
            panic!("expected audio settings");
        };
        assert_eq!(restored.source, AudioSource::Both);
        assert_eq!(restored.audio_format, AudioExportFormat::Wav);
    }
}
