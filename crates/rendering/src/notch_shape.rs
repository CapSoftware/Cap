//! Outline of a MacBook's camera housing, rasterized for the notch overlay.
//!
//! A vector path rather than the composite pipeline's SDF because the upper
//! corners are *concave* — the cutout widens as it meets the top of the panel,
//! flaring into the bezel — and `sdf_rounded_rect` only does convex corners.

/// Both radii as fractions of the notch's height, measured off a 14" panel:
/// ~7.9pt and ~2.4pt on a 32pt-tall cutout.
pub const BOTTOM_RADIUS_FRAC: f64 = 0.25;
pub const TOP_FILLET_FRAC: f64 = 0.075;

/// Rasterize above display size so the curves survive being scaled up by zoom.
/// Higher than the frame chrome's factor because a thin band shows softening
/// far sooner than a full window frame does.
const SUPERSAMPLE: f64 = 8.0;
const MAX_TEXTURE_DIM: f64 = 4096.0;

/// Texture size to rasterize a notch of `w` x `h` output px into.
pub fn texture_size(w: f64, h: f64) -> (u32, u32) {
    let scale = (MAX_TEXTURE_DIM / w.max(1.0))
        .min(MAX_TEXTURE_DIM / h.max(1.0))
        .min(SUPERSAMPLE);
    let tw = ((w * scale).round() as u32).clamp(8, MAX_TEXTURE_DIM as u32);
    let th = ((h * scale).round() as u32).clamp(8, MAX_TEXTURE_DIM as u32);
    (tw, th)
}

/// The notch outline, filling a `w` x `h` box, widest along its top edge.
fn notch_svg(w: f64, h: f64) -> String {
    // Bounded so a short or narrow notch degrades into a plain rectangle
    // instead of self-intersecting.
    let fillet = (h * TOP_FILLET_FRAC).min(w / 2.0).max(0.0);
    let bottom = (h * BOTTOM_RADIUS_FRAC)
        .min(h - fillet)
        .min(w / 2.0 - fillet)
        .max(0.0);

    let path = format!(
        "M 0 0 \
         A {fillet} {fillet} 0 0 1 {fillet} {fillet} \
         L {fillet} {bottom_y} \
         A {bottom} {bottom} 0 0 0 {bl_x} {h} \
         L {br_x} {h} \
         A {bottom} {bottom} 0 0 0 {right_wall} {bottom_y} \
         L {right_wall} {fillet} \
         A {fillet} {fillet} 0 0 1 {w} 0 Z",
        bottom_y = h - bottom,
        bl_x = fillet + bottom,
        br_x = w - fillet - bottom,
        right_wall = w - fillet,
    );

    format!(
        r##"<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg"><path d="{path}" fill="#000000"/></svg>"##
    )
}

/// RGBA pixels for the notch outline, or `None` if rasterization fails, which
/// makes the layer skip drawing rather than erroring the whole frame.
pub fn rasterize(tex_w: u32, tex_h: u32) -> Option<Vec<u8>> {
    let svg = notch_svg(tex_w as f64, tex_h as f64);

    let tree = match resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default()) {
        Ok(tree) => tree,
        Err(error) => {
            tracing::warn!("Failed to parse notch SVG: {error}");
            return None;
        }
    };

    let mut pixmap = tiny_skia::Pixmap::new(tex_w, tex_h)?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );

    Some(
        pixmap
            .pixels()
            .iter()
            .flat_map(|p| {
                let c = p.demultiply();
                [c.red(), c.green(), c.blue(), c.alpha()]
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 256;
    const H: u32 = 64;

    fn alpha_at(pixels: &[u8], x: u32, y: u32) -> u8 {
        pixels[((y * W + x) * 4 + 3) as usize]
    }

    /// Opaque pixels in a row, i.e. how wide the notch is there.
    fn run(pixels: &[u8], y: u32) -> u32 {
        (0..W).filter(|x| alpha_at(pixels, *x, y) > 200).count() as u32
    }

    #[test]
    fn widens_towards_the_top_and_narrows_at_the_bottom() {
        let pixels = rasterize(W, H).expect("notch should rasterize");

        let fillet = (H as f64 * TOP_FILLET_FRAC).round() as u32;
        let wall = run(&pixels, H / 2);

        // The straight flanks sit a fillet's width in from each edge.
        assert!(
            wall + 2 * fillet <= W && wall + 2 * fillet + 4 >= W,
            "wall {wall} should sit about {fillet}px in from each edge of {W}"
        );

        // Concave top: the notch is at its widest on the very first row and
        // narrows to the wall, rather than rounding inwards like the bottom.
        let top = run(&pixels, 0);
        assert!(
            top > wall,
            "top row {top} should flare past the wall {wall}"
        );
        assert!(
            (0..H).all(|y| run(&pixels, y) <= top),
            "no row should be wider than the top edge"
        );
        assert!(
            run(&pixels, fillet + 1) == wall,
            "the flare should be spent by the time the fillet ends"
        );

        // Convex bottom, pulling in from the wall on a much larger radius.
        let bottom = run(&pixels, H - 1);
        assert!(
            bottom + 8 < wall,
            "bottom row {bottom} should be clearly narrower than the wall {wall}"
        );
        assert!(
            wall - bottom > top - wall,
            "the bottom radius should be the more pronounced of the two"
        );
    }

    #[test]
    fn degenerate_sizes_still_rasterize() {
        for (w, h) in [(8, 8), (256, 4), (4, 64), (1024, 32)] {
            assert!(rasterize(w, h).is_some(), "{w}x{h} should rasterize");
        }
    }

    #[test]
    fn texture_size_supersamples_within_the_cap() {
        // A notch on a 1080p export, comfortably inside the cap.
        assert_eq!(texture_size(260.0, 21.0), (2080, 168));

        // A 4K one is clamped, and keeps its aspect while clamping.
        let (w, h) = texture_size(520.0, 42.0);
        assert!(w <= MAX_TEXTURE_DIM as u32 && h <= MAX_TEXTURE_DIM as u32);
        assert!((w as f64 / h as f64 - 520.0 / 42.0).abs() < 0.1);
    }
}
