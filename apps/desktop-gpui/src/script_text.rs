//! Script lettering drawn from pre-shaped glyph outlines (Damion, set with
//! HarfBuzz offline), so the face needs no font loading: the camera
//! preview's "loading" and the welcome screen's "Welcome".

use std::cell::RefCell;

use gpui::{Bounds, FillOptions, FillRule, Path, PathBuilder, PathStyle, Pixels, point, px};

pub(crate) enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Quad(f32, f32, f32, f32),
    Close,
}

/// Tessellated placements of each outline, keyed by outline, origin, scale
/// and stroke width (0 for the fill).
type PathCache = Vec<(usize, [u32; 4], Path<Pixels>)>;

/// A word's outline in font units (2048 per em, y up) and its tight bounds.
pub(crate) struct Script {
    pub bounds: ((f32, f32), (f32, f32)),
    pub outline: &'static [Segment],
}

impl Script {
    /// The origin and scale that fit the word, centred, inside `area`.
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

    /// Recent placements are cached: tessellation is the expensive part.
    fn build(&self, origin: (f32, f32), scale: f32, stroke: f32) -> Option<Path<Pixels>> {
        thread_local! {
            static CACHE: RefCell<PathCache> = const { RefCell::new(Vec::new()) };
        }
        let id = self.outline.as_ptr() as usize;
        let key = [
            origin.0.to_bits(),
            origin.1.to_bits(),
            scale.to_bits(),
            stroke.to_bits(),
        ];
        CACHE.with_borrow_mut(|cache| {
            if let Some((_, _, path)) = cache.iter().find(|(i, k, _)| *i == id && *k == key) {
                return Some(path.clone());
            }
            let place = |x: f32, y: f32| point(px(origin.0 + x * scale), px(origin.1 - y * scale));
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
            // A few placements per outline (fill, stroke, shadow) stay warm.
            if cache.len() >= 8 {
                cache.remove(0);
            }
            cache.push((id, key, path.clone()));
            Some(path)
        })
    }
}
