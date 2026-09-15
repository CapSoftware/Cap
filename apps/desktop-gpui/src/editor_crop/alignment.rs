use super::{CropBounds, Vec2};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CropGuides {
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, Copy)]
pub struct ResizeAlignment {
    pub origin: Vec2,
    pub axes: (bool, bool),
    pub ratio: Option<f64>,
}

pub fn align_crop(
    bounds: CropBounds,
    container: Vec2,
    resize: Option<ResizeAlignment>,
) -> (CropBounds, CropGuides) {
    let mut next = bounds;
    let mut guides = CropGuides::default();
    let mut best_ratio_distance = f64::INFINITY;
    for horizontal in [true, false] {
        if resize.is_some_and(|r| if horizontal { !r.axes.0 } else { !r.axes.1 }) {
            continue;
        }
        let base = if resize.is_some_and(|r| r.ratio.is_some()) {
            bounds
        } else {
            next
        };
        let (position, size, extent) = if horizontal {
            (base.x, base.width, container.x)
        } else {
            (base.y, base.height, container.y)
        };
        let mut best_distance = 7.;
        let mut candidate = base;
        let mut guide = None;
        let anchors: &[f64] = if resize.is_some() {
            &[0., 1.]
        } else {
            &[0.5, 0., 1.]
        };
        for target in [0.5, 0., 1., 0.25, 0.75] {
            for &anchor in anchors {
                let origin =
                    resize.map_or(0., |r| if horizontal { r.origin.x } else { r.origin.y });
                if resize.is_some() && anchor == origin {
                    continue;
                }
                let line = target * extent;
                let delta = line - (position + size * anchor);
                let distance = delta.abs();
                if distance > 6. || distance >= best_distance {
                    continue;
                }
                let mut proposed = base;
                if let Some(resize) = resize {
                    if horizontal {
                        proposed.width += delta / (anchor - origin);
                        if let Some(ratio) = resize.ratio {
                            proposed.height = proposed.width / ratio;
                        }
                    } else {
                        proposed.height += delta / (anchor - origin);
                        if let Some(ratio) = resize.ratio {
                            proposed.width = proposed.height * ratio;
                        }
                    }
                    proposed.x += (base.width - proposed.width) * resize.origin.x;
                    proposed.y += (base.height - proposed.height) * resize.origin.y;
                } else if horizontal {
                    proposed.x += delta;
                } else {
                    proposed.y += delta;
                }
                if proposed.width < 1.
                    || proposed.height < 1.
                    || proposed.x < -0.001
                    || proposed.y < -0.001
                    || proposed.x + proposed.width > container.x + 0.001
                    || proposed.y + proposed.height > container.y + 0.001
                {
                    continue;
                }
                candidate = proposed;
                guide = Some(line);
                best_distance = distance;
            }
        }
        if resize.is_some_and(|r| r.ratio.is_some()) {
            if guide.is_none() || best_distance >= best_ratio_distance {
                continue;
            }
            best_ratio_distance = best_distance;
            guides = CropGuides::default();
        }
        next = candidate;
        if horizontal {
            guides.x = guide;
        } else {
            guides.y = guide;
        }
    }
    (next, guides)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_a_moved_crop_on_both_axes() {
        let (bounds, guides) = align_crop(
            CropBounds::new(253.0, 197.0, 300.0, 200.0),
            Vec2::new(800., 600.),
            None,
        );
        assert_eq!(bounds, CropBounds::new(250.0, 200.0, 300.0, 200.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(400.0),
                y: Some(300.0)
            }
        );
    }

    #[test]
    fn snaps_a_resize_to_the_halfway_line() {
        let (bounds, guides) = align_crop(
            CropBounds::new(80.0, 70.0, 317.0, 180.0),
            Vec2::new(800., 600.),
            Some(ResizeAlignment {
                origin: Vec2::new(0.0, 0.0),
                axes: (true, false),
                ratio: None,
            }),
        );
        assert_eq!(bounds, CropBounds::new(80.0, 70.0, 320.0, 180.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(400.0),
                y: None
            }
        );
    }

    #[test]
    fn keeps_the_opposite_corner_fixed() {
        let (bounds, guides) = align_crop(
            CropBounds::new(197.0, 153.0, 343.0, 237.0),
            Vec2::new(800., 600.),
            Some(ResizeAlignment {
                origin: Vec2::new(1.0, 1.0),
                axes: (true, true),
                ratio: None,
            }),
        );
        assert_eq!(bounds, CropBounds::new(200.0, 150.0, 340.0, 240.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(200.0),
                y: Some(150.0)
            }
        );
    }

    #[test]
    fn keeps_alt_resizing_centered() {
        let (bounds, guides) = align_crop(
            CropBounds::new(163.0, 85.0, 234.0, 190.0),
            Vec2::new(800., 600.),
            Some(ResizeAlignment {
                origin: Vec2::new(0.5, 0.5),
                axes: (true, false),
                ratio: None,
            }),
        );
        assert_eq!(bounds, CropBounds::new(160.0, 85.0, 240.0, 190.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(400.0),
                y: None
            }
        );
    }

    #[test]
    fn preserves_a_locked_ratio() {
        let (bounds, guides) = align_crop(
            CropBounds::new(80.0, 70.0, 317.0, 158.5),
            Vec2::new(800., 600.),
            Some(ResizeAlignment {
                origin: Vec2::new(0.0, 0.0),
                axes: (true, true),
                ratio: Some(2.0),
            }),
        );
        assert_eq!(bounds, CropBounds::new(80.0, 70.0, 320.0, 160.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(400.0),
                y: None
            }
        );
    }

    #[test]
    fn releases_beyond_six_display_pixels() {
        let (bounds, guides) = align_crop(
            CropBounds::new(263.0, 217.0, 300.0, 200.0),
            Vec2::new(800., 600.),
            None,
        );
        assert_eq!(bounds, CropBounds::new(263.0, 217.0, 300.0, 200.0));
        assert_eq!(guides, CropGuides { x: None, y: None });
    }

    #[test]
    fn never_collapses_a_tiny_crop() {
        let (bounds, guides) = align_crop(
            CropBounds::new(400.0, 300.0, 3.0, 3.0),
            Vec2::new(800., 600.),
            Some(ResizeAlignment {
                origin: Vec2::new(0.0, 0.0),
                axes: (true, true),
                ratio: None,
            }),
        );
        assert_eq!(bounds, CropBounds::new(400.0, 300.0, 3.0, 3.0));
        assert_eq!(guides, CropGuides { x: None, y: None });
    }

    #[test]
    fn snaps_to_the_image_boundary() {
        let (bounds, guides) = align_crop(
            CropBounds::new(3.0, 91.0, 318.0, 217.0),
            Vec2::new(800., 600.),
            None,
        );
        assert_eq!(bounds, CropBounds::new(0.0, 91.0, 318.0, 217.0));
        assert_eq!(
            guides,
            CropGuides {
                x: Some(0.0),
                y: None
            }
        );
    }
}
