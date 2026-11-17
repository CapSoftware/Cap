//! Where a picked window goes when the picker resizes or focuses it. Pure
//! geometry in one display's logical points; `platform` moves the window.

use crate::target_overlay::AreaRect;

/// Kept clear between a moved window and the edge of the usable area.
pub const MARGIN: f32 = 16.;

pub const MIN_SIDE: f32 = 160.;

pub const RATIOS: [(u32, u32); 6] = [(21, 9), (16, 9), (16, 10), (4, 3), (1, 1), (9, 16)];

pub const SIZES: [(&str, u32, u32); 4] = [
    ("720p", 1280, 720),
    ("1080p", 1920, 1080),
    ("1440p", 2560, 1440),
    ("4K", 3840, 2160),
];

fn inset(area: AreaRect) -> AreaRect {
    let margin_x = MARGIN.min(area.width / 4.);
    let margin_y = MARGIN.min(area.height / 4.);
    AreaRect {
        x: area.x + margin_x,
        y: area.y + margin_y,
        width: area.width - margin_x * 2.,
        height: area.height - margin_y * 2.,
    }
}

fn place(width: f32, height: f32, cx: f32, cy: f32, area: AreaRect) -> AreaRect {
    let x = (cx - width / 2.).clamp(area.x, (area.x + area.width - width).max(area.x));
    let y = (cy - height / 2.).clamp(area.y, (area.y + area.height - height).max(area.y));
    AreaRect {
        x,
        y,
        width,
        height,
    }
}

fn fit_inside(width: f32, height: f32, area: AreaRect) -> (f32, f32) {
    let scale = (area.width / width).min(area.height / height).min(1.);
    (width * scale, height * scale)
}

/// The window reshaped to `ratio` with about the same area, centred where
/// it was and kept inside the usable area of its display.
pub fn fit_to_ratio(window: AreaRect, ratio: (u32, u32), work_area: AreaRect) -> AreaRect {
    let area = inset(work_area);
    let ratio = ratio.0 as f32 / ratio.1.max(1) as f32;
    let size = (window.width * window.height).max(MIN_SIDE * MIN_SIDE);
    let (mut width, mut height) = ((size * ratio).sqrt(), (size / ratio).sqrt());
    let shorter = width.min(height);
    if shorter < MIN_SIDE {
        width *= MIN_SIDE / shorter;
        height *= MIN_SIDE / shorter;
    }
    let (width, height) = fit_inside(width, height, area);
    place(
        width,
        height,
        window.x + window.width / 2.,
        window.y + window.height / 2.,
        area,
    )
}

/// The window resized so it records at `pixels` on a display drawing `scale`
/// pixels per point, or `None` when that does not fit the usable area.
pub fn fit_to_size(
    window: AreaRect,
    pixels: (u32, u32),
    scale: f32,
    work_area: AreaRect,
) -> Option<AreaRect> {
    let area = inset(work_area);
    let (width, height) = (pixels.0 as f32 / scale, pixels.1 as f32 / scale);
    (width <= area.width + 0.5 && height <= area.height + 0.5).then(|| {
        place(
            width.min(area.width),
            height.min(area.height),
            window.x + window.width / 2.,
            window.y + window.height / 2.,
            area,
        )
    })
}

pub fn centre(window: AreaRect, work_area: AreaRect) -> AreaRect {
    let area = inset(work_area);
    let (width, height) = fit_inside(window.width, window.height, area);
    place(
        width,
        height,
        area.x + area.width / 2.,
        area.y + area.height / 2.,
        area,
    )
}

/// The ratio `window` is closest to, when within 1%.
pub fn matching_ratio(window: AreaRect) -> Option<(u32, u32)> {
    let actual = window.width / window.height.max(1.);
    RATIOS.into_iter().find(|(w, h)| {
        let ratio = *w as f32 / *h as f32;
        (actual / ratio - 1.).abs() < 0.01
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> AreaRect {
        AreaRect {
            x,
            y,
            width,
            height,
        }
    }

    fn inside(window: AreaRect, area: AreaRect) -> bool {
        window.x >= area.x - 0.01
            && window.y >= area.y - 0.01
            && window.x + window.width <= area.x + area.width + 0.01
            && window.y + window.height <= area.y + area.height + 0.01
    }

    const WORK: AreaRect = AreaRect {
        x: 0.,
        y: 25.,
        width: 1512.,
        height: 892.,
    };

    #[test]
    fn a_ratio_keeps_the_area_and_the_centre() {
        let window = rect(300., 200., 800., 600.);
        let shaped = fit_to_ratio(window, (16, 9), WORK);
        assert!((shaped.width / shaped.height - 16. / 9.).abs() < 0.001);
        assert!((shaped.width * shaped.height - 800. * 600.).abs() < 1.);
        assert!((shaped.x + shaped.width / 2. - 700.).abs() < 0.01);
        assert!((shaped.y + shaped.height / 2. - 500.).abs() < 0.01);
    }

    #[test]
    fn a_ratio_near_an_edge_stays_on_screen() {
        for window in [
            rect(-200., 40., 900., 700.),
            rect(1100., 600., 900., 700.),
            rect(0., 25., 1512., 892.),
            rect(700., 30., 300., 1000.),
        ] {
            for ratio in RATIOS {
                let shaped = fit_to_ratio(window, ratio, WORK);
                assert!(
                    inside(shaped, inset(WORK)),
                    "{window:?} {ratio:?} -> {shaped:?}"
                );
                let actual = shaped.width / shaped.height;
                let wanted = ratio.0 as f32 / ratio.1 as f32;
                assert!((actual / wanted - 1.).abs() < 0.001, "{ratio:?}");
            }
        }
    }

    #[test]
    fn a_tiny_window_grows_to_a_usable_size() {
        let shaped = fit_to_ratio(rect(500., 400., 60., 40.), (9, 16), WORK);
        assert!(shaped.width >= MIN_SIDE - 0.01);
        assert!((shaped.width / shaped.height - 9. / 16.).abs() < 0.001);
    }

    #[test]
    fn exact_sizes_fit_or_are_refused() {
        let window = rect(300., 200., 800., 600.);
        let hd = fit_to_size(window, (1280, 720), 2., WORK).unwrap();
        assert_eq!((hd.width, hd.height), (640., 360.));
        assert!(inside(hd, inset(WORK)));
        let full = fit_to_size(window, (1920, 1080), 1., WORK);
        assert!(
            full.is_none(),
            "1920 points does not fit a 1512 point display"
        );
        let retina = fit_to_size(window, (2560, 1440), 2., WORK).unwrap();
        assert_eq!((retina.width, retina.height), (1280., 720.));
        assert!(fit_to_size(window, (3840, 2160), 2., WORK).is_none());
    }

    #[test]
    fn centring_is_exact_and_shrinks_an_oversized_window() {
        let centred = centre(rect(10., 600., 800., 500.), WORK);
        assert!((centred.x + centred.width / 2. - 756.).abs() < 0.01);
        assert!((centred.y + centred.height / 2. - (25. + 446.)).abs() < 0.01);
        let big = centre(rect(0., 0., 3000., 2000.), WORK);
        assert!(inside(big, inset(WORK)));
        assert!((big.width / big.height - 1.5).abs() < 0.001);
    }

    #[test]
    fn a_window_reports_the_ratio_it_already_has() {
        assert_eq!(matching_ratio(rect(0., 0., 1600., 900.)), Some((16, 9)));
        assert_eq!(matching_ratio(rect(0., 0., 1601., 900.)), Some((16, 9)));
        assert_eq!(matching_ratio(rect(0., 0., 1000., 700.)), None);
    }
}
