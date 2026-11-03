use cap_glass::{
    PRESETS_JSON, Rgba, Shape,
    model::{self, GlassMaterial},
    scenes,
};

fn presets() -> serde_json::Value {
    serde_json::from_str(PRESETS_JSON).unwrap()
}

fn material(name: &str) -> GlassMaterial {
    serde_json::from_value(presets()[name].clone()).unwrap()
}

fn centre_over(material: &GlassMaterial, gray: f32) -> f32 {
    let backdrop = Rgba::solid(960, 600, [gray, gray, gray, 255.]);
    let shape = scenes::SHAPES[1];
    let out = model::render(material, &[shape], &backdrop);
    out.get(
        (shape.x + shape.width / 2.) as usize,
        (shape.y + shape.height / 2.) as usize,
    )[0]
}

/// What Apple's glass turns a flat black, mid-grey and white backdrop into,
/// read off the reference captures (macOS 27, Apple M4 Max).
#[test]
fn presets_match_apple_over_flat_backdrops() {
    for (name, black, gray, white) in [
        ("regular-light", 133., 188., 240.),
        ("regular-dark", 20., 110., 114.),
        ("clear-light", 71., 158., 244.),
        ("clear-dark", 25., 116., 207.),
    ] {
        let material = material(name);
        for (backdrop, expected) in [(0., black), (128., gray), (255., white)] {
            let got = centre_over(&material, backdrop);
            eprintln!("{name} {backdrop} -> {got:.1} (apple {expected})");
            assert!(
                (got - expected).abs() <= 3.,
                "{name} over {backdrop}: {got} vs Apple's {expected}"
            );
        }
    }
}

#[test]
fn every_preset_is_complete() {
    let all = presets();
    let names: Vec<&str> = all
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        names,
        ["clear-dark", "clear-light", "regular-dark", "regular-light"]
    );
    for name in names {
        let material = material(name);
        let style = material.resolve(420., 240.);
        assert!(style.blur > 0. && style.lens_rim > 0., "{name}");
    }
}

#[test]
fn blur_and_lensing_scale_with_the_shorter_side_up_to_their_caps() {
    let material = material("clear-light");
    let small = material.resolve(300., 48.);
    let large = material.resolve(900., 600.);
    assert!((small.blur - material.blur_k * 48.).abs() < 1e-4);
    assert_eq!(large.blur, material.blur_max);
    assert!(small.lens_rim < large.lens_rim);
    let doubled = small.scaled(2.);
    assert_eq!(doubled.blur, small.blur * 2.);
    assert_eq!(doubled.lens_rim, small.lens_rim * 2.);
    assert_eq!(doubled.rim_bend, small.rim_bend * 2.);
}

#[test]
fn the_rounded_rect_distance_field_is_signed_and_clamps_its_radius() {
    let shape = Shape {
        x: 0.,
        y: 0.,
        width: 100.,
        height: 40.,
        radius: 80.,
    };
    assert!((shape.sdf(50., 20.) + 20.).abs() < 1e-4);
    assert!((shape.sdf(50., -5.) - 5.).abs() < 1e-4);
    assert!((shape.sdf(0., 20.)).abs() < 1e-4);
    assert!(
        shape.sdf(1., 1.) > 0.,
        "a corner beyond the clamped radius is outside"
    );
    let (nx, ny) = shape.normal(50., 1.);
    assert!(nx.abs() < 1e-3 && (ny + 1.).abs() < 1e-3);
}

#[test]
fn scenes_render_deterministically_at_any_scale() {
    for name in scenes::NAMES {
        let one = scenes::render(name, 1.).unwrap();
        assert_eq!((one.width, one.height), (960, 600));
        let two = scenes::render(name, 2.).unwrap();
        assert_eq!((two.width, two.height), (1920, 1200));
        assert_eq!(one.pixels, scenes::render(name, 1.).unwrap().pixels);
    }
    assert!(scenes::render("nope", 1.).is_none());
}

#[test]
fn glass_leaves_pixels_beyond_its_hairline_alone() {
    let material = material("regular-light");
    let backdrop = scenes::render("checker", 1.).unwrap();
    let shape = scenes::SHAPES[1];
    let out = model::render(&material, &[shape], &backdrop);
    for (x, y) in [(455usize, 180usize), (885, 180), (670, 55), (670, 305)] {
        assert_eq!(out.get(x, y), backdrop.get(x, y), "({x}, {y})");
    }
}

fn centre_of(
    material: &GlassMaterial,
    gray: f32,
    shape: Shape,
    tint: Option<([f32; 3], f32)>,
) -> [f32; 3] {
    let backdrop = Rgba::solid(960, 600, [gray, gray, gray, 255.]);
    let mut style = material.resolve(shape.width, shape.height);
    if let Some((color, alpha)) = tint {
        style.tint = material.tint_matrix(color, alpha);
    }
    let mut out = backdrop.clone();
    model::composite(&style, &shape, &backdrop.blurred(style.blur), &mut out);
    let pixel = out.get(
        (shape.x + shape.width / 2.) as usize,
        (shape.y + shape.height / 2.) as usize,
    );
    [pixel[0], pixel[1], pixel[2]]
}

fn pane(side: f32) -> Shape {
    Shape {
        x: 100.,
        y: 100.,
        width: 400.,
        height: side,
        radius: side / 2.,
    }
}

/// Regular dark glass lifts small panes over bright content: over white,
/// Apple's reads 180 up to 64 pt tall, 154 at 80 pt, 127 at 96 pt and 114
/// from 128 pt (`sweep`, macOS 27.0.1).
#[test]
fn regular_dark_adapts_to_pane_size() {
    let material = material("regular-dark");
    for (side, apple) in [
        (44., 180.),
        (64., 180.),
        (80., 154.),
        (96., 127.),
        (128., 114.),
        (240., 114.),
    ] {
        let got = centre_of(&material, 255., pane(side), None)[0];
        eprintln!("regular-dark {side} pt over white -> {got:.1} (apple {apple})");
        assert!(
            (got - apple).abs() <= 3.,
            "{side} pt: {got} vs Apple's {apple}"
        );
    }
}

/// Apple's tints over mid grey, read off the `sweep` captures: Regular
/// ignores the hue and shifts grey, Clear blends the colour in.
#[test]
fn tints_match_apple_over_mid_grey() {
    let blue = ([0., 0.533, 1.], 0.6);
    let red = ([1., 0.22, 0.235], 0.6);
    for (name, tint, apple) in [
        ("regular-light", blue, [172., 172., 172.]),
        ("regular-dark", blue, [126., 125., 126.]),
        ("regular-light", red, [172., 172., 172.]),
        ("clear-light", blue, [63., 130., 193.]),
        ("clear-dark", blue, [46., 107., 166.]),
    ] {
        let got = centre_of(&material(name), 128., pane(240.), Some(tint));
        eprintln!("{name} {tint:?} over 128 -> {got:?} (apple {apple:?})");
        for c in 0..3 {
            assert!(
                (got[c] - apple[c]).abs() <= 3.,
                "{name} channel {c}: {got:?} vs Apple's {apple:?}"
            );
        }
    }
}

/// Apple's refraction at the edge grows with the pane up to a cap: about
/// 0.52 px per point for Clear up to 45 px, 11 + 0.08 px per point for
/// Regular up to 26 px (`sweep lens`).
#[test]
fn lens_amplitude_follows_apple() {
    for (name, side, apple) in [
        ("clear-light", 20., 10.9),
        ("clear-light", 44., 23.5),
        ("clear-light", 270., 44.1),
        ("regular-light", 44., 14.3),
        ("regular-light", 270., 25.6),
    ] {
        let got = -material(name).resolve(400., side).rim_bend;
        assert!(
            (got - apple).abs() <= 2.,
            "{name} {side} pt: {got} vs Apple's {apple}"
        );
    }
}
