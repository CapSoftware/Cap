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

/// What a preset stores: the whole project config with `timeline: null` and
/// `clips: []` -- presets style a project, they never carry its cuts
/// (`createPresets.ts:31-35`).
pub fn preset_config(project: &ProjectConfiguration) -> Value {
    let mut value = serde_json::to_value(project).unwrap_or(Value::Null);
    if let Some(map) = value.as_object_mut() {
        map.insert("timeline".into(), Value::Null);
        map.insert("clips".into(), Value::Array(Vec::new()));
    }
    value
}

/// `applyPreset`'s merge (`PresetsDropdown.tsx`): the preset's config with the
/// *current* timeline and clips kept in place. `None` when the stored JSON no
/// longer deserializes.
pub fn apply_preset(
    config: &Value,
    current: &ProjectConfiguration,
) -> Option<ProjectConfiguration> {
    let mut next: ProjectConfiguration = serde_json::from_value(config.clone()).ok()?;
    next.timeline = current.timeline.clone();
    next.clips = current.clips.clone();
    Some(next)
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
    fn applying_keeps_the_current_timeline_and_clips() {
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
            ..Default::default()
        };
        let mut preset_source = ProjectConfiguration::default();
        preset_source.background.blur = 42.;
        let preset = preset_config(&preset_source);

        let applied = apply_preset(&preset, &current).expect("preset deserializes");
        assert_eq!(applied.background.blur, 42.);
        assert!(applied.timeline.is_some(), "current timeline is kept");
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
