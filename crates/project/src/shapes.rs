use serde::{Deserialize, Serialize};
use specta::Type;

use crate::XY;

/// Stroke widths, corner radii and badge text are authored in pixels of a
/// 1080p-tall frame, like text font sizes, so a shape keeps its weight at
/// every export resolution.
pub const SHAPE_REFERENCE_HEIGHT: f64 = 1080.0;
pub const SHAPE_MAX_STROKE_WIDTH: f32 = 40.0;
pub const SHAPE_MAX_CORNER_RADIUS: f32 = 200.0;
pub const SHAPE_MAX_ANIMATION_DURATION: f64 = 3.0;
pub const SHAPE_DEFAULT_STROKE: &str = "#F05656";
pub const SHAPE_HIGHLIGHT_FILL: &str = "#FFD60A";

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    #[default]
    Arrow,
    Line,
    Rectangle,
    Ellipse,
    Highlight,
    Badge,
}

impl ShapeKind {
    pub const ALL: [Self; 6] = [
        Self::Arrow,
        Self::Line,
        Self::Rectangle,
        Self::Ellipse,
        Self::Highlight,
        Self::Badge,
    ];

    pub fn is_line(self) -> bool {
        matches!(self, Self::Arrow | Self::Line)
    }

    pub fn keeps_square(self) -> bool {
        matches!(self, Self::Badge)
    }

    pub fn supports_fill(self) -> bool {
        matches!(
            self,
            Self::Rectangle | Self::Ellipse | Self::Highlight | Self::Badge
        )
    }

    pub fn supports_corner_radius(self) -> bool {
        matches!(self, Self::Rectangle | Self::Highlight)
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ShapeArrowHead {
    #[default]
    Filled,
    Open,
    Double,
}

#[derive(Type, Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ShapeAnimation {
    None,
    #[default]
    Fade,
    Scale,
    Draw,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShapeSegment {
    pub start: f64,
    pub end: f64,
    pub track: u32,
    pub enabled: bool,
    pub kind: ShapeKind,
    pub from: XY<f64>,
    pub to: XY<f64>,
    pub stroke_color: String,
    pub stroke_width: f32,
    pub fill: bool,
    pub fill_color: String,
    pub fill_opacity: f32,
    pub corner_radius: f32,
    pub arrow_head: ShapeArrowHead,
    pub shadow: f32,
    pub opacity: f32,
    pub animation_in: ShapeAnimation,
    pub animation_out: ShapeAnimation,
    pub animation_in_duration: f64,
    pub animation_out_duration: f64,
    pub number: u32,
}

impl Default for ShapeSegment {
    fn default() -> Self {
        Self {
            start: 0.0,
            end: 0.0,
            track: 0,
            enabled: true,
            kind: ShapeKind::Arrow,
            from: XY::new(0.4, 0.4),
            to: XY::new(0.6, 0.6),
            stroke_color: SHAPE_DEFAULT_STROKE.to_string(),
            stroke_width: 6.0,
            fill: false,
            fill_color: SHAPE_DEFAULT_STROKE.to_string(),
            fill_opacity: 0.2,
            corner_radius: 12.0,
            arrow_head: ShapeArrowHead::Filled,
            shadow: 0.3,
            opacity: 1.0,
            animation_in: ShapeAnimation::Fade,
            animation_out: ShapeAnimation::Fade,
            animation_in_duration: 0.25,
            animation_out_duration: 0.2,
            number: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl ShapeRect {
    pub fn from_points(a: XY<f64>, b: XY<f64>) -> Self {
        let x = a.x.min(b.x);
        let y = a.y.min(b.y);
        Self {
            x,
            y,
            w: (a.x - b.x).abs(),
            h: (a.y - b.y).abs(),
        }
    }

    pub fn center(self) -> XY<f64> {
        XY::new(self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

impl ShapeSegment {
    pub fn new(kind: ShapeKind, start: f64, end: f64, center: XY<f64>, aspect: f64) -> Self {
        let aspect = if aspect.is_finite() && aspect > 0.0 {
            aspect
        } else {
            16.0 / 9.0
        };
        let (half_w, half_h) = match kind {
            ShapeKind::Arrow => (0.16, 0.1),
            ShapeKind::Line => (0.18, 0.0),
            ShapeKind::Rectangle => (0.24, 0.15),
            ShapeKind::Ellipse => (0.18, 0.18),
            ShapeKind::Highlight => (0.28, 0.06),
            ShapeKind::Badge => (0.045, 0.045),
        };
        let half_w = half_w / aspect;
        let from = XY::new(center.x - half_w, center.y - half_h);
        let to = XY::new(center.x + half_w, center.y + half_h);
        let mut segment = Self {
            start,
            end,
            kind,
            from,
            to,
            ..Self::default()
        };
        segment.apply_kind_defaults();
        segment
    }

    pub fn apply_kind_defaults(&mut self) {
        let base = Self::default();
        self.stroke_color = base.stroke_color;
        self.fill_color = base.fill_color;
        self.fill_opacity = base.fill_opacity;
        self.fill = false;
        self.opacity = 1.0;
        self.arrow_head = ShapeArrowHead::Filled;
        match self.kind {
            ShapeKind::Arrow | ShapeKind::Line => {
                self.stroke_width = 6.0;
                self.shadow = 0.3;
                self.animation_in = ShapeAnimation::Draw;
                self.animation_in_duration = 0.4;
            }
            ShapeKind::Rectangle | ShapeKind::Ellipse => {
                self.stroke_width = 6.0;
                self.corner_radius = 12.0;
                self.shadow = 0.3;
                self.animation_in = ShapeAnimation::Draw;
                self.animation_in_duration = 0.5;
            }
            ShapeKind::Highlight => {
                self.stroke_width = 0.0;
                self.corner_radius = 10.0;
                self.fill = true;
                self.fill_color = SHAPE_HIGHLIGHT_FILL.to_string();
                self.fill_opacity = 0.4;
                self.shadow = 0.0;
                self.animation_in = ShapeAnimation::Fade;
                self.animation_in_duration = 0.25;
            }
            ShapeKind::Badge => {
                self.stroke_color = "#FFFFFF".to_string();
                self.stroke_width = 4.0;
                self.fill = true;
                self.fill_opacity = 1.0;
                self.shadow = 0.35;
                self.animation_in = ShapeAnimation::Scale;
                self.animation_in_duration = 0.3;
            }
        }
        self.animation_out = ShapeAnimation::Fade;
        self.animation_out_duration = 0.2;
    }

    pub fn is_active_at(&self, time: f64) -> bool {
        self.enabled
            && time.is_finite()
            && self.start.is_finite()
            && self.end.is_finite()
            && self.end > self.start
            && time >= self.start
            && time < self.end
    }

    pub fn rect(&self) -> ShapeRect {
        ShapeRect::from_points(self.from, self.to)
    }

    pub fn translate(&mut self, dx: f64, dy: f64) {
        self.from.x += dx;
        self.from.y += dy;
        self.to.x += dx;
        self.to.y += dy;
    }

    pub fn is_renderable(&self) -> bool {
        [self.from.x, self.from.y, self.to.x, self.to.y]
            .iter()
            .all(|value| value.is_finite() && value.abs() < 1.0e4)
            && self.stroke_width.is_finite()
            && self.corner_radius.is_finite()
            && self.fill_opacity.is_finite()
            && self.shadow.is_finite()
            && self.opacity.is_finite()
            && self.animation_in_duration.is_finite()
            && self.animation_out_duration.is_finite()
    }
}

pub fn arrow_head_size(stroke_width: f64, arrow_length: f64) -> (f64, f64) {
    let width = stroke_width.max(1.0);
    let length = (width * 5.0).max(18.0);
    let head_width = (width * 4.5).max(16.0);
    let fit = if arrow_length.is_finite() && arrow_length > 0.0 {
        (arrow_length * 0.45 / length).min(1.0)
    } else {
        1.0
    };
    (length * fit, head_width * fit)
}

pub fn next_badge_number(segments: &[ShapeSegment]) -> u32 {
    segments
        .iter()
        .filter(|segment| segment.kind == ShapeKind::Badge)
        .map(|segment| segment.number)
        .max()
        .map_or(1, |number| number.saturating_add(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_object_deserializes_to_defaults() {
        let segment: ShapeSegment = serde_json::from_str("{}").unwrap();
        assert_eq!(segment, ShapeSegment::default());
        assert!(segment.enabled);
        assert_eq!(segment.kind, ShapeKind::Arrow);
    }

    #[test]
    fn round_trips_every_field() {
        let segment = ShapeSegment {
            start: 1.5,
            end: 4.25,
            track: 2,
            enabled: false,
            kind: ShapeKind::Highlight,
            from: XY::new(0.1, 0.2),
            to: XY::new(0.3, 0.4),
            stroke_color: "#123456".into(),
            stroke_width: 3.5,
            fill: true,
            fill_color: "#abcdef".into(),
            fill_opacity: 0.5,
            corner_radius: 20.0,
            arrow_head: ShapeArrowHead::Double,
            shadow: 0.7,
            opacity: 0.8,
            animation_in: ShapeAnimation::Draw,
            animation_out: ShapeAnimation::Scale,
            animation_in_duration: 0.9,
            animation_out_duration: 1.1,
            number: 7,
        };
        let json = serde_json::to_value(&segment).unwrap();
        assert_eq!(json["kind"], "highlight");
        assert_eq!(json["arrowHead"], "double");
        assert_eq!(json["animationIn"], "draw");
        assert_eq!(json["strokeColor"], "#123456");
        let restored: ShapeSegment = serde_json::from_value(json).unwrap();
        assert_eq!(restored, segment);
    }

    #[test]
    fn unknown_fields_from_newer_builds_are_ignored() {
        let segment: ShapeSegment = serde_json::from_value(serde_json::json!({
            "kind": "ellipse",
            "start": 1.0,
            "end": 2.0,
            "rotation": 45.0,
            "somethingNew": {"nested": true}
        }))
        .unwrap();
        assert_eq!(segment.kind, ShapeKind::Ellipse);
        assert_eq!(segment.end, 2.0);
    }

    #[test]
    fn new_shapes_are_centred_and_square_in_pixels() {
        let aspect = 16.0 / 9.0;
        for kind in ShapeKind::ALL {
            let segment = ShapeSegment::new(kind, 2.0, 5.0, XY::new(0.5, 0.5), aspect);
            let rect = segment.rect();
            let center = rect.center();
            assert!((center.x - 0.5).abs() < 1e-9, "{kind:?}");
            assert!((center.y - 0.5).abs() < 1e-9, "{kind:?}");
            assert_eq!((segment.start, segment.end), (2.0, 5.0));
            assert!(segment.is_renderable());
        }
        let badge = ShapeSegment::new(ShapeKind::Badge, 0.0, 1.0, XY::new(0.5, 0.5), aspect);
        let rect = badge.rect();
        assert!((rect.w * aspect - rect.h).abs() < 1e-9);
        let circle = ShapeSegment::new(ShapeKind::Ellipse, 0.0, 1.0, XY::new(0.5, 0.5), aspect);
        let rect = circle.rect();
        assert!((rect.w * aspect - rect.h).abs() < 1e-9);
    }

    #[test]
    fn invalid_aspect_falls_back_to_widescreen() {
        let shape = ShapeSegment::new(ShapeKind::Rectangle, 0.0, 1.0, XY::new(0.5, 0.5), f64::NAN);
        assert!(shape.is_renderable());
        let zero = ShapeSegment::new(ShapeKind::Rectangle, 0.0, 1.0, XY::new(0.5, 0.5), 0.0);
        assert_eq!(shape, zero);
    }

    #[test]
    fn kind_defaults_give_each_kind_its_look() {
        let highlight = ShapeSegment::new(ShapeKind::Highlight, 0.0, 1.0, XY::new(0.5, 0.5), 1.0);
        assert!(highlight.fill);
        assert_eq!(highlight.stroke_width, 0.0);
        assert_eq!(highlight.fill_color, SHAPE_HIGHLIGHT_FILL);
        let badge = ShapeSegment::new(ShapeKind::Badge, 0.0, 1.0, XY::new(0.5, 0.5), 1.0);
        assert!(badge.fill);
        assert_eq!(badge.animation_in, ShapeAnimation::Scale);
        let arrow = ShapeSegment::new(ShapeKind::Arrow, 0.0, 1.0, XY::new(0.5, 0.5), 1.0);
        assert_eq!(arrow.animation_in, ShapeAnimation::Draw);
        assert!(!arrow.fill);
    }

    #[test]
    fn rect_normalizes_reversed_points() {
        let rect = ShapeRect::from_points(XY::new(0.8, 0.9), XY::new(0.2, 0.1));
        assert!((rect.x - 0.2).abs() < 1e-12);
        assert!((rect.y - 0.1).abs() < 1e-12);
        assert!((rect.w - 0.6).abs() < 1e-12);
        assert!((rect.h - 0.8).abs() < 1e-12);
    }

    #[test]
    fn activity_rejects_empty_and_non_finite_ranges() {
        let mut segment = ShapeSegment {
            start: 2.0,
            end: 2.0,
            ..Default::default()
        };
        assert!(!segment.is_active_at(2.0));
        segment.end = 3.0;
        assert!(segment.is_active_at(2.0));
        assert!(!segment.is_active_at(3.0));
        assert!(!segment.is_active_at(f64::NAN));
        segment.end = f64::INFINITY;
        assert!(!segment.is_active_at(2.5));
        segment.end = 3.0;
        segment.enabled = false;
        assert!(!segment.is_active_at(2.5));
    }

    #[test]
    fn long_timelines_keep_millisecond_ranges() {
        let start = 2.0 * 3600.0 + 0.001;
        let segment = ShapeSegment {
            start,
            end: start + 0.002,
            ..Default::default()
        };
        assert!(segment.is_active_at(start + 0.001));
        assert!(!segment.is_active_at(start - 0.0005));
    }

    #[test]
    fn non_finite_geometry_is_not_renderable() {
        let mut segment = ShapeSegment::default();
        segment.from.x = f64::NAN;
        assert!(!segment.is_renderable());
        let mut segment = ShapeSegment::default();
        segment.stroke_width = f32::INFINITY;
        assert!(!segment.is_renderable());
    }

    #[test]
    fn arrow_heads_shrink_on_short_arrows() {
        let (length, width) = arrow_head_size(6.0, 1000.0);
        assert_eq!((length, width), (30.0, 27.0));
        let (short_length, short_width) = arrow_head_size(6.0, 20.0);
        assert!((short_length - 9.0).abs() < 1e-9);
        assert!(short_width < width);
        assert_eq!(arrow_head_size(0.0, 1000.0), (18.0, 16.0));
        assert_eq!(arrow_head_size(6.0, 0.0), (30.0, 27.0));
    }

    #[test]
    fn badges_count_up_from_the_highest() {
        assert_eq!(next_badge_number(&[]), 1);
        let badge = |number| ShapeSegment {
            kind: ShapeKind::Badge,
            number,
            ..Default::default()
        };
        let arrow = ShapeSegment {
            number: 40,
            ..Default::default()
        };
        assert_eq!(next_badge_number(&[badge(1), badge(3), arrow]), 4);
        assert_eq!(next_badge_number(&[badge(u32::MAX)]), u32::MAX);
    }
}
