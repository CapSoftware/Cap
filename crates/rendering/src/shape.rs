use cap_project::{
    SHAPE_MAX_ANIMATION_DURATION, SHAPE_MAX_CORNER_RADIUS, SHAPE_MAX_STROKE_WIDTH,
    SHAPE_REFERENCE_HEIGHT, ShapeAnimation, ShapeArrowHead, ShapeKind, ShapeSegment, XY,
};

/// One visible shape for one frame, in output pixels with its animations
/// already applied. Geometry is final: a scale animation has already moved
/// the points and thickened or thinned the stroke.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedShape {
    pub track: u32,
    pub kind: ShapeKind,
    pub from: [f32; 2],
    pub to: [f32; 2],
    pub stroke_width: f32,
    pub stroke_color: [f32; 3],
    pub fill: Option<[f32; 4]>,
    pub corner_radius: f32,
    pub arrow_head: ShapeArrowHead,
    pub shadow: f32,
    pub alpha: f32,
    pub draw: f32,
    pub unit: f32,
    pub number: u32,
}

impl PreparedShape {
    pub fn rect(&self) -> [f32; 4] {
        [
            self.from[0].min(self.to[0]),
            self.from[1].min(self.to[1]),
            self.from[0].max(self.to[0]),
            self.from[1].max(self.to[1]),
        ]
    }

    pub fn badge_circle(&self) -> ([f32; 2], f32) {
        let [left, top, right, bottom] = self.rect();
        (
            [(left + right) * 0.5, (top + bottom) * 0.5],
            ((right - left).min(bottom - top) * 0.5).max(0.0),
        )
    }

    /// Black or white, whichever reads on the badge fill. An unfilled badge
    /// has nothing behind its number, so the number takes the ring's colour.
    pub fn badge_text_color(&self) -> [f32; 4] {
        let Some([r, g, b, _]) = self.fill else {
            let [r, g, b] = self.stroke_color;
            return [r, g, b, 1.0];
        };
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if luminance > 0.6 {
            [0.07, 0.07, 0.08, 1.0]
        } else {
            [1.0, 1.0, 1.0, 1.0]
        }
    }
}

pub(crate) fn parse_shape_color(hex: &str) -> Option<[f32; 3]> {
    let hex = hex.trim().trim_start_matches('#');
    if !hex.is_ascii() {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    let [r, g, b] = match hex.len() {
        6 => [channel(0..2)?, channel(2..4)?, channel(4..6)?],
        3 => [
            channel(0..1)? * 17,
            channel(1..2)? * 17,
            channel(2..3)? * 17,
        ],
        _ => return None,
    };
    Some([
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    ])
}

fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn ease_in_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

fn ease_out_back(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let c1 = 1.2;
    let c3 = c1 + 1.0;
    let p = t - 1.0;
    1.0 + c3 * p * p * p + c1 * p * p
}

pub(crate) const SCALE_ANIMATION_FROM: f32 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq)]
struct EdgeSample {
    alpha: f32,
    scale: f32,
    draw: f32,
}

const AT_REST: EdgeSample = EdgeSample {
    alpha: 1.0,
    scale: 1.0,
    draw: 1.0,
};

fn sample_edge(animation: ShapeAnimation, progress: f32) -> EdgeSample {
    if progress >= 1.0 {
        return AT_REST;
    }
    match animation {
        ShapeAnimation::None => AT_REST,
        ShapeAnimation::Fade => EdgeSample {
            alpha: ease_out_cubic(progress),
            ..AT_REST
        },
        ShapeAnimation::Scale => EdgeSample {
            alpha: ease_out_cubic((progress * 1.6).min(1.0)),
            scale: SCALE_ANIMATION_FROM + (1.0 - SCALE_ANIMATION_FROM) * ease_out_back(progress),
            draw: 1.0,
        },
        ShapeAnimation::Draw => EdgeSample {
            alpha: ease_out_cubic((progress * 5.0).min(1.0)),
            draw: ease_in_out_cubic(progress),
            ..AT_REST
        },
    }
}

pub(crate) fn edge_durations(segment: &ShapeSegment) -> (f64, f64) {
    let duration = |animation, seconds: f64| {
        if animation == ShapeAnimation::None || !seconds.is_finite() {
            0.0
        } else {
            seconds.clamp(0.0, SHAPE_MAX_ANIMATION_DURATION)
        }
    };
    let enter = duration(segment.animation_in, segment.animation_in_duration);
    let exit = duration(segment.animation_out, segment.animation_out_duration);
    let length = (segment.end - segment.start).max(0.0);
    let total = enter + exit;
    if total > length && total > 0.0 {
        let fit = length / total;
        (enter * fit, exit * fit)
    } else {
        (enter, exit)
    }
}

fn edge_progress(elapsed: f64, duration: f64) -> f32 {
    if duration <= 0.0 {
        1.0
    } else {
        (elapsed / duration).clamp(0.0, 1.0) as f32
    }
}

pub fn prepare_shapes(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[ShapeSegment],
) -> Vec<PreparedShape> {
    let mut prepared = Vec::new();
    prepare_shapes_into(output_size, frame_time, segments, &mut prepared);
    prepared
}

pub fn prepare_shapes_into(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[ShapeSegment],
    prepared: &mut Vec<PreparedShape>,
) {
    prepared.clear();
    if output_size.x == 0 || output_size.y == 0 {
        return;
    }
    let width = output_size.x as f64;
    let height = output_size.y as f64;
    let unit = (height / SHAPE_REFERENCE_HEIGHT) as f32;

    let mut visible = segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.is_active_at(frame_time) && segment.is_renderable())
        .collect::<Vec<_>>();
    if visible.is_empty() {
        return;
    }
    visible.sort_by_key(|(index, segment)| (segment.track, *index));

    for (_, segment) in visible {
        let (enter_duration, exit_duration) = edge_durations(segment);
        let enter = sample_edge(
            segment.animation_in,
            edge_progress(frame_time - segment.start, enter_duration),
        );
        let exit = sample_edge(
            segment.animation_out,
            edge_progress(segment.end - frame_time, exit_duration),
        );
        let alpha = segment.opacity.clamp(0.0, 1.0) * enter.alpha * exit.alpha;
        if alpha <= 0.0 {
            continue;
        }
        let scale = enter.scale * exit.scale;
        let draw = enter.draw.min(exit.draw);

        let mut from = [
            (segment.from.x * width) as f32,
            (segment.from.y * height) as f32,
        ];
        let mut to = [
            (segment.to.x * width) as f32,
            (segment.to.y * height) as f32,
        ];
        if segment.kind == ShapeKind::Badge {
            let rect = segment.rect();
            let center = [
                ((rect.x + rect.w / 2.0) * width) as f32,
                ((rect.y + rect.h / 2.0) * height) as f32,
            ];
            let radius = ((rect.w * width).min(rect.h * height) / 2.0) as f32;
            from = [center[0] - radius, center[1] - radius];
            to = [center[0] + radius, center[1] + radius];
        }
        if scale != 1.0 {
            let center = [(from[0] + to[0]) * 0.5, (from[1] + to[1]) * 0.5];
            for point in [&mut from, &mut to] {
                point[0] = center[0] + (point[0] - center[0]) * scale;
                point[1] = center[1] + (point[1] - center[1]) * scale;
            }
        }

        let stroke_width = segment.stroke_width.clamp(0.0, SHAPE_MAX_STROKE_WIDTH) * unit * scale;
        let fill = (segment.fill && segment.kind.supports_fill())
            .then(|| {
                parse_shape_color(&segment.fill_color)
                    .map(|[r, g, b]| [r, g, b, segment.fill_opacity.clamp(0.0, 1.0)])
            })
            .flatten()
            .filter(|fill| fill[3] > 0.0);
        let corner_radius = if segment.kind.supports_corner_radius() {
            segment.corner_radius.clamp(0.0, SHAPE_MAX_CORNER_RADIUS) * unit * scale
        } else {
            0.0
        };

        prepared.push(PreparedShape {
            track: segment.track,
            kind: segment.kind,
            from,
            to,
            stroke_width,
            stroke_color: parse_shape_color(&segment.stroke_color)
                .or_else(|| parse_shape_color(cap_project::SHAPE_DEFAULT_STROKE))
                .unwrap_or([1.0, 0.0, 0.0]),
            fill,
            corner_radius,
            arrow_head: segment.arrow_head,
            shadow: segment.shadow.clamp(0.0, 1.0),
            alpha,
            draw,
            unit: unit * scale,
            number: segment.number,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(kind: ShapeKind) -> ShapeSegment {
        ShapeSegment {
            start: 1.0,
            end: 5.0,
            kind,
            from: XY::new(0.25, 0.25),
            to: XY::new(0.75, 0.5),
            animation_in: ShapeAnimation::None,
            animation_out: ShapeAnimation::None,
            ..Default::default()
        }
    }

    const HD: XY<u32> = XY::new(1920, 1080);

    #[test]
    fn only_active_renderable_segments_are_prepared() {
        let shapes = [segment(ShapeKind::Rectangle)];
        assert!(prepare_shapes(HD, 0.99, &shapes).is_empty());
        assert_eq!(prepare_shapes(HD, 1.0, &shapes).len(), 1);
        assert_eq!(prepare_shapes(HD, 4.99, &shapes).len(), 1);
        assert!(prepare_shapes(HD, 5.0, &shapes).is_empty());
        assert!(prepare_shapes(HD, f64::NAN, &shapes).is_empty());
        assert!(prepare_shapes(XY::new(0, 1080), 2.0, &shapes).is_empty());

        let mut broken = segment(ShapeKind::Line);
        broken.to.y = f64::INFINITY;
        let mut nan_width = segment(ShapeKind::Line);
        nan_width.stroke_width = f32::NAN;
        let mut disabled = segment(ShapeKind::Line);
        disabled.enabled = false;
        let mut empty = segment(ShapeKind::Line);
        empty.end = empty.start;
        assert!(prepare_shapes(HD, 2.0, &[broken, nan_width, disabled, empty]).is_empty());
    }

    #[test]
    fn shapes_draw_in_track_then_config_order() {
        let mut shapes = vec![
            segment(ShapeKind::Arrow),
            segment(ShapeKind::Line),
            segment(ShapeKind::Ellipse),
        ];
        shapes[0].track = 2;
        shapes[1].track = 1;
        shapes[2].track = 2;
        let kinds = prepare_shapes(HD, 2.0, &shapes)
            .into_iter()
            .map(|shape| shape.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [ShapeKind::Line, ShapeKind::Arrow, ShapeKind::Ellipse]
        );
    }

    #[test]
    fn geometry_scales_with_the_output_in_normalised_terms() {
        let mut shape = segment(ShapeKind::Rectangle);
        shape.stroke_width = 8.0;
        shape.corner_radius = 20.0;
        let reference = &prepare_shapes(HD, 2.0, std::slice::from_ref(&shape))[0];
        for size in [XY::new(1280, 720), XY::new(3840, 2160), XY::new(1080, 1080)] {
            let prepared = &prepare_shapes(size, 2.0, std::slice::from_ref(&shape))[0];
            let sx = size.x as f32 / 1920.0;
            let sy = size.y as f32 / 1080.0;
            assert!((prepared.from[0] / sx - reference.from[0]).abs() < 1e-3);
            assert!((prepared.to[1] / sy - reference.to[1]).abs() < 1e-3);
            assert!((prepared.stroke_width / sy - 8.0).abs() < 1e-4);
            assert!((prepared.corner_radius / sy - 20.0).abs() < 1e-4);
            assert!((prepared.unit - sy).abs() < 1e-6);
        }
    }

    #[test]
    fn reversed_points_keep_the_same_box() {
        let mut shape = segment(ShapeKind::Ellipse);
        let forward = prepare_shapes(HD, 2.0, std::slice::from_ref(&shape))[0].rect();
        std::mem::swap(&mut shape.from, &mut shape.to);
        let reversed = prepare_shapes(HD, 2.0, std::slice::from_ref(&shape))[0].rect();
        assert_eq!(forward, reversed);
    }

    #[test]
    fn zero_length_lines_are_still_prepared() {
        let mut line = segment(ShapeKind::Line);
        line.to = line.from;
        let prepared = prepare_shapes(HD, 2.0, &[line]);
        assert_eq!(prepared[0].from, prepared[0].to);
    }

    #[test]
    fn badges_are_round_in_pixels() {
        let shape = segment(ShapeKind::Badge);
        let prepared = &prepare_shapes(HD, 2.0, &[shape])[0];
        let [left, top, right, bottom] = prepared.rect();
        assert!(((right - left) - (bottom - top)).abs() < 1e-3);
        assert!((bottom - top - 270.0).abs() < 1e-3);
        assert!(((left + right) / 2.0 - 960.0).abs() < 1e-3);
    }

    #[test]
    fn fill_and_corner_radius_follow_the_kind() {
        let mut line = segment(ShapeKind::Line);
        line.fill = true;
        line.corner_radius = 30.0;
        let prepared = &prepare_shapes(HD, 2.0, &[line])[0];
        assert!(prepared.fill.is_none());
        assert_eq!(prepared.corner_radius, 0.0);

        let mut highlight = segment(ShapeKind::Highlight);
        highlight.fill = true;
        highlight.fill_color = "#ff0000".into();
        highlight.fill_opacity = 0.4;
        let prepared = &prepare_shapes(HD, 2.0, &[highlight.clone()])[0];
        assert_eq!(prepared.fill, Some([1.0, 0.0, 0.0, 0.4]));
        highlight.fill_opacity = 0.0;
        assert!(prepare_shapes(HD, 2.0, &[highlight])[0].fill.is_none());
    }

    #[test]
    fn bad_colours_fall_back_to_the_default_stroke() {
        let mut shape = segment(ShapeKind::Line);
        shape.stroke_color = "not a colour".into();
        let prepared = &prepare_shapes(HD, 2.0, &[shape])[0];
        assert_eq!(
            Some(prepared.stroke_color),
            parse_shape_color(cap_project::SHAPE_DEFAULT_STROKE)
        );
        assert_eq!(parse_shape_color("#fff"), Some([1.0, 1.0, 1.0]));
        assert_eq!(parse_shape_color("#ééé"), None);
    }

    #[test]
    fn fade_runs_from_clear_to_opaque_and_back() {
        let mut shape = segment(ShapeKind::Rectangle);
        shape.animation_in = ShapeAnimation::Fade;
        shape.animation_out = ShapeAnimation::Fade;
        shape.animation_in_duration = 0.5;
        shape.animation_out_duration = 0.5;
        let alpha = |time| {
            prepare_shapes(HD, time, std::slice::from_ref(&shape))
                .first()
                .map_or(0.0, |shape| shape.alpha)
        };
        assert_eq!(alpha(1.0), 0.0);
        assert!(alpha(1.25) > 0.0 && alpha(1.25) < 1.0);
        assert_eq!(alpha(1.5), 1.0);
        assert_eq!(alpha(4.5), 1.0);
        assert!(alpha(4.75) > 0.0 && alpha(4.75) < 1.0);
        assert!(alpha(4.9999) < 0.01);
    }

    #[test]
    fn scale_grows_about_the_centre() {
        let mut shape = segment(ShapeKind::Ellipse);
        shape.animation_in = ShapeAnimation::Scale;
        shape.animation_in_duration = 1.0;
        let rest = prepare_shapes(HD, 3.0, std::slice::from_ref(&shape))[0].clone();
        let early = prepare_shapes(HD, 1.05, std::slice::from_ref(&shape))[0].clone();
        let center = |shape: &PreparedShape| {
            let [l, t, r, b] = shape.rect();
            [(l + r) / 2.0, (t + b) / 2.0]
        };
        let a = center(&rest);
        let b = center(&early);
        assert!((a[0] - b[0]).abs() < 1e-3 && (a[1] - b[1]).abs() < 1e-3);
        let width = |shape: &PreparedShape| shape.rect()[2] - shape.rect()[0];
        assert!(width(&early) < width(&rest));
        assert!(early.stroke_width < rest.stroke_width);
        assert!(width(&early) >= width(&rest) * (SCALE_ANIMATION_FROM - 0.01));
    }

    #[test]
    fn draw_progress_traces_in_and_retracts_out() {
        let mut shape = segment(ShapeKind::Arrow);
        shape.animation_in = ShapeAnimation::Draw;
        shape.animation_out = ShapeAnimation::Draw;
        shape.animation_in_duration = 1.0;
        shape.animation_out_duration = 1.0;
        let draw = |time| {
            prepare_shapes(HD, time, std::slice::from_ref(&shape))
                .first()
                .map_or(0.0, |shape| shape.draw)
        };
        assert_eq!(draw(1.0), 0.0);
        let samples = [1.2, 1.4, 1.6, 1.8].map(draw);
        assert!(samples.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(draw(2.0), 1.0);
        assert_eq!(draw(3.5), 1.0);
        assert!(draw(4.5) < 1.0);
        assert!(draw(4.9) < draw(4.5));
    }

    #[test]
    fn short_segments_share_their_length_between_the_edges() {
        let mut shape = segment(ShapeKind::Rectangle);
        shape.end = shape.start + 0.4;
        shape.animation_in = ShapeAnimation::Fade;
        shape.animation_out = ShapeAnimation::Draw;
        shape.animation_in_duration = 0.6;
        shape.animation_out_duration = 0.2;
        let (enter, exit) = edge_durations(&shape);
        assert!((enter - 0.3).abs() < 1e-9);
        assert!((exit - 0.1).abs() < 1e-9);
        let midpoint = &prepare_shapes(HD, shape.start + 0.3, &[shape])[0];
        assert_eq!(midpoint.alpha, 1.0);
        assert_eq!(midpoint.draw, 1.0);
    }

    #[test]
    fn hostile_durations_are_clamped() {
        let mut shape = segment(ShapeKind::Rectangle);
        shape.animation_in = ShapeAnimation::Fade;
        shape.animation_in_duration = -4.0;
        shape.animation_out = ShapeAnimation::Fade;
        shape.animation_out_duration = 1.0e9;
        assert_eq!(edge_durations(&shape), (0.0, SHAPE_MAX_ANIMATION_DURATION));
        shape.animation_out = ShapeAnimation::None;
        assert_eq!(edge_durations(&shape), (0.0, 0.0));
    }

    #[test]
    fn two_hour_timestamps_keep_frame_accuracy() {
        let start = 2.0 * 3600.0 + 17.0;
        let mut shape = segment(ShapeKind::Line);
        shape.start = start;
        shape.end = start + 1.0 / 30.0;
        shape.animation_in = ShapeAnimation::Fade;
        shape.animation_in_duration = 0.01;
        let shapes = [shape];
        assert!(prepare_shapes(HD, start - 1.0 / 60.0, &shapes).is_empty());
        let prepared = prepare_shapes(HD, start + 1.0 / 60.0, &shapes);
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].alpha, 1.0);
        assert!(prepare_shapes(HD, start + 1.0 / 30.0, &shapes).is_empty());
    }

    #[test]
    fn badge_numbers_pick_a_readable_colour() {
        let mut badge = segment(ShapeKind::Badge);
        badge.fill = true;
        badge.fill_opacity = 1.0;
        badge.fill_color = "#FFD60A".into();
        let light = &prepare_shapes(HD, 2.0, std::slice::from_ref(&badge))[0];
        assert!(light.badge_text_color()[0] < 0.5);
        badge.fill_color = "#F05656".into();
        let dark = &prepare_shapes(HD, 2.0, std::slice::from_ref(&badge))[0];
        assert_eq!(dark.badge_text_color(), [1.0, 1.0, 1.0, 1.0]);
        badge.fill = false;
        badge.stroke_color = "#00FF00".into();
        let ring = &prepare_shapes(HD, 2.0, &[badge])[0];
        assert_eq!(ring.badge_text_color(), [0.0, 1.0, 0.0, 1.0]);
    }
}
