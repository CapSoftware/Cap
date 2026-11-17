const INDEX_MIN_TARGETS: usize = 32;

#[derive(Default)]
pub(super) struct SnapTargets {
    targets: Vec<Target>,
}

struct Target {
    time: f64,
    order: usize,
}

impl SnapTargets {
    pub(super) fn new(times: Vec<f64>) -> Self {
        let mut targets: Vec<_> = times
            .into_iter()
            .enumerate()
            .filter(|(_, time)| !time.is_nan())
            .map(|(order, time)| Target { time, order })
            .collect();
        if targets.len() >= INDEX_MIN_TARGETS {
            targets.sort_unstable_by(|left, right| left.time.total_cmp(&right.time));
            targets.dedup_by(|target, previous| {
                if target.time != previous.time {
                    return false;
                }
                if target.order < previous.order {
                    previous.time = target.time;
                    previous.order = target.order;
                }
                true
            });
        }
        Self { targets }
    }

    pub(super) fn nearest(&self, value: f64, radius: f64) -> Option<f64> {
        self.nearest_target(value, radius)
            .map(|(target, _)| target.time)
    }

    pub(super) fn move_adjustment(&self, start: f64, end: f64, radius: f64) -> Option<(f64, f64)> {
        let mut best: Option<(f64, &Target)> = None;
        for edge in [start, end] {
            let Some((target, distance)) = self.nearest_target(edge, radius) else {
                continue;
            };
            if distance.is_finite()
                && best.is_none_or(|(adjustment, previous)| {
                    distance < adjustment.abs()
                        || (distance == adjustment.abs() && target.order < previous.order)
                })
            {
                best = Some((target.time - edge, target));
            }
        }
        best.map(|(adjustment, target)| (adjustment, target.time))
    }

    fn nearest_target(&self, value: f64, radius: f64) -> Option<(&Target, f64)> {
        if radius < 0.0 {
            return None;
        }
        let candidates =
            if self.targets.len() >= INDEX_MIN_TARGETS && value.is_finite() && radius.is_finite() {
                let split = self.targets.partition_point(|target| target.time < value);
                let nearest_distance = self.targets[..split]
                    .last()
                    .into_iter()
                    .chain(self.targets[split..].first())
                    .map(|target| (target.time - value).abs())
                    .fold(f64::INFINITY, f64::min);
                if nearest_distance > radius {
                    return None;
                }
                // Distinct timestamps can round to the same distance and retain their original priority.
                let mut start = split;
                while start > 0 && (self.targets[start - 1].time - value).abs() <= nearest_distance
                {
                    start -= 1;
                }
                let mut end = split;
                while end < self.targets.len()
                    && (self.targets[end].time - value).abs() <= nearest_distance
                {
                    end += 1;
                }
                &self.targets[start..end]
            } else {
                &self.targets
            };
        let mut best: Option<(&Target, f64)> = None;
        for target in candidates {
            let distance = (target.time - value).abs();
            if distance <= radius
                && best.is_none_or(|(previous, previous_distance)| {
                    distance < previous_distance
                        || (distance == previous_distance && target.order < previous.order)
                })
            {
                best = Some((target, distance));
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::{INDEX_MIN_TARGETS, SnapTargets};

    fn indexed_targets(times: Vec<f64>) -> SnapTargets {
        SnapTargets::new(
            times
                .into_iter()
                .chain((0..INDEX_MIN_TARGETS).map(|index| -1_000_000.0 - index as f64))
                .collect(),
        )
    }

    fn linear_nearest(targets: &[f64], value: f64, radius: f64) -> Option<f64> {
        let mut best: Option<f64> = None;
        for &target in targets {
            let distance = (target - value).abs();
            if distance <= radius && best.is_none_or(|previous| (previous - value).abs() > distance)
            {
                best = Some(target);
            }
        }
        best
    }

    fn linear_move(targets: &[f64], start: f64, end: f64, radius: f64) -> Option<(f64, f64)> {
        let mut best = f64::INFINITY;
        let mut engaged = None;
        for &target in targets {
            for edge in [start, end] {
                let adjust = target - edge;
                if adjust.abs() <= radius && adjust.abs() < best.abs() {
                    best = adjust;
                    engaged = Some(target);
                }
            }
        }
        engaged.map(|target| (best, target))
    }

    fn move_bits(result: Option<(f64, f64)>) -> Option<(u64, u64)> {
        result.map(|(adjustment, target)| (adjustment.to_bits(), target.to_bits()))
    }

    #[test]
    fn nearest_preserves_target_order_for_equal_distances() {
        let targets = indexed_targets(vec![12.0, 8.0, 8.0]);
        assert_eq!(targets.nearest(10.0, 2.0), Some(12.0));
        assert_eq!(targets.nearest(10.0, 1.0), None);
        assert_eq!(targets.nearest(8.0, 0.0), Some(8.0));
        assert_eq!(targets.nearest(8.0, -1.0), None);
        assert_eq!(SnapTargets::default().nearest(8.0, 2.0), None);
    }

    #[test]
    fn moves_prioritize_target_order_then_the_start_edge() {
        assert_eq!(
            indexed_targets(vec![16.0, 10.0]).move_adjustment(9.0, 15.0, 1.0),
            Some((1.0, 16.0))
        );
        assert_eq!(
            indexed_targets(vec![10.0]).move_adjustment(9.0, 11.0, 1.0),
            Some((1.0, 10.0))
        );
    }

    #[test]
    fn rounded_radius_boundaries_remain_inclusive() {
        let lower = f64::from_bits(0.5_f64.to_bits() - 1);
        assert!(lower < 1.0 - 0.5);
        assert_eq!(1.0 - lower, 0.5);
        assert_eq!(indexed_targets(vec![lower]).nearest(1.0, 0.5), Some(lower));
        let upper = -lower;
        assert_eq!(indexed_targets(vec![upper]).nearest(-1.0, 0.5), Some(upper));
    }

    #[test]
    fn rounded_distance_ties_can_span_distinct_targets() {
        let value = 2_f64.powi(55);
        let targets = indexed_targets(vec![0.0, 1.0, 2.0]);
        assert_eq!(targets.nearest(value, value), Some(0.0));
        assert_eq!(
            targets.move_adjustment(value, value, value),
            Some((-value, 0.0))
        );
    }

    #[test]
    fn signed_zero_keeps_the_original_target_bits() {
        for times in [vec![0.0, -0.0], vec![-0.0, 0.0]] {
            let targets = indexed_targets(times.clone());
            for value in [0.0, -0.0] {
                assert_eq!(
                    targets.nearest(value, 0.0).map(f64::to_bits),
                    Some(times[0].to_bits())
                );
                assert_eq!(
                    move_bits(targets.move_adjustment(value, -value, 0.0)),
                    move_bits(linear_move(&times, value, -value, 0.0))
                );
            }
        }
    }

    #[test]
    fn extreme_values_match_the_original_scans() {
        let values = [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::MAX,
            f64::MIN,
            -1.0,
            -f64::MIN_POSITIVE,
            -0.0,
            0.0,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            1.0,
        ];
        for offset in 0..values.len() {
            let mut times = values.to_vec();
            times.rotate_left(offset);
            times.extend((0..INDEX_MIN_TARGETS).map(|index| -1_000_000.0 - index as f64));
            let targets = SnapTargets::new(times.clone());
            for value in values {
                for radius in values {
                    assert_eq!(
                        targets.nearest(value, radius).map(f64::to_bits),
                        linear_nearest(&times, value, radius).map(f64::to_bits)
                    );
                    assert_eq!(
                        move_bits(targets.move_adjustment(value, -value, radius)),
                        move_bits(linear_move(&times, value, -value, radius))
                    );
                }
            }
        }
    }

    #[test]
    fn indexed_lookups_match_the_original_scans_for_varied_timelines() {
        let mut state = 0x5c7e_42b1_09a3_d6f8_u64;
        let mut next = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            state
        };
        for count in [0, 1, 2, 16, 31, 32, 33, 128, 1024] {
            let times: Vec<_> = (0..count).map(|_| (next() % 12000) as f64 / 20.0).collect();
            let targets = SnapTargets::new(times.clone());
            for _ in 0..200 {
                let start = (next() % 12000) as f64 / 20.0;
                let end = start + (next() % 200) as f64 / 20.0;
                let radius = (next() % 200) as f64 / 100.0;
                assert_eq!(
                    targets.nearest(start, radius).map(f64::to_bits),
                    linear_nearest(&times, start, radius).map(f64::to_bits)
                );
                assert_eq!(
                    move_bits(targets.move_adjustment(start, end, radius)),
                    move_bits(linear_move(&times, start, end, radius))
                );
            }
        }
    }

    #[test]
    #[ignore]
    fn benchmark_drag_snapping() {
        use std::{hint::black_box, time::Instant};
        println!("targets,duration,queries,radius,movement,sample,before_ns,after_ns");
        for (count, duration, queries, radius) in [
            (8usize, 600., 120, 0.08),
            (32, 600., 120, 4.8),
            (256, 600., 120, 4.8),
            (2048, 600., 120, 4.8),
            (16384, 3600., 240, 28.8),
        ] {
            let mut times = vec![0., duration * 0.47, duration];
            times.extend((3..count).map(|i| {
                let position = (i * 7919) % count;
                let position = if i.is_multiple_of(19) {
                    position / 8 * 8
                } else {
                    position
                };
                duration * position as f64 / count as f64
            }));
            let values: Vec<_> = (0..queries)
                .map(|i| duration * 0.4 + duration * 0.15 * (i as f64 / (queries - 1) as f64 - 0.5))
                .collect();
            let targets = SnapTargets::new(times.clone());
            for &value in &values {
                assert_eq!(
                    targets.nearest(value, radius).map(f64::to_bits),
                    linear_nearest(&times, value, radius).map(f64::to_bits)
                );
                assert_eq!(
                    move_bits(targets.move_adjustment(value, value + 5., radius)),
                    move_bits(linear_move(&times, value, value + 5., radius))
                );
            }
            for movement in [false, true] {
                let run = |indexed| {
                    let start = Instant::now();
                    if indexed {
                        let targets = SnapTargets::new(black_box(times.clone()));
                        for &value in &values {
                            if movement {
                                black_box(targets.move_adjustment(
                                    black_box(value),
                                    value + 5.,
                                    radius,
                                ));
                            } else {
                                black_box(targets.nearest(black_box(value), radius));
                            }
                        }
                    } else {
                        let targets = black_box(times.clone());
                        for &value in &values {
                            if movement {
                                black_box(linear_move(
                                    &targets,
                                    black_box(value),
                                    value + 5.,
                                    radius,
                                ));
                            } else {
                                black_box(linear_nearest(&targets, black_box(value), radius));
                            }
                        }
                    }
                    start.elapsed().as_nanos()
                };
                for sample in 0..35 {
                    let (before, after) = if sample % 2 == 0 {
                        (run(false), run(true))
                    } else {
                        let after = run(true);
                        (run(false), after)
                    };
                    if sample >= 5 {
                        println!(
                            "{count},{duration},{queries},{radius},{movement},{},{before},{after}",
                            sample - 5
                        );
                    }
                }
            }
        }
    }
}
