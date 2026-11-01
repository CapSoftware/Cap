use cap_project::XY;

/// Bounds of the (possibly zoomed) display rect, expressed as a scale of the
/// unzoomed display: `(0,0)-(1,1)` means no zoom, while a zoomed-in view
/// expands the rect beyond the unit square so the visible viewport becomes a
/// sub-region of the source frame.
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct SegmentBounds {
    pub top_left: XY<f64>,
    pub bottom_right: XY<f64>,
}

impl SegmentBounds {
    pub fn new(top_left: XY<f64>, bottom_right: XY<f64>) -> Self {
        Self {
            top_left,
            bottom_right,
        }
    }

    pub fn default() -> Self {
        SegmentBounds::new(XY::new(0.0, 0.0), XY::new(1.0, 1.0))
    }

    /// Build bounds from a zoom `amount` (>= 1) and a normalized center in
    /// [0, 1] "travel space": 0 pins the visible viewport flush to the
    /// left/top edge, 1 flush to the right/bottom edge, 0.5 centers it.
    /// Inputs are clamped so the resulting viewport is always contained in
    /// the source frame (the geometric in-bounds guarantee that replaced the
    /// old `ensure_cursor_visible*` post-correction).
    pub fn from_amount_center(amount: f64, center: XY<f64>) -> Self {
        let amount = if amount.is_finite() {
            amount.max(1.0)
        } else {
            1.0
        };
        let center = XY::new(clamp_unit(center.x), clamp_unit(center.y));

        // Same formula the easing-based `from_segment_with_cursor_constraint`
        // used: scale about the origin, then translate so `center` maps across
        // the valid travel range.
        let center_diff = XY::new(center.x * amount - center.x, center.y * amount - center.y);

        SegmentBounds::new(
            XY::new(0.0 - center_diff.x, 0.0 - center_diff.y),
            XY::new(amount - center_diff.x, amount - center_diff.y),
        )
    }

    /// Remaps a scalar in [0,1] so values inside the outer `snap_ratio` band
    /// stick to the edges: [r, 1-r] -> [0, 1], clamped.
    pub(crate) fn snap_to_edges(scalar: f64, snap_ratio: f64) -> f64 {
        if snap_ratio <= 0.0 {
            return scalar;
        }
        let lo = snap_ratio;
        let hi = 1.0 - snap_ratio + 0.0001;
        if hi <= lo {
            return 0.5;
        }
        ((scalar - lo) / (hi - lo)).clamp(0.0, 1.0)
    }

    /// Maps a focus position (UV space) to a `from_amount_center`-space center
    /// for auto zooms: edge-snap each axis, then clamp to [0, 1].
    ///
    /// `from_amount_center` places the center scalar PROPORTIONALLY across the
    /// frame (s = 0 is top-left-flush, s = 1 is bottom-right-flush), so the
    /// full [0, 1] range is exactly the set of in-bounds framings and a focus
    /// snapped to 1.0 puts the frame corner-flush with the content corner —
    /// no centered-viewport band, which would make corners unreachable.
    pub(crate) fn calculate_follow_center(
        focus_pos: (f64, f64),
        edge_snap_ratio: f64,
    ) -> (f64, f64) {
        (
            Self::snap_to_edges(focus_pos.0, edge_snap_ratio).clamp(0.0, 1.0),
            Self::snap_to_edges(focus_pos.1, edge_snap_ratio).clamp(0.0, 1.0),
        )
    }
}

const EXIT_BLEND_RATIO: f64 = 2.0;
const INFEASIBLE_EXIT_PENALTY: f64 = 4.0;

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct CameraZone {
    pub top_left: XY<f64>,
    pub bottom_right: XY<f64>,
    pub content_aspect: f64,
}

impl CameraZone {
    pub(crate) fn contains(&self, point: XY<f64>) -> bool {
        const EDGE_SLACK: f64 = 1e-9;
        point.x > self.top_left.x + EDGE_SLACK
            && point.x < self.bottom_right.x - EDGE_SLACK
            && point.y > self.top_left.y + EDGE_SLACK
            && point.y < self.bottom_right.y - EDGE_SLACK
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) struct ZoneExitSides {
    pub(crate) leading_x: bool,
    pub(crate) leading_y: bool,
}

fn smoothstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl SegmentBounds {
    pub(crate) fn focus_on_screen(amount: f64, focus: XY<f64>, center: XY<f64>) -> XY<f64> {
        let travel = amount - 1.0;
        XY::new(
            focus.x * amount - center.x * travel,
            focus.y * amount - center.y * travel,
        )
    }

    // Each zone edge inside the frame is an exit. Per axis only one side is
    // considered, and that choice is carried across steps by the caller: a
    // fresh cheapest-side pick every step jumped the framing across the
    // whole zone where the cheaper side flipped, and averaging the two sides
    // cancelled out for a focus near the zone's middle. The two axes are
    // blended by cost so the stronger exit is taken in full and the other
    // only adds to it, keeping the target continuous. Exits the clamped
    // center cannot fully reach are penalised by the shortfall rather than
    // dropped, which keeps the costs continuous as well.
    pub(crate) fn center_avoiding_zone(
        amount: f64,
        focus: XY<f64>,
        center: XY<f64>,
        zone: &CameraZone,
        sides: Option<ZoneExitSides>,
    ) -> (XY<f64>, Option<ZoneExitSides>) {
        let travel = amount - 1.0;
        if travel.is_nan() || travel <= 1e-6 || !zone.content_aspect.is_finite() {
            return (center, None);
        }
        let on_screen = Self::focus_on_screen(amount, focus, center);
        if !zone.contains(on_screen) {
            return (center, None);
        }

        let exit = |horizontal: bool, target: f64| {
            if !(0.0..=1.0).contains(&target) {
                return None;
            }
            let (axis_focus, axis_screen, axis_center, weight) = if horizontal {
                (focus.x, on_screen.x, center.x, zone.content_aspect)
            } else {
                (focus.y, on_screen.y, center.y, 1.0)
            };
            let wanted = (axis_focus * amount - target) / travel;
            let reached = wanted.clamp(0.0, 1.0);
            let shortfall = (wanted - reached).abs() * travel;
            let cost =
                ((target - axis_screen).abs() + shortfall * INFEASIBLE_EXIT_PENALTY) * weight;
            Some((cost, reached - axis_center))
        };
        let pick = |leading: Option<(f64, f64)>,
                    trailing: Option<(f64, f64)>,
                    held: Option<bool>| match (leading, trailing, held) {
            (Some(leading), _, Some(true)) => Some((true, leading)),
            (_, Some(trailing), Some(false)) => Some((false, trailing)),
            (Some(leading), Some(trailing), _) => Some(if trailing.0 < leading.0 {
                (false, trailing)
            } else {
                (true, leading)
            }),
            (Some(leading), None, _) => Some((true, leading)),
            (None, Some(trailing), _) => Some((false, trailing)),
            (None, None, _) => None,
        };
        let horizontal = pick(
            exit(true, zone.top_left.x),
            exit(true, zone.bottom_right.x),
            sides.map(|sides| sides.leading_x),
        );
        let vertical = pick(
            exit(false, zone.top_left.y),
            exit(false, zone.bottom_right.y),
            sides.map(|sides| sides.leading_y),
        );

        let Some(best) = [horizontal, vertical]
            .iter()
            .flatten()
            .map(|(_, (cost, _))| *cost)
            .min_by(f64::total_cmp)
        else {
            return (center, None);
        };
        let weighted = |choice: Option<(bool, (f64, f64))>| {
            choice.map_or(0.0, |(_, (cost, shift))| {
                let weight = if best <= f64::EPSILON {
                    if cost <= f64::EPSILON { 1.0 } else { 0.0 }
                } else {
                    smoothstep((EXIT_BLEND_RATIO - cost / best) / (EXIT_BLEND_RATIO - 1.0))
                };
                weight * shift
            })
        };
        let chosen = ZoneExitSides {
            leading_x: horizontal.is_none_or(|(leading, _)| leading),
            leading_y: vertical.is_none_or(|(leading, _)| leading),
        };
        (
            XY::new(
                center.x + weighted(horizontal),
                center.y + weighted(vertical),
            ),
            Some(chosen),
        )
    }
}

fn clamp_unit(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

/// A sampled zoom transform. Produced by `ZoomTransformTimeline::sample`.
#[derive(Debug, Clone, Copy)]
pub struct InterpolatedZoom {
    /// Smoothed 0..1 "zoom activity": the spring-driven response to whether
    /// any zoom segment is active. Reaches 1 once a zoom has fully engaged
    /// and returns to 0 at rest. Consumers (e.g. camera scale-during-zoom)
    /// must not assume monotonicity within a segment; it is always clamped
    /// to [0, 1].
    pub t: f64,
    pub bounds: SegmentBounds,
}

impl InterpolatedZoom {
    pub fn display_amount(&self) -> f64 {
        (self.bounds.bottom_right - self.bounds.top_left).x
    }
}

impl Default for InterpolatedZoom {
    /// The resting transform: no zoom engaged.
    fn default() -> Self {
        Self {
            t: 0.0,
            bounds: SegmentBounds::default(),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    // The old easing-based tests (segment ramps, ensure_cursor_visible*) were
    // removed together with the state machine they exercised; the spring
    // timeline that replaced it is covered in `zoom_spring.rs`. These tests
    // pin down the pure geometry that survived the rework.

    macro_rules! assert_f64_near {
        ($left:expr, $right:expr, $label:literal) => {
            let left = $left;
            let right = $right;
            assert!(
                (left - right).abs() < 1e-9,
                "{}: left `{:?}` != right `{:?}`",
                $label,
                left,
                right
            )
        };
    }

    #[test]
    fn from_amount_center_identity_at_amount_one() {
        let bounds = SegmentBounds::from_amount_center(1.0, XY::new(0.3, 0.9));
        assert_f64_near!(bounds.top_left.x, 0.0, "top_left.x");
        assert_f64_near!(bounds.top_left.y, 0.0, "top_left.y");
        assert_f64_near!(bounds.bottom_right.x, 1.0, "bottom_right.x");
        assert_f64_near!(bounds.bottom_right.y, 1.0, "bottom_right.y");
    }

    #[test]
    fn from_amount_center_centered() {
        let bounds = SegmentBounds::from_amount_center(2.0, XY::new(0.5, 0.5));
        assert_f64_near!(bounds.top_left.x, -0.5, "top_left.x");
        assert_f64_near!(bounds.top_left.y, -0.5, "top_left.y");
        assert_f64_near!(bounds.bottom_right.x, 1.5, "bottom_right.x");
        assert_f64_near!(bounds.bottom_right.y, 1.5, "bottom_right.y");
    }

    #[test]
    fn from_amount_center_edges_stay_in_bounds() {
        // center 0 -> viewport flush left/top, center 1 -> flush right/bottom.
        for amount in [1.0, 1.5, 2.0, 3.0, 4.5] {
            for c in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let bounds = SegmentBounds::from_amount_center(amount, XY::new(c, c));
                // Display must cover the whole output: top_left <= 0 and
                // bottom_right >= 1 on both axes.
                assert!(bounds.top_left.x <= 1e-9, "tl.x for a={amount} c={c}");
                assert!(bounds.top_left.y <= 1e-9, "tl.y for a={amount} c={c}");
                assert!(
                    bounds.bottom_right.x >= 1.0 - 1e-9,
                    "br.x for a={amount} c={c}"
                );
                assert!(
                    bounds.bottom_right.y >= 1.0 - 1e-9,
                    "br.y for a={amount} c={c}"
                );
            }
        }
    }

    #[test]
    fn from_amount_center_clamps_bad_inputs() {
        let bounds = SegmentBounds::from_amount_center(0.25, XY::new(-4.0, 7.0));
        // amount below 1 clamps to identity scale; centers clamp into [0,1].
        assert_f64_near!(bounds.bottom_right.x - bounds.top_left.x, 1.0, "width");
        let nan_bounds = SegmentBounds::from_amount_center(f64::NAN, XY::new(f64::NAN, 0.5));
        assert!(nan_bounds.top_left.x.is_finite());
        assert!(nan_bounds.bottom_right.y.is_finite());
    }

    #[test]
    fn follow_center_maps_focus_proportionally() {
        // Center focus stays centered.
        let (cx, cy) = SegmentBounds::calculate_follow_center((0.5, 0.5), 0.0);
        assert!((cx - 0.5).abs() < 1e-6);
        assert!((cy - 0.5).abs() < 1e-6);

        // Extreme focus reaches the corner-flush framings so edge/corner
        // content is actually reachable (proportional placement semantics).
        let (left, _) = SegmentBounds::calculate_follow_center((0.0, 0.5), 0.0);
        assert!(left.abs() < 1e-6);
        let (right, _) = SegmentBounds::calculate_follow_center((1.0, 0.5), 0.0);
        assert!((right - 1.0).abs() < 1e-6);

        // A corner-flush framing keeps the frame fully covered at any amount.
        let bounds = SegmentBounds::from_amount_center(2.0, XY::new(1.0, 1.0));
        assert!(bounds.top_left.x <= 0.0 && bounds.bottom_right.x >= 1.0);
    }

    fn zone(left: f64, top: f64, right: f64, bottom: f64) -> CameraZone {
        CameraZone {
            top_left: XY::new(left, top),
            bottom_right: XY::new(right, bottom),
            content_aspect: 16.0 / 9.0,
        }
    }

    fn assert_in_frame(amount: f64, focus: XY<f64>, center: XY<f64>) {
        assert!((0.0..=1.0).contains(&center.x) && (0.0..=1.0).contains(&center.y));
        let bounds = SegmentBounds::from_amount_center(amount, center);
        assert!(bounds.top_left.x <= 1e-9 && bounds.bottom_right.x >= 1.0 - 1e-9);
        assert!(bounds.top_left.y <= 1e-9 && bounds.bottom_right.y >= 1.0 - 1e-9);
        let screen = SegmentBounds::focus_on_screen(amount, focus, center);
        assert!((-1e-9..=1.0 + 1e-9).contains(&screen.x), "{screen:?}");
        assert!((-1e-9..=1.0 + 1e-9).contains(&screen.y), "{screen:?}");
    }

    fn assert_clear(amount: f64, focus: XY<f64>, center: XY<f64>, zone: &CameraZone) {
        assert_in_frame(amount, focus, center);
        let screen = SegmentBounds::focus_on_screen(amount, focus, center);
        assert!(
            !zone.contains(screen),
            "focus {focus:?} still under camera at {screen:?}"
        );
    }

    fn largest_screen_step(
        amount: f64,
        zone: &CameraZone,
        path: impl Iterator<Item = XY<f64>>,
        center_for: impl Fn(XY<f64>) -> XY<f64>,
    ) -> f64 {
        let mut previous: Option<XY<f64>> = None;
        let mut sides = None;
        let mut largest: f64 = 0.0;
        for focus in path {
            let (moved, chosen) =
                SegmentBounds::center_avoiding_zone(amount, focus, center_for(focus), zone, sides);
            sides = chosen;
            assert_in_frame(amount, focus, moved);
            let screen = SegmentBounds::focus_on_screen(amount, focus, moved);
            if let Some(previous) = previous {
                let step = screen - previous;
                largest = largest.max(step.x.abs().max(step.y.abs()));
            }
            previous = Some(screen);
        }
        largest
    }

    fn manual_center(focus: XY<f64>) -> XY<f64> {
        focus
    }

    fn follow_center(focus: XY<f64>) -> XY<f64> {
        let (x, y) = SegmentBounds::calculate_follow_center((focus.x, focus.y), 0.25);
        XY::new(x, y)
    }

    #[test]
    fn camera_avoidance_leaves_clear_focus_alone() {
        let camera = zone(0.75, 0.7, 1.05, 1.05);
        let center = XY::new(0.5, 0.5);
        let moved =
            SegmentBounds::center_avoiding_zone(2.0, XY::new(0.5, 0.5), center, &camera, None).0;
        assert_eq!(moved, center);
    }

    #[test]
    fn camera_avoidance_clears_each_corner() {
        let amount = 2.0;
        let corners = [
            (zone(-0.05, -0.05, 0.3, 0.4), XY::new(0.27, 0.25)),
            (zone(0.7, -0.05, 1.05, 0.4), XY::new(0.73, 0.25)),
            (zone(-0.05, 0.6, 0.3, 1.05), XY::new(0.27, 0.75)),
            (zone(0.7, 0.6, 1.05, 1.05), XY::new(0.73, 0.75)),
        ];
        for (camera, focus) in corners {
            let before = SegmentBounds::focus_on_screen(amount, focus, focus);
            assert!(camera.contains(before), "setup: {focus:?} not under camera");
            let moved = SegmentBounds::center_avoiding_zone(amount, focus, focus, &camera, None).0;
            assert_clear(amount, focus, moved, &camera);
            let after = SegmentBounds::focus_on_screen(amount, focus, moved);
            assert!(
                (after.x - before.x) * (0.5 - before.x) >= 0.0,
                "{before:?} -> {after:?}"
            );
            assert!(
                (after.y - before.y) * (0.5 - before.y) >= 0.0,
                "{before:?} -> {after:?}"
            );
        }
    }

    #[test]
    fn camera_avoidance_takes_a_clearly_shorter_exit_alone() {
        let camera = zone(0.6, 0.6, 1.05, 1.05);
        let amount = 2.0;
        let focus = XY::new(0.62, 0.8);
        let moved = SegmentBounds::center_avoiding_zone(amount, focus, focus, &camera, None).0;
        let after = SegmentBounds::focus_on_screen(amount, focus, moved);
        assert!((after.x - 0.6).abs() < 1e-9, "{after:?}");
        assert!((after.y - 0.8).abs() < 1e-9, "{after:?}");
    }

    #[test]
    fn camera_avoidance_clears_a_focus_dead_centre_under_a_centred_camera() {
        let camera = zone(0.38, 0.33, 0.62, 0.67);
        for amount in [1.5, 2.0, 3.0] {
            let focus = XY::new(0.5, 0.5);
            let (moved, sides) =
                SegmentBounds::center_avoiding_zone(amount, focus, focus, &camera, None);
            assert_clear(amount, focus, moved, &camera);
            let (again, kept) =
                SegmentBounds::center_avoiding_zone(amount, focus, focus, &camera, sides);
            assert_eq!(again, moved);
            assert_eq!(kept, sides);
        }
    }

    #[test]
    fn camera_avoidance_keeps_its_side_across_the_middle() {
        let camera = zone(0.38, 0.33, 0.62, 0.67);
        let amount = 2.0;
        let start = XY::new(0.42, 0.5);
        let (_, sides) = SegmentBounds::center_avoiding_zone(amount, start, start, &camera, None);
        let sides = sides.expect("focus under the camera");
        let past_middle = XY::new(0.56, 0.5);
        let (_, kept) = SegmentBounds::center_avoiding_zone(
            amount,
            past_middle,
            past_middle,
            &camera,
            Some(sides),
        );
        assert_eq!(kept, Some(sides));
        let (_, fresh) =
            SegmentBounds::center_avoiding_zone(amount, past_middle, past_middle, &camera, None);
        assert_ne!(fresh, Some(sides));
    }

    #[test]
    fn camera_avoidance_respects_frame_bounds() {
        let camera = zone(0.7, 0.65, 1.05, 1.05);
        let corner = XY::new(1.0, 1.0);
        let moved = SegmentBounds::center_avoiding_zone(2.0, corner, corner, &camera, None).0;
        assert_eq!(moved, corner);

        for amount in [1.25, 1.5, 2.0, 3.0, 4.0] {
            for focus_x in [0.6, 0.7, 0.8, 0.9, 0.95, 1.0] {
                for focus_y in [0.6, 0.7, 0.8, 0.9, 0.95, 1.0] {
                    let focus = XY::new(focus_x, focus_y);
                    let moved = SegmentBounds::center_avoiding_zone(
                        amount,
                        focus,
                        follow_center(focus),
                        &camera,
                        None,
                    )
                    .0;
                    assert_in_frame(amount, focus, moved);
                }
            }
        }
    }

    #[test]
    fn camera_avoidance_is_off_without_zoom() {
        let camera = zone(0.0, 0.0, 1.0, 1.0);
        let center = XY::new(0.4, 0.4);
        assert_eq!(
            SegmentBounds::center_avoiding_zone(1.0, XY::new(0.4, 0.4), center, &camera, None).0,
            center
        );
    }

    #[test]
    fn smaller_camera_during_zoom_needs_less_shift() {
        let amount = 2.0;
        let focus = XY::new(0.8, 0.8);
        let full = zone(0.6, 0.55, 1.05, 1.05);
        let shrunk = zone(0.72, 0.68, 1.05, 1.05);
        let shift = |camera: &CameraZone| {
            let moved = SegmentBounds::center_avoiding_zone(amount, focus, focus, camera, None).0;
            assert_clear(amount, focus, moved, camera);
            let before = SegmentBounds::focus_on_screen(amount, focus, focus);
            let after = SegmentBounds::focus_on_screen(amount, focus, moved);
            ((after.x - before.x).powi(2) + (after.y - before.y).powi(2)).sqrt()
        };
        assert!(shift(&shrunk) < shift(&full));
        let tiny = zone(0.85, 0.85, 1.05, 1.05);
        assert_eq!(
            SegmentBounds::center_avoiding_zone(amount, focus, focus, &tiny, None).0,
            focus
        );
    }

    #[test]
    fn camera_avoidance_is_continuous_entering_the_zone() {
        let camera = zone(0.7, 0.65, 1.05, 1.05);
        let path = (0..=160).map(|step| XY::new(0.6 + f64::from(step) * 0.001, 0.85));
        let largest = largest_screen_step(2.0, &camera, path, manual_center);
        assert!(largest < 0.01, "focus jumped {largest}");
    }

    #[test]
    fn camera_avoidance_is_continuous_where_the_cheapest_exit_flips() {
        let bottom_centre = zone(0.38, 0.7, 0.62, 1.05);
        let bottom_right = zone(0.55, 0.5, 1.05, 1.05);
        for amount in [1.25, 1.5] {
            for center_for in [manual_center as fn(XY<f64>) -> XY<f64>, follow_center] {
                let across = (0..=200).map(|step| XY::new(0.4 + f64::from(step) * 0.001, 0.9));
                let largest = largest_screen_step(amount, &bottom_centre, across, center_for);
                assert!(
                    largest < 0.015,
                    "bottom centre at {amount}: jumped {largest}"
                );

                let diagonal = (0..=300).map(|step| {
                    let t = f64::from(step) / 300.0;
                    XY::new(0.6 + 0.35 * t, 0.95 - 0.4 * t)
                });
                let largest = largest_screen_step(amount, &bottom_right, diagonal, center_for);
                assert!(
                    largest < 0.015,
                    "bottom right at {amount}: jumped {largest}"
                );

                let back = (0..=200).map(|step| XY::new(0.6 - f64::from(step) * 0.001, 0.9));
                let largest = largest_screen_step(amount, &bottom_centre, back, center_for);
                assert!(
                    largest < 0.015,
                    "bottom centre back at {amount}: jumped {largest}"
                );
            }
        }
    }

    #[test]
    fn display_amount_is_zoom_scale() {
        let zoom = InterpolatedZoom {
            t: 1.0,
            bounds: SegmentBounds::from_amount_center(2.5, XY::new(0.4, 0.6)),
        };
        assert!((zoom.display_amount() - 2.5).abs() < 1e-9);
    }
}
