mod script_outline;

use std::cell::RefCell;
use std::time::Instant;

use gpui::{
    Bounds, BoxShadow, ContentMask, Corners, FillOptions, FillRule, Hsla, IntoElement, Path,
    PathBuilder, PathStyle, Pixels, Styled, Window, canvas, fill, hsla, linear_color_stop,
    linear_gradient, point, px, size,
};

use script_outline::{SCRIPT_BOUNDS, SCRIPT_OUTLINE};

const STATIC_PHASE_SECONDS: f32 = 3.;
const FADE_IN_SECONDS: f32 = 0.3;
/// The first pass starts this far in, so the band is already entering the
/// word on the first frame: most cameras deliver within a second.
const SWEEP_LEAD_SECONDS: f32 = 0.15;
const SWEEP_SECONDS: f32 = 1.;
const SWEEP_PERIOD_SECONDS: f32 = 1.6;
const SWEEP_HALF_WIDTH: f32 = 0.26;
const SCRIPT_REST_ALPHA: f32 = 0.12;
const SCRIPT_PEAK_ALPHA: f32 = 0.42;

enum Segment {
    Move(f32, f32),
    Line(f32, f32),
    Quad(f32, f32, f32, f32),
    Close,
}

struct Cloud {
    lightness: f32,
    alpha: f32,
    speed: f32,
    phase: f32,
    reach: f32,
    blur: f32,
}

const CLOUDS: [Cloud; 4] = [
    Cloud {
        lightness: 0.5,
        alpha: 0.2,
        speed: -0.13,
        phase: 1.,
        reach: 0.26,
        blur: 0.22,
    },
    Cloud {
        lightness: 0.75,
        alpha: 0.16,
        speed: -0.19,
        phase: 2.1,
        reach: 0.28,
        blur: 0.2,
    },
    Cloud {
        lightness: 0.95,
        alpha: 0.18,
        speed: 0.25,
        phase: 0.,
        reach: 0.24,
        blur: 0.18,
    },
    Cloud {
        lightness: 1.,
        alpha: 0.12,
        speed: 0.42,
        phase: 3.,
        reach: 0.14,
        blur: 0.09,
    },
];

fn ease_out(progress: f32) -> f32 {
    let progress = progress.clamp(0., 1.);
    1. - (1. - progress).powi(3)
}

fn ease_in_out(progress: f32) -> f32 {
    let progress = progress.clamp(0., 1.);
    0.5 - 0.5 * (progress * std::f32::consts::PI).cos()
}

/// A zero `radius` is the background-cutout mode: its window is transparent,
/// so a feathered disc stands in for the rounded glass.
pub(crate) fn camera_loading(
    started: Instant,
    radius: f32,
    opacity: f32,
    animate: bool,
    show_script: bool,
) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, cx| {
            let animate = animate && !cx.reduce_motion();
            let elapsed = if animate {
                started.elapsed().as_secs_f32()
            } else {
                f32::INFINITY
            };
            let opacity = if animate {
                opacity * ease_out(elapsed / FADE_IN_SECONDS)
            } else {
                opacity
            };
            let seconds = if animate {
                elapsed + STATIC_PHASE_SECONDS
            } else {
                STATIC_PHASE_SECONDS
            };
            if opacity > 0. {
                let script_area = if radius > 0. {
                    let corners = Corners::all(px(radius)).clamp_radii_for_quad_size(bounds.size);
                    paint_glass(bounds, corners, None, seconds, opacity, window);
                    let extent = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
                    Bounds::centered_at(bounds.center(), size(px(extent * 0.62), px(extent * 0.3)))
                } else {
                    paint_feathered(bounds, seconds, opacity, window)
                };
                if show_script {
                    paint_script(script_area, elapsed, opacity, window);
                }
            }
            if animate {
                window.request_animation_frame();
            }
        },
    )
    .absolute()
    .inset_0()
}

fn sweep_center(elapsed: f32) -> Option<f32> {
    if !elapsed.is_finite() {
        return None;
    }
    let time = (elapsed + SWEEP_LEAD_SECONDS) % SWEEP_PERIOD_SECONDS;
    (time < SWEEP_SECONDS).then(|| {
        let reach = 1. + 2. * SWEEP_HALF_WIDTH;
        -SWEEP_HALF_WIDTH + reach * ease_in_out(time / SWEEP_SECONDS)
    })
}

fn sweep_alpha(position: f32, center: f32) -> f32 {
    ease_in_out(1. - (position - center).abs() / SWEEP_HALF_WIDTH)
}

/// The glyph contours overlap where the letters join; a non-zero fill
/// tessellates them as one union, so the translucent word never doubles up.
fn script_path(origin: (f32, f32), scale: f32) -> Option<Path<Pixels>> {
    thread_local! {
        static CACHE: RefCell<Option<([u32; 3], Path<Pixels>)>> = const { RefCell::new(None) };
    }
    let key = [origin.0.to_bits(), origin.1.to_bits(), scale.to_bits()];
    CACHE.with_borrow_mut(|cache| {
        if let Some((cached, path)) = cache.as_ref()
            && *cached == key
        {
            return Some(path.clone());
        }
        let place = |x: f32, y: f32| point(px(origin.0 + x * scale), px(origin.1 - y * scale));
        let mut builder = PathBuilder::fill().with_style(PathStyle::Fill(
            FillOptions::default()
                .with_fill_rule(FillRule::NonZero)
                .with_tolerance(0.02),
        ));
        for segment in SCRIPT_OUTLINE {
            match *segment {
                Segment::Move(x, y) => builder.move_to(place(x, y)),
                Segment::Line(x, y) => builder.line_to(place(x, y)),
                Segment::Quad(cx, cy, x, y) => builder.curve_to(place(x, y), place(cx, cy)),
                Segment::Close => builder.close(),
            }
        }
        let path = builder.build().ok()?;
        *cache = Some((key, path.clone()));
        Some(path)
    })
}

fn paint_script(area: Bounds<Pixels>, elapsed: f32, opacity: f32, window: &mut Window) {
    let ((min_x, min_y), (max_x, max_y)) = SCRIPT_BOUNDS;
    let word_width = max_x - min_x;
    let word_height = max_y - min_y;
    let scale =
        (f32::from(area.size.width) / word_width).min(f32::from(area.size.height) / word_height);
    if scale <= 0. || opacity <= 0. {
        return;
    }
    let origin = (
        f32::from(area.center().x) - (min_x + word_width / 2.) * scale,
        f32::from(area.center().y) + (min_y + word_height / 2.) * scale,
    );
    let Some(path) = script_path(origin, scale) else {
        return;
    };
    window.paint_path(path.clone(), hsla(0., 0., 1., SCRIPT_REST_ALPHA * opacity));

    let Some(center) = sweep_center(elapsed) else {
        return;
    };
    let left = f32::from(path.bounds.left());
    let width = f32::from(path.bounds.size.width).max(1.);
    let band = |position: f32| -> Hsla {
        hsla(
            0.,
            0.,
            1.,
            SCRIPT_PEAK_ALPHA * opacity * sweep_alpha(position, center),
        )
    };
    for (from, to) in [
        (center - SWEEP_HALF_WIDTH, center),
        (center, center + SWEEP_HALF_WIDTH),
    ] {
        let (start, end) = (from.max(0.), to.min(1.));
        if end <= start {
            continue;
        }
        let mask = Bounds {
            origin: point(px(left + start * width), path.bounds.top()),
            size: size(px((end - start) * width), path.bounds.size.height),
        };
        // Path gradients are measured against the path's bounds clipped to the
        // content mask, so each half's stops span its own mask, 0 to 1.
        window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
            window.paint_path(
                path.clone(),
                linear_gradient(
                    90.,
                    linear_color_stop(band(start), 0.),
                    linear_color_stop(band(end), 1.),
                ),
            );
        });
    }
}

/// Drop shadows are not clipped to a rounded mask, so the disc and its blur
/// are sized to stay inside the window's inscribed circle.
fn paint_feathered(
    bounds: Bounds<Pixels>,
    seconds: f32,
    opacity: f32,
    window: &mut Window,
) -> Bounds<Pixels> {
    let extent = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
    let center = bounds.center();
    let bloom = 1. + 0.08 * (1. - opacity);
    let disc = |diameter: f32, offset: (f32, f32), blur: f32, color: Hsla| {
        let diameter = diameter * extent * bloom;
        (
            Bounds::centered_at(
                point(
                    center.x + px(offset.0 * extent),
                    center.y + px(offset.1 * extent),
                ),
                size(px(diameter), px(diameter)),
            ),
            Corners::all(px(diameter / 2.)),
            BoxShadow {
                color,
                offset: point(px(0.), px(0.)),
                blur_radius: px(blur * extent),
                spread_radius: px(0.),
                inset: false,
            },
        )
    };
    let drift = (seconds * 0.35).sin_cos();
    let layers = [
        disc(
            0.6,
            (0., 0.),
            0.065,
            hsla(240. / 360., 0.06, 0.06, 0.88 * opacity),
        ),
        disc(
            0.3,
            (drift.1 * 0.05, drift.0 * 0.04 - 0.05),
            0.07,
            hsla(0., 0., 1., 0.06 * opacity),
        ),
    ];
    for (bounds, corners, shadow) in layers {
        window.paint_drop_shadows(bounds, corners, &[shadow]);
    }
    Bounds::centered_at(center, size(px(extent * 0.46), px(extent * 0.24)))
}

/// Every cloud is an inset shadow, which the shader clips to the shape's own
/// rounded rect, so nothing spills past its edge even though gpui content
/// masks are rectangular.
fn paint_glass(
    shape: Bounds<Pixels>,
    corners: Corners<Pixels>,
    scale: Option<f32>,
    seconds: f32,
    opacity: f32,
    window: &mut Window,
) {
    let width = f32::from(shape.size.width);
    let height = f32::from(shape.size.height);
    if width <= 0. || height <= 0. {
        return;
    }
    let extent = scale.unwrap_or(width.min(height));

    window.paint_quad(
        fill(
            shape,
            linear_gradient(
                170. + 10. * (seconds * 0.2).sin(),
                linear_color_stop(hsla(0., 0., 0.12, opacity), 0.),
                linear_color_stop(hsla(0., 0., 0.03, opacity), 1.),
            ),
        )
        .corner_radii(corners),
    );

    let clouds = CLOUDS.map(|cloud| {
        let angle = cloud.phase + seconds * cloud.speed;
        let reach = cloud.reach * (1. + 0.12 * (seconds * 0.9 + cloud.phase * 1.7).sin());
        BoxShadow {
            color: hsla(0., 0., cloud.lightness, cloud.alpha * opacity),
            offset: point(
                px(angle.cos() * reach * width),
                px(angle.sin() * reach * height),
            ),
            blur_radius: px(cloud.blur * extent),
            spread_radius: px(0.),
            inset: true,
        }
    });
    window.paint_inset_shadows(shape, corners, &clouds);

    window.paint_inset_shadows(
        shape,
        corners,
        &[
            BoxShadow {
                color: hsla(0., 0., 0., 0.35 * opacity),
                offset: point(px(0.), px(-extent * 0.08)),
                blur_radius: px(extent * 0.1),
                spread_radius: px(0.),
                inset: true,
            },
            BoxShadow {
                color: hsla(0., 0., 1., 0.16 * opacity),
                offset: point(px(0.), px(extent * 0.025)),
                blur_radius: px(extent * 0.03),
                spread_radius: px(0.),
                inset: true,
            },
            BoxShadow {
                color: hsla(0., 0., 1., 0.1 * opacity),
                offset: point(px(0.), px(0.)),
                blur_radius: px(0.75),
                spread_radius: px(1.),
                inset: true,
            },
        ],
    );
}
