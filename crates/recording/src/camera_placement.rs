use cap_project::{Camera, CameraPosition, CameraXPosition, CameraYPosition};

use crate::screen_capture::ScreenCaptureTarget;

#[derive(Clone, Copy, Debug)]
pub struct RecordingCameraPlacement {
    column: u8,
    bottom: bool,
}

impl RecordingCameraPlacement {
    pub fn from_bounds(camera: [f64; 4], reference: [f64; 4]) -> Option<Self> {
        if !valid_bounds(camera) || !valid_bounds(reference) {
            return None;
        }
        let [x, y, width, height] = camera;
        let [left, top, reference_width, reference_height] = reference;
        let center_x = ((x - left + width / 2.0) / reference_width).clamp(0.0, 1.0);
        let center_y = ((y - top + height / 2.0) / reference_height).clamp(0.0, 1.0);
        let column = if center_x < 1.0 / 3.0 {
            0
        } else if center_x > 2.0 / 3.0 {
            2
        } else {
            1
        };
        Some(Self {
            column,
            bottom: center_y >= 0.5,
        })
    }

    pub fn apply(self, camera: &mut Camera) {
        camera.position = CameraPosition {
            x: match self.column {
                0 => CameraXPosition::Left,
                2 => CameraXPosition::Right,
                _ => CameraXPosition::Center,
            },
            y: if self.bottom {
                CameraYPosition::Bottom
            } else {
                CameraYPosition::Top
            },
        };
        camera.manual_position = None;
    }
}

fn valid_bounds([x, y, width, height]: [f64; 4]) -> bool {
    [x, y, width, height, x + width, y + height]
        .into_iter()
        .all(f64::is_finite)
        && width > 0.0
        && height > 0.0
}

fn overlap(a: [f64; 4], b: [f64; 4]) -> f64 {
    ((a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0])).max(0.0)
        * ((a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1])).max(0.0)
}

// macOS capture coordinates are global points; Windows and X11 use global
// pixels so monitors with different DPI never share incompatible logical origins.
pub fn recording_camera_placement(
    target: &ScreenCaptureTarget,
    camera: [f64; 4],
) -> Option<RecordingCameraPlacement> {
    if matches!(target, ScreenCaptureTarget::CameraOnly) || !valid_bounds(camera) {
        return None;
    }
    let reference = capture_bounds(target)
        .filter(|bounds| valid_bounds(*bounds) && overlap(camera, *bounds) > 0.0);
    let reference = reference.or_else(|| {
        scap_targets::Display::list()
            .into_iter()
            .filter_map(display_bounds)
            .filter(|bounds| valid_bounds(*bounds) && overlap(camera, *bounds) > 0.0)
            .max_by(|a, b| overlap(camera, *a).total_cmp(&overlap(camera, *b)))
    })?;
    RecordingCameraPlacement::from_bounds(camera, reference)
}

fn display_bounds(display: scap_targets::Display) -> Option<[f64; 4]> {
    #[cfg(target_os = "macos")]
    let bounds = display.raw_handle().logical_bounds()?;
    #[cfg(not(target_os = "macos"))]
    let bounds = display.raw_handle().physical_bounds()?;
    Some([
        bounds.position().x(),
        bounds.position().y(),
        bounds.size().width(),
        bounds.size().height(),
    ])
}

fn capture_bounds(target: &ScreenCaptureTarget) -> Option<[f64; 4]> {
    match target {
        ScreenCaptureTarget::CameraOnly => None,
        ScreenCaptureTarget::Display { .. } => display_bounds(target.display()?),
        ScreenCaptureTarget::Window { id } => {
            let window = scap_targets::Window::from_id(id)?;
            #[cfg(target_os = "macos")]
            let bounds = window.raw_handle().logical_bounds()?;
            #[cfg(not(target_os = "macos"))]
            let bounds = window.raw_handle().physical_bounds()?;
            Some([
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            ])
        }
        ScreenCaptureTarget::Area { bounds, .. } => {
            let display = target.display()?;
            let origin = display_bounds(display)?;
            #[cfg(target_os = "macos")]
            let scale = (1.0, 1.0);
            #[cfg(not(target_os = "macos"))]
            let scale = {
                let logical = display.logical_size()?;
                (origin[2] / logical.width(), origin[3] / logical.height())
            };
            Some([
                origin[0] + bounds.position().x() * scale.0,
                origin[1] + bounds.position().y() * scale.1,
                bounds.size().width() * scale.0,
                bounds.size().height() * scale.1,
            ])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::BackgroundBlurMode;

    fn position(bounds: [f64; 4], reference: [f64; 4], cutout: bool) -> serde_json::Value {
        let mut camera = Camera {
            manual_position: Some(cap_project::XY::new(0.8, 0.2)),
            ..Default::default()
        };
        if cutout {
            camera.background_blur.mode = BackgroundBlurMode::Remove;
        }
        RecordingCameraPlacement::from_bounds(bounds, reference)
            .unwrap()
            .apply(&mut camera);
        assert!(camera.manual_position.is_none());
        serde_json::to_value(camera.position).unwrap()
    }

    #[test]
    fn chooses_all_six_position_presets_with_and_without_cutout() {
        let reference = [0.0, 0.0, 1920.0, 1080.0];
        for (x, horizontal) in [(40.0, "left"), (860.0, "center"), (1600.0, "right")] {
            for (y, vertical) in [(20.0, "top"), (800.0, "bottom")] {
                for cutout in [false, true] {
                    assert_eq!(
                        position([x, y, 200.0, 200.0], reference, cutout),
                        serde_json::json!({"x": horizontal, "y": vertical}),
                    );
                }
            }
        }
    }

    #[test]
    fn reported_low_left_cutout_selects_bottom_left_not_a_custom_position() {
        let center = [0.1123798076923077, 0.6731481685185186];
        assert_eq!(
            position(
                [
                    center[0] * 1920.0 - 100.0,
                    center[1] * 1080.0 - 100.0,
                    200.0,
                    200.0
                ],
                [0.0, 0.0, 1920.0, 1080.0],
                true
            ),
            serde_json::json!({"x": "left", "y": "bottom"}),
        );
    }

    #[test]
    fn preset_boundaries_use_the_preview_center() {
        for (x, horizontal) in [
            (299.0, "left"),
            (300.0, "center"),
            (600.0, "center"),
            (601.0, "right"),
        ] {
            for (y, vertical) in [(299.0, "top"), (300.0, "bottom")] {
                assert_eq!(
                    position(
                        [x - 50.0, y - 50.0, 100.0, 100.0],
                        [0.0, 0.0, 900.0, 600.0],
                        false
                    ),
                    serde_json::json!({"x": horizontal, "y": vertical})
                );
            }
        }
    }

    #[test]
    fn placement_is_invariant_under_display_origin_and_scale() {
        for origin in [[0.0, 0.0], [-3840.0, -2160.0], [1920.0, -400.0]] {
            for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
                for cutout in [false, true] {
                    let bounds = [80.0, 760.0, 240.0, 240.0];
                    let reference = [0.0, 0.0, 1920.0, 1080.0];
                    let shifted = |rect: [f64; 4]| {
                        [
                            origin[0] + rect[0] * scale,
                            origin[1] + rect[1] * scale,
                            rect[2] * scale,
                            rect[3] * scale,
                        ]
                    };
                    let expected = position(bounds, reference, cutout);
                    let actual = position(shifted(bounds), shifted(reference), cutout);
                    assert_eq!(actual, expected);
                }
            }
        }
    }

    #[test]
    fn window_and_area_origins_are_relative_to_the_recorded_region() {
        let placed = position(
            [-900.0, 250.0, 200.0, 200.0],
            [-1400.0, 200.0, 1200.0, 700.0],
            false,
        );
        assert_eq!(placed, serde_json::json!({"x": "center", "y": "top"}));
    }

    #[test]
    fn invalid_geometry_is_ignored_and_offscreen_centers_are_clamped() {
        let valid = [0.0, 0.0, 100.0, 100.0];
        for index in 0..4 {
            for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut invalid = valid;
                invalid[index] = value;
                assert!(RecordingCameraPlacement::from_bounds(invalid, valid).is_none());
                assert!(RecordingCameraPlacement::from_bounds(valid, invalid).is_none());
            }
        }
        for size in [0.0, -1.0] {
            assert!(
                RecordingCameraPlacement::from_bounds([0.0, 0.0, size, 100.0], valid).is_none()
            );
            assert!(
                RecordingCameraPlacement::from_bounds(valid, [0.0, 0.0, 100.0, size]).is_none()
            );
        }
        let placed = position([-100.0, 200.0, 20.0, 20.0], valid, false);
        assert_eq!(placed, serde_json::json!({"x": "left", "y": "bottom"}));
    }

    #[test]
    fn applying_placement_preserves_every_other_camera_setting() {
        for mode in [
            BackgroundBlurMode::Off,
            BackgroundBlurMode::Light,
            BackgroundBlurMode::Heavy,
            BackgroundBlurMode::Remove,
        ] {
            let mut camera = Camera::default();
            camera.background_blur.mode = mode;
            let mut expected = serde_json::to_value(&camera).unwrap();
            RecordingCameraPlacement::from_bounds(
                [800.0, 20.0, 320.0, 180.0],
                [0.0, 0.0, 1920.0, 1080.0],
            )
            .unwrap()
            .apply(&mut camera);
            expected["manualPosition"] = serde_json::Value::Null;
            expected["position"] = serde_json::json!({"x": "center", "y": "top"});
            assert_eq!(serde_json::to_value(&camera).unwrap(), expected);
        }
    }

    #[test]
    #[ignore = "placement microbenchmark"]
    fn placement_benchmark() {
        let mut camera = Camera::default();
        camera.background_blur.mode = BackgroundBlurMode::Remove;
        let iterations = 1_000_000;
        let started = std::time::Instant::now();
        for index in 0..iterations {
            let bounds = std::hint::black_box([f64::from(index % 1600), 20.0, 200.0, 200.0]);
            RecordingCameraPlacement::from_bounds(bounds, [0.0, 0.0, 1920.0, 1080.0])
                .unwrap()
                .apply(&mut camera);
            std::hint::black_box(&camera);
        }
        println!(
            "placement mapping: {:.1} ns/operation over {iterations} operations",
            started.elapsed().as_nanos() as f64 / f64::from(iterations)
        );
    }
}
