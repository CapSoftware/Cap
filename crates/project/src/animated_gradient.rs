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
        Mood::Field.config(COOL_CANDY, 0)
    }
}

/// Aqua to periwinkle to lilac; also the default palette for a fresh animated background.
const COOL_CANDY: [u32; 5] = [0x7ddcf9, 0x6f9bf5, 0x6b6fe8, 0x9a7ff5, 0xc0a6f7];

/// Two families of presets, both built like a blurred colour-field wallpaper:
/// a few adjacent hues at large scale, no specular highlights, fine grain.
/// `Field` is a full-frame colour wash at mid lightness; `Deep` starts from a
/// tinted dark base and lets one or two colours glow out of it.
#[derive(Clone, Copy)]
enum Mood {
    Field,
    Deep,
}

impl Mood {
    fn config(self, palette: [u32; 5], index: usize) -> AnimatedGradientConfig {
        let variation = index as f32;
        match self {
            Self::Field => AnimatedGradientConfig {
                color_stops: stops(palette),
                direction: (30.0 + variation * 33.0) % 360.0,
                flow_scale: 0.8 + (index % 3) as f32 * 0.1,
                flow_strength: 65.0,
                curvature: 75.0,
                detail: 2.0,
                relief: 15.0,
                light: 5.0,
                shade: 20.0,
                ripples: 100.0,
                grain_amount: 7.0,
                grain_size: 1.0,
                exposure: 0.0,
                contrast: 104.0,
                vibrance: 110.0,
                motion_speed: 40.0,
                seed: index as u32 * 137,
            },
            Self::Deep => AnimatedGradientConfig {
                color_stops: stops(palette),
                direction: (20.0 + variation * 37.0) % 360.0,
                flow_scale: 0.9 + (index % 3) as f32 * 0.1,
                flow_strength: 65.0,
                curvature: 80.0,
                detail: 2.0,
                relief: 30.0,
                light: 8.0,
                shade: 40.0,
                ripples: 100.0,
                grain_amount: 8.0,
                grain_size: 1.0,
                exposure: 0.0,
                contrast: 106.0,
                vibrance: 112.0,
                motion_speed: 40.0,
                seed: index as u32 * 137,
            },
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
        // Built from scratch rather than sampled from the templates: any
        // start hue, a pastel / field / deep register, 3-5 stops and freely
        // varied lighting. Only three quality rules survive: stops walk a short
        // arc of adjacent hues (a long arc blends through grey), yellow-green
        // is folded onto gold (olive), and a dark base never sits on orange or
        // green (brown, forest) but leans maroon or navy instead.
        let register = random.next() % 3;
        let deep = register == 0;
        let pastel = register == 1;
        // The arc lives either in the teal -> blue -> violet -> magenta -> red
        // -> orange -> gold sweep or entirely inside green; crossing between
        // the two always blends through olive.
        let (arc_start, arc_end): (f32, f32) = if random.next() % 6 == 0 {
            (120.0, 200.0)
        } else {
            (175.0, 415.0)
        };
        let span = random.range(60.0, (arc_end - arc_start).min(170.0));
        let start = random.range(arc_start, arc_end - span);
        let reversed = random.next() % 2 == 0;
        let hue = if reversed { start + span } else { start };
        let span = if reversed { -span } else { span };
        let count = 3 + (random.next() % 3) as usize;
        let color_stops = (0..count)
            .map(|index| {
                let t = index as f32 / (count - 1) as f32;
                let mut h = (hue + span * t + random.range(-8.0, 8.0)).rem_euclid(360.0);
                // Yellow-green at any lightness is olive; fold that band onto gold.
                if (55.0..105.0).contains(&h) {
                    h = 40.0 + (h - 55.0) * 0.2;
                }
                let (s, l) = if deep {
                    if index == 0 {
                        if (15.0..55.0).contains(&h) {
                            h = 350.0;
                        } else if (105.0..175.0).contains(&h) {
                            h = 205.0;
                        }
                        (random.range(0.5, 0.8), random.range(0.08, 0.16))
                    } else {
                        (
                            random.range(0.6, 0.95),
                            (0.2 + t * 0.5 + random.range(-0.06, 0.06)).clamp(0.2, 0.8),
                        )
                    }
                } else if pastel {
                    (
                        random.range(0.7, 1.0),
                        (0.78 + t * 0.1 + random.range(-0.05, 0.05)).clamp(0.68, 0.9),
                    )
                } else {
                    (
                        random.range(0.7, 0.95),
                        (0.55 + t * 0.15 + random.range(-0.06, 0.06)).clamp(0.45, 0.78),
                    )
                };
                AnimatedGradientStop {
                    color: hsl_color(h, s, l),
                    position: if index == 0 || index == count - 1 {
                        t * 100.0
                    } else {
                        t * 100.0 + random.range(-9.0, 9.0)
                    },
                }
            })
            .collect();
        Self {
            color_stops,
            direction: random.range(0.0, 360.0),
            flow_scale: random.range(0.6, 1.8),
            flow_strength: random.range(40.0, 80.0),
            curvature: random.range(40.0, 95.0),
            detail: random.range(1.0, 4.0),
            relief: if deep {
                random.range(20.0, 55.0)
            } else {
                random.range(5.0, 35.0)
            },
            light: random.range(0.0, 25.0),
            shade: if deep {
                random.range(25.0, 55.0)
            } else {
                random.range(10.0, 35.0)
            },
            ripples: random.range(60.0, 100.0),
            grain_amount: random.range(3.0, 12.0),
            grain_size: random.range(0.7, 1.6),
            exposure: random.range(-4.0, 5.0),
            contrast: random.range(98.0, 112.0),
            vibrance: random.range(95.0, 125.0),
            motion_speed: random.range(30.0, 55.0),
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
    // Seven colour fields (five vibrant, two pastel) then five deep glows.
    // Stops walk a short arc of adjacent hues so every blend stays clean,
    // with the brightest, warmest stop reading as the light source.
    let palettes = [
        (
            "Golden Hour",
            Mood::Field,
            [0xff6a52, 0xff9a4d, 0xf8c56a, 0xe9a8a0, 0xb0a6d8],
        ),
        ("Cool Candy", Mood::Field, COOL_CANDY),
        (
            "Sherbet",
            Mood::Field,
            [0xf9c87e, 0xf28fb7, 0xc86ad8, 0x8467ea, 0x6a9af2],
        ),
        (
            "Good Energy",
            Mood::Field,
            [0x5a35e0, 0x9a4de8, 0xd84fa0, 0xf0705f, 0xf5b85a],
        ),
        (
            "Rain Light",
            Mood::Field,
            [0x5f52b8, 0x6a86d4, 0x58b3cf, 0xc27e8c, 0xe7a58a],
        ),
        (
            "Blush Aqua",
            Mood::Field,
            [0x6fd9e6, 0x9bcdf5, 0xa8a6f0, 0xe3a0c4, 0xf3e6d6],
        ),
        (
            "Blossom",
            Mood::Field,
            [0xd66a5c, 0xe4948f, 0xf0cfa0, 0xc9b3e6, 0xe4eef0],
        ),
        (
            "Moonlit",
            Mood::Deep,
            [0x1a0c4a, 0x4a1478, 0x7b2a9a, 0xb055b0, 0xd48fd0],
        ),
        (
            "Deep Reef",
            Mood::Deep,
            [0x171a44, 0x2a4f8f, 0x2ee0cc, 0x6f69b8, 0xcf62ac],
        ),
        (
            "Ultraviolet",
            Mood::Deep,
            [0x150a3a, 0x3e1fa8, 0x7b3ff0, 0xd056e6, 0xff8a6a],
        ),
        (
            "Nightfall Bloom",
            Mood::Deep,
            [0x120820, 0x3a1a60, 0x7a4fb0, 0xbb8fe8, 0xecd0ff],
        ),
        (
            "Ember Bloom",
            Mood::Deep,
            [0x160809, 0x5a2030, 0xa04f66, 0xe092a8, 0xffd0e0],
        ),
    ];
    AnimatedGradientCatalog {
        default_config: AnimatedGradientConfig::default(),
        templates: palettes
            .into_iter()
            .enumerate()
            .map(|(index, (name, mood, palette))| AnimatedGradientPreset {
                id: format!("template-{index}"),
                name: name.into(),
                config: mood.config(palette, index).normalized(),
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
        assert_eq!(config, config.normalized());
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
        assert_eq!(
            config.flow_scale,
            AnimatedGradientConfig::default().flow_scale
        );
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
