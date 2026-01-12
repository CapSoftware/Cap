use cap_project::{XY, ZoomSegment};

use crate::{Coord, RawDisplayUVSpace};

pub const ZOOM_DURATION: f64 = 1.0;

const SCREEN_SPRING_STIFFNESS: f64 = 200.0;
const SCREEN_SPRING_DAMPING: f64 = 40.0;
const SCREEN_SPRING_MASS: f64 = 2.25;

#[derive(Debug, Clone, Copy)]
pub struct SegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a ZoomSegment>,
    prev_segment: Option<&'a ZoomSegment>,
    segments: &'a [ZoomSegment],
}

impl<'a> SegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [ZoomSegment]) -> Self {
        match segments
            .iter()
            .position(|s| time > s.start && time <= s.end)
        {
            Some(segment_index) => SegmentsCursor {
                time,
                segment: Some(&segments[segment_index]),
                prev_segment: if segment_index > 0 {
                    Some(&segments[segment_index - 1])
                } else {
                    None
                },
                segments,
            },
            None => {
                let prev = segments
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, s)| s.end <= time);
                SegmentsCursor {
                    time,
                    segment: None,
                    prev_segment: prev.map(|(_, s)| s),
                    segments,
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct SegmentBounds {
    pub top_left: XY<f64>,
    pub bottom_right: XY<f64>,
}

impl SegmentBounds {
    pub fn from_segment_with_cursor_constraint(
        segment: &ZoomSegment,
        zoom_focus: Coord<RawDisplayUVSpace>,
        actual_cursor: Option<Coord<RawDisplayUVSpace>>,
    ) -> Self {
        let is_auto_mode = matches!(segment.mode, cap_project::ZoomMode::Auto);

        let focus_pos = match segment.mode {
            cap_project::ZoomMode::Auto => (zoom_focus.x, zoom_focus.y),
            cap_project::ZoomMode::Manual { x, y } => (x as f64, y as f64),
        };

        let (effective_zoom, viewport_center) = if is_auto_mode {
            if let Some(cursor) = actual_cursor {
                Self::calculate_zoom_and_center_for_cursor(
                    focus_pos,
                    (cursor.x, cursor.y),
                    segment.amount,
                    segment.edge_snap_ratio,
                )
            } else {
                let center = Self::calculate_follow_center(
                    focus_pos,
                    segment.amount,
                    segment.edge_snap_ratio,
                );
                (segment.amount, center)
            }
        } else {
            (segment.amount, focus_pos)
        };

        let scaled_center = [
            viewport_center.0 * effective_zoom,
            viewport_center.1 * effective_zoom,
        ];
        let center_diff = [
            scaled_center[0] - viewport_center.0,
            scaled_center[1] - viewport_center.1,
        ];

        SegmentBounds::new(
            XY::new(0.0 - center_diff[0], 0.0 - center_diff[1]),
            XY::new(
                effective_zoom - center_diff[0],
                effective_zoom - center_diff[1],
            ),
        )
    }

    fn calculate_follow_center(
        cursor_pos: (f64, f64),
        zoom_amount: f64,
        _edge_snap_ratio: f64,
    ) -> (f64, f64) {
        let viewport_half = 0.5 / zoom_amount;

        let min_center = viewport_half;
        let max_center = 1.0 - viewport_half;

        (
            cursor_pos.0.clamp(min_center, max_center),
            cursor_pos.1.clamp(min_center, max_center),
        )
    }

    fn calculate_zoom_and_center_for_cursor(
        focus_pos: (f64, f64),
        cursor_pos: (f64, f64),
        target_zoom: f64,
        _edge_snap_ratio: f64,
    ) -> (f64, (f64, f64)) {
        let viewport_half = 0.5 / target_zoom;
        let min_center = viewport_half;
        let max_center = 1.0 - viewport_half;

        let mut center = (
            focus_pos.0.clamp(min_center, max_center),
            focus_pos.1.clamp(min_center, max_center),
        );

        let viewport_left = center.0 - viewport_half;
        let viewport_right = center.0 + viewport_half;
        let viewport_top = center.1 - viewport_half;
        let viewport_bottom = center.1 + viewport_half;

        let cursor_visible = cursor_pos.0 >= viewport_left
            && cursor_pos.0 <= viewport_right
            && cursor_pos.1 >= viewport_top
            && cursor_pos.1 <= viewport_bottom;

        if cursor_visible {
            return (target_zoom, center);
        }

        if cursor_pos.0 < viewport_left {
            center.0 = (cursor_pos.0 + viewport_half).clamp(min_center, max_center);
        } else if cursor_pos.0 > viewport_right {
            center.0 = (cursor_pos.0 - viewport_half).clamp(min_center, max_center);
        }

        if cursor_pos.1 < viewport_top {
            center.1 = (cursor_pos.1 + viewport_half).clamp(min_center, max_center);
        } else if cursor_pos.1 > viewport_bottom {
            center.1 = (cursor_pos.1 - viewport_half).clamp(min_center, max_center);
        }

        let new_viewport_left = center.0 - viewport_half;
        let new_viewport_right = center.0 + viewport_half;
        let new_viewport_top = center.1 - viewport_half;
        let new_viewport_bottom = center.1 + viewport_half;

        let cursor_still_visible = cursor_pos.0 >= new_viewport_left
            && cursor_pos.0 <= new_viewport_right
            && cursor_pos.1 >= new_viewport_top
            && cursor_pos.1 <= new_viewport_bottom;

        if cursor_still_visible {
            return (target_zoom, center);
        }

        let required_zoom = Self::minimum_zoom_to_show_cursor(cursor_pos);
        let effective_zoom = target_zoom.min(required_zoom).max(1.0);

        let new_viewport_half = 0.5 / effective_zoom;
        let new_min_center = new_viewport_half;
        let new_max_center = 1.0 - new_viewport_half;

        let final_center = (
            cursor_pos.0.clamp(new_min_center, new_max_center),
            cursor_pos.1.clamp(new_min_center, new_max_center),
        );

        (effective_zoom, final_center)
    }

    fn minimum_zoom_to_show_cursor(cursor_pos: (f64, f64)) -> f64 {
        let dist_from_edge_x = cursor_pos.0.min(1.0 - cursor_pos.0).max(0.001);
        let dist_from_edge_y = cursor_pos.1.min(1.0 - cursor_pos.1).max(0.001);

        let min_dist = dist_from_edge_x.min(dist_from_edge_y);

        (0.5 / min_dist).max(1.0)
    }

    pub fn new(top_left: XY<f64>, bottom_right: XY<f64>) -> Self {
        Self {
            top_left,
            bottom_right,
        }
    }

    pub fn default() -> Self {
        SegmentBounds::new(XY::new(0.0, 0.0), XY::new(1.0, 1.0))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InterpolatedZoom {
    // the ratio of current zoom to the maximum amount for the current segment
    pub t: f64,
    pub bounds: SegmentBounds,
}

fn spring_ease(t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }

    let omega0 = (SCREEN_SPRING_STIFFNESS / SCREEN_SPRING_MASS).sqrt() as f32;
    let zeta = (SCREEN_SPRING_DAMPING
        / (2.0 * (SCREEN_SPRING_STIFFNESS * SCREEN_SPRING_MASS).sqrt())) as f32;

    if zeta < 1.0 {
        let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
        let decay = (-zeta * omega0 * t).exp();
        1.0 - decay * ((omega_d * t).cos() + (zeta * omega0 / omega_d) * (omega_d * t).sin())
    } else {
        let decay = (-omega0 * t).exp();
        1.0 - decay * (1.0 + omega0 * t)
    }
}

fn spring_ease_out(t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }

    let omega0 = (SCREEN_SPRING_STIFFNESS / SCREEN_SPRING_MASS).sqrt() as f32 * 0.9;
    let zeta = (SCREEN_SPRING_DAMPING
        / (2.0 * (SCREEN_SPRING_STIFFNESS * SCREEN_SPRING_MASS).sqrt())) as f32
        * 1.15;

    if zeta < 1.0 {
        let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
        let decay = (-zeta * omega0 * t).exp();
        1.0 - decay * ((omega_d * t).cos() + (zeta * omega0 / omega_d) * (omega_d * t).sin())
    } else {
        let decay = (-omega0 * t).exp();
        1.0 - decay * (1.0 + omega0 * t)
    }
}

fn instant_ease(t: f32) -> f32 {
    if t <= 0.0 { 0.0 } else { 1.0 }
}

impl InterpolatedZoom {
    pub fn new(cursor: SegmentsCursor, interpolated_cursor: Coord<RawDisplayUVSpace>) -> Self {
        Self::new_with_cursor(cursor, interpolated_cursor, None)
    }

    pub fn new_with_cursor(
        cursor: SegmentsCursor,
        zoom_focus: Coord<RawDisplayUVSpace>,
        actual_cursor: Option<Coord<RawDisplayUVSpace>>,
    ) -> Self {
        let use_instant = cursor.segment.map(|s| s.instant_animation).unwrap_or(false);
        if use_instant {
            Self::new_with_easing_and_cursor(
                cursor,
                zoom_focus,
                actual_cursor,
                instant_ease,
                instant_ease,
            )
        } else {
            Self::new_with_easing_and_cursor(
                cursor,
                zoom_focus,
                actual_cursor,
                spring_ease,
                spring_ease_out,
            )
        }
    }

    pub fn display_amount(&self) -> f64 {
        (self.bounds.bottom_right - self.bounds.top_left).x
    }

    fn new_with_easing_and_cursor(
        cursor: SegmentsCursor,
        zoom_focus: Coord<RawDisplayUVSpace>,
        actual_cursor: Option<Coord<RawDisplayUVSpace>>,
        ease_in: impl Fn(f32) -> f32 + Copy,
        ease_out: impl Fn(f32) -> f32 + Copy,
    ) -> InterpolatedZoom {
        let default = SegmentBounds::default();
        let is_auto_mode = cursor
            .segment
            .or(cursor.prev_segment)
            .map(|s| matches!(s.mode, cap_project::ZoomMode::Auto))
            .unwrap_or(false);

        let result = match (cursor.prev_segment, cursor.segment) {
            (Some(prev_segment), None) => {
                let zoom_t =
                    ease_out(t_clamp((cursor.time - prev_segment.end) / ZOOM_DURATION) as f32)
                        as f64;

                Self {
                    t: 1.0 - zoom_t,
                    bounds: {
                        let prev_segment_bounds =
                            SegmentBounds::from_segment_with_cursor_constraint(
                                prev_segment,
                                zoom_focus,
                                actual_cursor,
                            );

                        SegmentBounds::new(
                            prev_segment_bounds.top_left * (1.0 - zoom_t)
                                + default.top_left * zoom_t,
                            prev_segment_bounds.bottom_right * (1.0 - zoom_t)
                                + default.bottom_right * zoom_t,
                        )
                    },
                }
            }
            (None, Some(segment)) => {
                let t =
                    ease_in(t_clamp((cursor.time - segment.start) / ZOOM_DURATION) as f32) as f64;

                Self {
                    t,
                    bounds: {
                        let segment_bounds = SegmentBounds::from_segment_with_cursor_constraint(
                            segment,
                            zoom_focus,
                            actual_cursor,
                        );

                        SegmentBounds::new(
                            default.top_left * (1.0 - t) + segment_bounds.top_left * t,
                            default.bottom_right * (1.0 - t) + segment_bounds.bottom_right * t,
                        )
                    },
                }
            }
            (Some(prev_segment), Some(segment)) => {
                let prev_segment_bounds = SegmentBounds::from_segment_with_cursor_constraint(
                    prev_segment,
                    zoom_focus,
                    actual_cursor,
                );
                let segment_bounds = SegmentBounds::from_segment_with_cursor_constraint(
                    segment,
                    zoom_focus,
                    actual_cursor,
                );

                let zoom_t =
                    ease_in(t_clamp((cursor.time - segment.start) / ZOOM_DURATION) as f32) as f64;

                if segment.start == prev_segment.end {
                    Self {
                        t: 1.0,
                        bounds: SegmentBounds::new(
                            prev_segment_bounds.top_left * (1.0 - zoom_t)
                                + segment_bounds.top_left * zoom_t,
                            prev_segment_bounds.bottom_right * (1.0 - zoom_t)
                                + segment_bounds.bottom_right * zoom_t,
                        ),
                    }
                } else if segment.start - prev_segment.end < ZOOM_DURATION {
                    let min = InterpolatedZoom::new_with_easing_and_cursor(
                        SegmentsCursor::new(segment.start, cursor.segments),
                        zoom_focus,
                        actual_cursor,
                        ease_in,
                        ease_out,
                    );

                    Self {
                        t: (min.t * (1.0 - zoom_t)) + zoom_t,
                        bounds: {
                            let max = segment_bounds;

                            SegmentBounds::new(
                                min.bounds.top_left * (1.0 - zoom_t) + max.top_left * zoom_t,
                                min.bounds.bottom_right * (1.0 - zoom_t)
                                    + max.bottom_right * zoom_t,
                            )
                        },
                    }
                } else {
                    Self {
                        t: zoom_t,
                        bounds: SegmentBounds::new(
                            default.top_left * (1.0 - zoom_t) + segment_bounds.top_left * zoom_t,
                            default.bottom_right * (1.0 - zoom_t)
                                + segment_bounds.bottom_right * zoom_t,
                        ),
                    }
                }
            }
            _ => Self {
                t: 0.0,
                bounds: default,
            },
        };

        if is_auto_mode {
            if let Some(cursor_coord) = actual_cursor {
                return result.ensure_cursor_visible((cursor_coord.x, cursor_coord.y));
            }
        }

        result
    }
}

impl InterpolatedZoom {
    fn ensure_cursor_visible(self, cursor_pos: (f64, f64)) -> Self {
        let current_zoom = self.bounds.bottom_right.x - self.bounds.top_left.x;

        if current_zoom <= 1.001 {
            return self;
        }

        let viewport_size = 1.0 / current_zoom;
        let viewport_left = -self.bounds.top_left.x / current_zoom;
        let viewport_right = viewport_left + viewport_size;
        let viewport_top = -self.bounds.top_left.y / current_zoom;
        let viewport_bottom = viewport_top + viewport_size;

        let margin_ratio = 0.15;
        let margin = viewport_size * margin_ratio;

        let inner_left = viewport_left + margin;
        let inner_right = viewport_right - margin;
        let inner_top = viewport_top + margin;
        let inner_bottom = viewport_bottom - margin;

        let cursor_in_safe_zone = cursor_pos.0 >= inner_left
            && cursor_pos.0 <= inner_right
            && cursor_pos.1 >= inner_top
            && cursor_pos.1 <= inner_bottom;

        if cursor_in_safe_zone {
            return self;
        }

        let target_margin = viewport_size * margin_ratio;

        let mut new_viewport_left = viewport_left;
        let mut new_viewport_top = viewport_top;

        if cursor_pos.0 < inner_left {
            new_viewport_left = cursor_pos.0 - target_margin;
        } else if cursor_pos.0 > inner_right {
            new_viewport_left = cursor_pos.0 - viewport_size + target_margin;
        }

        if cursor_pos.1 < inner_top {
            new_viewport_top = cursor_pos.1 - target_margin;
        } else if cursor_pos.1 > inner_bottom {
            new_viewport_top = cursor_pos.1 - viewport_size + target_margin;
        }

        new_viewport_left = new_viewport_left.clamp(0.0, 1.0 - viewport_size);
        new_viewport_top = new_viewport_top.clamp(0.0, 1.0 - viewport_size);

        let new_viewport_right = new_viewport_left + viewport_size;
        let new_viewport_bottom = new_viewport_top + viewport_size;

        let cursor_now_visible = cursor_pos.0 >= new_viewport_left
            && cursor_pos.0 <= new_viewport_right
            && cursor_pos.1 >= new_viewport_top
            && cursor_pos.1 <= new_viewport_bottom;

        if cursor_now_visible {
            let new_top_left_x = -new_viewport_left * current_zoom;
            let new_top_left_y = -new_viewport_top * current_zoom;

            return Self {
                t: self.t,
                bounds: SegmentBounds::new(
                    XY::new(new_top_left_x, new_top_left_y),
                    XY::new(new_top_left_x + current_zoom, new_top_left_y + current_zoom),
                ),
            };
        }

        let required_margin = 0.1;
        let dist_from_left = (cursor_pos.0 - required_margin).max(0.0);
        let dist_from_right = (1.0 - cursor_pos.0 - required_margin).max(0.0);
        let dist_from_top = (cursor_pos.1 - required_margin).max(0.0);
        let dist_from_bottom = (1.0 - cursor_pos.1 - required_margin).max(0.0);

        let effective_dist_x = dist_from_left.min(dist_from_right).max(0.001);
        let effective_dist_y = dist_from_top.min(dist_from_bottom).max(0.001);

        let max_zoom_x = 0.5 / effective_dist_x;
        let max_zoom_y = 0.5 / effective_dist_y;

        let max_zoom_for_cursor = max_zoom_x.min(max_zoom_y).max(1.0);
        let new_zoom = current_zoom.min(max_zoom_for_cursor);

        let new_viewport_size = 1.0 / new_zoom;
        let new_margin = new_viewport_size * margin_ratio;

        let final_viewport_left = if cursor_pos.0 - new_margin <= 0.0 {
            0.0
        } else if cursor_pos.0 + new_margin >= 1.0 {
            1.0 - new_viewport_size
        } else {
            (cursor_pos.0 - new_viewport_size / 2.0).clamp(0.0, 1.0 - new_viewport_size)
        };

        let final_viewport_top = if cursor_pos.1 - new_margin <= 0.0 {
            0.0
        } else if cursor_pos.1 + new_margin >= 1.0 {
            1.0 - new_viewport_size
        } else {
            (cursor_pos.1 - new_viewport_size / 2.0).clamp(0.0, 1.0 - new_viewport_size)
        };

        let new_top_left_x = -final_viewport_left * new_zoom;
        let new_top_left_y = -final_viewport_top * new_zoom;

        Self {
            t: self.t,
            bounds: SegmentBounds::new(
                XY::new(new_top_left_x, new_top_left_y),
                XY::new(new_top_left_x + new_zoom, new_top_left_y + new_zoom),
            ),
        }
    }
}

fn t_clamp(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

#[cfg(test)]
mod test {
    use cap_project::{GlideDirection, ZoomMode, ZoomSegment};

    use super::*;

    // Custom macro for floating-point near equality
    macro_rules! assert_f64_near {
        ($left:expr, $right:expr, $label:literal) => {
            let left = $left;
            let right = $right;
            assert!(
                (left - right).abs() < 1e-6,
                "{}: `(left ~ right)` \n left: `{:?}`, \n right: `{:?}`",
                $label,
                left,
                right
            )
        };
        ($left:expr, $right:expr) => {
            assert_f64_near!($left, $right, "assertion failed");
        };
    }

    fn c<'a>(time: f64, segments: &'a [ZoomSegment]) -> SegmentsCursor<'a> {
        SegmentsCursor::new(time, segments)
    }

    fn test_interp((time, segments): (f64, &[ZoomSegment]), expected: InterpolatedZoom) {
        let actual = InterpolatedZoom::new_with_easing_and_cursor(
            c(time, segments),
            Default::default(),
            None,
            |t| t,
            |t| t,
        );

        assert_f64_near!(actual.t, expected.t, "t");

        let a = &actual.bounds;
        let e = &expected.bounds;

        assert_f64_near!(a.top_left.x, e.top_left.x, "bounds.top_left.x");
        assert_f64_near!(a.top_left.y, e.top_left.y, "bounds.top_left.y");
        assert_f64_near!(a.bottom_right.x, e.bottom_right.x, "bounds.bottom_right.x");
        assert_f64_near!(a.bottom_right.y, e.bottom_right.y, "bounds.bottom_right.y");
    }

    fn test_segment(start: f64, end: f64, amount: f64, x: f64, y: f64) -> ZoomSegment {
        ZoomSegment {
            start,
            end,
            amount,
            mode: ZoomMode::Manual {
                x: x as f32,
                y: y as f32,
            },
            glide_direction: GlideDirection::default(),
            glide_speed: 0.05,
            instant_animation: false,
            edge_snap_ratio: 0.075,
        }
    }

    #[test]
    fn one_segment() {
        let segments = vec![test_segment(2.0, 4.0, 2.0, 0.5, 0.5)];

        test_interp(
            (0.0, &segments),
            InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::default(),
            },
        );
        test_interp(
            (2.0, &segments),
            InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::default(),
            },
        );
        test_interp(
            (2.0 + ZOOM_DURATION * 0.1, &segments),
            InterpolatedZoom {
                t: 0.1,
                bounds: SegmentBounds::new(XY::new(-0.05, -0.05), XY::new(1.05, 1.05)),
            },
        );
        test_interp(
            (2.0 + ZOOM_DURATION * 0.9, &segments),
            InterpolatedZoom {
                t: 0.9,
                bounds: SegmentBounds::new(XY::new(-0.45, -0.45), XY::new(1.45, 1.45)),
            },
        );
        test_interp(
            (2.0 + ZOOM_DURATION, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
            },
        );
        test_interp(
            (4.0, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.2, &segments),
            InterpolatedZoom {
                t: 0.8,
                bounds: SegmentBounds::new(XY::new(-0.4, -0.4), XY::new(1.4, 1.4)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.8, &segments),
            InterpolatedZoom {
                t: 0.2,
                bounds: SegmentBounds::new(XY::new(-0.1, -0.1), XY::new(1.1, 1.1)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION, &segments),
            InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(1.0, 1.0)),
            },
        );
    }

    #[test]
    fn two_segments_no_gap() {
        let segments = vec![
            test_segment(2.0, 4.0, 2.0, 0.0, 0.0),
            test_segment(4.0, 6.0, 4.0, 0.5, 0.5),
        ];

        test_interp(
            (4.0, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(2.0, 2.0)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.2, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-0.3, -0.3), XY::new(2.1, 2.1)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.8, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-1.2, -1.2), XY::new(2.4, 2.4)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-1.5, -1.5), XY::new(2.5, 2.5)),
            },
        );
    }

    #[test]
    fn two_segments_small_gap() {
        let segments = vec![
            test_segment(2.0, 4.0, 2.0, 0.5, 0.5),
            test_segment(4.0 + ZOOM_DURATION * 0.75, 6.0, 4.0, 0.5, 0.5),
        ];

        test_interp(
            (4.0, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.5, &segments),
            InterpolatedZoom {
                t: 0.5,
                bounds: SegmentBounds::new(XY::new(-0.25, -0.25), XY::new(1.25, 1.25)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.75, &segments),
            InterpolatedZoom {
                t: 0.25,
                bounds: SegmentBounds::new(XY::new(-0.125, -0.125), XY::new(1.125, 1.125)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * (0.75 + 0.5), &segments),
            InterpolatedZoom {
                t: 0.625,
                bounds: SegmentBounds::new(XY::new(-0.8125, -0.8125), XY::new(1.8125, 1.8125)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * (0.75 + 1.0), &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-1.5, -1.5), XY::new(2.5, 2.5)),
            },
        );
    }

    #[test]
    fn two_segments_large_gap() {
        let segments = vec![
            test_segment(2.0, 4.0, 2.0, 0.5, 0.5),
            test_segment(7.0, 9.0, 4.0, 0.0, 0.0),
        ];

        test_interp(
            (4.0, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION * 0.5, &segments),
            InterpolatedZoom {
                t: 0.5,
                bounds: SegmentBounds::new(XY::new(-0.25, -0.25), XY::new(1.25, 1.25)),
            },
        );
        test_interp(
            (4.0 + ZOOM_DURATION, &segments),
            InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(1.0, 1.0)),
            },
        );
        test_interp(
            (7.0, &segments),
            InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(1.0, 1.0)),
            },
        );
        test_interp(
            (7.0 + ZOOM_DURATION * 0.5, &segments),
            InterpolatedZoom {
                t: 0.5,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(2.5, 2.5)),
            },
        );
        test_interp(
            (7.0 + ZOOM_DURATION * 1.0, &segments),
            InterpolatedZoom {
                t: 1.0,
                bounds: SegmentBounds::new(XY::new(0.0, 0.0), XY::new(4.0, 4.0)),
            },
        );
    }

    fn cursor_is_visible_in_zoom(zoom: &InterpolatedZoom, cursor_pos: (f64, f64)) -> bool {
        let current_zoom = zoom.bounds.bottom_right.x - zoom.bounds.top_left.x;
        if current_zoom <= 1.001 {
            return cursor_pos.0 >= 0.0
                && cursor_pos.0 <= 1.0
                && cursor_pos.1 >= 0.0
                && cursor_pos.1 <= 1.0;
        }

        let viewport_size = 1.0 / current_zoom;
        let viewport_left = -zoom.bounds.top_left.x / current_zoom;
        let viewport_right = viewport_left + viewport_size;
        let viewport_top = -zoom.bounds.top_left.y / current_zoom;
        let viewport_bottom = viewport_top + viewport_size;

        let margin = 1e-9;
        cursor_pos.0 >= viewport_left - margin
            && cursor_pos.0 <= viewport_right + margin
            && cursor_pos.1 >= viewport_top + margin
            && cursor_pos.1 <= viewport_bottom + margin
    }

    #[test]
    fn ensure_cursor_visible_keeps_cursor_in_view() {
        let zoom = InterpolatedZoom {
            t: 1.0,
            bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
        };

        let cursor_outside_right = (0.9, 0.5);
        let result = zoom.ensure_cursor_visible(cursor_outside_right);
        assert!(
            cursor_is_visible_in_zoom(&result, cursor_outside_right),
            "Cursor should be visible after ensure_cursor_visible"
        );

        let cursor_outside_bottom = (0.5, 0.9);
        let result = zoom.ensure_cursor_visible(cursor_outside_bottom);
        assert!(
            cursor_is_visible_in_zoom(&result, cursor_outside_bottom),
            "Cursor should be visible after ensure_cursor_visible"
        );

        let cursor_outside_corner = (0.9, 0.9);
        let result = zoom.ensure_cursor_visible(cursor_outside_corner);
        assert!(
            cursor_is_visible_in_zoom(&result, cursor_outside_corner),
            "Cursor should be visible after ensure_cursor_visible"
        );

        let cursor_at_edge = (0.95, 0.95);
        let result = zoom.ensure_cursor_visible(cursor_at_edge);
        assert!(
            cursor_is_visible_in_zoom(&result, cursor_at_edge),
            "Cursor at edge should be visible after ensure_cursor_visible"
        );
    }

    #[test]
    fn ensure_cursor_visible_handles_extreme_positions() {
        let zoom = InterpolatedZoom {
            t: 1.0,
            bounds: SegmentBounds::new(XY::new(-0.5, -0.5), XY::new(1.5, 1.5)),
        };

        let test_positions = [
            (0.05, 0.5),
            (0.95, 0.5),
            (0.5, 0.05),
            (0.5, 0.95),
            (0.05, 0.05),
            (0.95, 0.95),
            (0.05, 0.95),
            (0.95, 0.05),
        ];

        for cursor_pos in test_positions {
            let result = zoom.ensure_cursor_visible(cursor_pos);
            assert!(
                cursor_is_visible_in_zoom(&result, cursor_pos),
                "Cursor at {:?} should be visible",
                cursor_pos
            );
        }
    }

    #[test]
    fn ensure_cursor_visible_handles_interpolated_bounds() {
        let zoom = InterpolatedZoom {
            t: 0.5,
            bounds: SegmentBounds::new(XY::new(-0.25, -0.25), XY::new(1.25, 1.25)),
        };

        let cursor_pos = (0.85, 0.85);
        let result = zoom.ensure_cursor_visible(cursor_pos);
        assert!(
            cursor_is_visible_in_zoom(&result, cursor_pos),
            "Cursor should be visible in interpolated zoom state"
        );
    }
}
