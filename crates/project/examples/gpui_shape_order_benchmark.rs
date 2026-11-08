use cap_project::{
    OverlayTrack, OverlayTrackKind, ProjectConfiguration, ShapeSegment, TimelineConfiguration,
};
use std::{hint::black_box, time::Instant};

fn previous_overlay_tracks(project: &ProjectConfiguration) -> Vec<OverlayTrack> {
    let Some(timeline) = &project.timeline else {
        return Vec::new();
    };
    let mut available = Vec::new();
    for (kind, mut tracks) in [
        (
            OverlayTrackKind::Text,
            timeline
                .text_segments
                .iter()
                .map(|segment| segment.track)
                .collect::<Vec<_>>(),
        ),
        (
            OverlayTrackKind::Shape,
            timeline
                .shape_segments
                .iter()
                .map(|segment| segment.track)
                .collect::<Vec<_>>(),
        ),
        (
            OverlayTrackKind::Image,
            timeline
                .image_segments
                .iter()
                .map(|segment| segment.track)
                .collect::<Vec<_>>(),
        ),
        (
            OverlayTrackKind::Mask,
            timeline
                .mask_segments
                .iter()
                .map(|segment| segment.track)
                .collect::<Vec<_>>(),
        ),
    ] {
        tracks.sort_unstable();
        tracks.dedup();
        available.extend(
            tracks
                .into_iter()
                .rev()
                .map(|track| OverlayTrack { kind, track }),
        );
    }
    let saved = project.overlay_order();
    let mut ordered = Vec::with_capacity(available.len());
    for track in &available {
        if !saved.contains(track) && !ordered.contains(track) {
            ordered.push(*track);
        }
    }
    for track in saved {
        if available.contains(track) && !ordered.contains(track) {
            ordered.push(*track);
        }
    }
    ordered
}

fn previous_visible_shape_order(project: &ProjectConfiguration, time: f64) -> Vec<usize> {
    let Some(timeline) = &project.timeline else {
        return Vec::new();
    };
    let mut order = Vec::new();
    for track in previous_overlay_tracks(project)
        .into_iter()
        .rev()
        .filter(|track| track.kind == OverlayTrackKind::Shape)
    {
        order.extend(
            timeline
                .shape_segments
                .iter()
                .enumerate()
                .filter(|(_, segment)| {
                    segment.track == track.track && segment.is_active_at(time)
                })
                .map(|(index, _)| index),
        );
    }
    order
}

fn project_with_shapes(tracks: usize, shapes_per_track: usize) -> ProjectConfiguration {
    let mut timeline: TimelineConfiguration = serde_json::from_value(serde_json::json!({
        "segments": [],
        "zoomSegments": []
    }))
    .unwrap();
    timeline.shape_segments = (0..tracks * shapes_per_track)
        .map(|index| {
            let mut segment = ShapeSegment::default();
            segment.track = ((index * 137) % tracks) as u32;
            segment.start = 0.;
            segment.end = 60.;
            segment.enabled = index % 7 != 0;
            segment
        })
        .collect();
    let mut project = ProjectConfiguration {
        timeline: Some(timeline),
        ..Default::default()
    };
    let mut saved: Vec<_> = (0..tracks)
        .map(|index| OverlayTrack {
            kind: OverlayTrackKind::Shape,
            track: index as u32,
        })
        .collect();
    saved.rotate_left(tracks / 4);
    project.set_overlay_order(saved);
    project
}

fn measure(iterations: usize, mut run: impl FnMut()) -> f64 {
    let start = Instant::now();
    for _ in 0..iterations {
        run();
    }
    start.elapsed().as_secs_f64() * 1_000_000. / iterations as f64
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn main() {
    for (tracks, shapes_per_track, iterations) in [
        (1, 1_024, 500),
        (16, 32, 200),
        (64, 32, 40),
        (128, 32, 15),
        (256, 16, 10),
    ] {
        let project = project_with_shapes(tracks, shapes_per_track);
        let time = 2.;
        assert_eq!(
            previous_visible_shape_order(&project, time),
            project.visible_shape_order(time)
        );
        for _ in 0..8 {
            black_box(previous_visible_shape_order(black_box(&project), black_box(time)));
            black_box(project.visible_shape_order(black_box(time)));
        }

        let mut before = Vec::new();
        let mut after = Vec::new();
        for run in 0..9 {
            if run % 2 == 0 {
                before.push(measure(iterations, || {
                    black_box(previous_visible_shape_order(black_box(&project), black_box(time)));
                }));
                after.push(measure(iterations, || {
                    black_box(project.visible_shape_order(black_box(time)));
                }));
            } else {
                after.push(measure(iterations, || {
                    black_box(project.visible_shape_order(black_box(time)));
                }));
                before.push(measure(iterations, || {
                    black_box(previous_visible_shape_order(black_box(&project), black_box(time)));
                }));
            }
        }
        let before = median(before);
        let after = median(after);
        println!(
            "{{\"tracks\":{tracks},\"shapes\":{},\"baseline_p50_us\":{before:.2},\"optimized_p50_us\":{after:.2},\"speedup\":{:.2}}}",
            tracks * shapes_per_track,
            before / after
        );
    }
}
