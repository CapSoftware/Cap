mod script_outline;

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    Bounds, BoxShadow, ContentMask, Corners, EntityId, Hsla, IntoElement, Pixels, Styled, Window,
    canvas, fill, hsla, linear_color_stop, linear_gradient, point, px, size,
};

use script_outline::LOADING;

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
const MOTION_FPS: f32 = 60.;
const DRIFT_FPS: f32 = 30.;

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
    redraw: LoadingRedraw,
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
                let due = Instant::now() + frame_gap(elapsed, opacity, show_script);
                let generation = redraw.begin();
                redraw_when_due(window, window.current_view(), due, redraw, generation);
            }
        },
    )
    .absolute()
    .inset_0()
}

/// Fades and the script sweep redraw at 60 fps. Between sweeps only the
/// clouds move, under a pixel per frame at 30 fps. The gap is a fifth short of
/// the frame time so a display refresh landing just early still counts.
fn frame_gap(elapsed: f32, opacity: f32, show_script: bool) -> Duration {
    let fps = if opacity < 1. || (show_script && sweep_center(elapsed).is_some()) {
        MOTION_FPS
    } else {
        DRIFT_FPS
    };
    Duration::from_secs_f32(0.8 / fps)
}

/// Each paint supersedes the redraw scheduled by the one before it, so extra
/// paints (a resize, a chrome change) never leave several deadlines running.
#[derive(Clone, Default)]
pub(crate) struct LoadingRedraw(Rc<Cell<u64>>);

impl LoadingRedraw {
    fn begin(&self) -> u64 {
        let generation = self.0.get().wrapping_add(1);
        self.0.set(generation);
        generation
    }

    fn is_current(&self, generation: u64) -> bool {
        self.0.get() == generation
    }
}

/// Checks on each display refresh and only re-renders the view once `due`
/// has passed, so redraws never outpace the platform's own frames.
fn redraw_when_due(
    window: &Window,
    view: EntityId,
    due: Instant,
    redraw: LoadingRedraw,
    generation: u64,
) {
    window.on_next_frame(move |window, cx| {
        if !redraw.is_current(generation) {
            return;
        }
        if Instant::now() >= due {
            cx.notify(view);
        } else {
            redraw_when_due(window, view, due, redraw, generation);
        }
    });
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

fn paint_script(area: Bounds<Pixels>, elapsed: f32, opacity: f32, window: &mut Window) {
    if opacity <= 0. {
        return;
    }
    let Some((origin, scale)) = LOADING.fit(area) else {
        return;
    };
    let Some(path) = LOADING.path(origin, scale) else {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn paints_in(start: f32, seconds: f32, refresh_hz: f32, opacity: f32, script: bool) -> usize {
        let refresh = 1. / refresh_hz;
        let mut due = 0.;
        let mut paints = 0;
        let mut frame = (start / refresh).ceil();
        while frame * refresh < start + seconds {
            let now = frame * refresh;
            if now >= due {
                paints += 1;
                due = now + frame_gap(now, opacity, script).as_secs_f32();
            }
            frame += 1.;
        }
        paints
    }

    #[test]
    fn loading_redraws_at_sixty_while_sweeping_and_thirty_between() {
        let period_start = SWEEP_PERIOD_SECONDS - SWEEP_LEAD_SECONDS;
        assert!(sweep_center(period_start + 0.01).is_some());
        assert!(sweep_center(period_start + SWEEP_SECONDS + 0.01).is_none());
        let resting_start = period_start + SWEEP_SECONDS;
        let resting_seconds = SWEEP_PERIOD_SECONDS - SWEEP_SECONDS;

        for refresh_hz in [60., 120.] {
            let sweeping = paints_in(period_start, SWEEP_SECONDS, refresh_hz, 1., true);
            assert!((59..=61).contains(&sweeping), "{refresh_hz} Hz: {sweeping}");
            let resting = paints_in(resting_start, resting_seconds, refresh_hz, 1., true);
            assert!((17..=19).contains(&resting), "{refresh_hz} Hz: {resting}");
            let no_script = paints_in(period_start, SWEEP_PERIOD_SECONDS, refresh_hz, 1., false);
            assert!(
                (47..=49).contains(&no_script),
                "{refresh_hz} Hz: {no_script}"
            );
            let fading = paints_in(0., FADE_IN_SECONDS, refresh_hz, 0.5, false);
            assert!((17..=19).contains(&fading), "{refresh_hz} Hz: {fading}");
        }
        let slow_display = paints_in(period_start, SWEEP_SECONDS, 20., 1., true);
        assert!((19..=21).contains(&slow_display), "{slow_display}");
    }

    #[test]
    fn extra_paints_leave_one_pending_redraw() {
        let refresh = 1. / 120.;
        let start = SWEEP_PERIOD_SECONDS - SWEEP_LEAD_SECONDS + SWEEP_SECONDS;
        let end = start + SWEEP_PERIOD_SECONDS - SWEEP_SECONDS;
        let redraw = LoadingRedraw::default();
        let mut pending: Vec<(u64, f32)> = Vec::new();
        let paint = |now: f32, pending: &mut Vec<(u64, f32)>| {
            pending.push((redraw.begin(), now + frame_gap(now, 1., true).as_secs_f32()));
        };
        paint(start, &mut pending);
        paint(start + refresh, &mut pending);

        let mut paints = 0;
        let mut frame = (start / refresh).ceil() + 2.;
        while frame * refresh < end {
            let now = frame * refresh;
            let mut due_paints = 0;
            pending.retain(|&(generation, due)| {
                if !redraw.is_current(generation) {
                    return false;
                }
                if now >= due {
                    due_paints += 1;
                    return false;
                }
                true
            });
            for _ in 0..due_paints {
                paints += 1;
                paint(now, &mut pending);
            }
            assert!(pending.len() <= 1, "{} pending at {now}", pending.len());
            frame += 1.;
        }
        assert!((17..=19).contains(&paints), "{paints}");
    }
}
