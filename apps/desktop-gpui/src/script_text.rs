//! Script lettering drawn from pre-shaped glyph outlines (Damion, set with
//! HarfBuzz offline), so the face needs no font loading: the camera
//! preview's "loading" and the welcome screen's "Welcome".

use std::cell::RefCell;

use gpui::{Bounds, FillOptions, FillRule, Path, PathBuilder, PathStyle, Pixels, Point, point, px};

pub(crate) enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Quad(f32, f32, f32, f32),
    Close,
}

type PathCache = Vec<(usize, [u32; 2], Path<Pixels>)>;

pub(crate) struct Script {
    pub bounds: ((f32, f32), (f32, f32)),
    pub outline: &'static [Segment],
}

impl Script {
    pub fn fit(&self, area: Bounds<Pixels>) -> Option<((f32, f32), f32)> {
        let ((min_x, min_y), (max_x, max_y)) = self.bounds;
        let word_width = max_x - min_x;
        let word_height = max_y - min_y;
        let scale = (f32::from(area.size.width) / word_width)
            .min(f32::from(area.size.height) / word_height);
        (scale > 0.).then(|| {
            let origin = (
                f32::from(area.center().x) - (min_x + word_width / 2.) * scale,
                f32::from(area.center().y) + (min_y + word_height / 2.) * scale,
            );
            (origin, scale)
        })
    }

    /// The glyph contours overlap where the letters join; a non-zero fill
    /// tessellates them as one union, so a translucent word never doubles up.
    pub fn path(&self, origin: (f32, f32), scale: f32) -> Option<Path<Pixels>> {
        self.build(origin, scale, 0.)
    }

    /// Every contour stroked `width` wide. Strokes run through the joins
    /// too, so paint the fill over this: only the word's outer edge stays.
    pub fn stroke(&self, origin: (f32, f32), scale: f32, width: f32) -> Option<Path<Pixels>> {
        self.build(origin, scale, width)
    }

    // Tessellated once per scale and stroke at the origin, then translated:
    // the welcome title moves every frame of its entrance and exit.
    fn build(&self, origin: (f32, f32), scale: f32, stroke: f32) -> Option<Path<Pixels>> {
        thread_local! {
            static CACHE: RefCell<PathCache> = const { RefCell::new(Vec::new()) };
        }
        let id = self.outline.as_ptr() as usize;
        let key = [scale.to_bits(), stroke.to_bits()];
        let at = point(px(origin.0), px(origin.1));
        CACHE.with_borrow_mut(|cache| {
            if let Some((_, _, path)) = cache.iter().find(|(i, k, _)| *i == id && *k == key) {
                return Some(translated(path, at));
            }
            let place = |x: f32, y: f32| point(px(x * scale), px(-y * scale));
            let mut builder = if stroke > 0. {
                PathBuilder::stroke(px(stroke))
            } else {
                PathBuilder::fill().with_style(PathStyle::Fill(
                    FillOptions::default()
                        .with_fill_rule(FillRule::NonZero)
                        .with_tolerance(0.02),
                ))
            };
            for segment in self.outline {
                match *segment {
                    Segment::Move(x, y) => builder.move_to(place(x, y)),
                    Segment::Line(x, y) => builder.line_to(place(x, y)),
                    Segment::Quad(cx, cy, x, y) => builder.curve_to(place(x, y), place(cx, cy)),
                    Segment::Close => builder.close(),
                }
            }
            let path = builder.build().ok()?;
            if cache.len() >= 8 {
                cache.remove(0);
            }
            let placed = translated(&path, at);
            cache.push((id, key, path));
            Some(placed)
        })
    }
}

fn translated(path: &Path<Pixels>, by: Point<Pixels>) -> Path<Pixels> {
    let mut path = path.clone();
    path.bounds.origin += by;
    for vertex in &mut path.vertices {
        vertex.xy_position += by;
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    const SQUARE: Script = Script {
        bounds: ((0., 0.), (100., 100.)),
        outline: &[
            Segment::Move(0., 0.),
            Segment::Line(100., 0.),
            Segment::Quad(110., 50., 100., 100.),
            Segment::Line(0., 100.),
            Segment::Close,
        ],
    };

    #[test]
    fn a_moved_word_is_the_cached_shape_offset_exactly() {
        for stroke in [0., 2.4] {
            let first = SQUARE.build((10., 200.), 0.5, stroke).unwrap();
            let moved = SQUARE.build((37.25, 151.5), 0.5, stroke).unwrap();
            assert_eq!(first.vertices.len(), moved.vertices.len());
            let near = |a: Point<Pixels>, b: Point<Pixels>| {
                (f32::from(a.x) - f32::from(b.x) - 27.25).abs() < 1e-3
                    && (f32::from(a.y) - f32::from(b.y) + 48.5).abs() < 1e-3
            };
            assert!(near(moved.bounds.origin, first.bounds.origin));
            assert_eq!(moved.bounds.size, first.bounds.size);
            for (a, b) in first.vertices.iter().zip(&moved.vertices) {
                assert!(near(b.xy_position, a.xy_position));
                assert_eq!(b.st_position, a.st_position);
            }
        }
    }

    #[test]
    fn fill_and_stroke_are_cached_separately() {
        let fill = SQUARE.build((0., 100.), 1., 0.).unwrap();
        let stroke = SQUARE.build((0., 100.), 1., 3.).unwrap();
        assert!(stroke.bounds.size.width > fill.bounds.size.width);
    }
}
