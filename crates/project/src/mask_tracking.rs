use std::borrow::Cow;

use crate::{MaskScalarKeyframe, MaskSegment, MaskVectorKeyframe, XY};

const MARKER_TIME_EPSILON: f64 = 1e-3;

impl MaskSegment {
    pub fn rect_at(&self, relative_time: f64) -> (XY<f64>, XY<f64>) {
        (
            interpolate_vector(self.center, &self.keyframes.position, relative_time),
            interpolate_vector(self.size, &self.keyframes.size, relative_time),
        )
    }

    pub fn intensity_at(&self, relative_time: f64) -> f64 {
        interpolate_scalar(self.opacity, &self.keyframes.intensity, relative_time)
    }

    pub fn is_tracked(&self) -> bool {
        !self.keyframes.position.is_empty() || !self.keyframes.size.is_empty()
    }

    pub fn tracking_marker_times(&self) -> Vec<f64> {
        let duration = self.end - self.start;
        let mut times = self
            .keyframes
            .position
            .iter()
            .chain(&self.keyframes.size)
            .map(|key| key.time)
            .filter(|time| *time >= -MARKER_TIME_EPSILON && *time <= duration + MARKER_TIME_EPSILON)
            .collect::<Vec<_>>();
        times.sort_by(f64::total_cmp);
        times.dedup_by(|a, b| same_marker_time(*a, *b));
        times
    }

    pub fn tracking_marker_at(&self, relative_time: f64) -> Option<f64> {
        self.tracking_marker_times()
            .into_iter()
            .find(|time| same_marker_time(*time, relative_time))
    }

    pub fn set_rect_at(&mut self, relative_time: f64, center: XY<f64>, size: XY<f64>) {
        if self.is_tracked() {
            upsert_vector_keyframe(&mut self.keyframes.position, relative_time, center);
            upsert_vector_keyframe(&mut self.keyframes.size, relative_time, size);
        } else {
            self.center = center;
            self.size = size;
        }
    }

    pub fn add_tracking_marker(&mut self, relative_time: f64) {
        let (center, size) = self.rect_at(relative_time);
        upsert_vector_keyframe(&mut self.keyframes.position, relative_time, center);
        upsert_vector_keyframe(&mut self.keyframes.size, relative_time, size);
    }

    pub fn remove_tracking_marker(&mut self, relative_time: f64) {
        let (center, size) = self.rect_at(relative_time);
        self.keyframes
            .position
            .retain(|key| !same_marker_time(key.time, relative_time));
        self.keyframes
            .size
            .retain(|key| !same_marker_time(key.time, relative_time));
        if !self.is_tracked() {
            self.center = center;
            self.size = size;
        }
    }

    pub fn clear_tracking_markers(&mut self, relative_time: f64) {
        (self.center, self.size) = self.rect_at(relative_time);
        self.keyframes.position.clear();
        self.keyframes.size.clear();
    }

    pub fn apply_tracked_path(&mut self, path: &[(f64, XY<f64>, XY<f64>)], tolerance: f64) {
        let (Some(first), Some(last)) = (path.first(), path.last()) else {
            return;
        };
        let (from, to) = (first.0, last.0);
        let mut kept = vec![false; path.len()];
        kept[0] = true;
        kept[path.len() - 1] = true;
        simplify_path(path, 0, path.len() - 1, tolerance, &mut kept);
        let markers = path
            .iter()
            .zip(kept)
            .filter(|(_, keep)| *keep)
            .map(|(&point, _)| point)
            .collect::<Vec<_>>();

        let outside =
            |time: f64| time < from - MARKER_TIME_EPSILON || time > to + MARKER_TIME_EPSILON;
        self.keyframes.position.retain(|key| outside(key.time));
        self.keyframes.size.retain(|key| outside(key.time));
        for (time, center, size) in markers {
            upsert_vector_keyframe(&mut self.keyframes.position, time, center);
            upsert_vector_keyframe(&mut self.keyframes.size, time, size);
        }
    }
}

fn simplify_path(
    path: &[(f64, XY<f64>, XY<f64>)],
    first: usize,
    last: usize,
    tolerance: f64,
    kept: &mut [bool],
) {
    if last <= first + 1 {
        return;
    }
    let (start_time, start_center, start_size) = path[first];
    let (end_time, end_center, end_size) = path[last];
    let span = (end_time - start_time).max(1e-9);
    let deviation = |start: XY<f64>, end: XY<f64>, point: XY<f64>, t: f64| {
        (point.x - (start.x + (end.x - start.x) * t))
            .hypot(point.y - (start.y + (end.y - start.y) * t))
    };
    let (farthest, distance) = (first + 1..last)
        .map(|index| {
            let (time, center, size) = path[index];
            let t = (time - start_time) / span;
            (
                index,
                deviation(start_center, end_center, center, t)
                    .max(deviation(start_size, end_size, size, t) / 2.0),
            )
        })
        .fold((first, 0.0), |best, candidate| {
            if candidate.1 > best.1 {
                candidate
            } else {
                best
            }
        });
    if distance > tolerance {
        kept[farthest] = true;
        simplify_path(path, first, farthest, tolerance, kept);
        simplify_path(path, farthest, last, tolerance, kept);
    }
}

fn same_marker_time(a: f64, b: f64) -> bool {
    (a - b).abs() <= MARKER_TIME_EPSILON
}

fn upsert_vector_keyframe(keys: &mut Vec<MaskVectorKeyframe>, time: f64, value: XY<f64>) {
    if let Some(existing) = keys
        .iter_mut()
        .find(|existing| same_marker_time(existing.time, time))
    {
        existing.x = value.x;
        existing.y = value.y;
        return;
    }
    let index = keys.partition_point(|existing| existing.time < time);
    keys.insert(
        index,
        MaskVectorKeyframe {
            time,
            x: value.x,
            y: value.y,
        },
    );
}

fn sorted_by_time<T: Clone>(keys: &[T], time: impl Fn(&T) -> f64) -> Cow<'_, [T]> {
    if keys.is_sorted_by(|a, b| time(a) <= time(b)) {
        return Cow::Borrowed(keys);
    }

    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| {
        time(a)
            .partial_cmp(&time(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Cow::Owned(sorted)
}

fn interpolate_vector(base: XY<f64>, keys: &[MaskVectorKeyframe], time: f64) -> XY<f64> {
    if keys.is_empty() {
        return base;
    }

    let sorted = sorted_by_time(keys, |key| key.time);

    if time <= sorted[0].time {
        return XY::new(sorted[0].x, sorted[0].y);
    }

    for window in sorted.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        if time <= next.time {
            let span = (next.time - prev.time).max(1e-6);
            let t = ((time - prev.time) / span).clamp(0.0, 1.0);
            let x = prev.x + (next.x - prev.x) * t;
            let y = prev.y + (next.y - prev.y) * t;
            return XY::new(x, y);
        }
    }

    let last = sorted.last().unwrap();
    XY::new(last.x, last.y)
}

fn interpolate_scalar(base: f64, keys: &[MaskScalarKeyframe], time: f64) -> f64 {
    if keys.is_empty() {
        return base;
    }

    let sorted = sorted_by_time(keys, |key| key.time);

    if time <= sorted[0].time {
        return sorted[0].value;
    }

    for window in sorted.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        if time <= next.time {
            let span = (next.time - prev.time).max(1e-6);
            let t = ((time - prev.time) / span).clamp(0.0, 1.0);
            return prev.value + (next.value - prev.value) * t;
        }
    }

    sorted.last().map(|k| k.value).unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask() -> MaskSegment {
        serde_json::from_value(serde_json::json!({
            "start": 10.0,
            "end": 20.0,
            "maskType": "sensitive",
            "center": { "x": 0.5, "y": 0.5 },
            "size": { "x": 0.2, "y": 0.2 }
        }))
        .unwrap()
    }

    #[test]
    fn tracking_markers_pin_the_rect_and_interpolate_between_them() {
        let mut mask = mask();

        mask.set_rect_at(1.0, XY::new(0.1, 0.1), XY::new(0.3, 0.3));
        assert!(!mask.is_tracked());
        assert_eq!(mask.center, XY::new(0.1, 0.1));

        mask.add_tracking_marker(0.0);
        mask.set_rect_at(4.0, XY::new(0.9, 0.5), XY::new(0.3, 0.3));
        assert_eq!(mask.tracking_marker_times(), vec![0.0, 4.0]);
        let (center, size) = mask.rect_at(1.0);
        assert!((center.x - 0.3).abs() < 1e-9 && (center.y - 0.2).abs() < 1e-9);
        assert_eq!(size, XY::new(0.3, 0.3));

        mask.set_rect_at(4.0004, XY::new(0.8, 0.5), XY::new(0.3, 0.3));
        assert_eq!(mask.tracking_marker_times(), vec![0.0, 4.0]);
        assert_eq!(mask.tracking_marker_at(3.9995), Some(4.0));

        mask.remove_tracking_marker(0.0);
        assert_eq!(mask.rect_at(1.0).0, XY::new(0.8, 0.5));
        mask.remove_tracking_marker(4.0);
        assert!(!mask.is_tracked());
        assert_eq!(mask.center, XY::new(0.8, 0.5));

        mask.keyframes.position.push(MaskVectorKeyframe {
            time: -2.0,
            x: 0.4,
            y: 0.4,
        });
        assert!(mask.is_tracked());
        assert!(mask.tracking_marker_times().is_empty());
    }

    #[test]
    fn a_tracked_path_keeps_only_the_corners_and_markers_outside_it() {
        let mut mask = mask();
        mask.add_tracking_marker(0.5);
        mask.add_tracking_marker(9.0);
        mask.set_rect_at(9.0, XY::new(0.7, 0.7), XY::new(0.25, 0.1));

        let corner = |time: f64| {
            if time <= 3.0 {
                XY::new(0.1 + 0.1 * (time - 1.0), 0.2)
            } else {
                XY::new(0.3, 0.2 + 0.05 * (time - 3.0))
            }
        };
        let path = (0..=40)
            .map(|step| {
                let time = 1.0 + f64::from(step) / 10.0;
                let jitter = if step % 2 == 0 { 0.001 } else { -0.001 };
                let point = corner(time);
                let size = 0.2 + 0.02 * (time - 1.0);
                (time, XY::new(point.x + jitter, point.y), XY::new(size, 0.1))
            })
            .collect::<Vec<_>>();

        mask.apply_tracked_path(&path, 0.004);

        assert_eq!(mask.tracking_marker_times(), vec![0.5, 1.0, 3.0, 5.0, 9.0]);
        for time in [1.5, 2.5, 3.5, 4.5] {
            let (center, _) = mask.rect_at(time);
            let expected = corner(time);
            assert!(
                (center.x - expected.x).abs() < 0.004 && (center.y - expected.y).abs() < 0.004,
                "{time}: {center:?} vs {expected:?}"
            );
        }
        assert_eq!(mask.rect_at(9.0).0, XY::new(0.7, 0.7));
        let size = mask.rect_at(4.2).1;
        assert!(
            (size.x - 0.264).abs() < 1e-9 && (size.y - 0.1).abs() < 1e-9,
            "{size:?}"
        );
        assert_eq!(mask.rect_at(0.5).1, XY::new(0.2, 0.2));
    }

    fn old_interpolate_vector(base: XY<f64>, keys: &[MaskVectorKeyframe], time: f64) -> XY<f64> {
        if keys.is_empty() {
            return base;
        }

        let mut sorted = keys.to_vec();
        sorted.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if time <= sorted[0].time {
            return XY::new(sorted[0].x, sorted[0].y);
        }

        for window in sorted.windows(2) {
            let prev = &window[0];
            let next = &window[1];
            if time <= next.time {
                let span = (next.time - prev.time).max(1e-6);
                let t = ((time - prev.time) / span).clamp(0.0, 1.0);
                let x = prev.x + (next.x - prev.x) * t;
                let y = prev.y + (next.y - prev.y) * t;
                return XY::new(x, y);
            }
        }

        let last = sorted.last().unwrap();
        XY::new(last.x, last.y)
    }

    fn old_interpolate_scalar(base: f64, keys: &[MaskScalarKeyframe], time: f64) -> f64 {
        if keys.is_empty() {
            return base;
        }

        let mut sorted = keys.to_vec();
        sorted.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if time <= sorted[0].time {
            return sorted[0].value;
        }

        for window in sorted.windows(2) {
            let prev = &window[0];
            let next = &window[1];
            if time <= next.time {
                let span = (next.time - prev.time).max(1e-6);
                let t = ((time - prev.time) / span).clamp(0.0, 1.0);
                return prev.value + (next.value - prev.value) * t;
            }
        }

        sorted.last().map(|k| k.value).unwrap_or(base)
    }

    fn vector_key(time: f64, x: f64, y: f64) -> MaskVectorKeyframe {
        MaskVectorKeyframe { time, x, y }
    }

    fn scalar_key(time: f64, value: f64) -> MaskScalarKeyframe {
        MaskScalarKeyframe { time, value }
    }

    const QUERY_TIMES: [f64; 13] = [
        f64::NEG_INFINITY,
        -1.0,
        0.0,
        0.25,
        0.5,
        1.0,
        1.5,
        2.0,
        2.5,
        3.0,
        f64::INFINITY,
        f64::NAN,
        -0.0,
    ];

    #[test]
    fn keyframe_order_does_not_change_interpolation() {
        let sorted = vec![
            vector_key(0.0, 0.1, 0.2),
            vector_key(1.0, 0.4, 0.3),
            vector_key(1.0, 0.6, 0.1),
            vector_key(2.5, 0.9, 0.8),
        ];
        let mut unsorted = sorted.clone();
        unsorted.swap(0, 3);
        unsorted.swap(1, 3);
        let vector_cases = [
            sorted.clone(),
            unsorted,
            vec![],
            vec![vector_key(1.0, 0.3, 0.7)],
            vec![
                vector_key(2.0, 0.9, 0.9),
                vector_key(f64::NAN, 0.5, 0.5),
                vector_key(0.0, 0.1, 0.1),
            ],
            vec![
                vector_key(0.0, 0.1, 0.1),
                vector_key(f64::NAN, 0.5, 0.5),
                vector_key(2.0, 0.9, 0.9),
            ],
            vec![
                vector_key(f64::NEG_INFINITY, 0.2, 0.2),
                vector_key(f64::INFINITY, 0.8, 0.8),
            ],
        ];

        let scalar_sorted = vec![
            scalar_key(0.5, 0.2),
            scalar_key(1.0, 0.4),
            scalar_key(1.0, 0.7),
            scalar_key(2.0, 0.9),
        ];
        let scalar_cases = [
            scalar_sorted.iter().rev().cloned().collect::<Vec<_>>(),
            scalar_sorted,
            vec![],
            vec![scalar_key(1.0, 0.6)],
            vec![
                scalar_key(1.0, 0.6),
                scalar_key(f64::NAN, 0.1),
                scalar_key(0.0, 0.3),
            ],
            vec![
                scalar_key(0.0, 0.3),
                scalar_key(f64::NAN, 0.1),
                scalar_key(1.0, 0.6),
            ],
        ];

        let base = XY::new(0.5, 0.5);
        for time in QUERY_TIMES {
            for keys in &vector_cases {
                let expected = old_interpolate_vector(base, keys, time);
                let actual = interpolate_vector(base, keys, time);
                assert_eq!(
                    (actual.x.to_bits(), actual.y.to_bits()),
                    (expected.x.to_bits(), expected.y.to_bits()),
                    "time {time} keys {keys:?}"
                );
            }
            for keys in &scalar_cases {
                assert_eq!(
                    interpolate_scalar(0.3, keys, time).to_bits(),
                    old_interpolate_scalar(0.3, keys, time).to_bits(),
                    "time {time} keys {keys:?}"
                );
            }
        }
    }

    #[test]
    fn only_out_of_order_or_non_finite_keyframes_are_cloned() {
        let time = |key: &MaskVectorKeyframe| key.time;
        let in_order = [
            vector_key(0.0, 0.0, 0.0),
            vector_key(1.0, 1.0, 1.0),
            vector_key(1.0, 0.5, 0.5),
            vector_key(2.0, 0.2, 0.2),
        ];
        assert!(matches!(sorted_by_time(&in_order, time), Cow::Borrowed(_)));
        assert!(matches!(
            sorted_by_time(&in_order[..1], time),
            Cow::Borrowed(_)
        ));
        assert!(matches!(sorted_by_time(&[], time), Cow::Borrowed(_)));

        let out_of_order = [vector_key(1.0, 0.0, 0.0), vector_key(0.0, 1.0, 1.0)];
        assert!(matches!(sorted_by_time(&out_of_order, time), Cow::Owned(_)));

        let with_nan = [
            vector_key(0.0, 0.0, 0.0),
            vector_key(f64::NAN, 0.5, 0.5),
            vector_key(2.0, 1.0, 1.0),
        ];
        assert!(matches!(sorted_by_time(&with_nan, time), Cow::Owned(_)));
    }
}
