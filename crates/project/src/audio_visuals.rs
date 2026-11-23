use serde::{Deserialize, Serialize};
use specta::Type;

use crate::BackgroundSource;

pub const AUDIO_VISUALIZER_DEFAULT_COLOR: &str = "#FFFFFF";
/// Used instead of white when the background is light, so visuals switched
/// on over the default white canvas are visible from the first frame.
pub const AUDIO_VISUALIZER_DARK_COLOR: &str = "#111111";

/// Size of the black placeholder an audio-only recording keeps as its display
/// track. It is also the canvas a visualiser export is drawn on, so it
/// matches the 1080p default export.
pub const AUDIO_ONLY_CANVAS_WIDTH: u32 = 1920;
pub const AUDIO_ONLY_CANVAS_HEIGHT: u32 = 1080;
pub const AUDIO_ONLY_CANVAS_FPS: u32 = 30;
/// Software H.264 only: a static black frame costs libx264 almost nothing,
/// and keeping it off the hardware encoders means an audio recording never
/// competes with, or depends on, a GPU encoder session.
pub const AUDIO_ONLY_CANVAS_ENCODERS: &[&str] = &["libx264"];

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AudioVisualizerStyle {
    #[default]
    Bars,
    Wave,
    Circle,
}

impl AudioVisualizerStyle {
    pub const ALL: [Self; 3] = [Self::Bars, Self::Wave, Self::Circle];
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioVisualsConfiguration {
    pub enabled: bool,
    pub style: AudioVisualizerStyle,
    pub color: String,
    pub size: f32,
}

impl AudioVisualsConfiguration {
    pub const MIN_SIZE: f32 = 0.2;
    pub const MAX_SIZE: f32 = 1.0;

    /// The settings visuals start with over `background`: dark on a light
    /// solid colour or gradient, white on anything else.
    pub fn for_background(background: &BackgroundSource) -> Self {
        let mut config = Self::default();
        if is_light(background) {
            config.color = AUDIO_VISUALIZER_DARK_COLOR.to_string();
        }
        config
    }

    pub fn clamped_size(&self) -> f32 {
        if self.size.is_finite() {
            self.size.clamp(Self::MIN_SIZE, Self::MAX_SIZE)
        } else {
            Self::default().size
        }
    }
}

fn is_light(background: &BackgroundSource) -> bool {
    let luminance = |[r, g, b]: [u16; 3]| {
        let channel = |value: u16| f32::from(value.min(255)) / 255.0;
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    };
    match background {
        BackgroundSource::Color { value, alpha } => *alpha > 127 && luminance(*value) > 0.6,
        BackgroundSource::Gradient { from, to, .. } => {
            (luminance(*from) + luminance(*to)) / 2.0 > 0.6
        }
        _ => false,
    }
}

impl Default for AudioVisualsConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            style: AudioVisualizerStyle::Bars,
            color: AUDIO_VISUALIZER_DEFAULT_COLOR.to_string(),
            size: 0.6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visuals_start_dark_on_a_light_background_and_white_otherwise() {
        let color = |value: [u16; 3]| BackgroundSource::Color { value, alpha: 255 };
        let start = |background: BackgroundSource| {
            AudioVisualsConfiguration::for_background(&background).color
        };
        assert_eq!(start(color([255, 255, 255])), AUDIO_VISUALIZER_DARK_COLOR);
        assert_eq!(start(color([20, 20, 30])), AUDIO_VISUALIZER_DEFAULT_COLOR);
        assert_eq!(
            start(BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 0
            }),
            AUDIO_VISUALIZER_DEFAULT_COLOR
        );
        assert_eq!(
            start(BackgroundSource::Wallpaper { path: None }),
            AUDIO_VISUALIZER_DEFAULT_COLOR
        );
        assert!(!AudioVisualsConfiguration::for_background(&color([255, 255, 255])).enabled);
    }

    #[test]
    fn old_project_files_have_no_audio_visuals() {
        let config: crate::ProjectConfiguration = serde_json::from_str("{}").unwrap();
        assert!(config.audio_visuals.is_none());
        let written = serde_json::to_value(&config).unwrap();
        assert!(written.get("audioVisuals").is_none());
    }

    #[test]
    fn audio_visuals_round_trip_and_fill_missing_fields() {
        let config: crate::ProjectConfiguration =
            serde_json::from_str(r#"{"audioVisuals":{"enabled":true,"style":"circle"}}"#).unwrap();
        let visuals = config.audio_visuals.clone().unwrap();
        assert!(visuals.enabled);
        assert_eq!(visuals.style, AudioVisualizerStyle::Circle);
        assert_eq!(visuals.color, AUDIO_VISUALIZER_DEFAULT_COLOR);
        assert_eq!(visuals.size, 0.6);
        let reread: crate::ProjectConfiguration =
            serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
        assert_eq!(reread.audio_visuals, Some(visuals));
    }

    #[test]
    fn size_is_clamped() {
        let mut visuals = AudioVisualsConfiguration {
            size: 4.0,
            ..Default::default()
        };
        assert_eq!(visuals.clamped_size(), 1.0);
        visuals.size = f32::NAN;
        assert_eq!(visuals.clamped_size(), 0.6);
        visuals.size = 0.0;
        assert_eq!(visuals.clamped_size(), 0.2);
    }
}
