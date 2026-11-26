use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Band {
    pub x0: f32,
    pub x1: f32,
    pub y0: f32,
    pub y1: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Curve { ctrl: (f32, f32), to: (f32, f32) },
}

pub(crate) fn regions(bands: &[Band]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..=bands.len() {
        let joined = i < bands.len() && {
            let (a, b) = (bands[i - 1], bands[i]);
            (b.y0 - a.y1).abs() < 0.5 && a.x0.max(b.x0) < a.x1.min(b.x1) - 0.5
        };
        if !joined {
            if start < i {
                out.push(start..i);
            }
            start = i;
        }
    }
    out
}

pub(crate) fn outline(bands: &[Band]) -> Vec<(f32, f32)> {
    let Some(first) = bands.first() else {
        return Vec::new();
    };
    let mut points = Vec::with_capacity(bands.len() * 4 + 2);
    points.push((first.x0, first.y0));
    points.push((first.x1, first.y0));
    for (k, band) in bands.iter().enumerate() {
        points.push((band.x1, band.y1));
        if let Some(next) = bands.get(k + 1) {
            points.push((next.x1, band.y1));
        }
    }
    for k in (0..bands.len()).rev() {
        let band = bands[k];
        if k + 1 == bands.len() {
            points.push((band.x0, band.y1));
        }
        points.push((band.x0, band.y0));
        if k > 0 {
            points.push((bands[k - 1].x0, band.y0));
        }
    }
    points.pop();
    simplify(points)
}

fn simplify(points: Vec<(f32, f32)>) -> Vec<(f32, f32)> {
    let close = |a: (f32, f32), b: (f32, f32)| (a.0 - b.0).abs() < 0.01 && (a.1 - b.1).abs() < 0.01;
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(points.len());
    for point in points {
        if out.last().is_some_and(|last| close(*last, point)) {
            continue;
        }
        out.push(point);
    }
    while out.len() > 1 && close(out[0], out[out.len() - 1]) {
        out.pop();
    }
    loop {
        let n = out.len();
        if n < 3 {
            return out;
        }
        let mut removed = false;
        let mut i = 0;
        while i < out.len() && out.len() >= 3 {
            let n = out.len();
            let prev = out[(i + n - 1) % n];
            let here = out[i];
            let next = out[(i + 1) % n];
            let collinear = ((prev.0 - here.0).abs() < 0.01 && (here.0 - next.0).abs() < 0.01)
                || ((prev.1 - here.1).abs() < 0.01 && (here.1 - next.1).abs() < 0.01);
            if collinear {
                out.remove(i);
                removed = true;
            } else {
                i += 1;
            }
        }
        if !removed {
            return out;
        }
    }
}

struct Corner {
    before: (f32, f32),
    at: (f32, f32),
    after: (f32, f32),
}

/// Rounds every corner of a rectilinear polygon. Convex and concave corners
/// get the same treatment, which is what turns a step between two lines of
/// different widths into a soft join instead of a notch.
pub(crate) fn rounded(points: &[(f32, f32)], radius: f32) -> Vec<Segment> {
    let n = points.len();
    if n < 3 {
        return Vec::new();
    }
    let dist = |a: (f32, f32), b: (f32, f32)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let toward = |from: (f32, f32), to: (f32, f32), amount: f32| {
        let d = dist(from, to);
        if d <= f32::EPSILON {
            from
        } else {
            (
                from.0 + (to.0 - from.0) * amount / d,
                from.1 + (to.1 - from.1) * amount / d,
            )
        }
    };
    let corners: Vec<Corner> = (0..n)
        .map(|i| {
            let prev = points[(i + n - 1) % n];
            let here = points[i];
            let next = points[(i + 1) % n];
            let r = radius.min(dist(prev, here) / 2.).min(dist(here, next) / 2.);
            Corner {
                before: toward(here, prev, r),
                at: here,
                after: toward(here, next, r),
            }
        })
        .collect();
    let mut out = Vec::with_capacity(n * 2 + 1);
    let start = corners[n - 1].after;
    out.push(Segment::Move(start.0, start.1));
    for corner in corners {
        out.push(Segment::Line(corner.before.0, corner.before.1));
        out.push(Segment::Curve {
            ctrl: corner.at,
            to: corner.after,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(x0: f32, x1: f32, y0: f32, y1: f32) -> Band {
        Band { x0, x1, y0, y1 }
    }

    #[test]
    fn a_single_band_is_a_rectangle() {
        let points = outline(&[band(0., 100., 0., 20.)]);
        assert_eq!(points, vec![(0., 0.), (100., 0.), (100., 20.), (0., 20.)]);
    }

    #[test]
    fn two_bands_of_different_widths_make_one_stepped_outline() {
        let points = outline(&[band(40., 200., 0., 20.), band(0., 120., 20., 40.)]);
        assert_eq!(
            points,
            vec![
                (40., 0.),
                (200., 0.),
                (200., 20.),
                (120., 20.),
                (120., 40.),
                (0., 40.),
                (0., 20.),
                (40., 20.),
            ]
        );
    }

    #[test]
    fn equal_widths_collapse_into_one_rectangle() {
        let points = outline(&[
            band(0., 100., 0., 20.),
            band(0., 100., 20., 40.),
            band(0., 100., 40., 60.),
        ]);
        assert_eq!(points, vec![(0., 0.), (100., 0.), (100., 60.), (0., 60.)]);
    }

    #[test]
    fn bands_that_do_not_overlap_are_separate_regions() {
        let bands = [
            band(300., 600., 0., 20.),
            band(0., 50., 20., 40.),
            band(0., 80., 40., 60.),
            band(0., 80., 70., 90.),
        ];
        assert_eq!(regions(&bands), vec![0..1, 1..3, 3..4]);
    }

    #[test]
    fn rounding_never_overshoots_short_edges() {
        let points = outline(&[band(0., 100., 0., 20.), band(0., 102., 20., 40.)]);
        let segments = rounded(&points, 4.);
        for segment in segments {
            let (x, y) = match segment {
                Segment::Move(x, y) | Segment::Line(x, y) => (x, y),
                Segment::Curve { to, .. } => to,
            };
            assert!((0. ..=102.).contains(&x));
            assert!((0. ..=40.).contains(&y));
        }
    }
}
