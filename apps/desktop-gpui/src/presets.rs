//! Project-configuration presets -- the store-backed catalogue behind the
//! editor header's Presets dropdown (`PresetsDropdown.tsx`,
//! `utils/createPresets.ts`).
//!
//! The catalogue lives under the shared Tauri store file's `presets` key --
//! `{ presets: [{ name, config }], default: number | null }` -- so presets
//! created in either app appear in both. Configs are held as raw JSON here:
//! deserializing through `ProjectConfiguration` only happens when a preset is
//! *applied*, so a preset written by a newer Tauri build with fields this
//! build has never heard of survives every rename/reorder untouched.

use cap_project::ProjectConfiguration;
use serde_json::{Map, Value, json};

use crate::store::{set_store_setting, store_section};

#[derive(Debug, Clone, PartialEq)]
pub struct PresetEntry {
    pub name: String,
    pub config: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresetsStore {
    pub presets: Vec<PresetEntry>,
    pub default: Option<usize>,
}

impl PresetsStore {
    pub fn load() -> Self {
        Self::from_section(store_section("presets"))
    }

    fn from_section(section: Map<String, Value>) -> Self {
        let presets = section
            .get("presets")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let name = entry.get("name")?.as_str()?.to_string();
                        let config = entry.get("config")?.clone();
                        Some(PresetEntry { name, config })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default = section
            .get("default")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .filter(|index| *index < presets.len());
        Self { presets, default }
    }

    pub fn save(&self) -> bool {
        let presets: Vec<Value> = self
            .presets
            .iter()
            .map(|entry| json!({ "name": entry.name, "config": entry.config }))
            .collect();
        let default = match self.default {
            Some(index) => json!(index),
            None => Value::Null,
        };
        set_store_setting("presets", "presets", Value::Array(presets))
            && set_store_setting("presets", "default", default)
    }

    /// `createPreset` (`createPresets.ts:30-43`).
    pub fn create(&mut self, name: String, config: Value, default: bool) {
        self.presets.push(PresetEntry { name, config });
        if default {
            self.default = Some(self.presets.len() - 1);
        }
    }

    /// `deletePreset` (`createPresets.ts:44-53`), with its exact default
    /// re-seating: deleting the default falls back to the first remaining
    /// preset, and deleting an earlier row shifts the default down by one.
    pub fn delete(&mut self, index: usize) {
        if index >= self.presets.len() {
            return;
        }
        self.presets.remove(index);
        let Some(default) = self.default else {
            return;
        };
        if index == default {
            self.default = (!self.presets.is_empty()).then_some(0);
        } else if index < default {
            self.default = Some(default - 1);
        }
    }

    pub fn set_default(&mut self, index: usize) {
        if index < self.presets.len() {
            self.default = Some(index);
        }
    }

    /// New recordings go back to Cap's own defaults.
    pub fn clear_default(&mut self) {
        self.default = None;
    }

    pub fn rename(&mut self, index: usize, name: String) {
        if let Some(entry) = self.presets.get_mut(index) {
            entry.name = name;
        }
    }

    /// `saveToPreset` (`createPresets.ts:62-72`).
    pub fn save_to(&mut self, index: usize, config: Value) {
        if let Some(entry) = self.presets.get_mut(index) {
            entry.config = config;
        }
    }
}

/// The built-in "Default" preset: what a fresh screen recording looks like
/// with no user preset -- `ProjectConfiguration::default()` plus the
/// presentation defaults the recorder applies (`recording.rs`
/// `apply_screen_recording_presentation_defaults`): 10% padding, 7.5%
/// rounding and the default screen-movement spring.
pub fn default_project_config(current: &ProjectConfiguration) -> ProjectConfiguration {
    let mut config = ProjectConfiguration::default();
    if config.background.padding <= f64::EPSILON {
        config.background.padding = 10.0;
    }
    if config.background.rounding <= f64::EPSILON {
        config.background.rounding = 7.5;
    }
    config.screen_movement_spring = cap_project::ScreenMovementSpring::default();
    current.with_preset(config)
}

/// Presets store styling without recording cuts, caption text or layer order.
pub fn preset_config(project: &ProjectConfiguration) -> Value {
    let mut value = serde_json::to_value(project).unwrap_or(Value::Null);
    if let Some(map) = value.as_object_mut() {
        map.insert("timeline".into(), Value::Null);
        map.insert("clips".into(), Value::Array(Vec::new()));
        map.remove("overlayOrder");
        if let Some(captions) = map.get_mut("captions").and_then(Value::as_object_mut) {
            captions.insert("segments".into(), Value::Array(Vec::new()));
            captions.remove("sourceTimed");
        }
    }
    value
}

/// `applyPreset`'s merge (`PresetsDropdown.tsx`): the preset's config with the
/// *current* timeline, clips and caption source kept in place. `None` when the
/// stored JSON no longer deserializes.
pub fn apply_preset(
    config: &Value,
    current: &ProjectConfiguration,
) -> Option<ProjectConfiguration> {
    let next = serde_json::from_value(config.clone()).ok()?;
    Some(current.with_preset(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(names: &[&str], default: Option<usize>) -> PresetsStore {
        PresetsStore {
            presets: names
                .iter()
                .map(|name| PresetEntry {
                    name: (*name).to_string(),
                    config: json!({}),
                })
                .collect(),
            default,
        }
    }

    #[test]
    fn deleting_the_default_falls_back_to_the_first_preset() {
        let mut store = store_with(&["a", "b", "c"], Some(1));
        store.delete(1);
        assert_eq!(store.default, Some(0));
        let mut last = store_with(&["a"], Some(0));
        last.delete(0);
        assert_eq!(last.default, None);
    }

    #[test]
    fn deleting_before_the_default_shifts_it_down() {
        let mut store = store_with(&["a", "b", "c"], Some(2));
        store.delete(0);
        assert_eq!(store.default, Some(1));
        assert_eq!(store.presets[1].name, "c");
    }

    #[test]
    fn deleting_after_the_default_leaves_it_alone() {
        let mut store = store_with(&["a", "b", "c"], Some(0));
        store.delete(2);
        assert_eq!(store.default, Some(0));
    }

    #[test]
    fn creating_as_default_points_at_the_new_row() {
        let mut store = store_with(&["a"], Some(0));
        store.create("b".into(), json!({}), true);
        assert_eq!(store.default, Some(1));
        store.create("c".into(), json!({}), false);
        assert_eq!(store.default, Some(1));
    }

    #[test]
    fn a_stored_default_out_of_range_is_dropped_on_load() {
        let mut section = Map::new();
        section.insert("presets".into(), json!([{ "name": "a", "config": {} }]));
        section.insert("default".into(), json!(4));
        let store = PresetsStore::from_section(section);
        assert_eq!(store.default, None);
        assert_eq!(store.presets.len(), 1);
    }

    #[test]
    fn a_preset_config_strips_timeline_and_clips() {
        let config = preset_config(&ProjectConfiguration::default());
        assert_eq!(config["timeline"], Value::Null);
        assert_eq!(config["clips"], json!([]));
    }

    #[test]
    fn applying_keeps_the_current_timeline_clips_and_layer_order() {
        let current = ProjectConfiguration {
            timeline: Some(cap_project::TimelineConfiguration {
                segments: Vec::new(),
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
            }),
            overlay_order: vec![cap_project::OverlayTrack {
                kind: cap_project::OverlayTrackKind::Image,
                track: 2,
            }],
            ..Default::default()
        };
        let mut preset_source = ProjectConfiguration::default();
        preset_source.background.blur = 42.;
        let preset = preset_config(&preset_source);

        let applied = apply_preset(&preset, &current).expect("preset deserializes");
        assert_eq!(applied.background.blur, 42.);
        assert_eq!(applied.overlay_order, current.overlay_order);
        assert!(applied.timeline.is_some(), "current timeline is kept");
    }

    #[test]
    fn applying_a_legacy_tauri_preset_keeps_text_unchanged_after_reopening() {
        let store: Value = serde_json::from_str(
            r#"{
                "presets": {
                    "default": 0,
                    "presets": [{
                        "name": "Legacy Tauri preset",
                        "config": {
                            "background": { "padding": 24.0 },
                            "camera": { "size": 45.0, "zoom_size": 65.0 },
                            "timeline": null,
                            "clips": []
                        }
                    }]
                }
            }"#,
        )
        .unwrap();
        let presets = PresetsStore::from_section(store["presets"].as_object().unwrap().clone());
        let current: ProjectConfiguration = serde_json::from_str(
            r#"{
                "textSizeVersion": 1,
                "textAnimVersion": 1,
                "timeline": {
                    "segments": [{ "recordingSegment": 0, "start": 0.0, "end": 5.0, "timescale": 1.0 }],
                    "zoomSegments": [],
                    "textSegments": [{
                        "start": 1.0,
                        "end": 4.0,
                        "content": "Keep this title",
                        "size": { "x": 0.6, "y": 0.4 },
                        "fontSize": 48.0,
                        "fadeDuration": 0.15,
                        "animationIn": "slideUp",
                        "animationOut": "slideDown",
                        "animationInDuration": 0.4,
                        "animationOutDuration": 0.6
                    }]
                },
                "clips": [{ "index": 0, "offsets": { "mic": -0.125 } }]
            }"#,
        )
        .unwrap();
        let applied = apply_preset(&presets.presets[0].config, &current).unwrap();
        let directory = tempfile::tempdir().unwrap();
        applied.write(directory.path()).unwrap();
        let reopened = ProjectConfiguration::load(directory.path()).unwrap();

        assert_eq!(reopened.background.padding, 24.0);
        assert_eq!(reopened.camera.size, 45.0);
        assert_eq!(reopened.camera.zoom_size, Some(65.0));
        assert_eq!(
            serde_json::to_value(&reopened.timeline).unwrap(),
            serde_json::to_value(&current.timeline).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&reopened.clips).unwrap(),
            serde_json::to_value(&current.clips).unwrap()
        );
    }

    fn captioned_project(text: &str, source_timed: bool) -> ProjectConfiguration {
        serde_json::from_value(json!({
            "timeline": {
                "segments": [{ "start": 0.0, "end": 10.0, "timescale": 1.0 }],
                "zoomSegments": [],
                "captionSegments": [{
                    "id": "spoken", "start": 2.0, "end": 3.0, "text": text,
                    "words": [{ "text": text, "start": 2.0, "end": 3.0 }],
                    "colorOverride": "#123456", "positionOverride": "top-center"
                }]
            },
            "captions": {
                "segments": [{
                    "id": "spoken", "start": 2.0, "end": 3.0, "text": text,
                    "words": [{ "text": text, "start": 2.0, "end": 3.0 }]
                }],
                "settings": { "enabled": true, "size": 32 },
                "sourceTimed": source_timed
            }
        }))
        .unwrap()
    }

    #[test]
    fn saving_a_preset_keeps_caption_settings_without_the_transcript() {
        let source = captioned_project("Other recording", true);
        let preset = preset_config(&source);
        let captions = &preset["captions"];
        assert_eq!(captions["segments"], json!([]));
        assert_eq!(captions["settings"]["size"], 32);
        assert!(captions.get("sourceTimed").is_none());
        assert!(
            !serde_json::to_string(&preset)
                .unwrap()
                .contains("Other recording")
        );
    }

    #[test]
    fn applying_a_preset_keeps_source_captions_and_timeline_overrides() {
        let preset = serde_json::to_value(captioned_project("Other recording", false)).unwrap();
        for source_timed in [false, true] {
            let current = captioned_project("Current recording", source_timed);
            let mut preset = preset.clone();
            preset["captions"]["settings"]["size"] = json!(72);
            let mut applied = apply_preset(&preset, &current).unwrap();
            let captions = applied.captions.as_ref().unwrap();
            assert_eq!(captions.segments[0].text, "Current recording");
            assert_eq!(captions.source_timed, source_timed);
            assert_eq!(captions.settings.size, 72);
            assert!(captions.settings.enabled);
            cap_project::synchronize_captions(&mut applied, &[10.0]);
            let track = &applied.timeline.as_ref().unwrap().caption_segments[0];
            assert_eq!(track.text, "Current recording");
            assert_eq!((track.start, track.end), (2.0, 3.0));
            assert_eq!(track.color_override.as_deref(), Some("#123456"));
            assert_eq!(track.position_override.as_deref(), Some("top-center"));
            let directory = tempfile::tempdir().unwrap();
            applied.write(directory.path()).unwrap();
            let mut reopened = ProjectConfiguration::load(directory.path()).unwrap();
            cap_project::synchronize_captions(&mut reopened, &[10.0]);
            assert_eq!(
                reopened.captions.as_ref().unwrap().segments[0].text,
                "Current recording"
            );
            assert_eq!(
                reopened.timeline.as_ref().unwrap().caption_segments[0].text,
                "Current recording"
            );
        }
    }

    #[test]
    fn applying_default_caption_settings_keeps_the_current_transcript() {
        let current = captioned_project("Current recording", true);
        let preset = preset_config(&ProjectConfiguration::default());
        for applied in [
            apply_preset(&preset, &current).unwrap(),
            default_project_config(&current),
        ] {
            let captions = applied.captions.as_ref().unwrap();
            assert_eq!(captions.segments[0].text, "Current recording");
            assert!(captions.source_timed);
            assert_eq!(
                captions.settings.size,
                cap_project::CaptionSettings::default().size
            );
            assert!(!captions.settings.enabled);
        }
    }

    #[test]
    fn applying_a_preset_to_an_uncaptioned_project_keeps_only_its_settings() {
        let source = captioned_project("Other recording", true);
        let preset = serde_json::to_value(&source).unwrap();
        let current = ProjectConfiguration::default();
        let applied = apply_preset(&preset, &current).unwrap();
        let captions = applied.captions.as_ref().unwrap();
        assert!(captions.segments.is_empty());
        assert_eq!(captions.settings.size, 32);
        assert!(captions.settings.enabled);
        let preset = preset_config(&current);
        assert!(apply_preset(&preset, &current).unwrap().captions.is_none());
        assert!(default_project_config(&current).captions.is_none());
    }

    #[test]
    fn malformed_entries_are_skipped_on_load() {
        let mut section = Map::new();
        section.insert(
            "presets".into(),
            json!([{ "name": "ok", "config": {} }, { "config": {} }, 42]),
        );
        section.insert("default".into(), Value::Null);
        let store = PresetsStore::from_section(section);
        assert_eq!(store.presets.len(), 1);
        assert_eq!(store.presets[0].name, "ok");
    }
}
