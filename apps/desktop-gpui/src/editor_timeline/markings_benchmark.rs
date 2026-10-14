use std::{hint::black_box, time::Instant};

use super::*;

fn fixture(count: usize, duration: f64) -> TimelineModel {
    let segments: Vec<_> = (0..count)
        .map(|index| {
            serde_json::json!({
                "recordingSegment": 0,
                "timescale": 1.0,
                "start": index as f64 * 12.0,
                "end": index as f64 * 12.0 + duration
            })
        })
        .collect();
    let config: ProjectConfiguration = serde_json::from_value(serde_json::json!({
        "timeline": { "segments": segments, "zoomSegments": [] }
    }))
    .expect("synthetic timeline parses");
    let model = TimelineModel::build(&config, false, false);
    assert_eq!(model.clips.len(), count);
    assert!((model.total_duration - count as f64 * duration).abs() < 1e-9);
    model
}

fn measure(model: &TimelineModel, view: TimelineView, culled: bool) -> f64 {
    let secs_per_pixel = view.transform.secs_per_pixel(1200.0);
    let started = Instant::now();
    for _ in 0..20 {
        for segment in &model.clips {
            if !view.transform.segment_visible(segment.start, segment.end) {
                continue;
            }
            let SegmentDetail::Clip { holds, .. } = &segment.detail else {
                panic!("fixture contains only clips");
            };
            let width = ((segment.end - segment.start) / secs_per_pixel) as f32;
            let element = if culled {
                render_clip_markings(
                    TrackKind::Clip.color(),
                    black_box(segment),
                    holds,
                    view,
                    secs_per_pixel,
                    width,
                    model.track_height(),
                )
                .into_any_element()
            } else {
                render_clip_markings_before(
                    TrackKind::Clip.color(),
                    black_box(segment),
                    holds,
                    view,
                    secs_per_pixel,
                    width,
                    model.track_height(),
                )
                .into_any_element()
            };
            drop(black_box(element));
        }
    }
    started.elapsed().as_secs_f64() * 1_000_000.0 / 20.0
}

#[test]
#[ignore = "benchmarks GPUI element construction/drop from synthetic TimelineModel fixtures"]
fn clip_marking_construction() {
    for (name, count, duration) in [
        ("one_cut", 1, 9.0),
        ("ten_cuts", 10, 9.0),
        ("thirty_cuts", 30, 9.0),
        ("three_hundred_cuts", 300, 9.0),
        ("uncut_2700_seconds", 1, 2700.0),
    ] {
        let model = fixture(count, duration);
        let view = TimelineView {
            transform: Transform {
                zoom: model.total_duration,
                position: 0.0,
            },
            ..TimelineView::default()
        };
        for _ in 0..5 {
            black_box(measure(&model, view, false));
            black_box(measure(&model, view, true));
        }
        let mut before = Vec::new();
        let mut after = Vec::new();
        for sample in 0..24 {
            let order = if sample % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            };
            for culled in order {
                let elapsed = measure(&model, view, culled);
                if culled {
                    after.push(elapsed);
                } else {
                    before.push(elapsed);
                }
                println!("raw,{name},{sample},{culled},{elapsed:.3}");
            }
        }
        before.sort_by(f64::total_cmp);
        after.sort_by(f64::total_cmp);
        println!(
            "construction_drop_us,{name},baseline_p50={:.3},candidate_p50={:.3},baseline_p95={:.3},candidate_p95={:.3}",
            before[12], after[12], before[22], after[22]
        );
    }
}

fn render_clip_markings_before(
    color: Hsla,
    segment: &Segment,
    holds: &[(f64, f64)],
    view: TimelineView,
    secs_per_pixel: f64,
    width: f32,
    height: f32,
) -> impl IntoElement {
    let SegmentDetail::Clip { source_start, .. } = segment.detail else {
        return div();
    };
    let resolution = marking_resolution(view.transform.zoom);
    // `visibleMin = transform.position - props.prevDuration + props.segment.start`
    // (`TL/ClipTrack.tsx:1437-1439`): `prevDuration` is the box's output start
    // and `segment.start` its recording-domain start, so the grid is walked in
    // recording time and mapped back through the holds below.
    let visible_min = view.transform.position - segment.start + source_start;
    let visible_max = visible_min + view.transform.zoom;
    let first = (visible_min / resolution).floor();
    let count = ((visible_max / resolution).ceil() - first).max(0.) as usize;

    let via = with_alpha(color, 0.14);
    let transparent = with_alpha(color, 0.);

    let mut root = div();
    let holds_relative: Vec<(f64, f64)> = holds
        .iter()
        .map(|(start, end)| (start - segment.start, end - segment.start))
        .collect();

    for index in 0..count.min(512) {
        let marking = (first + index as f64) * resolution;
        let effective = marking - source_start;
        if effective < 0. {
            continue;
        }
        let x = (effective_to_output(&holds_relative, effective) / secs_per_pixel) as f32;
        let radius = SEGMENT_RADIUS.min(width / 2.).min(height / 2.);
        let inset = rounded_corner_inset(f64::from(x), f64::from(width), f64::from(radius)).max(
            rounded_corner_inset(f64::from(x + 1.), f64::from(width), f64::from(radius)),
        ) as f32;
        let marking_height = (height - 2. * inset).max(0.);
        root = root.child(
            div()
                .absolute()
                .top(px(inset))
                .left(px(x))
                .w(px(1.))
                .h(px(marking_height))
                .flex()
                .flex_col()
                .child(
                    div()
                        .w_full()
                        .h(px(marking_height / 2.))
                        .bg(gpui::linear_gradient(
                            180.,
                            gpui::linear_color_stop(transparent, 0.),
                            gpui::linear_color_stop(via, 1.),
                        )),
                )
                .child(
                    div()
                        .w_full()
                        .h(px(marking_height / 2.))
                        .bg(gpui::linear_gradient(
                            180.,
                            gpui::linear_color_stop(via, 0.),
                            gpui::linear_color_stop(transparent, 1.),
                        )),
                ),
        );
    }
    root
}
