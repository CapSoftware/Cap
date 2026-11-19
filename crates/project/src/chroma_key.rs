use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{Color, configuration::clamp_finite};

/// Keys a solid backdrop out of the camera. `enabled` turns the key off
/// without losing the colour and levels.
#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChromaKey {
    pub enabled: bool,
    pub color: Color,
    /// Chroma distance from `color` that is fully keyed, in units of the key
    /// colour's own saturation: 0 is the key colour, 1 is any neutral grey.
    pub tolerance: f32,
    /// Width of the transparent-to-opaque ramp above `tolerance`.
    pub softness: f32,
    /// How much of the key's hue is removed from the subject.
    pub spill: f32,
}

impl Default for ChromaKey {
    fn default() -> Self {
        Self {
            enabled: true,
            color: Self::GREEN,
            tolerance: Self::DEFAULT_TOLERANCE,
            softness: Self::DEFAULT_SOFTNESS,
            spill: Self::DEFAULT_SPILL,
        }
    }
}

impl ChromaKey {
    pub const GREEN: Color = [0, 177, 64];
    pub const BLUE: Color = [0, 71, 187];

    pub const DEFAULT_TOLERANCE: f32 = 0.45;
    pub const DEFAULT_SOFTNESS: f32 = 0.15;
    pub const DEFAULT_SPILL: f32 = 0.5;

    const LEVEL_RANGE: (f32, f32) = (0.0, 1.0);

    pub fn sanitized(&self) -> Self {
        Self {
            enabled: self.enabled,
            color: self.color.map(|channel| channel.min(255)),
            tolerance: clamp_finite(self.tolerance, Self::LEVEL_RANGE, Self::DEFAULT_TOLERANCE),
            softness: clamp_finite(self.softness, Self::LEVEL_RANGE, Self::DEFAULT_SOFTNESS),
            spill: clamp_finite(self.spill, Self::LEVEL_RANGE, Self::DEFAULT_SPILL),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Camera;

    #[test]
    fn legacy_cameras_load_without_a_key_and_save_without_one() {
        let camera: Camera = serde_json::from_str(r#"{"rounding": 40.0}"#).unwrap();
        assert_eq!(camera.chroma_key, None);
        assert_eq!(camera.active_chroma_key(), None);
        assert!(!camera.is_cutout());
        let json = serde_json::to_value(&camera).unwrap();
        assert!(json.get("chromaKey").is_none());
    }

    #[test]
    fn keys_round_trip_and_keep_their_levels_when_turned_off() {
        let key = ChromaKey {
            enabled: false,
            color: ChromaKey::BLUE,
            tolerance: 0.25,
            softness: 0.0625,
            spill: 0.75,
        };
        let camera = Camera {
            chroma_key: Some(key),
            ..Camera::default()
        };
        let json = serde_json::to_value(&camera).unwrap();
        assert_eq!(
            json["chromaKey"],
            serde_json::json!({
                "enabled": false,
                "color": [0, 71, 187],
                "tolerance": 0.25,
                "softness": 0.0625,
                "spill": 0.75
            })
        );
        let restored: Camera = serde_json::from_value(json).unwrap();
        assert_eq!(restored.chroma_key, Some(key));
        assert_eq!(restored.active_chroma_key(), None);
        assert!(!restored.is_cutout());
    }

    #[test]
    fn partial_keys_fill_in_defaults() {
        let camera: Camera =
            serde_json::from_value(serde_json::json!({ "chromaKey": { "color": [0, 71, 187] } }))
                .unwrap();
        assert_eq!(
            camera.active_chroma_key(),
            Some(ChromaKey {
                color: ChromaKey::BLUE,
                ..ChromaKey::default()
            })
        );
        assert!(camera.is_cutout());
    }

    #[test]
    fn hand_edited_levels_are_clamped_on_read() {
        let camera: Camera = serde_json::from_value(serde_json::json!({
            "chromaKey": {
                "color": [300, 1000, 12],
                "tolerance": -2.0,
                "softness": 9.0,
                "spill": 1.5
            }
        }))
        .unwrap();
        assert_eq!(
            camera.active_chroma_key(),
            Some(ChromaKey {
                enabled: true,
                color: [255, 255, 12],
                tolerance: 0.0,
                softness: 1.0,
                spill: 1.0,
            })
        );
        let mut key = camera.chroma_key.unwrap();
        key.tolerance = f32::NAN;
        key.softness = f32::INFINITY;
        key.spill = f32::NEG_INFINITY;
        let clean = key.sanitized();
        assert_eq!(clean.tolerance, ChromaKey::DEFAULT_TOLERANCE);
        assert_eq!(clean.softness, ChromaKey::DEFAULT_SOFTNESS);
        assert_eq!(clean.spill, ChromaKey::DEFAULT_SPILL);
    }
}
