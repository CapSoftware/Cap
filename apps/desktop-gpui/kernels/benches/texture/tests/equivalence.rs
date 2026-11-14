use cap_gpui_texture_bench::{
    PRESETS, Preset, candidate_preview, reference, reference_preview,
    texture::{self, Filter, Overlay},
};

#[test]
fn every_preset_matches_every_reference_pixel() {
    for preset in PRESETS {
        for (width, height) in [(0, 0), (1, 13), (13, 1), (21, 9), (216, 122), (432, 244)] {
            assert_eq!(
                reference_preview(preset, width, height),
                candidate_preview(preset, width, height),
                "{} {width}x{height}",
                preset.name
            );
        }
    }
}

#[test]
fn public_filters_keep_the_original_float_results() {
    let values = [-0.5, 0., 1. / 255., 0.25, 0.5, 1., 1.5];
    for amount in [-180., -2., 0., 0.25, 0.5, 1., 1.5, 2., 360.] {
        for filter in [
            Filter::Brightness(amount),
            Filter::Contrast(amount),
            Filter::Saturate(amount),
            Filter::Grayscale(amount),
            Filter::Sepia(amount),
            Filter::HueRotate(amount),
        ] {
            for r in values {
                for g in values {
                    for b in values {
                        let color = [r, g, b];
                        assert_eq!(
                            reference::apply_filter(color, filter).map(f32::to_bits),
                            texture::apply_filter(color, filter).map(f32::to_bits),
                            "{filter:?} {color:?}",
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn extreme_filter_chains_keep_clamping_after_each_filter() {
    for filters in [
        vec![Filter::Brightness(10.), Filter::Brightness(0.1)],
        vec![
            Filter::Contrast(8.),
            Filter::Sepia(1.),
            Filter::Brightness(0.2),
        ],
        vec![
            Filter::Saturate(4.),
            Filter::Grayscale(0.5),
            Filter::HueRotate(147.),
        ],
        vec![Filter::Brightness(-1.), Filter::Contrast(-2.)],
    ] {
        for vignette in [0., 0.01, 1.] {
            for grain in [0., 0.8] {
                let preset = Preset {
                    name: "extreme",
                    filters: &filters,
                    overlay: Some(Overlay {
                        angle: -47.,
                        from: [0.9, 0.1, 0.8, 0.2],
                        to: [0.1, 0.8, 0.3, 0.7],
                    }),
                    vignette,
                    grain,
                };
                assert_eq!(
                    reference_preview(&preset, 39, 17),
                    candidate_preview(&preset, 39, 17)
                );
            }
        }
    }
}
