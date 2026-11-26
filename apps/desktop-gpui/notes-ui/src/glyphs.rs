use gpui::{
    Bounds, Hsla, IntoElement, PathBuilder, Pixels, Styled, Window, canvas, point, px, quad,
    transparent_black,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Glyph {
    Text,
    Heading(u8),
    Bullet,
    Numbered,
    Checkbox,
    Quote,
    Code,
    Divider,
    Template,
    Link,
    ChevronUp,
    ChevronDown,
    Close,
    Search,
}

type Line = &'static [(f32, f32)];

const DIGIT_1: Line = &[(11.3, 7.3), (12.8, 6.0), (12.8, 12.5)];
const DIGIT_2: Line = &[
    (10.7, 7.2),
    (11.5, 6.2),
    (12.4, 6.0),
    (13.4, 6.4),
    (13.7, 7.4),
    (13.2, 8.6),
    (10.7, 12.5),
    (13.9, 12.5),
];
const DIGIT_3: Line = &[
    (10.8, 6.3),
    (13.6, 6.0),
    (12.0, 9.0),
    (13.4, 9.4),
    (13.8, 10.9),
    (13.1, 12.2),
    (11.8, 12.5),
    (10.7, 12.0),
];

struct Pen<'a> {
    origin: (f32, f32),
    scale: f32,
    color: Hsla,
    window: &'a mut Window,
}

impl Pen<'_> {
    fn at(&self, p: (f32, f32)) -> gpui::Point<Pixels> {
        point(
            px(self.origin.0 + p.0 * self.scale),
            px(self.origin.1 + p.1 * self.scale),
        )
    }

    fn line(&mut self, points: &[(f32, f32)], width: f32) {
        self.line_colored(points, width, self.color);
    }

    fn line_colored(&mut self, points: &[(f32, f32)], width: f32, color: Hsla) {
        if points.len() < 2 {
            return;
        }
        let w = width * self.scale;
        let mut builder = PathBuilder::stroke(px(w));
        builder.move_to(self.at(points[0]));
        for p in &points[1..] {
            builder.line_to(self.at(*p));
        }
        if let Ok(path) = builder.build() {
            self.window.paint_path(path, color);
        }
        for p in points {
            self.dot_colored(*p, width / 2., color);
        }
    }

    fn dot(&mut self, center: (f32, f32), radius: f32) {
        self.dot_colored(center, radius, self.color);
    }

    fn dot_colored(&mut self, center: (f32, f32), radius: f32, color: Hsla) {
        let c = self.at(center);
        let r = px(radius * self.scale);
        self.window.paint_quad(quad(
            Bounds::from_corners(point(c.x - r, c.y - r), point(c.x + r, c.y + r)),
            r,
            color,
            px(0.),
            transparent_black(),
            Default::default(),
        ));
    }

    fn rounded_box(&mut self, from: (f32, f32), to: (f32, f32), radius: f32, border: f32) {
        self.window.paint_quad(quad(
            Bounds::from_corners(self.at(from), self.at(to)),
            px(radius * self.scale),
            transparent_black(),
            px(border * self.scale),
            self.color,
            Default::default(),
        ));
    }

    fn bar(&mut self, from: (f32, f32), to: (f32, f32), radius: f32) {
        self.window.paint_quad(quad(
            Bounds::from_corners(self.at(from), self.at(to)),
            px(radius * self.scale),
            self.color,
            px(0.),
            transparent_black(),
            Default::default(),
        ));
    }
}

fn capsule(center: (f32, f32), length: f32, radius: f32, angle: f32) -> Vec<(f32, f32)> {
    let (dx, dy) = (angle.cos(), angle.sin());
    let half = length / 2. - radius;
    let a = (center.0 - dx * half, center.1 - dy * half);
    let b = (center.0 + dx * half, center.1 + dy * half);
    let mut points = Vec::with_capacity(22);
    let steps = 10;
    for i in 0..=steps {
        let t =
            angle - std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / steps as f32;
        points.push((b.0 + radius * t.cos(), b.1 + radius * t.sin()));
    }
    for i in 0..=steps {
        let t =
            angle + std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / steps as f32;
        points.push((a.0 + radius * t.cos(), a.1 + radius * t.sin()));
    }
    points.push(points[0]);
    points
}

fn draw(glyph: Glyph, pen: &mut Pen<'_>) {
    let w = 1.4;
    match glyph {
        Glyph::Text => {
            pen.line(&[(3., 4.5), (13., 4.5)], w);
            pen.line(&[(3., 8.), (13., 8.)], w);
            pen.line(&[(3., 11.5), (9., 11.5)], w);
        }
        Glyph::Heading(level) => {
            pen.line(&[(2.5, 3.5), (2.5, 12.5)], w);
            pen.line(&[(8.5, 3.5), (8.5, 12.5)], w);
            pen.line(&[(2.5, 8.), (8.5, 8.)], w);
            let digit = match level {
                1 => DIGIT_1,
                2 => DIGIT_2,
                _ => DIGIT_3,
            };
            pen.line(digit, 1.2);
        }
        Glyph::Bullet => {
            for y in [4.5, 8., 11.5] {
                pen.dot((3.5, y), 1.15);
                pen.line(&[(6.5, y), (13.5, y)], w);
            }
        }
        Glyph::Numbered => {
            for (digit, y) in [(DIGIT_1, 4.5), (DIGIT_2, 8.), (DIGIT_3, 11.5)] {
                let scaled: Vec<(f32, f32)> = digit
                    .iter()
                    .map(|(x, dy)| (2. + (x - 10.5) * 0.55, y - 1.8 + (dy - 6.) * 0.55))
                    .collect();
                pen.line(&scaled, 0.9);
                pen.line(&[(6.5, y), (13.5, y)], w);
            }
        }
        Glyph::Checkbox => {
            pen.rounded_box((2.5, 2.5), (13.5, 13.5), 3.5, 1.3);
            pen.line(&[(5.2, 8.3), (7.3, 10.4), (10.9, 5.9)], w);
        }
        Glyph::Quote => {
            pen.bar((2.8, 3.), (4.4, 13.), 0.8);
            for y in [5., 8., 11.] {
                pen.line(&[(7., y), (13.5, y)], w);
            }
        }
        Glyph::Code => {
            pen.line(&[(6., 4.5), (2.8, 8.), (6., 11.5)], w);
            pen.line(&[(10., 4.5), (13.2, 8.), (10., 11.5)], w);
        }
        Glyph::Divider => {
            let faint = Hsla {
                a: pen.color.a * 0.4,
                ..pen.color
            };
            pen.line_colored(&[(4., 4.5), (12., 4.5)], 1.2, faint);
            pen.line(&[(2., 8.), (14., 8.)], w);
            pen.line_colored(&[(4., 11.5), (12., 11.5)], 1.2, faint);
        }
        Glyph::Template => {
            pen.rounded_box((3., 2.5), (13., 13.5), 2.5, 1.3);
            pen.line(&[(5.6, 6.), (10.4, 6.)], 1.2);
            pen.line(&[(5.6, 8.5), (10.4, 8.5)], 1.2);
            pen.line(&[(5.6, 11.), (8.4, 11.)], 1.2);
        }
        Glyph::Link => {
            let angle = -std::f32::consts::FRAC_PI_4;
            pen.line(&capsule((5.5, 10.5), 7.6, 2.5, angle), 1.3);
            pen.line(&capsule((10.5, 5.5), 7.6, 2.5, angle), 1.3);
        }
        Glyph::ChevronUp => pen.line(&[(4., 10.), (8., 6.), (12., 10.)], 1.5),
        Glyph::ChevronDown => pen.line(&[(4., 6.), (8., 10.), (12., 6.)], 1.5),
        Glyph::Close => {
            pen.line(&[(4.5, 4.5), (11.5, 11.5)], 1.5);
            pen.line(&[(11.5, 4.5), (4.5, 11.5)], 1.5);
        }
        Glyph::Search => {
            pen.line(&capsule((7., 7.), 8.6, 4.3, 0.), 1.4);
            pen.line(&[(10.4, 10.4), (13.5, 13.5)], 1.5);
        }
    }
}

pub(crate) fn glyph(kind: Glyph, size: f32, color: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let scale = f32::from(bounds.size.width) / 16.;
            let mut pen = Pen {
                origin: (f32::from(bounds.left()), f32::from(bounds.top())),
                scale,
                color,
                window,
            };
            draw(kind, &mut pen);
        },
    )
    .size(px(size))
    .flex_shrink_0()
}
