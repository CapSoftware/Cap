//! What an empty page shows while someone else is about to write into it:
//! calm motion where the first words will land, eased out as they arrive.
//! Drawn from a handful of quads and short strokes; frames run only while it
//! shows. Three looks were built to compare; Flow is the one that ships.

use gpui::{
    Bounds, Hsla, PaintQuad, Path, PathBuilder, Pixels, fill, linear_color_stop, linear_gradient,
    point, px,
};

/// Only Flow ships; the other two exist for dev builds to compare.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(crate) enum Look {
    /// Soft threads weaving across the first lines, a little lively at
    /// first like the recording's level, then calm; they settle onto the
    /// lines as the words arrive.
    Flow,
    /// A light sweep through the "Writing the summary" line.
    Sweep,
    /// Fine pen strokes drawing themselves under it.
    Ink,
}

/// Flow ships. Dev builds can show the others for side by side videos.
pub(crate) fn look() -> Look {
    #[cfg(debug_assertions)]
    {
        static LOOK: std::sync::OnceLock<Look> = std::sync::OnceLock::new();
        *LOOK.get_or_init(|| match std::env::var("CAP_NOTES_WRITING").as_deref() {
            Ok("sweep") => Look::Sweep,
            Ok("ink") => Look::Ink,
            _ => Look::Flow,
        })
    }
    #[cfg(not(debug_assertions))]
    Look::Flow
}

/// How long the motion takes to fade in when writing starts and to fade out
/// once the first words land.
pub(crate) const FADE_IN: f32 = 0.35;
pub(crate) const FADE_OUT: f32 = 0.32;

pub(crate) struct Scene {
    pub strokes: Vec<(Path<Pixels>, Hsla)>,
    pub quads: Vec<PaintQuad>,
}

/// Where the page's first line sits.
pub(crate) struct Place {
    pub left: f32,
    pub width: f32,
    /// Top of the first line and its height.
    pub top: f32,
    pub line_height: f32,
    /// The placeholder's own width ("Writing the summary").
    pub label_width: f32,
}

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    t * t * (3. - 2. * t)
}

fn alpha(color: Hsla, a: f32) -> Hsla {
    Hsla {
        a: color.a * a.clamp(0., 1.),
        ..color
    }
}

/// `t` is seconds since writing started, `shown` 0..1 how present the whole
/// thing is (fades in, and out once words land).
pub(crate) fn scene(
    look: Look,
    place: &Place,
    t: f32,
    shown: f32,
    accent: Hsla,
    ink: Hsla,
    page: Hsla,
) -> Scene {
    let mut out = Scene {
        strokes: Vec::new(),
        quads: Vec::new(),
    };
    if shown <= 0.001 || place.width < 40. {
        return out;
    }
    match look {
        // On a dark page the same accent reads fainter, so it shows a little
        // more.
        Look::Flow => {
            let strength = if page.l < 0.5 { 1.45 } else { 1. };
            flow(place, t, shown, strength, accent, &mut out)
        }
        Look::Sweep => sweep(place, t, shown, page, &mut out),
        Look::Ink => ink_lines(place, t, shown, ink, &mut out),
    }
    out
}

/// One of Flow's threads: where it rests (in lines below the first line's
/// top), how far it moves, and how it looks.
struct Thread {
    rest: f32,
    swing: f32,
    wavelength: f32,
    period: f32,
    width: f32,
    alpha: f32,
    hue: f32,
    phase: f32,
}

const THREADS: [Thread; 4] = [
    Thread {
        rest: 2.4,
        swing: 1.0,
        wavelength: 120.,
        period: 1.8,
        width: 2.6,
        alpha: 0.7,
        hue: 0.,
        phase: 0.,
    },
    Thread {
        rest: 1.5,
        swing: 0.75,
        wavelength: 150.,
        period: 2.4,
        width: 1.6,
        alpha: 0.4,
        hue: 0.03,
        phase: 1.3,
    },
    Thread {
        rest: 3.4,
        swing: 0.85,
        wavelength: 92.,
        period: 1.5,
        width: 1.6,
        alpha: 0.36,
        hue: -0.03,
        phase: 2.4,
    },
    Thread {
        rest: 4.6,
        swing: 0.6,
        wavelength: 180.,
        period: 3.0,
        width: 1.2,
        alpha: 0.24,
        hue: 0.05,
        phase: 4.1,
    },
];

/// Each thread is drawn as this many pieces (so its ends can taper and the
/// swell can brighten it), each piece a few points long.
const PIECES: usize = 18;
const POINTS: usize = 4;

fn flow(place: &Place, t: f32, shown: f32, strength: f32, accent: Hsla, out: &mut Scene) {
    const TRAVEL: f32 = 2.9;
    let width = place.width.min(760.);
    let lh = place.line_height;
    // A soft swell travels left to right through every thread at once.
    let sigma = width * 0.26;
    let centre = ((t / TRAVEL).fract()) * (width + 2. * sigma) - sigma;
    // Lively at first, like the level line it follows, then calm.
    let lively = 1. + 1.2 * (-t / 0.5).exp();
    // As it fades (in or out) every thread settles onto a line of text, so
    // the first words land where the motion was.
    let settle = smooth(shown);
    let piece = width / PIECES as f32;
    for (k, thread) in THREADS.iter().enumerate() {
        let target = place.top + lh * (k as f32 + 0.5);
        let breathe = (t * 0.7 + thread.phase).sin() * lh * 0.12;
        let rest = place.top + lh * thread.rest + breathe;
        let color = Hsla {
            h: (accent.h + thread.hue).rem_euclid(1.),
            ..accent
        };
        let y_at = |x: f32| {
            let envelope = (-((x - centre) / sigma).powi(2)).exp();
            let amp = (3.2 + 12. * envelope) * thread.swing * lively;
            let wave =
                std::f32::consts::TAU * (x / thread.wavelength - t / thread.period) + thread.phase;
            let y = rest + amp * wave.sin();
            (target + (y - target) * settle, envelope)
        };
        for i in 0..PIECES {
            let x0 = i as f32 * piece;
            let mid = x0 + piece / 2.;
            let (_, envelope) = y_at(mid);
            // Ends taper away so no thread has a hard start or stop.
            let edge = smooth(mid / (width * 0.2)) * smooth((width - mid) / (width * 0.2));
            let a = (shown * strength * edge * thread.alpha * (0.35 + 0.65 * envelope)).min(1.);
            if a < 0.01 {
                continue;
            }
            let line = |stroke: f32| {
                let mut builder = PathBuilder::stroke(px(stroke));
                for j in 0..=POINTS {
                    let x = x0 + piece * j as f32 / POINTS as f32;
                    let at = point(px(place.left + x), px(y_at(x).0));
                    if j == 0 {
                        builder.move_to(at);
                    } else {
                        builder.line_to(at);
                    }
                }
                builder.build().ok()
            };
            // The main thread carries a faint glow where the swell is.
            if k == 0
                && envelope > 0.2
                && let Some(path) = line(7.)
            {
                out.strokes.push((path, alpha(color, a * 0.14 * envelope)));
            }
            if let Some(path) = line(thread.width) {
                out.strokes.push((path, alpha(color, a)));
            }
        }
    }
}

fn sweep(place: &Place, t: f32, shown: f32, page: Hsla, out: &mut Scene) {
    const PERIOD: f32 = 1.8;
    // The placeholder is drawn in full ink; a veil of the page colour keeps
    // it faint everywhere but a soft band that moves through it.
    let width = place.label_width.max(80.) + 8.;
    let band = 46.;
    let centre = ((t / PERIOD).fract()) * (width + 2. * band) - band;
    let veil = alpha(page, 0.72 * shown + (1. - shown));
    let top = place.top;
    let bottom = place.top + place.line_height;
    let left = place.left - 2.;
    let rect = |x0: f32, x1: f32| {
        Bounds::from_corners(
            point(px(left + x0.clamp(0., width)), px(top)),
            point(px(left + x1.clamp(0., width)), px(bottom)),
        )
    };
    let solid = |x0: f32, x1: f32, out: &mut Scene| {
        if x1 > x0 {
            out.quads.push(fill(rect(x0, x1), veil));
        }
    };
    solid(0., centre - band, out);
    solid(centre + band, width, out);
    let clear = alpha(page, 0.);
    for (x0, x1, from, to) in [
        (centre - band, centre, veil, clear),
        (centre, centre + band, clear, veil),
    ] {
        let (a, b) = (x0.max(0.), x1.min(width));
        if b <= a {
            continue;
        }
        // Gradient stops in the clipped piece's own 0..1.
        let span = x1 - x0;
        let p0 = (a - x0) / span;
        let p1 = (b - x0) / span;
        let mix = |p: f32| Hsla {
            a: from.a + (to.a - from.a) * p,
            ..from
        };
        out.quads.push(fill(
            rect(a, b),
            linear_gradient(
                90.,
                linear_color_stop(mix(p0), 0.),
                linear_color_stop(mix(p1), 1.),
            ),
        ));
    }
}

fn ink_lines(place: &Place, t: f32, shown: f32, ink: Hsla, out: &mut Scene) {
    const CYCLE: f32 = 3.2;
    let width = place.width.min(560.);
    let local = t % CYCLE;
    for (i, share) in [0.92_f32, 0.74, 0.48].into_iter().enumerate() {
        let start = 0.15 + i as f32 * 0.32;
        let drawn = smooth((local - start) / 1.1);
        let gone = 1. - smooth((local - 2.5) / 0.5);
        let a = shown * gone * 0.55;
        if drawn <= 0. || a < 0.01 {
            continue;
        }
        let y = place.top + place.line_height * (1.75 + i as f32 * 0.9);
        let length = width * share * drawn;
        let mut builder = PathBuilder::stroke(px(1.5));
        // A pen line is never perfectly straight.
        let steps = 12;
        builder.move_to(point(px(place.left), px(y)));
        for s in 1..=steps {
            let x = length * s as f32 / steps as f32;
            let wobble = (x / 37. + i as f32).sin() * 0.6;
            builder.line_to(point(px(place.left + x), px(y + wobble)));
        }
        if let Ok(path) = builder.build() {
            out.strokes.push((path, alpha(ink, a)));
        }
    }
}

/// Where `name` appears in `text` as whole words (not inside a longer
/// word), byte ranges.
pub(crate) fn name_ranges(text: &str, name: &str) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    if name.trim().is_empty() {
        return out;
    }
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut from = 0;
    while let Some(i) = text[from..].find(name) {
        let start = from + i;
        let end = start + name.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if !word(before) && !word(after) {
            out.push(start..end);
        }
        from = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place() -> Place {
        Place {
            left: 100.,
            width: 600.,
            top: 200.,
            line_height: 24.,
            label_width: 160.,
        }
    }

    #[test]
    fn names_match_whole_words_only() {
        assert_eq!(
            name_ranges("Ana: send it to Anabel and Ana.", "Ana"),
            vec![0..3, 27..30]
        );
        assert_eq!(
            name_ranges("Person 2 and Person 20", "Person 2"),
            vec![0..8]
        );
        assert!(name_ranges("anything", "").is_empty());
    }

    #[test]
    fn nothing_is_drawn_once_it_has_faded() {
        let p = place();
        let black = Hsla::default();
        for look in [Look::Flow, Look::Sweep, Look::Ink] {
            let s = scene(look, &p, 1.0, 0., black, black, black);
            assert!(s.strokes.is_empty() && s.quads.is_empty(), "{look:?}");
        }
    }

    #[test]
    fn flow_stays_inside_the_column_and_over_the_first_lines() {
        let p = place();
        let accent = Hsla {
            h: 0.6,
            s: 0.8,
            l: 0.5,
            a: 1.,
        };
        for t in [0., 0.3, 1.1, 2.7, 9.0] {
            for shown in [0.2, 1.] {
                let s = scene(Look::Flow, &p, t, shown, accent, accent, accent);
                assert!(!s.strokes.is_empty());
                assert!(s.strokes.len() <= THREADS.len() * PIECES * 2);
                for (path, color) in &s.strokes {
                    assert!(color.a <= 1.);
                    let b = path.bounds;
                    assert!(f32::from(b.left()) >= p.left - 4.);
                    assert!(f32::from(b.right()) <= p.left + 760. + 4.);
                    assert!(f32::from(b.top()) >= p.top - 12.);
                    assert!(f32::from(b.bottom()) <= p.top + 6. * p.line_height + 16.);
                }
            }
        }
    }

    /// Fading out, every thread settles onto its line of text: almost flat
    /// and where the words will be.
    #[test]
    fn flow_settles_onto_the_text_lines_as_it_fades() {
        let p = place();
        let accent = Hsla {
            h: 0.6,
            s: 0.8,
            l: 0.5,
            a: 1.,
        };
        let s = scene(Look::Flow, &p, 2.0, 0.04, accent, accent, accent);
        for (path, _) in &s.strokes {
            let b = path.bounds;
            assert!(f32::from(b.bottom()) <= p.top + 4. * p.line_height + 2.);
            // Flat: the stroke's own width (the glow's at most), no wave.
            assert!(f32::from(b.size.height) < 9.);
        }
    }
}
