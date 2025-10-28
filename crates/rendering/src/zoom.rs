use cap_project::{XY, ZoomSegment};

use crate::{Coord, RawDisplayUVSpace};

pub const ZOOM_DURATION: f64 = 1.0;

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
    fn from_segment(segment: &ZoomSegment, interpolated_cursor: Coord<RawDisplayUVSpace>) -> Self {
        let position = match segment.mode {
            cap_project::ZoomMode::Auto => (interpolated_cursor.x, interpolated_cursor.y),
            cap_project::ZoomMode::Manual { x, y } => (x as f64, y as f64),
        };

        let scaled_center = [position.0 * segment.amount, position.1 * segment.amount];
        let center_diff = [scaled_center[0] - position.0, scaled_center[1] - position.1];

        SegmentBounds::new(
            XY::new(0.0 - center_diff[0], 0.0 - center_diff[1]),
            XY::new(
                segment.amount - center_diff[0],
                segment.amount - center_diff[1],
            ),
        )
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

impl InterpolatedZoom {
    pub fn new(cursor: SegmentsCursor, interpolated_cursor: Coord<RawDisplayUVSpace>) -> Self {
        let ease_in = bezier_easing::bezier_easing(0.1, 0.0, 0.3, 1.0).unwrap();
        let ease_out = bezier_easing::bezier_easing(0.5, 0.0, 0.5, 1.0).unwrap();

        Self::new_with_easing(cursor, interpolated_cursor, ease_in, ease_out)
    }

    // the multiplier applied to the display width/height
    pub fn display_amount(&self) -> f64 {
        (self.bounds.bottom_right - self.bounds.top_left).x
    }

    pub(self) fn new_with_easing(
        cursor: SegmentsCursor,
        interpolated_cursor: Coord<RawDisplayUVSpace>,
        ease_in: impl Fn(f32) -> f32,
        ease_out: impl Fn(f32) -> f32,
    ) -> InterpolatedZoom {
        let default = SegmentBounds::default();
        match (cursor.prev_segment, cursor.segment) {
            (Some(prev_segment), None) => {
                let zoom_t =
                    ease_out(t_clamp((cursor.time - prev_segment.end) / ZOOM_DURATION) as f32)
                        as f64;

                Self {
                    t: 1.0 - zoom_t,
                    bounds: {
                        let prev_segment_bounds =
                            SegmentBounds::from_segment(prev_segment, interpolated_cursor);

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
                        let segment_bounds =
                            SegmentBounds::from_segment(segment, interpolated_cursor);

                        SegmentBounds::new(
                            default.top_left * (1.0 - t) + segment_bounds.top_left * t,
                            default.bottom_right * (1.0 - t) + segment_bounds.bottom_right * t,
                        )
                    },
                }
            }
            (Some(prev_segment), Some(segment)) => {
                let prev_segment_bounds =
                    SegmentBounds::from_segment(prev_segment, interpolated_cursor);
                let segment_bounds = SegmentBounds::from_segment(segment, interpolated_cursor);

                let zoom_t =
                    ease_in(t_clamp((cursor.time - segment.start) / ZOOM_DURATION) as f32) as f64;

                // no gap
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
                }
                // small gap
                else if segment.start - prev_segment.end < ZOOM_DURATION {
                    // handling this is a bit funny, since we're not zooming in from 0 but rather
                    // from the previous value that the zoom out got interrupted at by the current segment

                    let min = InterpolatedZoom::new_with_easing(
                        SegmentsCursor::new(segment.start, cursor.segments),
                        interpolated_cursor,
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
                }
                // entirely separate
                else {
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
        }
    }
}

fn t_clamp(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

#[cfg(test)]
mod test {
    use cap_project::ZoomMode;

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
        let actual =
            InterpolatedZoom::new_with_easing(c(time, segments), Default::default(), |t| t, |t| t);

        assert_f64_near!(actual.t, expected.t, "t");

        let a = &actual.bounds;
        let e = &expected.bounds;

        assert_f64_near!(a.top_left.x, e.top_left.x, "bounds.top_left.x");
        assert_f64_near!(a.top_left.y, e.top_left.y, "bounds.top_left.y");
        assert_f64_near!(a.bottom_right.x, e.bottom_right.x, "bounds.bottom_right.x");
        assert_f64_near!(a.bottom_right.y, e.bottom_right.y, "bounds.bottom_right.y");
    }

    #[test]
    fn one_segment() {
        let segments = vec![ZoomSegment {
            start: 2.0,
            end: 4.0,
            amount: 2.0,
            mode: ZoomMode::Manual { x: 0.5, y: 0.5 },
        }];

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
            ZoomSegment {
                start: 2.0,
                end: 4.0,
                amount: 2.0,
                mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
            ZoomSegment {
                start: 4.0,
                end: 6.0,
                amount: 4.0,
                mode: ZoomMode::Manual { x: 0.5, y: 0.5 },
            },
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
            ZoomSegment {
                start: 2.0,
                end: 4.0,
                amount: 2.0,
                mode: ZoomMode::Manual { x: 0.5, y: 0.5 },
            },
            ZoomSegment {
                start: 4.0 + ZOOM_DURATION * 0.75,
                end: 6.0,
                amount: 4.0,
                mode: ZoomMode::Manual { x: 0.5, y: 0.5 },
            },
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
            ZoomSegment {
                start: 2.0,
                end: 4.0,
                amount: 2.0,
                mode: ZoomMode::Manual { x: 0.5, y: 0.5 },
            },
            ZoomSegment {
                start: 7.0,
                end: 9.0,
                amount: 4.0,
                mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
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
}
