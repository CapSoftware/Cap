use cap_flags::FLAGS;
use cap_project::{ProjectConfiguration, ZoomSegment};

#[derive(Debug, PartialEq)]
pub struct ZoomKeyframe {
    pub time: f64,
    pub scale: f64,
    pub position: ZoomPosition,
    pub has_segment: bool,
    pub lowered: LoweredKeyframe,
}
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ZoomPosition {
    Cursor,
    Manual { x: f32, y: f32 },
}
#[derive(Debug, PartialEq)]
pub struct ZoomKeyframes(Vec<ZoomKeyframe>);

pub const ZOOM_DURATION: f64 = 1.0;

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct InterpolatedZoom {
    pub amount: f64,
    pub t: f64,
    pub position: ZoomPosition,
    pub time_t: f64,
    pub lowered: LoweredKeyframe,
}

impl ZoomKeyframes {
    pub fn new(config: &ProjectConfiguration) -> Self {
        let Some(zoom_segments) = config.timeline().map(|t| &t.zoom_segments) else {
            return Self(vec![]);
        };

        Self::from_zoom_segments(zoom_segments)
    }

    fn from_zoom_segments(segments: &[ZoomSegment]) -> Self {
        if segments.is_empty() {
            return Self(vec![]);
        }

        let mut keyframes = vec![];

        for (i, segment) in segments.iter().enumerate() {
            let position = match segment.mode {
                cap_project::ZoomMode::Auto => ZoomPosition::Cursor,
                cap_project::ZoomMode::Manual { x, y } => ZoomPosition::Manual { x, y },
            };

            let prev = if i > 0 { segments.get(i - 1) } else { None };
            let next = segments.get(i + 1);

            let lowered_position = match segment.mode {
                cap_project::ZoomMode::Auto => (0.0, 0.0),
                cap_project::ZoomMode::Manual { x, y } => (x, y),
            };

            if let Some(prev) = prev {
                if prev.end + ZOOM_DURATION < segment.start {
                    // keyframes.push(ZoomKeyframe {
                    //     time: segment.start,
                    //     scale: 1.0,
                    //     position,
                    // });
                }

                keyframes.push(ZoomKeyframe {
                    time: segment.start + ZOOM_DURATION,
                    scale: segment.amount,
                    position,
                    has_segment: true,
                    lowered: LoweredKeyframe::new(lowered_position, segment.amount as f32),
                });
            } else {
                if segment.start != 0.0 {
                    keyframes.extend([
                        ZoomKeyframe {
                            time: 0.0,
                            scale: 1.0,
                            position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
                            has_segment: false,
                            lowered: LoweredKeyframe::new((0.0, 0.0), 1.0),
                        },
                        ZoomKeyframe {
                            time: segment.start,
                            scale: 1.0,
                            position,
                            has_segment: true,
                            lowered: LoweredKeyframe::new(lowered_position, 1.0),
                        },
                        ZoomKeyframe {
                            time: segment.start + ZOOM_DURATION,
                            scale: segment.amount,
                            position,
                            has_segment: true,
                            lowered: LoweredKeyframe::new(lowered_position, segment.amount as f32),
                        },
                    ]);
                } else {
                    keyframes.push(ZoomKeyframe {
                        time: segment.start,
                        scale: segment.amount,
                        position,
                        has_segment: true,
                        lowered: LoweredKeyframe::new(lowered_position, segment.amount as f32),
                    });
                }
            }

            keyframes.push(ZoomKeyframe {
                time: segment.end,
                scale: segment.amount,
                position,
                has_segment: true,
                lowered: LoweredKeyframe::new(lowered_position, segment.amount as f32),
            });

            if let Some(next) = next {
                if segment.end + ZOOM_DURATION > next.start && next.start > segment.end {
                    let time = next.start - segment.end;
                    let t = time / ZOOM_DURATION;

                    keyframes.push(ZoomKeyframe {
                        time: segment.end + time,
                        scale: 1.0 * t + (1.0 - t) * segment.amount,
                        position,
                        has_segment: false,
                        lowered: LoweredKeyframe::new(
                            lowered_position,
                            (1.0 * t + (1.0 - t) * segment.amount) as f32,
                        ),
                    });
                }
            } else {
                keyframes.push(ZoomKeyframe {
                    time: segment.end + ZOOM_DURATION,
                    scale: 1.0,
                    position,
                    has_segment: false,
                    lowered: LoweredKeyframe::new(lowered_position, 1.0),
                });
            }
        }

        Self(keyframes)
    }

    pub fn interpolate(&self, time: f64) -> InterpolatedZoom {
        let default = InterpolatedZoom {
            amount: 1.0,
            position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
            t: 0.0,
            time_t: 0.0,
            lowered: LoweredKeyframe::new((0.0, 0.0), 1.0),
        };

        if !FLAGS.zoom {
            return default;
        }

        let prev_index = self
            .0
            .iter()
            .rev()
            .position(|k| time >= k.time)
            .map(|p| self.0.len() - 1 - p);

        let Some(prev_index) = prev_index else {
            return default;
        };

        let next_index = prev_index + 1;

        let Some((prev, next)) = self.0.get(prev_index).zip(self.0.get(next_index)) else {
            return default;
        };

        let keyframe_length = next.time - prev.time;
        let delta_time = time - prev.time;

        let ease = if next.scale >= prev.scale {
            bezier_easing::bezier_easing(0.1, 0.0, 0.3, 1.0).unwrap()
        } else {
            bezier_easing::bezier_easing(0.5, 0.0, 0.5, 1.0).unwrap()
        };

        let time_t_raw = delta_time / keyframe_length;

        let keyframe_diff = next.scale - prev.scale;

        // let time_t = ease(time_t_raw as f32) as f64;
        let time_t = time_t_raw;

        let amount = prev.scale + (keyframe_diff) * time_t;

        // the process we use to get to this is way too convoluted lol
        let t = if prev.scale > 1.0 && next.scale > 1.0 {
            if !next.has_segment {
                (amount - 1.0) / (prev.scale - 1.0)
            } else if !prev.has_segment {
                (amount - 1.0) / (next.scale - 1.0)
            } else {
                1.0
            }
        } else if next.scale > 1.0 {
            (amount - 1.0) / (next.scale - 1.0)
        } else if prev.scale > 1.0 {
            (amount - 1.0) / (prev.scale - 1.0)
        } else {
            0.0
        };

        let position = match (&prev.position, &next.position) {
            (ZoomPosition::Manual { x: x1, y: y1 }, ZoomPosition::Manual { x: x2, y: y2 }) => {
                ZoomPosition::Manual {
                    x: x1 + (x2 - x1) * time_t_raw as f32,
                    y: y1 + (y2 - y1) * time_t_raw as f32,
                }
            }
            _ => ZoomPosition::Manual { x: 0.0, y: 0.0 },
        };

        let eased_time_t = ease(time_t as f32);

        InterpolatedZoom {
            time_t,
            amount: prev.scale + (next.scale - prev.scale) * time_t,
            position,
            t: ease(t as f32) as f64,
            lowered: LoweredKeyframe {
                top_left: {
                    let prev = prev.lowered.top_left;
                    let next = next.lowered.top_left;

                    (
                        prev.0 + (next.0 - prev.0) * eased_time_t,
                        prev.1 + (next.1 - prev.1) * eased_time_t,
                    )
                },
                bottom_right: {
                    let prev = prev.lowered.bottom_right;
                    let next = next.lowered.bottom_right;

                    (
                        prev.0 + (next.0 - prev.0) * eased_time_t,
                        prev.1 + (next.1 - prev.1) * eased_time_t,
                    )
                },
            },
        }
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct LoweredKeyframe {
    pub top_left: (f32, f32),
    pub bottom_right: (f32, f32),
}

impl LoweredKeyframe {
    fn new(center: (f32, f32), amount: f32) -> Self {
        let scaled_center = (center.0 * amount, center.1 * amount);
        let center_diff = (scaled_center.0 - center.0, scaled_center.1 - center.1);

        Self {
            top_left: (0.0 - center_diff.0, 0.0 - center_diff.1),
            bottom_right: (amount - center_diff.0, amount - center_diff.1),
        }
    }
}

#[cfg(test)]
mod test {
    use cap_project::ZoomMode;

    use super::*;

    #[test]
    fn single_keyframe() {
        let segments = [ZoomSegment {
            start: 0.5,
            end: 1.5,
            amount: 1.5,
            mode: cap_project::ZoomMode::Manual { x: 0.2, y: 0.2 },
        }];

        let keyframes = ZoomKeyframes::from_zoom_segments(&segments);

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    time: 0.0,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.0)
                }
            ])
        );
    }

    #[test]
    fn adjancent_different_position() {
        let segments = [
            ZoomSegment {
                start: 0.5,
                end: 1.5,
                amount: 1.5,
                mode: cap_project::ZoomMode::Manual { x: 0.2, y: 0.2 },
            },
            ZoomSegment {
                start: 1.5,
                end: 2.5,
                amount: 1.5,
                mode: cap_project::ZoomMode::Manual { x: 0.8, y: 0.8 },
            },
        ];

        let keyframes = ZoomKeyframes::from_zoom_segments(&segments);

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    time: 0.0,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.8, 0.8), 1.5)
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.8, 0.8), 1.5)
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.8, 0.8), 1.0)
                }
            ])
        );
    }

    #[test]
    fn adjacent_different_amount() {
        let segments = [
            ZoomSegment {
                start: 0.5,
                end: 1.5,
                amount: 1.5,
                mode: cap_project::ZoomMode::Manual { x: 0.2, y: 0.2 },
            },
            ZoomSegment {
                start: 1.5,
                end: 2.5,
                amount: 2.0,
                mode: cap_project::ZoomMode::Manual { x: 0.2, y: 0.2 },
            },
        ];

        let keyframes = ZoomKeyframes::from_zoom_segments(&segments);

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    time: 0.0,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.0)
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.5)
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 2.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 2.0)
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 2.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 2.0)
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.2, 0.2), 1.0)
                }
            ])
        );
    }

    #[test]
    fn gap() {
        let segments = [
            ZoomSegment {
                start: 0.5,
                end: 1.5,
                amount: 1.5,
                mode: cap_project::ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
            ZoomSegment {
                start: 1.8,
                end: 2.5,
                amount: 1.5,
                mode: cap_project::ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
        ];

        let keyframes = ZoomKeyframes::from_zoom_segments(&segments);

        let position = ZoomPosition::Manual { x: 0.0, y: 0.0 };
        let base = ZoomKeyframe {
            time: 0.0,
            scale: 1.0,
            position,
            has_segment: true,
            lowered: LoweredKeyframe::new((0.0, 0.0), 1.0),
        };

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    has_segment: false,
                    ..base
                },
                ZoomKeyframe { time: 0.5, ..base },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.5),
                    ..base
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.5),
                    ..base
                },
                ZoomKeyframe {
                    time: 1.8,
                    scale: 1.5 - (0.3 / ZOOM_DURATION) * 0.5,
                    lowered: LoweredKeyframe::new(
                        (0.0, 0.0),
                        1.5 - (0.3 / ZOOM_DURATION as f32) * 0.5
                    ),
                    has_segment: false,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.8 + ZOOM_DURATION,
                    scale: 1.5,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.5),
                    ..base
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 1.5,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.5),
                    ..base
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    has_segment: false,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.0),
                    ..base
                }
            ])
        );
    }

    #[test]
    fn project_config() {
        let segments = [
            ZoomSegment {
                start: 0.3966305848375451,
                end: 1.396630584837545,
                amount: 1.176,
                mode: cap_project::ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
            ZoomSegment {
                start: 1.396630584837545,
                end: 3.21881273465704,
                amount: 1.204,
                mode: cap_project::ZoomMode::Manual { x: 0.0, y: 0.0 },
            },
        ];

        let keyframes = ZoomKeyframes::from_zoom_segments(&segments);

        let position = ZoomPosition::Manual { x: 0.0, y: 0.0 };
        let base = ZoomKeyframe {
            time: 0.0,
            scale: 1.0,
            position,
            has_segment: true,
            lowered: LoweredKeyframe::new((0.0, 0.0), 1.0),
        };

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    has_segment: false,
                    ..base
                },
                ZoomKeyframe {
                    time: 0.3966305848375451,
                    ..base
                },
                ZoomKeyframe {
                    time: 0.3966305848375451 + ZOOM_DURATION,
                    scale: 1.176,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.176),
                    ..base
                },
                ZoomKeyframe {
                    time: 1.396630584837545,
                    scale: 1.176,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.176),
                    ..base
                },
                ZoomKeyframe {
                    time: 1.396630584837545 + ZOOM_DURATION,
                    scale: 1.204,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.204),
                    ..base
                },
                ZoomKeyframe {
                    time: 3.21881273465704,
                    scale: 1.204,
                    lowered: LoweredKeyframe::new((0.0, 0.0), 1.204),
                    ..base
                },
                ZoomKeyframe {
                    time: 3.21881273465704 + ZOOM_DURATION,
                    has_segment: false,
                    ..base
                },
            ])
        );
    }

    mod interpolate {
        use super::*;

        #[test]
        fn amount() {
            let keyframes = ZoomKeyframes::from_zoom_segments(&[
                ZoomSegment {
                    start: 0.0,
                    end: 1.0,
                    amount: 1.2,
                    mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
                },
                ZoomSegment {
                    start: 1.0,
                    end: 2.0,
                    amount: 1.5,
                    mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
                },
            ]);

            assert_eq!(keyframes.interpolate(0.0).amount, 1.2);
            assert_eq!(keyframes.interpolate(1.0).amount, 1.2);
            assert_eq!(keyframes.interpolate(2.0).amount, 1.5);
        }

        #[test]
        fn t() {
            let keyframes = ZoomKeyframes::from_zoom_segments(&[
                ZoomSegment {
                    start: 0.0,
                    end: 1.0,
                    amount: 1.2,
                    mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
                },
                ZoomSegment {
                    start: 1.0,
                    end: 2.0,
                    amount: 1.5,
                    mode: ZoomMode::Manual { x: 0.0, y: 0.0 },
                },
            ]);

            assert_eq!(keyframes.interpolate(0.0).t, 1.0);
            assert_eq!(keyframes.interpolate(1.0).t, 1.0);
            assert_eq!(keyframes.interpolate(2.0).t, 1.0);
            assert_eq!(keyframes.interpolate(2.0 + ZOOM_DURATION).t, 0.0);
        }
    }

    mod new_keyframe_lowering {
        use super::*;

        #[test]
        fn basic() {
            let center = (0.0, 0.0);
            let amount = 2.0;

            assert_eq!(
                LoweredKeyframe::new(center, amount),
                LoweredKeyframe {
                    top_left: (0.0, 0.0),
                    bottom_right: (2.0, 2.0)
                }
            );

            let center = (1.0, 1.0);
            let amount = 2.0;

            assert_eq!(
                LoweredKeyframe::new(center, amount),
                LoweredKeyframe {
                    top_left: (-1.0, -1.0),
                    bottom_right: (1.0, 1.0)
                }
            );
        }
    }
}
