use std::time::Instant;

use super::*;

fn annotations(count: usize) -> Vec<Annotation> {
    (0..count)
        .map(|index| Annotation {
            id: index.to_string(),
            annotation_type: [
                AnnotationType::Rectangle,
                AnnotationType::Circle,
                AnnotationType::Arrow,
                AnnotationType::Draw,
            ][index % 4],
            x: 40. + (index % 10) as f64 * 170.,
            y: 40. + (index / 10) as f64 * 90.,
            width: 140.,
            height: 70.,
            stroke_color: "#F05656".into(),
            stroke_width: 4.,
            fill_color: "#112233".into(),
            opacity: 0.7,
            rotation: 0.,
            text: None,
            mask_type: None,
            mask_level: None,
            points: (index % 4 == 3).then(|| {
                (0..64)
                    .map(|sample| {
                        let x = sample as f64 / 63.;
                        [x, 0.5 + (x * 12.).sin() * 0.4]
                    })
                    .collect()
            }),
        })
        .collect()
}

struct AnnotationLayerBench {
    annotations: Vec<Annotation>,
    selected: Option<String>,
    hover: Option<String>,
    paths: Rc<RefCell<Vec<Option<CachedAnnotationPaths>>>>,
}

impl gpui::Render for AnnotationLayerBench {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let paint = LayerPaint {
            annotations: self.annotations.clone(),
            paths: self.paths.clone(),
            temp: None,
            masks: Vec::new(),
            selected: self.selected.clone(),
            editing: None,
            hover: self.hover.clone(),
            select_tool: true,
            scale: 0.5,
            handle_size: 16.,
        };
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| paint_layer(&paint, bounds, window, cx),
        )
        .size_full()
    }
}

#[test]
#[ignore]
fn benchmark_annotation_layer_repaint() {
    let mut cx = gpui::TestAppContext::single();
    for count in [20, 50, 100] {
        for dragging in [false, true] {
            let window = cx.open_window(gpui::size(px(960.), px(540.)), |_, _| {
                AnnotationLayerBench {
                    annotations: annotations(count),
                    selected: dragging.then(|| "3".into()),
                    hover: None,
                    paths: Rc::default(),
                }
            });
            let mut rounds = Vec::new();
            for round in 0..9 {
                let mut elapsed = std::time::Duration::ZERO;
                for frame in 0..60 {
                    window
                        .update(&mut cx, |view, window, cx| {
                            if dragging {
                                view.annotations[3].x = 550. + frame as f64;
                            } else {
                                view.hover = Some((frame % count).to_string());
                            }
                            window.refresh();
                            cx.notify();
                        })
                        .unwrap();
                    let handle: gpui::AnyWindowHandle = window.into();
                    elapsed += handle
                        .update(&mut cx, |_, window, cx| {
                            let started = Instant::now();
                            window.draw(cx).clear();
                            started.elapsed()
                        })
                        .unwrap();
                }
                if round > 0 {
                    rounds.push(elapsed.as_secs_f64() * 1e6 / 60.);
                }
            }
            rounds.sort_by(f64::total_cmp);
            println!(
                "{count} annotations, {}: {:.2} us/frame median of 8 rounds x 60 frames",
                if dragging { "drag" } else { "hover" },
                rounds[rounds.len() / 2],
            );
            window
                .update(&mut cx, |_, window, _| window.remove_window())
                .unwrap();
        }
    }
}

fn assert_paths_eq(actual: &[(gpui::Path<Pixels>, Hsla)], expected: &[(gpui::Path<Pixels>, Hsla)]) {
    assert_eq!(actual.len(), expected.len());
    for ((actual, color), (expected, expected_color)) in actual.iter().zip(expected) {
        assert_eq!(color, expected_color);
        assert_eq!(actual.bounds, expected.bounds);
        assert_eq!(actual.vertices.len(), expected.vertices.len());
        for (actual, expected) in actual.vertices.iter().zip(&expected.vertices) {
            assert_eq!(
                f32::from(actual.xy_position.x).to_bits(),
                f32::from(expected.xy_position.x).to_bits()
            );
            assert_eq!(
                f32::from(actual.xy_position.y).to_bits(),
                f32::from(expected.xy_position.y).to_bits()
            );
            assert_eq!(
                actual.st_position.x.to_bits(),
                expected.st_position.x.to_bits()
            );
            assert_eq!(
                actual.st_position.y.to_bits(),
                expected.st_position.y.to_bits()
            );
        }
    }
}

#[test]
fn cached_paths_match_fresh_tessellation_after_edits_and_transform_changes() {
    let edits: &[fn(&mut Annotation)] = &[
        |a| a.x += 13.25,
        |a| a.y -= 7.75,
        |a| a.width = -90.,
        |a| a.height = -45.,
        |a| a.height = 0.,
        |a| a.stroke_width = 0.,
        |a| a.stroke_width = 0.4,
        |a| a.stroke_color = "transparent".into(),
        |a| a.stroke_color = "#12345678".into(),
        |a| a.stroke_color = "invalid".into(),
        |a| a.fill_color = "transparent".into(),
        |a| a.fill_color = "#fedcba80".into(),
        |a| a.opacity = 0.,
        |a| a.opacity = 0.35,
        |a| a.points = None,
        |a| a.points = Some(Vec::new()),
        |a| a.points = Some(vec![[0., 0.], [0.25, 0.7], [1., 1.]]),
        |a| a.annotation_type = AnnotationType::Rectangle,
        |a| a.annotation_type = AnnotationType::Circle,
        |a| a.annotation_type = AnnotationType::Arrow,
        |a| a.annotation_type = AnnotationType::Draw,
        |a| a.annotation_type = AnnotationType::Mask,
        |a| a.annotation_type = AnnotationType::Text,
    ];
    let mut cache = None;
    for base in annotations(4) {
        for edit in edits {
            let mut edited = base.clone();
            edit(&mut edited);
            for annotation in [&base, &edited, &base] {
                for (origin, scale) in [
                    (gpui::point(px(11.25), px(27.5)), 0.5),
                    (gpui::point(px(-9.5), px(0.)), 0.5),
                    (gpui::point(px(-9.5), px(0.)), 1.25),
                ] {
                    let expected = annotation_paths(annotation, origin, scale);
                    assert_paths_eq(
                        cached_annotation_paths(&mut cache, annotation, origin, scale),
                        &expected,
                    );
                    assert_paths_eq(
                        cached_annotation_paths(&mut cache, annotation, origin, scale),
                        &expected,
                    );
                }
            }
        }
    }
}

fn draw_layer(window: gpui::WindowHandle<AnnotationLayerBench>, cx: &mut gpui::TestAppContext) {
    let handle: gpui::AnyWindowHandle = window.into();
    handle
        .update(cx, |_, window, cx| {
            window.refresh();
            window.draw(cx).clear();
        })
        .unwrap();
}

#[test]
fn repaint_reuses_unchanged_paths_and_discards_removed_annotations() {
    let mut cx = gpui::TestAppContext::single();
    let paths = Rc::default();
    let window = cx.open_window(gpui::size(px(960.), px(540.)), |_, _| {
        AnnotationLayerBench {
            annotations: annotations(4),
            selected: None,
            hover: None,
            paths: Rc::clone(&paths),
        }
    });
    draw_layer(window, &mut cx);
    let vertices = || {
        paths.borrow()[0].as_ref().unwrap().paths[0]
            .0
            .vertices
            .as_ptr()
    };
    let original = vertices();
    window
        .update(&mut cx, |view, _, cx| {
            view.hover = Some("1".into());
            view.selected = Some("3".into());
            view.annotations[3].x += 20.;
            cx.notify();
        })
        .unwrap();
    draw_layer(window, &mut cx);
    assert_eq!(vertices(), original);
    window
        .update(&mut cx, |view, _, cx| {
            view.annotations.swap(0, 3);
            view.annotations.remove(1);
            cx.notify();
        })
        .unwrap();
    draw_layer(window, &mut cx);
    assert_eq!(paths.borrow().len(), 3);
    window
        .update(&mut cx, |view, _, _| {
            for (entry, annotation) in paths.borrow().iter().zip(&view.annotations) {
                let entry = entry.as_ref().unwrap();
                assert_eq!(entry.source, *annotation);
                assert_paths_eq(
                    &entry.paths,
                    &annotation_paths(annotation, entry.origin, entry.scale),
                );
            }
        })
        .unwrap();
    window
        .update(&mut cx, |view, _, cx| {
            view.annotations.clear();
            cx.notify();
        })
        .unwrap();
    draw_layer(window, &mut cx);
    assert!(paths.borrow().is_empty());
}
