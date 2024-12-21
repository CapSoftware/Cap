use cap_flags::FLAGS;
use cap_project::{ProjectConfiguration, ZoomSegment};

#[derive(Debug, PartialEq)]
pub struct ZoomKeyframe {
    pub time: f64,
    pub scale: f64,
    pub position: ZoomPosition,
    pub has_segment: bool,
}
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ZoomPosition {
    Cursor,
    Manual { x: f32, y: f32 },
}
#[derive(Debug, PartialEq)]
pub struct ZoomKeyframes(Vec<ZoomKeyframe>);

pub const ZOOM_DURATION: f64 = 0.6;

#[derive(Debug, PartialEq, Clone, Copy)]
pub struct InterpolatedZoom {
    pub amount: f64,
    pub t: f64,
    pub position: ZoomPosition,
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

        if segments[0].start != 0.0 {
            keyframes.push(ZoomKeyframe {
                time: 0.0,
                scale: 1.0,
                position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
                has_segment: false,
            });
        }

        for (i, segment) in segments.iter().enumerate() {
            let position = match segment.mode {
                cap_project::ZoomMode::Auto => ZoomPosition::Cursor,
                cap_project::ZoomMode::Manual { x, y } => ZoomPosition::Manual { x, y },
            };

            let prev = if i > 0 { segments.get(i - 1) } else { None };
            let next = segments.get(i + 1);

            if let Some(prev) = prev {
                if prev.end + ZOOM_DURATION < segment.start {
                    // keyframes.push(ZoomKeyframe {
                    //     time: segment.start,
                    //     scale: 1.0,
                    //     position,
                    // });
                }
            } else {
                if keyframes.len() != 0 {
                    keyframes.push(ZoomKeyframe {
                        time: segment.start,
                        scale: 1.0,
                        position,
                        has_segment: true,
                    });
                }
            }

            keyframes.push(ZoomKeyframe {
                time: segment.start + ZOOM_DURATION,
                scale: segment.amount,
                position,
                has_segment: true,
            });
            keyframes.push(ZoomKeyframe {
                time: segment.end,
                scale: segment.amount,
                position,
                has_segment: true,
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
                    });
                }
            } else {
                keyframes.push(ZoomKeyframe {
                    time: segment.end + ZOOM_DURATION,
                    scale: 1.0,
                    position,
                    has_segment: false,
                });
            }
        }

        Self(dbg!(keyframes))
    }

    pub fn interpolate(&self, time: f64) -> InterpolatedZoom {
        let default = InterpolatedZoom {
            amount: 1.0,
            position: ZoomPosition::Manual { x: 0.0, y: 0.0 },
            t: 0.0,
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

        let time_t = delta_time / keyframe_length;

        let keyframe_diff = next.scale - prev.scale;

        let amount = prev.scale + (keyframe_diff) * time_t;

        let time_t = ease(time_t as f32) as f64;

        // the process we use to get to this is way too convoluted lol
        let t = ease(
            (if prev.scale > 1.0 && next.scale > 1.0 {
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
            }) as f32,
        ) as f64;

        let position = match (&prev.position, &next.position) {
            (ZoomPosition::Manual { x: x1, y: y1 }, ZoomPosition::Manual { x: x2, y: y2 }) => {
                ZoomPosition::Manual {
                    x: x1 + (x2 - x1) * time_t as f32,
                    y: y1 + (y2 - y1) * time_t as f32,
                }
            }
            _ => ZoomPosition::Manual { x: 0.0, y: 0.0 },
        };

        InterpolatedZoom {
            amount: if next.scale > prev.scale {
                prev.scale + (next.scale - prev.scale) * t
            } else {
                prev.scale + (next.scale - prev.scale) * (1.0 - t)
            },
            position,
            t,
        }
    }
}

#[cfg(test)]
mod test {
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
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: false,
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
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.8, y: 0.8 },
                    has_segment: false,
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
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 1.5 + ZOOM_DURATION,
                    scale: 2.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 2.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: true,
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    position: ZoomPosition::Manual { x: 0.2, y: 0.2 },
                    has_segment: false,
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
        };

        pretty_assertions::assert_eq!(
            keyframes,
            ZoomKeyframes(vec![
                ZoomKeyframe {
                    has_segment: false,
                    ..base
                },
                ZoomKeyframe {
                    time: 0.5,
                    scale: 1.0,
                    ..base
                },
                ZoomKeyframe {
                    time: 0.5 + ZOOM_DURATION,
                    scale: 1.5,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.5,
                    scale: 1.5,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.8,
                    scale: 1.5 - (0.3 / ZOOM_DURATION) * 0.5,
                    has_segment: false,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.8 + ZOOM_DURATION,
                    scale: 1.5,
                    ..base
                },
                ZoomKeyframe {
                    time: 2.5,
                    scale: 1.5,
                    ..base
                },
                ZoomKeyframe {
                    time: 2.5 + ZOOM_DURATION,
                    scale: 1.0,
                    has_segment: false,
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
                    scale: 1.0,
                    ..base
                },
                ZoomKeyframe {
                    time: 0.3966305848375451 + ZOOM_DURATION,
                    scale: 1.176,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.396630584837545,
                    scale: 1.176,
                    ..base
                },
                ZoomKeyframe {
                    time: 1.396630584837545 + ZOOM_DURATION,
                    scale: 1.204,
                    ..base
                },
                ZoomKeyframe {
                    time: 3.21881273465704,
                    scale: 1.204,
                    ..base
                },
                ZoomKeyframe {
                    time: 3.21881273465704 + ZOOM_DURATION,
                    scale: 1.0,
                    has_segment: false,
                    ..base
                },
            ])
        );
    }
}
