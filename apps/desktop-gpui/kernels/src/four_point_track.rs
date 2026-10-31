use crate::motion_track::{
    BRIDGED_GAP, HOLD_LEAD, LumaFrame, MotionTracker, Pyramid, TrackPoint, TrackSession,
};

type Point = (f64, f64);

struct AnchorTracker {
    tracker: MotionTracker,
    anchor: Point,
    offset: Point,
}

pub struct FourPointSession {
    region: TrackSession,
    trackers: [MotionTracker; 4],
    anchors: [Point; 4],
    offsets: [Point; 4],
    patch_size: Point,
    initial_size: Point,
    corners: Vec<(f64, [Point; 4])>,
    unresolved: Vec<f64>,
    supplemental: Vec<AnchorTracker>,
}

impl FourPointSession {
    pub fn new(frame: &LumaFrame, time: f64, selected: impl AsRef<[Point]>) -> Option<Self> {
        let selected = selected.as_ref();
        if selected.len() < 4
            || selected.iter().any(|&(x, y)| {
                !x.is_finite()
                    || !y.is_finite()
                    || !(0.0..=1.0).contains(&x)
                    || !(0.0..=1.0).contains(&y)
            })
        {
            return None;
        }
        let mut points: [Point; 4] = selected[..4].try_into().ok()?;
        points.sort_by(|a, b| a.1.total_cmp(&b.1));
        points[..2].sort_by(|a, b| a.0.total_cmp(&b.0));
        points[2..].sort_by(|a, b| b.0.total_cmp(&a.0));
        let inside = region_at(time, points)?;
        let left = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let top = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let right = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let bottom = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
        let size = (right - left, bottom - top);
        let region = TrackSession::new(
            frame,
            time,
            ((left + right) / 2.0, (top + bottom) / 2.0),
            size,
        )?;
        let (width, height) = (frame.width() as f64, frame.height() as f64);
        let side = 16.0_f64
            .min(inside.size.0 * width / 2.0)
            .min(inside.size.1 * height / 2.0)
            .floor();
        if side < 8.0 {
            return None;
        }
        let mut trackers = Vec::with_capacity(4);
        let mut offsets = [(0.0, 0.0); 4];
        let anchors = points.map(|p| ((p.0 - left) / size.0, (p.1 - top) / size.1));
        for (index, point) in points.into_iter().enumerate() {
            let (tracker, offset) = anchor_tracker(frame, point, side)?;
            offsets[index] = offset;
            trackers.push(tracker);
        }
        let supplemental = selected[4..]
            .iter()
            .map(|&point| {
                let (tracker, offset) = anchor_tracker(frame, point, side)?;
                Some(AnchorTracker {
                    tracker,
                    anchor: ((point.0 - left) / size.0, (point.1 - top) / size.1),
                    offset,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            region,
            trackers: trackers.try_into().ok()?,
            anchors,
            offsets,
            patch_size: (side / width, side / height),
            initial_size: size,
            corners: vec![(time, points)],
            unresolved: Vec::new(),
            supplemental,
        })
    }

    pub fn push(&mut self, time: f64, frame: LumaFrame) {
        let pyramid = Pyramid::new(&frame);
        self.region.push_pyramid(time, &pyramid);
        let (region, confidence) = self.region.latest();
        let (width, height) = (frame.width() as f64, frame.height() as f64);
        let mut local = self.trackers.clone();
        let mut local_points = [(0.0, 0.0); 4];
        let mut complete = true;
        let mut local_confidence = 1.0_f32;
        let mut measurements = Vec::new();
        let mut anchor_confidence = 1.0_f32;
        let mut matched = [false; 4];
        for (index, tracker) in local.iter_mut().enumerate() {
            if let Some(found) = tracker
                .follow_only(&pyramid)
                .filter(|found| found.score >= 0.65)
            {
                local_confidence = local_confidence.min(found.score);
                let offset = self.offsets[index];
                local_points[index] = (
                    (found.x + (0.5 + offset.0) * found.width) / width,
                    (found.y + (0.5 + offset.1) * found.height) / height,
                );
                if found.score >= 0.85 {
                    matched[index] = true;
                    anchor_confidence = anchor_confidence.min(found.score);
                    measurements.push((self.anchors[index], local_points[index]));
                }
            } else {
                complete = false;
            }
        }
        for anchor in &mut self.supplemental {
            let mut candidate = anchor.tracker.clone();
            if let Some(found) = candidate
                .follow_only(&pyramid)
                .filter(|found| found.score >= 0.85)
            {
                anchor_confidence = anchor_confidence.min(found.score);
                measurements.push((
                    anchor.anchor,
                    (
                        (found.x + (0.5 + anchor.offset.0) * found.width) / width,
                        (found.y + (0.5 + anchor.offset.1) * found.height) / height,
                    ),
                ));
                anchor.tracker = candidate;
            }
        }
        let follows_region = local_confidence >= 0.9
            || confidence < 0.9
            || local_points
                .iter()
                .zip(self.anchors)
                .all(|(point, anchor)| {
                    let expected = project(region, anchor);
                    ((point.0 - expected.0) * width).hypot((point.1 - expected.1) * height) <= 8.0
                });
        if complete
            && coherent(self.anchors, local_points, (width, height))
            && follows_region
            && region_at(time, local_points).is_some()
        {
            self.trackers = local;
            let points = if confidence >= 0.85 && local_confidence < confidence {
                self.anchors.map(|anchor| project(region, anchor))
            } else {
                local_points
            };
            self.corners.push((time, points));
            return;
        }
        if !self.supplemental.is_empty()
            && let Some(fitted) = fit_anchors(time, &measurements, (width, height))
            && (anchor_confidence >= 0.9
                || confidence < 0.85
                || self.anchors.iter().all(|&anchor| {
                    let expected = project(region, anchor);
                    let found = project(fitted, anchor);
                    ((expected.0 - found.0) * width).hypot((expected.1 - found.1) * height) <= 8.0
                }))
        {
            for ((tracker, candidate), matched) in self.trackers.iter_mut().zip(local).zip(matched)
            {
                if matched {
                    *tracker = candidate;
                }
            }
            self.corners
                .push((time, self.anchors.map(|anchor| project(fitted, anchor))));
            return;
        }
        if region.time != time {
            self.unresolved.push(time);
            return;
        }
        let mut points = self.anchors.map(|anchor| project(region, anchor));
        for (index, tracker) in self.trackers.iter_mut().enumerate() {
            let point = points[index];
            let offset = self.offsets[index];
            let patch = (
                self.patch_size.0 * region.size.0 / self.initial_size.0,
                self.patch_size.1 * region.size.1 / self.initial_size.1,
            );
            let center = (
                (point.0 - offset.0 * patch.0) * width,
                (point.1 - offset.1 * patch.1) * height,
            );
            if let Some(found) = tracker.track_near(&pyramid, center)
                && confidence < 0.85
            {
                points[index] = (
                    (found.x + (0.5 + offset.0) * found.width) / width,
                    (found.y + (0.5 + offset.1) * found.height) / height,
                );
            }
        }
        if region_at(time, points).is_some() {
            self.corners.push((time, points));
        }
    }

    pub fn finish(self) -> (Vec<TrackPoint>, Vec<(f64, f64)>) {
        let (path, lost) = self.region.finish();
        let mut path = path
            .into_iter()
            .filter(|point| {
                !lost
                    .iter()
                    .any(|(from, to)| point.time >= *from && point.time < *to)
            })
            .filter_map(|point| {
                region_at(
                    point.time,
                    self.anchors.map(|anchor| project(point, anchor)),
                )
            })
            .collect::<Vec<_>>();
        for (time, corners) in self.corners {
            if let Some(region) = region_at(time, corners) {
                let index = path.partition_point(|point| point.time < time);
                if path.get(index).is_some_and(|point| point.time == time) {
                    path[index] = region;
                } else {
                    path.insert(index, region);
                }
            }
        }
        for &(_, end) in &lost {
            let next = path.partition_point(|point| point.time < end);
            if let Some(previous) = next.checked_sub(1).map(|index| path[index])
                && end - previous.time > BRIDGED_GAP
            {
                path.insert(
                    next,
                    TrackPoint {
                        time: end - HOLD_LEAD,
                        ..previous
                    },
                );
            }
        }
        let lost = lost
            .into_iter()
            .filter(|(from, to)| {
                self.unresolved
                    .iter()
                    .any(|time| time >= from && time <= to)
            })
            .collect();
        (path, lost)
    }
}

fn anchor_tracker(frame: &LumaFrame, point: Point, side: f64) -> Option<(MotionTracker, Point)> {
    let (px, py) = (
        point.0 * frame.width() as f64,
        point.1 * frame.height() as f64,
    );
    let x = (px - side / 2.0)
        .round()
        .clamp(0.0, frame.width() as f64 - side);
    let y = (py - side / 2.0)
        .round()
        .clamp(0.0, frame.height() as f64 - side);
    Some((
        MotionTracker::new(frame, x as usize, y as usize, side as usize, side as usize)?,
        ((px - x) / side - 0.5, (py - y) / side - 0.5),
    ))
}

fn fit_anchors(time: f64, measurements: &[(Point, Point)], pixels: Point) -> Option<TrackPoint> {
    if measurements.len() < 4 {
        return None;
    }
    let fit = |axis: fn(Point) -> f64, pixels: f64| {
        let count = measurements.len() as f64;
        let mean_a = measurements.iter().map(|(a, _)| axis(*a)).sum::<f64>() / count;
        let mean_b = measurements.iter().map(|(_, b)| axis(*b)).sum::<f64>() / count;
        let variance = measurements
            .iter()
            .map(|(a, _)| (axis(*a) - mean_a).powi(2))
            .sum::<f64>();
        if variance < 1e-6 {
            return None;
        }
        let scale = measurements
            .iter()
            .map(|(a, b)| (axis(*a) - mean_a) * (axis(*b) - mean_b))
            .sum::<f64>()
            / variance;
        let offset = mean_b - scale * mean_a;
        (scale > 0.0
            && scale <= 2.0
            && measurements
                .iter()
                .all(|(a, b)| (axis(*b) - (offset + scale * axis(*a))).abs() * pixels <= 3.0))
        .then_some((offset + scale / 2.0, scale))
    };
    let x = fit(|p| p.0, pixels.0)?;
    let y = fit(|p| p.1, pixels.1)?;
    Some(TrackPoint {
        time,
        center: (x.0, y.0),
        size: (x.1, y.1),
    })
}

fn coherent(anchors: [Point; 4], points: [Point; 4], size: Point) -> bool {
    let fit = |axis: fn(Point) -> f64, pixels: f64| {
        let a = anchors.map(axis);
        let b = points.map(axis);
        let mean_a = a.iter().sum::<f64>() / 4.0;
        let mean_b = b.iter().sum::<f64>() / 4.0;
        let variance = a.iter().map(|v| (v - mean_a).powi(2)).sum::<f64>();
        let slope = a
            .iter()
            .zip(b)
            .map(|(a, b)| (a - mean_a) * (b - mean_b))
            .sum::<f64>()
            / variance;
        slope > 0.0
            && a.iter()
                .zip(b)
                .all(|(a, b)| ((b - mean_b) - slope * (a - mean_a)).abs() * pixels <= 3.0)
    };
    fit(|p| p.0, size.0) && fit(|p| p.1, size.1)
}

fn project(region: TrackPoint, anchor: Point) -> Point {
    (
        region.center.0 + (anchor.0 - 0.5) * region.size.0,
        region.center.1 + (anchor.1 - 0.5) * region.size.1,
    )
}

fn region_at(time: f64, [tl, tr, br, bl]: [Point; 4]) -> Option<TrackPoint> {
    let left = tl.0.max(bl.0);
    let right = tr.0.min(br.0);
    let top = tl.1.max(tr.1);
    let bottom = bl.1.min(br.1);
    if right <= left || bottom <= top {
        return None;
    }
    Some(TrackPoint {
        time,
        center: ((left + right) / 2.0, (top + bottom) / 2.0),
        size: (right - left, bottom - top),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(step: usize, supplemental: bool) -> (LumaFrame, Vec<Point>) {
        let (left, top, right, bottom) = (40 + step, 30 + step / 2, 160 + 3 * step, 130 - step);
        let mut points = vec![(left, top), (right, top), (right, bottom), (left, bottom)];
        if supplemental {
            points.extend([((left + right) / 2, top), ((left + right) / 2, bottom)]);
        }
        let mut rgba = vec![45u8; 320 * 180 * 4];
        for y in top..=bottom {
            for x in left..=right {
                let value = ((x * 17 + y * 31 + step * 73) % 180 + 60) as u8;
                rgba[(y * 320 + x) * 4..(y * 320 + x) * 4 + 4]
                    .copy_from_slice(&[value, value, value, 255]);
            }
        }
        for (corner, &(x, y)) in points.iter().enumerate() {
            if supplemental && step >= 4 && corner < 2 {
                continue;
            }
            for dy in 0..16 {
                for dx in 0..16 {
                    let value = ((dx * 37 + dy * 61 + corner * 43 + dx * dy * 19) % 220 + 20) as u8;
                    let offset = ((y + dy - 8) * 320 + x + dx - 8) * 4;
                    rgba[offset..offset + 4].copy_from_slice(&[value, value, value, 255]);
                }
            }
        }
        (
            LumaFrame::from_rgba(&rgba, 320, 180, 320 * 4),
            points
                .into_iter()
                .map(|(x, y)| (x as f64 / 320.0, y as f64 / 180.0))
                .collect(),
        )
    }

    #[test]
    fn follows_independent_width_and_height_changes_with_changing_contents() {
        let (first, points) = window(0, false);
        let mut session =
            FourPointSession::new(&first, 0.0, [points[2], points[0], points[3], points[1]])
                .unwrap();
        for step in 1..=20 {
            session.push(step as f64 / 30.0, window(step, false).0);
        }
        let hidden = LumaFrame::from_rgba(&vec![0; 320 * 180 * 4], 320, 180, 320 * 4);
        for step in 21..=40 {
            session.push(step as f64 / 30.0, hidden.clone());
        }
        let (path, _) = session.finish();
        for step in 0..=20 {
            let time = step as f64 / 30.0;
            let found = path
                .iter()
                .find(|point| point.time == time)
                .expect("every frame tracked");
            let left = (40 + step) as f64;
            let top = (30 + step / 2) as f64;
            let right = (160 + 3 * step) as f64;
            let bottom = (130 - step) as f64;
            let expected = TrackPoint {
                time,
                center: ((left + right) / 640.0, (top + bottom) / 360.0),
                size: ((right - left) / 320.0, (bottom - top) / 180.0),
            };
            assert!(
                (found.center.0 - expected.center.0).abs() * 320.0 < 2.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.center.1 - expected.center.1).abs() * 180.0 < 2.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.size.0 - expected.size.0).abs() * 320.0 < 3.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.size.1 - expected.size.1).abs() * 180.0 < 3.0,
                "{step}: {found:?}"
            );
        }
        let last = path.last().unwrap();
        assert!((last.center.0 * 320.0 - 140.0).abs() < 2.0, "{last:?}");
        assert!((last.size.0 * 320.0 - 160.0).abs() < 3.0, "{last:?}");
    }

    #[test]
    fn supplemental_points_follow_resizing_when_two_corners_disappear() {
        let (first, points) = window(0, true);
        let mut session = FourPointSession::new(&first, 0.0, &points).unwrap();
        for step in 1..=20 {
            session.push(step as f64 / 30.0, window(step, true).0);
        }
        let (path, _) = session.finish();
        for step in 4..=20 {
            let time = step as f64 / 30.0;
            let found = path
                .iter()
                .find(|p| p.time == time)
                .expect("visible anchors still track");
            let expected_center = (
                (100 + 2 * step) as f64,
                (160 + step / 2 - step) as f64 / 2.0,
            );
            let expected_size = ((120 + 2 * step) as f64, (100 - step - step / 2) as f64);
            assert!(
                (found.center.0 * 320.0 - expected_center.0).abs() < 2.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.center.1 * 180.0 - expected_center.1).abs() < 2.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.size.0 * 320.0 - expected_size.0).abs() < 3.0,
                "{step}: {found:?}"
            );
            assert!(
                (found.size.1 * 180.0 - expected_size.1).abs() < 3.0,
                "{step}: {found:?}"
            );
        }
    }
}
