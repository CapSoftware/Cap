use std::hint::black_box;
use std::time::Instant;

fn segment(index: usize, active: bool) -> MaskSegment {
    MaskSegment {
        start: if active { 0.0 } else { 20.0 + index as f64 },
        end: if active { 10.0 } else { 30.0 + index as f64 },
        track: ((index * 97) % 31) as u32,
        enabled: true,
        mask_type: if index % 2 == 0 {
            MaskKind::Sensitive
        } else {
            MaskKind::Highlight
        },
        center: XY::new((index % 10) as f64 / 10.0, 0.5),
        size: XY::new(0.25, 0.25),
        feather: 0.1,
        opacity: 0.7,
        pixelation: 18.0,
        darkness: 0.5,
        fade_duration: 0.15,
        keyframes: Default::default(),
    }
}

fn bits(masks: &[PreparedMask]) -> Vec<u64> {
    masks
        .iter()
        .flat_map(|mask| {
            [
                mask.track as u64,
                mask.center.x.to_bits() as u64,
                mask.center.y.to_bits() as u64,
                mask.size.x.to_bits() as u64,
                mask.size.y.to_bits() as u64,
                mask.feather.to_bits() as u64,
                mask.opacity.to_bits() as u64,
                mask.effect_size.to_bits() as u64,
                mask.darkness.to_bits() as u64,
                mask.mode as u64,
                mask.output_size.x as u64,
                mask.output_size.y as u64,
            ]
        })
        .collect()
}

type Prepare = fn(XY<u32>, f64, &[MaskSegment]) -> Vec<PreparedMask>;

fn elapsed_ns(function: Prepare, segments: &[MaskSegment], iterations: usize) -> (f64, u128) {
    let function = black_box(function);
    let start = Instant::now();
    for frame in 0..iterations {
        let time = 1.0 + (frame % 120) as f64 / 60.0;
        black_box(function(
            black_box(XY::new(1920, 1080)),
            black_box(time),
            black_box(segments),
        ));
    }
    let elapsed = start.elapsed().as_nanos();
    (elapsed as f64 / iterations as f64, elapsed)
}

fn iterations(function: Prepare, segments: &[MaskSegment], target_ms: usize) -> usize {
    let warmup = elapsed_ns(function, segments, 1200).0;
    let initial = ((target_ms as f64 * 1_000_000.0 / warmup).clamp(120.0, 16_000_000.0) as usize
        / 120)
        .max(1)
        * 120;
    let calibrated = elapsed_ns(function, segments, initial).0;
    ((target_ms as f64 * 1_000_000.0 / calibrated).clamp(120.0, 16_000_000.0) as usize / 120).max(1)
        * 120
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let samples = args
        .get(1)
        .map_or(24, |value| value.parse::<usize>().unwrap());
    let target_ms = args
        .get(2)
        .map_or(30, |value| value.parse::<usize>().unwrap());
    let process = args
        .get(3)
        .map_or(0, |value| value.parse::<usize>().unwrap());
    println!(
        "case,total,active,sample,order,baseline_iterations,candidate_iterations,baseline_ns,candidate_ns,baseline_elapsed_ns,candidate_elapsed_ns"
    );
    let mut cases = vec![
        ("empty", 0, 0, false, false),
        ("one_active", 1, 1, false, false),
        ("one_inactive", 1, 0, false, false),
        ("eight_all_active", 8, 8, false, false),
        ("16_one_active", 16, 1, false, false),
        ("64_one_active", 64, 1, false, false),
        ("256_four_active", 256, 4, false, false),
        ("1024_four_active", 1024, 4, false, false),
        ("1024_none_active", 1024, 0, false, false),
        ("256_all_active", 256, 256, false, false),
        ("256_same_track", 256, 4, true, false),
        ("4096_stress_four_active", 4096, 4, false, false),
        ("control_empty", 0, 0, false, true),
        ("control_256_four_active", 256, 4, false, true),
        ("control_256_all_active", 256, 256, false, true),
    ];
    let count = cases.len();
    cases.rotate_left((process * 7) % count);
    for (name, total, active, same_track, is_control) in cases {
        let segments = (0..total)
            .map(|i| {
                let mut item = segment(i, total > 0 && (i * 97) % total < active);
                if i % 2 == 0 && item.start > 10.0 {
                    item.start = -20.0 - i as f64;
                    item.end = -10.0 - i as f64;
                }
                if same_track {
                    item.track = 0;
                }
                item
            })
            .collect::<Vec<_>>();
        let candidate: Prepare = if is_control {
            control::interpolate_masks
        } else {
            candidate::interpolate_masks
        };
        assert_eq!(
            bits(&baseline::interpolate_masks(
                XY::new(1920, 1080),
                2.0,
                &segments
            )),
            bits(&candidate(XY::new(1920, 1080), 2.0, &segments))
        );
        let old_iterations = iterations(baseline::interpolate_masks, &segments, target_ms);
        let new_iterations = iterations(candidate, &segments, target_ms);
        for sample in 0..samples {
            let baseline_first = matches!((sample + process * 2) % 4, 0 | 3);
            let (old, new) = if baseline_first {
                (
                    elapsed_ns(baseline::interpolate_masks, &segments, old_iterations),
                    elapsed_ns(candidate, &segments, new_iterations),
                )
            } else {
                let new = elapsed_ns(candidate, &segments, new_iterations);
                let old = elapsed_ns(baseline::interpolate_masks, &segments, old_iterations);
                (old, new)
            };
            let order = if baseline_first { "BC" } else { "CB" };
            println!(
                "{name},{total},{active},{sample},{order},{old_iterations},{new_iterations},{:.3},{:.3},{},{}",
                old.0, new.0, old.1, new.1
            );
        }
    }
}

#[cfg(test)]
mod differential_tests {
    use super::*;

    #[test]
    fn exact_output_for_generated_timelines_and_boundary_values() {
        let times = [
            f64::NEG_INFINITY,
            -1.0,
            0.0,
            0.15,
            5.0,
            9.85,
            10.0,
            20.0,
            30.0,
            100.0,
            f64::INFINITY,
            f64::NAN,
        ];
        let mut state = 0x8312_9894_0012_u64;
        for trial in 0..200 {
            let mut segments = Vec::new();
            for index in 0..(trial % 80) {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let mut item = segment(index, state % 3 == 0);
                item.enabled = state % 7 != 0;
                item.track = (state % 9) as u32;
                if state % 11 == 0 {
                    item.start = f64::NAN;
                }
                if state % 13 == 0 {
                    item.end = f64::NAN;
                }
                if state % 17 == 0 {
                    item.end = item.start - 1.0;
                }
                item.keyframes.position = vec![
                    MaskVectorKeyframe {
                        time: 8.0,
                        x: 0.8,
                        y: 0.2,
                    },
                    MaskVectorKeyframe {
                        time: 2.0,
                        x: 0.1,
                        y: 0.9,
                    },
                    MaskVectorKeyframe {
                        time: 2.0,
                        x: 0.3,
                        y: 0.7,
                    },
                ];
                item.keyframes.intensity = vec![
                    MaskScalarKeyframe {
                        time: 5.0,
                        value: 0.3,
                    },
                    MaskScalarKeyframe {
                        time: 1.0,
                        value: 0.8,
                    },
                ];
                segments.push(item);
            }
            for time in times {
                assert_eq!(
                    bits(&baseline::interpolate_masks(
                        XY::new(3840, 2160),
                        time,
                        &segments
                    )),
                    bits(&candidate::interpolate_masks(
                        XY::new(3840, 2160),
                        time,
                        &segments
                    )),
                    "trial {trial}, time {time}"
                );
            }
        }
    }
}
