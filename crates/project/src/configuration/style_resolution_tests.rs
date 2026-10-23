use super::*;

fn baseline_style_at(project: &ProjectConfiguration, time: f64) -> Cow<'_, ProjectConfiguration> {
    let mut configuration = Cow::Borrowed(project);
    if let Some(background) =
        project.style_override_at(time, |overrides| overrides.background.as_ref())
    {
        configuration.to_mut().background = background.clone();
    }
    if let Some(camera) = project.style_override_at(time, |overrides| overrides.camera.as_ref()) {
        configuration.to_mut().camera = camera.clone();
    }
    if let Some(cursor) = project.style_override_at(time, |overrides| overrides.cursor.as_ref()) {
        configuration.to_mut().cursor = cursor.clone();
    }
    configuration
}

fn fixture(count: usize, overlap: bool) -> ProjectConfiguration {
    let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
        "segments": [{"start": 0.0, "end": 3600.0, "timescale": 1.0}],
        "zoomSegments": []
    }))
    .unwrap();
    timeline.style_segments = (0..count)
        .map(|index| {
            let start = if overlap {
                (index % 7) as f64 * 0.5
            } else {
                index as f64 * 2.0
            };
            StyleSegment {
                start,
                end: start + 1.0,
                track: (index % 4) as u32,
                enabled: index % 11 != 10,
                overrides: StyleOverrides {
                    background: (index % 3 != 1).then(|| BackgroundConfiguration {
                        padding: index as f64,
                        ..Default::default()
                    }),
                    camera: (index % 3 != 2).then(|| Camera {
                        size: index as f32,
                        ..Default::default()
                    }),
                    cursor: (index % 3 != 0).then(|| CursorConfiguration {
                        size: index as u32,
                        ..Default::default()
                    }),
                    camera_only_padding: Some(index as f64),
                },
                ..Default::default()
            }
        })
        .collect();
    ProjectConfiguration {
        timeline: Some(timeline),
        ..Default::default()
    }
}

#[test]
fn one_pass_styles_match_independent_group_selection() {
    let mut project = fixture(70, true);
    let timeline = project.timeline.as_mut().unwrap();
    for (index, start, end) in [
        (0, -0.0, 5.0),
        (1, 0.0, 5.0),
        (2, -1.0, 5.0),
        (3, f64::NAN, 5.0),
        (4, 0.0, f64::INFINITY),
        (5, 3.0, 2.0),
        (6, 2.0, 2.0),
    ] {
        timeline.style_segments[index].start = start;
        timeline.style_segments[index].end = end;
    }
    let original = serde_json::to_value(&project).unwrap();
    for time in [
        -1.0,
        -0.0,
        0.0,
        0.5,
        0.5_f64.next_down(),
        0.5_f64.next_up(),
        1.0,
        2.0,
        3.0,
        3.5,
        4.0,
        5.0,
        10.0,
        f64::NAN,
        f64::NEG_INFINITY,
        f64::INFINITY,
    ] {
        let expected = baseline_style_at(&project, time);
        let actual = project.style_at(time);
        assert_eq!(
            matches!(actual, Cow::Borrowed(_)),
            matches!(expected, Cow::Borrowed(_))
        );
        assert_eq!(
            serde_json::to_value(actual.as_ref()).unwrap(),
            serde_json::to_value(expected.as_ref()).unwrap()
        );
    }
    assert_eq!(serde_json::to_value(&project).unwrap(), original);
    let project = ProjectConfiguration::default();
    assert!(matches!(project.style_at(1.0), Cow::Borrowed(_)));
}

#[test]
#[ignore]
fn benchmark_style_resolution() {
    use std::{hint::black_box, time::Instant};
    for count in [0, 20, 200, 1000] {
        let project = fixture(count, false);
        for active in [false, true] {
            let time = if active && count > 0 {
                let segment = project
                    .timeline
                    .as_ref()
                    .unwrap()
                    .style_segments
                    .iter()
                    .skip(count / 2)
                    .find(|segment| segment.enabled)
                    .unwrap();
                segment.start + 0.25
            } else {
                count as f64 * 2.0 + 0.25
            };
            let expected = baseline_style_at(&project, time);
            let actual = project.style_at(time);
            assert_eq!(matches!(actual, Cow::Owned(_)), active && count > 0);
            assert_eq!(
                serde_json::to_value(actual.as_ref()).unwrap(),
                serde_json::to_value(expected.as_ref()).unwrap()
            );
            let run = |baseline: bool, iterations| {
                let started = Instant::now();
                for _ in 0..iterations {
                    let output = if baseline {
                        baseline_style_at(black_box(&project), black_box(time))
                    } else {
                        black_box(&project).style_at(black_box(time))
                    };
                    black_box(output);
                }
                started.elapsed().as_secs_f64() * 1e9 / f64::from(iterations)
            };
            let iterations = if active && count > 0 { 1000 } else { 10000 };
            run(true, 10);
            run(false, 10);
            let mut baseline = Vec::new();
            let mut single = Vec::new();
            for sample in 0..7 {
                if sample % 2 == 0 {
                    baseline.push(run(true, iterations));
                    single.push(run(false, iterations));
                } else {
                    single.push(run(false, iterations));
                    baseline.push(run(true, iterations));
                }
            }
            baseline.sort_by(f64::total_cmp);
            single.sort_by(f64::total_cmp);
            println!(
                "styles={count} active={active} before_ns={:.3} after_ns={:.3} speedup={:.2}",
                baseline[3],
                single[3],
                baseline[3] / single[3]
            );
        }
    }
}
