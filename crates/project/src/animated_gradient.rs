use serde::{Deserialize, Serialize};
use specta::Type;

use crate::Color;

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimatedGradientStop {
    pub color: Color,
    pub position: f32,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AnimatedGradientConfig {
    pub color_stops: Vec<AnimatedGradientStop>,
    pub direction: f32,
    pub flow_scale: f32,
    pub flow_strength: f32,
    pub curvature: f32,
    pub detail: f32,
    pub relief: f32,
    pub light: f32,
    pub shade: f32,
    pub ripples: f32,
    pub grain_amount: f32,
    pub grain_size: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub vibrance: f32,
    pub motion_speed: f32,
    pub seed: u32,
}

impl Default for AnimatedGradientConfig {
    fn default() -> Self {
        Self {
            color_stops: stops([0xff6b35, 0xf7c59f, 0xe891b9, 0x2e4057, 0x1a1a2e]),
            direction: 45.0,
            flow_scale: 2.0,
            flow_strength: 55.0,
            curvature: 70.0,
            detail: 2.0,
            relief: 60.0,
            light: 50.0,
            shade: 55.0,
            ripples: 60.0,
            grain_amount: 8.0,
            grain_size: 1.0,
            exposure: 0.0,
            contrast: 100.0,
            vibrance: 100.0,
            motion_speed: 30.0,
            seed: 0,
        }
    }
}

macro_rules! parameters {
    ($(($variant:ident, $field:ident, $label:literal, $group:literal, $min:expr, $max:expr, $step:expr)),+ $(,)?) => {
        #[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[serde(rename_all = "camelCase")]
        pub enum AnimatedGradientParameter {
            $($variant),+
        }

        impl AnimatedGradientParameter {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn control(self) -> AnimatedGradientControl {
                let (label, group, min, max, step) = match self {
                    $(Self::$variant => ($label, $group, $min, $max, $step)),+
                };
                AnimatedGradientControl {
                    key: self,
                    label: label.into(),
                    group: group.into(),
                    min,
                    max,
                    step,
                }
            }

            pub fn get(self, config: &AnimatedGradientConfig) -> f32 {
                match self {
                    $(Self::$variant => config.$field),+
                }
            }

            pub fn set(self, config: &mut AnimatedGradientConfig, value: f32) {
                let control = self.control();
                let value = if value.is_finite() {
                    value.clamp(control.min, control.max)
                } else {
                    self.get(&AnimatedGradientConfig::default())
                };
                let value = (value / control.step).round() * control.step;
                match self {
                    $(Self::$variant => config.$field = value),+
                }
            }
        }
    };
}

parameters![
    (Direction, direction, "Direction", "Flow", 0.0, 360.0, 1.0),
    (FlowScale, flow_scale, "Flow Scale", "Flow", 0.5, 5.0, 0.1),
    (
        FlowStrength,
        flow_strength,
        "Flow Strength",
        "Flow",
        0.0,
        100.0,
        1.0
    ),
    (Curvature, curvature, "Curvature", "Flow", 0.0, 100.0, 1.0),
    (Detail, detail, "Detail", "Flow", 1.0, 6.0, 1.0),
    (Relief, relief, "Relief", "Lighting", 0.0, 100.0, 1.0),
    (Light, light, "Highlights", "Lighting", 0.0, 100.0, 1.0),
    (Shade, shade, "Shading", "Lighting", 0.0, 100.0, 1.0),
    (
        Ripples,
        ripples,
        "Ripple Size",
        "Lighting",
        10.0,
        100.0,
        1.0
    ),
    (
        GrainAmount,
        grain_amount,
        "Grain Amount",
        "Texture",
        0.0,
        30.0,
        1.0
    ),
    (
        GrainSize,
        grain_size,
        "Grain Size",
        "Texture",
        0.5,
        3.0,
        0.1
    ),
    (Exposure, exposure, "Exposure", "Colour", -50.0, 50.0, 1.0),
    (Contrast, contrast, "Contrast", "Colour", 50.0, 200.0, 1.0),
    (Vibrance, vibrance, "Vibrance", "Colour", 0.0, 200.0, 1.0),
    (
        MotionSpeed,
        motion_speed,
        "Motion Speed",
        "Animation",
        0.0,
        100.0,
        1.0
    ),
];

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnimatedGradientControl {
    pub key: AnimatedGradientParameter,
    pub label: String,
    pub group: String,
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

impl AnimatedGradientConfig {
    pub fn normalized(&self) -> Self {
        let mut config = self.clone();
        for parameter in AnimatedGradientParameter::ALL {
            parameter.set(&mut config, parameter.get(self));
        }
        config.color_stops.truncate(5);
        if config.color_stops.len() < 2 {
            config.color_stops = Self::default().color_stops;
        }
        for stop in &mut config.color_stops {
            stop.color = stop.color.map(|channel| channel.min(255));
            stop.position = if stop.position.is_finite() {
                stop.position.clamp(0.0, 100.0)
            } else {
                0.0
            };
        }
        config
            .color_stops
            .sort_by(|a, b| a.position.total_cmp(&b.position));
        config
    }

    pub fn random() -> Self {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        Self::from_seed(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn from_seed(seed: u32) -> Self {
        let mut random = GradientRandom(u64::from(seed));
        let hue = random.range(0.0, 360.0);
        let span = random.range(65.0, 260.0);
        let count = 3 + (random.next() % 3) as usize;
        let color_stops = (0..count)
            .map(|index| {
                let t = index as f32 / (count - 1) as f32;
                let h = (hue + span * t + random.range(-12.0, 12.0)).rem_euclid(360.0);
                let s = random.range(0.55, 0.92);
                let l = (0.76 - t * 0.55 + random.range(-0.08, 0.08)).clamp(0.12, 0.88);
                AnimatedGradientStop {
                    color: hsl_color(h, s, l),
                    position: if index == 0 || index == count - 1 {
                        t * 100.0
                    } else {
                        t * 100.0 + random.range(-7.0, 7.0)
                    },
                }
            })
            .collect();
        Self {
            color_stops,
            direction: random.range(0.0, 360.0),
            flow_scale: random.range(0.7, 3.2),
            flow_strength: random.range(25.0, 75.0),
            curvature: random.range(30.0, 90.0),
            detail: random.range(1.0, 4.0),
            relief: random.range(30.0, 85.0),
            light: random.range(20.0, 75.0),
            shade: random.range(25.0, 80.0),
            ripples: random.range(30.0, 90.0),
            grain_amount: random.range(3.0, 15.0),
            grain_size: random.range(0.6, 2.0),
            exposure: random.range(-8.0, 8.0),
            contrast: random.range(90.0, 125.0),
            vibrance: random.range(85.0, 130.0),
            motion_speed: random.range(20.0, 65.0),
            seed,
        }
        .normalized()
    }
}

pub(crate) fn deserialize_config<'de, D>(
    deserializer: D,
) -> Result<AnimatedGradientConfig, D::Error>
where
    D: serde::Deserializer<'de>,
{
    AnimatedGradientConfig::deserialize(deserializer).map(|config| config.normalized())
}

fn deserialize_optional_config<'de, D>(
    deserializer: D,
) -> Result<Option<AnimatedGradientConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<AnimatedGradientConfig>::deserialize(deserializer)
        .map(|config| config.map(|config| config.normalized()))
}

struct GradientRandom(u64);

impl GradientRandom {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
        (value ^ (value >> 31)) as u32
    }

    fn range(&mut self, min: f32, max: f32) -> f32 {
        min + (max - min) * (self.next() as f64 / u32::MAX as f64) as f32
    }
}

fn hsl_color(hue: f32, saturation: f32, lightness: f32) -> Color {
    let amplitude = saturation * lightness.min(1.0 - lightness);
    [0.0, 8.0, 4.0].map(|n| {
        let k = (n + hue / 30.0) % 12.0;
        ((lightness - amplitude * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)) * 255.0).round() as u16
    })
}

fn stops(palette: [u32; 5]) -> Vec<AnimatedGradientStop> {
    palette
        .into_iter()
        .enumerate()
        .map(|(index, color)| AnimatedGradientStop {
            color: [
                ((color >> 16) & 255) as u16,
                ((color >> 8) & 255) as u16,
                (color & 255) as u16,
            ],
            position: index as f32 * 25.0,
        })
        .collect()
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnimatedGradientPreset {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "deserialize_config")]
    pub config: AnimatedGradientConfig,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AnimatedGradientLibrary {
    pub presets: Vec<AnimatedGradientPreset>,
    #[serde(deserialize_with = "deserialize_optional_config")]
    pub last_used: Option<AnimatedGradientConfig>,
    pub selected: bool,
}

impl AnimatedGradientLibrary {
    pub fn save_preset(&mut self, name: &str, config: &AnimatedGradientConfig) -> Option<String> {
        let name = name.trim();
        if name.is_empty() || self.presets.len() >= 100 {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.presets.push(AnimatedGradientPreset {
            id: id.clone(),
            name: name.chars().take(80).collect(),
            config: config.normalized(),
        });
        Some(id)
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnimatedGradientCatalog {
    pub default_config: AnimatedGradientConfig,
    pub templates: Vec<AnimatedGradientPreset>,
    pub controls: Vec<AnimatedGradientControl>,
}

pub fn animated_gradient_catalog() -> AnimatedGradientCatalog {
    let palettes = [
        (
            "Afterglow",
            [0xff6b35, 0xf7c59f, 0xe891b9, 0x2e4057, 0x1a1a2e],
        ),
        ("Tidal", [0x081c35, 0x165b83, 0x51b6d6, 0xc7eef2, 0xffd49b]),
        (
            "Northern Lights",
            [0x091322, 0x155450, 0x3ac8a0, 0xa4eed4, 0x7154b8],
        ),
        (
            "Electric Iris",
            [0x23085d, 0x4737d7, 0x8b62f1, 0xee98d2, 0xffcfdf],
        ),
        (
            "Rose Quartz",
            [0x542c56, 0xa65d88, 0xea9cae, 0xffd2c2, 0xffead5],
        ),
        (
            "Solar Flare",
            [0x260c23, 0x971c49, 0xef5a43, 0xffad58, 0xffe7a3],
        ),
        (
            "Glacier",
            [0xf0ffff, 0xbce9fa, 0x63b9de, 0x27628c, 0x11253e],
        ),
        (
            "Jade Silk",
            [0x102f2e, 0x286854, 0x70af83, 0xc2dca6, 0xf8efd5],
        ),
        (
            "Moonstone",
            [0x181a36, 0x515470, 0x9195b1, 0xd1c7d7, 0xffe6dd],
        ),
        (
            "Hot Pink",
            [0x21134b, 0x612585, 0xc33599, 0xfa77b1, 0xffced9],
        ),
        (
            "Desert Glass",
            [0x263a42, 0x737b76, 0xd1ad84, 0xf3d3a7, 0xfaeee0],
        ),
        (
            "Deep Current",
            [0x040c23, 0x152a64, 0x265e9f, 0x44afb0, 0xb0ead2],
        ),
    ];
    AnimatedGradientCatalog {
        default_config: AnimatedGradientConfig::default(),
        templates: palettes
            .into_iter()
            .enumerate()
            .map(|(index, (name, palette))| AnimatedGradientPreset {
                id: format!("template-{index}"),
                name: name.into(),
                config: AnimatedGradientConfig {
                    color_stops: stops(palette),
                    direction: (45.0 + index as f32 * 29.0) % 360.0,
                    flow_scale: 1.3 + (index % 4) as f32 * 0.4,
                    curvature: 45.0 + (index % 3) as f32 * 18.0,
                    relief: 40.0 + (index % 4) as f32 * 13.0,
                    seed: index as u32 * 137,
                    ..Default::default()
                }
                .normalized(),
            })
            .collect(),
        controls: AnimatedGradientParameter::ALL
            .iter()
            .map(|key| key.control())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_library_round_trip() {
        let config: AnimatedGradientConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config, AnimatedGradientConfig::default());
        assert_eq!(
            serde_json::from_str::<AnimatedGradientLibrary>("{}").unwrap(),
            AnimatedGradientLibrary::default()
        );
        let mut library = AnimatedGradientLibrary {
            last_used: Some(config.clone()),
            selected: true,
            ..Default::default()
        };
        assert!(library.save_preset("  My gradient  ", &config).is_some());
        assert!(library.save_preset(" ", &config).is_none());
        assert_eq!(library.presets[0].name, "My gradient");
        let json = serde_json::to_string(&library).unwrap();
        assert_eq!(
            serde_json::from_str::<AnimatedGradientLibrary>(&json).unwrap(),
            library
        );
    }

    #[test]
    fn persisted_backgrounds_and_presets_are_normalized_before_editing() {
        let invalid = serde_json::json!({
            "colorStops": [
                {"color": [999, 255, 0], "position": 120},
                {"color": [0, 0, 255], "position": -20}
            ],
            "detail": 2.4,
            "flowScale": 0,
            "motionSpeed": 900
        });
        let source: crate::BackgroundSource = serde_json::from_value(serde_json::json!({
            "type": "animatedGradient", "config": invalid
        }))
        .unwrap();
        let crate::BackgroundSource::AnimatedGradient { config } = source else {
            panic!("Expected animated gradient");
        };
        assert_eq!(config, config.normalized());
        assert_eq!(config.color_stops[0].position, 0.0);
        assert_eq!(config.color_stops[1].position, 100.0);
        assert_eq!(config.color_stops[1].color, [255, 255, 0]);
        let library: AnimatedGradientLibrary = serde_json::from_value(serde_json::json!({
            "presets": [{"id": "test", "name": "Test", "config": invalid}],
            "lastUsed": invalid,
            "selected": true
        }))
        .unwrap();
        assert_eq!(library.last_used.as_ref(), Some(&config));
        assert_eq!(library.presets[0].config, config);
    }

    #[test]
    fn background_variant_round_trips_without_changing_legacy_defaults() {
        let source: crate::BackgroundSource =
            serde_json::from_str(r#"{"type":"animatedGradient","config":{}}"#).unwrap();
        let crate::BackgroundSource::AnimatedGradient { config } = &source else {
            panic!("Expected animated gradient");
        };
        assert_eq!(config, &AnimatedGradientConfig::default());
        let json = serde_json::to_value(&source).unwrap();
        assert_eq!(json["type"], "animatedGradient");
        let round_trip: crate::BackgroundSource = serde_json::from_value(json).unwrap();
        assert_eq!(
            serde_json::to_value(round_trip).unwrap(),
            serde_json::to_value(source).unwrap()
        );
        let legacy: crate::BackgroundSource =
            serde_json::from_str(r#"{"type":"gradient","from":[0,0,0],"to":[255,255,255]}"#)
                .unwrap();
        assert!(matches!(
            legacy,
            crate::BackgroundSource::Gradient {
                angle: 90,
                animated: None,
                ..
            }
        ));
        assert!(matches!(
            crate::BackgroundSource::default(),
            crate::BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 255
            }
        ));
    }

    #[test]
    fn invalid_settings_are_bounded_and_stops_sorted() {
        let mut config = AnimatedGradientConfig {
            color_stops: vec![
                AnimatedGradientStop {
                    color: [800, 20, 30],
                    position: 150.0,
                },
                AnimatedGradientStop {
                    color: [10, 20, 30],
                    position: -15.0,
                },
            ],
            flow_scale: f32::NAN,
            grain_size: 0.0,
            detail: 1000.0,
            motion_speed: -40.0,
            ..Default::default()
        }
        .normalized();
        assert_eq!(config.flow_scale, 2.0);
        assert_eq!(config.grain_size, 0.5);
        assert_eq!(config.detail, 6.0);
        assert_eq!(config.motion_speed, 0.0);
        assert_eq!(config.color_stops[0].position, 0.0);
        assert_eq!(config.color_stops[1].color[0], 255);
        config.color_stops.clear();
        assert_eq!(config.normalized().color_stops.len(), 5);
    }

    #[test]
    fn seeded_randomizer_is_reproducible_and_varied() {
        let mut results = std::collections::HashSet::new();
        for seed in 0..256 {
            let config = AnimatedGradientConfig::from_seed(seed);
            assert_eq!(config, AnimatedGradientConfig::from_seed(seed));
            assert_eq!(config, config.normalized());
            assert!((3..=5).contains(&config.color_stops.len()));
            assert!(results.insert(serde_json::to_string(&config).unwrap()));
        }
    }

    #[test]
    fn templates_and_control_keys_match_the_serialized_model() {
        let catalog = animated_gradient_catalog();
        assert_eq!(catalog.templates.len(), 12);
        for template in catalog.templates {
            assert_eq!(template.config, template.config.normalized());
        }
        let config = serde_json::to_value(AnimatedGradientConfig::default()).unwrap();
        for control in catalog.controls {
            let key = serde_json::to_value(control.key).unwrap();
            assert!(config.get(key.as_str().unwrap()).unwrap().is_number());
        }
    }
}
