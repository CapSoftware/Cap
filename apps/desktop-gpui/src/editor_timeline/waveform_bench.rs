use super::*;

const SAMPLES: [(f64, f64); 4] = [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)];

fn peaks(len: usize, period: f32) -> Arc<Vec<f32>> {
    Arc::new(
        (0..len)
            .map(|i| -40. + 30. * (i as f32 / period).sin().abs())
            .collect(),
    )
}

fn original_waveform(geometry: &WaveformGeometry) -> Option<gpui::Path<Pixels>> {
    tessellate_waveform(geometry, gpui::FillOptions::default())
}

#[test]
fn horizontal_sweep_preserves_waveform_within_tessellation_tolerance() {
    let tolerance = f64::from(gpui::FillOptions::default().tolerance);
    let peaks = Arc::new((0..15001).map(|i| -50. + 2. * (i % 25) as f32).collect());
    for duration in [1500., 300., 30., 3.] {
        for (timescale, scale, holds) in [
            (1., 1., Vec::new()),
            (0.5, 0.6, vec![(1., 2.), (20., 21.)]),
            (2., 1.5, vec![(1., 2.), (20., 21.)]),
        ] {
            let geometry = WaveformGeometry {
                peaks: Arc::clone(&peaks),
                range: (0., duration),
                target_samples: 2400,
                holds,
                source_start: 0.,
                timescale,
                origin: gpui::point(px(0.), px(0.)),
                size: gpui::size(px(1200.), px(18.)),
                scale,
                clip_bounds: gpui::Bounds {
                    origin: gpui::point(px(0.), px(-26.)),
                    size: gpui::size(px(1200.), px(44.)),
                },
            };
            let original = original_waveform(&geometry).unwrap();
            let horizontal = waveform_path(&geometry).unwrap();
            let before = coverage(&original, 1200, 18);
            let after = coverage(&horizontal, 1200, 18);
            for (i, (before, after)) in before.iter().zip(after).enumerate() {
                for (sample, (dx, dy)) in SAMPLES.into_iter().enumerate() {
                    if (before ^ after) & (1 << sample) == 0 {
                        continue;
                    }
                    let point = ((i % 1200) as f64 + dx, (i / 1200) as f64 + dy);
                    assert!(
                        distance_to_edge(&original, point) <= tolerance
                            && distance_to_edge(&horizontal, point) <= tolerance,
                        "duration={duration} timescale={timescale} scale={scale} point={point:?} before={} after={}",
                        distance_to_edge(&original, point),
                        distance_to_edge(&horizontal, point)
                    );
                }
            }
        }
    }
}

#[test]
#[ignore]
fn waveform_zoom_benchmark() {
    use std::{hint::black_box, time::Instant};

    let duration = 1500.0;
    let peaks = [peaks(15001, 7.), peaks(15001, 11.)];
    for clips in [1, 50] {
        for (label, build) in [
            ("vertical", original_waveform as fn(&WaveformGeometry) -> _),
            ("horizontal", waveform_path),
        ] {
            let mut runs = Vec::new();
            for _ in 0..7 {
                let started = Instant::now();
                for frame in 0..120 {
                    let progress = frame as f64 / 119.;
                    let zoom = duration * (3.0_f64 / duration).powf(progress);
                    let position = (duration - zoom) * 0.5;
                    let clip_duration = duration / clips as f64;
                    for index in 0..clips {
                        let full_width = clip_duration / zoom * 1200.;
                        let Some(layout) = waveform_layout(
                            (position, zoom),
                            (index as f64 * clip_duration, clip_duration),
                            full_width,
                            (px(18.), px(full_width as f32), px(44.), px(18.)),
                        ) else {
                            continue;
                        };
                        for peaks in &peaks {
                            let geometry = WaveformGeometry {
                                peaks: peaks.clone(),
                                range: layout.range,
                                target_samples: layout.samples,
                                holds: Vec::new(),
                                source_start: index as f64 * clip_duration,
                                timescale: 1.,
                                origin: layout.origin,
                                size: layout.size,
                                scale: 1.,
                                clip_bounds: layout.clip_bounds,
                            };
                            black_box(build(&geometry).unwrap());
                        }
                    }
                }
                runs.push(started.elapsed().as_secs_f64() * 1000. / 120.);
            }
            runs.sort_by(f64::total_cmp);
            eprintln!(
                "duration={duration}s width=1200 clips={clips} tracks=2 {label} median_ms={:.6} runs={runs:?}",
                runs[3]
            );
        }
    }
}

fn coverage(path: &gpui::Path<Pixels>, width: usize, height: usize) -> Vec<u8> {
    let mut pixels = vec![0; width * height];
    for triangle in path.vertices.as_chunks::<3>().0 {
        let points = triangle.each_ref().map(|v| {
            (
                f32::from(v.xy_position.x) as f64,
                f32::from(v.xy_position.y) as f64,
            )
        });
        let area = edge(points[0], points[1], points[2]);
        if area.abs() < 1e-10 {
            continue;
        }
        let min_x = points
            .iter()
            .map(|p| p.0)
            .fold(f64::INFINITY, f64::min)
            .floor()
            .max(0.) as usize;
        let min_y = points
            .iter()
            .map(|p| p.1)
            .fold(f64::INFINITY, f64::min)
            .floor()
            .max(0.) as usize;
        let max_x = points
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .max(0.)
            .min(width as f64) as usize;
        let max_y = points
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .max(0.)
            .min(height as f64) as usize;
        for y in min_y..max_y {
            for x in min_x..max_x {
                for (sample, (dx, dy)) in SAMPLES.into_iter().enumerate() {
                    let point = (x as f64 + dx, y as f64 + dy);
                    let edges = [
                        edge(points[0], points[1], point),
                        edge(points[1], points[2], point),
                        edge(points[2], points[0], point),
                    ];
                    if edges.iter().all(|e| *e >= 0.) || edges.iter().all(|e| *e <= 0.) {
                        pixels[y * width + x] |= 1 << sample;
                    }
                }
            }
        }
    }
    pixels
}
fn edge(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

fn distance_to_edge(path: &gpui::Path<Pixels>, point: (f64, f64)) -> f64 {
    let mut edges = std::collections::HashMap::new();
    for triangle in path.vertices.as_chunks::<3>().0 {
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let [a, b] = [a, b].map(|i| {
                let p = triangle[i].xy_position;
                (f32::from(p.x).to_bits(), f32::from(p.y).to_bits())
            });
            *edges
                .entry(if a <= b { (a, b) } else { (b, a) })
                .or_insert(0) += 1;
        }
    }
    edges
        .into_iter()
        .filter(|(_, count)| *count == 1)
        .map(|(edge, _)| {
            let [a, b] = [edge.0, edge.1]
                .map(|(x, y)| (f64::from(f32::from_bits(x)), f64::from(f32::from_bits(y))));
            let delta = (b.0 - a.0, b.1 - a.1);
            let length_squared = delta.0 * delta.0 + delta.1 * delta.1;
            let t = if length_squared > 0. {
                (((point.0 - a.0) * delta.0 + (point.1 - a.1) * delta.1) / length_squared)
                    .clamp(0., 1.)
            } else {
                0.
            };
            (point.0 - a.0 - t * delta.0).hypot(point.1 - a.1 - t * delta.1)
        })
        .fold(f64::INFINITY, f64::min)
}
