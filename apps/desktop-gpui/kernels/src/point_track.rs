//! Tracks a mask from points the user clicked on the target: its corners, or
//! points around the edge of a rounded or irregular shape, four or more.
//!
//! The mask is the box around the points. Each frame every point is matched
//! with small patches, and the box is fitted per axis (offset and scale) to
//! the matches that agree with each other, so the box can widen without
//! growing taller, as a resized panel does. A patch centred on an edge point
//! is mostly background, which stays put while the target moves, so each
//! point also gets patches set inside the shape; the fit keeps whichever
//! move consistently. The whole-box tracker from [`TrackSession`] runs
//! alongside to carry the box through frames where too few points match
//! (zooms past the patches' scale range, the target leaving the frame), and
//! sides the user clicked along stay on the straight edge they start on
//! ([`BoxEdges`]).

use crate::box_edges::BoxEdges;
use crate::motion_track::{
    BRIDGED_GAP, HOLD_LEAD, LumaFrame, MotionTracker, Pyramid, TrackPoint, TrackSession, TrackedBox,
};

type Point = (f64, f64);

/// A patch match below this is not evidence of where its point went.
const MATCH_SCORE: f32 = 0.8;
/// How far, in tracking pixels, a match may sit from the fitted box before
/// it counts as following something else.
const FIT_RESIDUAL: f64 = 3.0;
/// Patch sides tried at each placement, smallest first: a larger patch
/// takes in enough detail on flat chrome such as a title bar.
const PATCH_SIDES: [f64; 3] = [16.0, 24.0, 32.0];
/// How much the box may grow or shrink between consecutive frames. A fast
/// Cap zoom scales about 7% a frame; a fit beyond this is patches failing
/// together, not the target changing.
const MAX_STEP_SCALE: f64 = 1.25;

#[derive(Clone)]
struct Patch {
    tracker: MotionTracker,
    /// The clicked point, as a fraction of the starting box.
    anchor: Point,
    /// Where the point sits in the patch, relative to the patch centre and
    /// in patch widths, so a match maps back to the point at any scale.
    offset: Point,
}

impl Patch {
    fn point(&self, found: &TrackedBox, frame: Point) -> Point {
        (
            (found.x + (0.5 + self.offset.0) * found.width) / frame.0,
            (found.y + (0.5 + self.offset.1) * found.height) / frame.1,
        )
    }
}

pub struct PointTrackSession {
    region: Option<TrackSession>,
    patches: Vec<Patch>,
    frame: Point,
    edges: BoxEdges,
    fitted: Vec<TrackPoint>,
    unresolved: Vec<f64>,
}

impl PointTrackSession {
    /// `points` are normalized to the frame. `None` with fewer than four,
    /// when they span no area, or when no patch around them has detail.
    pub fn new(frame: &LumaFrame, time: f64, points: &[Point]) -> Option<Self> {
        if points.len() < 4
            || !time.is_finite()
            || points.iter().any(|&(x, y)| {
                !x.is_finite()
                    || !y.is_finite()
                    || !(0.0..=1.0).contains(&x)
                    || !(0.0..=1.0).contains(&y)
            })
        {
            return None;
        }
        let (left, top, right, bottom) = bounds(points);
        let size = (right - left, bottom - top);
        let (width, height) = (frame.width() as f64, frame.height() as f64);
        if size.0 * width < 4.0 || size.1 * height < 4.0 {
            return None;
        }
        let center = ((left + right) / 2.0, (top + bottom) / 2.0);
        let mut patches = Vec::new();
        for &point in points {
            let anchor = ((point.0 - left) / size.0, (point.1 - top) / size.1);
            // The unit step from the point towards the middle of the shape:
            // (±1, ±1) at a corner, (0, ±1) on the middle of an edge.
            let inward = (
                ((center.0 - point.0) / (size.0 / 2.0)).clamp(-1.0, 1.0),
                ((center.1 - point.1) / (size.1 / 2.0)).clamp(-1.0, 1.0),
            );
            let limit = (size.0 * width).min(size.1 * height);
            let mut placed = 0;
            for shift in [0.0, 1.0] {
                let found = PATCH_SIDES
                    .iter()
                    .filter(|&&side| shift == 0.0 || side <= limit)
                    .find_map(|&side| {
                        patch(
                            frame,
                            point,
                            anchor,
                            side,
                            (inward.0 * shift, inward.1 * shift),
                        )
                    });
                if let Some(found) = found {
                    patches.push(found);
                    placed += 1;
                }
            }
            if placed == 0 {
                tracing::debug!(?point, "no detail around a tracking point");
            }
        }
        if patches.len() < 3 {
            return None;
        }
        let start = TrackPoint { time, center, size };
        Some(Self {
            region: TrackSession::new(frame, time, center, size),
            patches,
            frame: (width, height),
            edges: BoxEdges::new(frame, start, points),
            fitted: vec![start],
            unresolved: Vec::new(),
        })
    }

    pub fn push(&mut self, time: f64, frame: LumaFrame) {
        let pyramid = Pyramid::new(&frame);
        if let Some(region) = self.region.as_mut() {
            region.push_pyramid(time, &pyramid);
        }
        let mut matches = Vec::new();
        for (index, patch) in self.patches.iter().enumerate() {
            let mut candidate = patch.tracker.clone();
            if let Some(found) = candidate
                .follow_only(&pyramid)
                .filter(|found| found.score >= MATCH_SCORE)
            {
                matches.push((index, patch.point(&found, self.frame), candidate));
            }
        }
        let measurements = matches
            .iter()
            .map(|(index, point, _)| (self.patches[*index].anchor, *point))
            .collect::<Vec<_>>();
        let previous = self.fitted.last().map(|point| point.size);
        let fit = fit_box(time, &measurements, self.frame).filter(|(fit, _)| {
            previous.is_none_or(|previous| {
                plausible_scale(fit.size.0 / previous.0) && plausible_scale(fit.size.1 / previous.1)
            })
        });
        // The whole-box tracker applies its own match thresholds (lower ones
        // for fine detail it had to smooth to see) and reports a box for this
        // frame only when it found the target.
        let region = self
            .region
            .as_ref()
            .map(TrackSession::latest)
            .filter(|(region, _)| region.time == time);
        // A fit backed by most matched patches wins. When only a few back
        // it, they are more likely stuck on the background than right, so
        // the whole-box track is preferred and the fit used only without
        // one. Straight edges then correct the sides of whichever is chosen.
        let (estimate, inliers) = match (fit, region) {
            (Some((fit, inliers)), _) if inliers.len() * 5 >= measurements.len() * 3 => {
                (Some(fit), inliers)
            }
            (_, Some((region, _))) => (Some(region), Vec::new()),
            (Some((fit, inliers)), None) => (Some(fit), inliers),
            (None, None) => (None, Vec::new()),
        };
        // With no estimate, the box's straight edges can still be found
        // from where it last was: a window resized past what its patches
        // can follow keeps its border.
        let held = estimate.is_none();
        let base = estimate.or_else(|| self.fitted.last().map(|last| TrackPoint { time, ..*last }));
        let expected = base.and_then(|base| {
            let (snapped, edges) = self.edges.snap(&frame, base);
            (!held || edges > 0).then_some(snapped)
        });
        match expected {
            Some(expected) => self.fitted.push(expected),
            None => self.unresolved.push(time),
        }
        for (position, (index, _, candidate)) in matches.into_iter().enumerate() {
            if inliers.contains(&position) {
                self.patches[index].tracker = candidate;
            }
        }
        // A patch that lost its point or wandered onto the background is
        // pulled back to where the box says its point is now, if its
        // content is still there.
        if let Some(expected) = expected {
            for patch in &mut self.patches {
                let point = project(expected, patch.anchor);
                let size = patch.tracker.size();
                let center = (
                    point.0 * self.frame.0 - patch.offset.0 * size.0,
                    point.1 * self.frame.1 - patch.offset.1 * size.1,
                );
                let current = patch.tracker.center();
                if (current.0 - center.0).hypot(current.1 - center.1) > FIT_RESIDUAL {
                    let _ = patch.tracker.track_near(&pyramid, center);
                }
            }
        }
    }

    /// The path, and the spans in which the target could not be found.
    pub fn finish(self) -> (Vec<TrackPoint>, Vec<(f64, f64)>) {
        // Every frame with an estimate is already in `fitted` (the fit or
        // the whole-box track it fell back on). The whole-box track adds only
        // what it found for frames that had none: when it picks the target
        // up again it walks back through the frames it missed.
        let (region, lost) = self
            .region
            .map_or_else(|| (Vec::new(), Vec::new()), TrackSession::finish);
        let mut path = self.fitted;
        for found in region {
            if self.unresolved.contains(&found.time) {
                let index = path.partition_point(|point| point.time < found.time);
                path.insert(index, found);
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

fn plausible_scale(ratio: f64) -> bool {
    (1.0 / MAX_STEP_SCALE..=MAX_STEP_SCALE).contains(&ratio)
}

fn bounds(points: &[Point]) -> (f64, f64, f64, f64) {
    points.iter().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(l, t, r, b), p| (l.min(p.0), t.min(p.1), r.max(p.0), b.max(p.1)),
    )
}

/// A patch of `side` pixels for `point`, its centre moved `shift` half-sides
/// from the point (towards the inside of the shape), or `None` where the
/// frame there is too flat to match.
fn patch(frame: &LumaFrame, point: Point, anchor: Point, side: f64, shift: Point) -> Option<Patch> {
    let (width, height) = (frame.width() as f64, frame.height() as f64);
    let (px, py) = (point.0 * width, point.1 * height);
    let x = (px - side / 2.0 + shift.0 * side / 2.0)
        .round()
        .clamp(0.0, width - side);
    let y = (py - side / 2.0 + shift.1 * side / 2.0)
        .round()
        .clamp(0.0, height - side);
    let tracker = MotionTracker::new(frame, x as usize, y as usize, side as usize, side as usize)?;
    Some(Patch {
        tracker,
        anchor,
        offset: ((px - x) / side - 0.5, (py - y) / side - 0.5),
    })
}

fn project(region: TrackPoint, anchor: Point) -> Point {
    (
        region.center.0 + (anchor.0 - 0.5) * region.size.0,
        region.center.1 + (anchor.1 - 0.5) * region.size.1,
    )
}

/// Fits `found = offset + scale * anchor` on each axis to the measurements,
/// dropping the worst one while any sits further than [`FIT_RESIDUAL`] from
/// the fit. Returns the box and which measurements it kept, or `None` when
/// too few agree or they cannot pin down an axis.
fn fit_box(
    time: f64,
    measurements: &[(Point, Point)],
    frame: Point,
) -> Option<(TrackPoint, Vec<usize>)> {
    let mut kept = (0..measurements.len()).collect::<Vec<_>>();
    loop {
        if kept.len() < 3 {
            return None;
        }
        let x = fit_axis(measurements, &kept, |p| p.0)?;
        let y = fit_axis(measurements, &kept, |p| p.1)?;
        let residual = |index: usize| {
            let (anchor, found) = measurements[index];
            ((found.0 - (x.0 + x.1 * anchor.0)) * frame.0)
                .hypot((found.1 - (y.0 + y.1 * anchor.1)) * frame.1)
        };
        let (worst, distance) = kept
            .iter()
            .map(|&index| (index, residual(index)))
            .max_by(|a, b| a.1.total_cmp(&b.1))?;
        if distance <= FIT_RESIDUAL {
            if x.1 <= 0.0 || y.1 <= 0.0 {
                return None;
            }
            let point = TrackPoint {
                time,
                center: (x.0 + x.1 / 2.0, y.0 + y.1 / 2.0),
                size: (x.1, y.1),
            };
            return Some((point, kept));
        }
        kept.retain(|&index| index != worst);
    }
}

/// Least squares `offset + scale * anchor` on one axis, or `None` when the
/// kept anchors all sit at one position on it (the scale is unknowable).
fn fit_axis(
    measurements: &[(Point, Point)],
    kept: &[usize],
    axis: fn(Point) -> f64,
) -> Option<(f64, f64)> {
    let count = kept.len() as f64;
    let mean_a = kept.iter().map(|&i| axis(measurements[i].0)).sum::<f64>() / count;
    let mean_b = kept.iter().map(|&i| axis(measurements[i].1)).sum::<f64>() / count;
    let variance = kept
        .iter()
        .map(|&i| (axis(measurements[i].0) - mean_a).powi(2))
        .sum::<f64>();
    if variance < 0.05 {
        return None;
    }
    let scale = kept
        .iter()
        .map(|&i| (axis(measurements[i].0) - mean_a) * (axis(measurements[i].1) - mean_b))
        .sum::<f64>()
        / variance;
    Some((mean_b - scale * mean_a, scale))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motion_track::TrackPoint;

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
            PointTrackSession::new(&first, 0.0, &[points[2], points[0], points[3], points[1]])
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
        let mut session = PointTrackSession::new(&first, 0.0, &points).unwrap();
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
