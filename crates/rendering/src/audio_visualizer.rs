//! The visualiser an audio-only recording can be exported with. It draws from
//! a loudness envelope of each clip (ten values a second, the resolution of
//! the editor's waveform) with the shape layer's instanced SDF pipeline, so
//! preview and export draw the same frame from the same numbers.

use cap_project::{AudioVisualizerStyle, AudioVisualsConfiguration, ShapeArrowHead, ShapeKind};

use crate::shape::{PreparedShape, parse_shape_color};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioLevels {
    pub clips: Vec<Vec<f32>>,
}

pub const LEVELS_PER_SECOND: f64 = 10.0;
const FLOOR_DB: f32 = -50.0;

impl AudioLevels {
    /// Combines the microphone and system audio waveform peaks (dB of the mean
    /// absolute sample per tenth of a second, as `waveform_peaks` returns
    /// them) into one level per tenth of a second for every clip.
    pub fn from_waveform_peaks(mic: &[impl AsRef<[f32]>], system: &[impl AsRef<[f32]>]) -> Self {
        let clips = mic.len().max(system.len());
        let empty: &[f32] = &[];
        Self {
            clips: (0..clips)
                .map(|index| {
                    let mic = mic.get(index).map_or(empty, AsRef::as_ref);
                    let system = system.get(index).map_or(empty, AsRef::as_ref);
                    (0..mic.len().max(system.len()))
                        .map(|slot| {
                            let amplitude = [mic.get(slot), system.get(slot)]
                                .into_iter()
                                .flatten()
                                .map(|db| 10f32.powf(db / 20.0))
                                .sum::<f32>();
                            level_from_amplitude(amplitude)
                        })
                        .collect()
                })
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.clips.iter().all(Vec::is_empty)
    }

    /// Level at `time` seconds into `clip`, read between the two nearest
    /// values so the visualiser moves smoothly at any frame rate.
    pub fn level_at(&self, clip: usize, time: f64) -> f32 {
        let Some(levels) = self.clips.get(clip).filter(|levels| !levels.is_empty()) else {
            return 0.0;
        };
        if !time.is_finite() || time < 0.0 {
            return 0.0;
        }
        let position = time * LEVELS_PER_SECOND;
        let index = position.floor() as usize;
        if index >= levels.len() {
            return 0.0;
        }
        let next = levels.get(index + 1).copied().unwrap_or(0.0);
        let fraction = (position - index as f64) as f32;
        levels[index] + (next - levels[index]) * fraction
    }
}

fn level_from_amplitude(amplitude: f32) -> f32 {
    if !(amplitude.is_finite() && amplitude > 0.0) {
        return 0.0;
    }
    let db = 20.0 * amplitude.log10();
    ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

const BAR_COUNT: usize = 48;
const WAVE_POINTS: usize = 64;
const CIRCLE_BARS: usize = 72;
/// Each step outwards from the centre shows the sound this much earlier, so
/// the newest sound sits in the middle and spreads out as it ages.
const HISTORY_STEP_SECS: f64 = 0.05;

pub fn visualizer_shapes(
    config: &AudioVisualsConfiguration,
    levels: &AudioLevels,
    clip: usize,
    time: f64,
    output_size: (u32, u32),
) -> Vec<PreparedShape> {
    let (width, height) = (output_size.0 as f32, output_size.1 as f32);
    if !config.enabled || width <= 0.0 || height <= 0.0 {
        return Vec::new();
    }
    let unit = height / cap_project::SHAPE_REFERENCE_HEIGHT as f32;
    let color = parse_shape_color(&config.color).unwrap_or([1.0, 1.0, 1.0]);
    let size = config.clamped_size();
    let center = [width * 0.5, height * 0.5];
    let history = |step: usize| levels.level_at(clip, time - step as f64 * HISTORY_STEP_SECS);
    let shape = |kind: ShapeKind, from: [f32; 2], to: [f32; 2], stroke_width: f32| PreparedShape {
        track: 0,
        kind,
        from,
        to,
        stroke_width,
        stroke_color: color,
        fill: (kind == ShapeKind::Rectangle).then_some([color[0], color[1], color[2], 1.0]),
        corner_radius: 0.0,
        arrow_head: ShapeArrowHead::Filled,
        shadow: 0.0,
        alpha: 1.0,
        draw: 1.0,
        unit,
        number: 0,
    };

    match config.style {
        AudioVisualizerStyle::Bars => {
            let span = width * size;
            let pitch = span / BAR_COUNT as f32;
            let bar_width = pitch * 0.55;
            let max_height = height * size * 0.5;
            let left = center[0] - span * 0.5;
            (0..BAR_COUNT)
                .map(|index| {
                    let step = (index as isize * 2 + 1 - BAR_COUNT as isize).unsigned_abs() / 2;
                    let bar_height = (history(step) * max_height).max(bar_width);
                    let x = left + pitch * (index as f32 + 0.5);
                    let mut bar = shape(
                        ShapeKind::Rectangle,
                        [x - bar_width * 0.5, center[1] - bar_height * 0.5],
                        [x + bar_width * 0.5, center[1] + bar_height * 0.5],
                        0.0,
                    );
                    bar.corner_radius = bar_width * 0.5;
                    bar
                })
                .collect()
        }
        AudioVisualizerStyle::Wave => {
            let span = width * size;
            let amplitude = height * size * 0.25;
            let left = center[0] - span * 0.5;
            let stroke = (4.0 * unit).max(1.0);
            let points = (0..WAVE_POINTS)
                .map(|index| {
                    let position = index as f32 / (WAVE_POINTS - 1) as f32;
                    let step = (index as isize * 2 + 1 - WAVE_POINTS as isize).unsigned_abs() / 2;
                    let taper = (std::f32::consts::PI * position).sin();
                    let swing = if index % 2 == 0 { 1.0 } else { -1.0 };
                    [
                        left + span * position,
                        center[1] + swing * history(step) * amplitude * taper,
                    ]
                })
                .collect::<Vec<_>>();
            points
                .windows(2)
                .map(|pair| shape(ShapeKind::Line, pair[0], pair[1], stroke))
                .collect()
        }
        AudioVisualizerStyle::Circle => {
            let radius = width.min(height) * size * 0.3;
            let reach = radius * 0.6;
            let stroke = (std::f32::consts::TAU * radius / CIRCLE_BARS as f32 * 0.45).max(1.0);
            (0..CIRCLE_BARS)
                .map(|index| {
                    let angle = std::f32::consts::TAU * index as f32 / CIRCLE_BARS as f32
                        - std::f32::consts::FRAC_PI_2;
                    let half = CIRCLE_BARS / 2;
                    let step = if index <= half {
                        index
                    } else {
                        CIRCLE_BARS - index
                    };
                    let length = history(step) * reach + stroke * 0.5;
                    let (sin, cos) = angle.sin_cos();
                    shape(
                        ShapeKind::Line,
                        [center[0] + cos * radius, center[1] + sin * radius],
                        [
                            center[0] + cos * (radius + length),
                            center[1] + sin * (radius + length),
                        ],
                        stroke,
                    )
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visuals(style: AudioVisualizerStyle) -> AudioVisualsConfiguration {
        AudioVisualsConfiguration {
            enabled: true,
            style,
            ..Default::default()
        }
    }

    #[test]
    fn levels_combine_tracks_and_floor_silence() {
        let levels = AudioLevels::from_waveform_peaks(&[vec![0.0, -60.0]], &[vec![-60.0]]);
        assert_eq!(levels.clips.len(), 1);
        assert_eq!(levels.clips[0][0], 1.0);
        assert_eq!(levels.clips[0][1], 0.0);
        let only_system = AudioLevels::from_waveform_peaks(&Vec::<Vec<f32>>::new(), &[vec![-25.0]]);
        assert!((only_system.clips[0][0] - 0.5).abs() < 1.0e-4);
    }

    #[test]
    fn level_at_interpolates_and_is_silent_outside_the_clip() {
        let levels = AudioLevels {
            clips: vec![vec![0.0, 1.0]],
        };
        assert!((levels.level_at(0, 0.05) - 0.5).abs() < 1.0e-5);
        assert_eq!(levels.level_at(0, -1.0), 0.0);
        assert_eq!(levels.level_at(0, 5.0), 0.0);
        assert_eq!(levels.level_at(3, 0.0), 0.0);
        assert_eq!(levels.level_at(0, f64::NAN), 0.0);
    }

    #[test]
    fn disabled_visuals_draw_nothing() {
        let levels = AudioLevels {
            clips: vec![vec![1.0; 20]],
        };
        let config = AudioVisualsConfiguration::default();
        assert!(visualizer_shapes(&config, &levels, 0, 1.0, (1920, 1080)).is_empty());
    }

    #[test]
    fn every_style_stays_inside_the_frame() {
        let levels = AudioLevels {
            clips: vec![vec![1.0; 40]],
        };
        for style in AudioVisualizerStyle::ALL {
            for size in [0.2, 0.6, 1.0] {
                let config = AudioVisualsConfiguration {
                    size,
                    ..visuals(style)
                };
                let shapes = visualizer_shapes(&config, &levels, 0, 2.0, (1920, 1080));
                assert!(!shapes.is_empty(), "{style:?}");
                for shape in shapes {
                    for [x, y] in [shape.from, shape.to] {
                        assert!((0.0..=1920.0).contains(&x), "{style:?} {size} x {x}");
                        assert!((0.0..=1080.0).contains(&y), "{style:?} {size} y {y}");
                    }
                }
            }
        }
    }

    #[test]
    fn bars_are_symmetric_and_follow_the_level() {
        let quiet = AudioLevels {
            clips: vec![vec![0.0; 40]],
        };
        let loud = AudioLevels {
            clips: vec![vec![1.0; 40]],
        };
        let config = visuals(AudioVisualizerStyle::Bars);
        let height = |shape: &PreparedShape| shape.to[1] - shape.from[1];
        let quiet = visualizer_shapes(&config, &quiet, 0, 3.0, (1920, 1080));
        let loud = visualizer_shapes(&config, &loud, 0, 3.0, (1920, 1080));
        assert_eq!(loud.len(), BAR_COUNT);
        assert!(height(&loud[BAR_COUNT / 2]) > height(&quiet[BAR_COUNT / 2]) * 5.0);
        for index in 0..BAR_COUNT / 2 {
            let mirrored = BAR_COUNT - 1 - index;
            assert!((height(&loud[index]) - height(&loud[mirrored])).abs() < 1.0e-3);
        }
    }
}
