use cap_project::{
    MaskKeyframes, MaskKind, MaskSegment, MaskVectorKeyframe, XY, mask_effect_contract,
};

use crate::frame::Rect;
use crate::scan::{SensitiveTrack, TrackSample};

const KEYFRAME_TOLERANCE: f64 = 0.0015;
const COVERED_FRACTION: f32 = 0.9;

fn interpolate(keys: &[MaskVectorKeyframe], base: XY<f64>, time: f64) -> XY<f64> {
    let Some(first) = keys.first() else {
        return base;
    };
    if time <= first.time {
        return XY::new(first.x, first.y);
    }
    for pair in keys.windows(2) {
        if time <= pair[1].time {
            let span = (pair[1].time - pair[0].time).max(1e-6);
            let t = ((time - pair[0].time) / span).clamp(0.0, 1.0);
            return XY::new(
                pair[0].x + (pair[1].x - pair[0].x) * t,
                pair[0].y + (pair[1].y - pair[0].y) * t,
            );
        }
    }
    keys.last().map_or(base, |last| XY::new(last.x, last.y))
}

pub fn mask_rect_at(segment: &MaskSegment, time: f64) -> Option<Rect> {
    if !segment.enabled || time < segment.start || time > segment.end {
        return None;
    }
    let relative = (time - segment.start).max(0.0);
    let center = interpolate(&segment.keyframes.position, segment.center, relative);
    let size = interpolate(&segment.keyframes.size, segment.size, relative);
    Some(Rect::new(
        (center.x - size.x / 2.0) as f32,
        (center.y - size.y / 2.0) as f32,
        (center.x + size.x / 2.0) as f32,
        (center.y + size.y / 2.0) as f32,
    ))
}

fn covered_by(existing: &[MaskSegment], sample: &TrackSample) -> bool {
    let area = sample.rect.area();
    area <= 0.0
        || existing
            .iter()
            .filter(|segment| matches!(segment.mask_type, MaskKind::Sensitive))
            .filter_map(|segment| mask_rect_at(segment, sample.time))
            .any(|rect| rect.intersection(&sample.rect).area() >= area * COVERED_FRACTION)
}

fn deviation(a: &TrackSample, b: &TrackSample, mid: &TrackSample) -> f64 {
    let span = (b.time - a.time).max(1e-9);
    let t = ((mid.time - a.time) / span) as f32;
    let lerp = |x: f32, y: f32| x + (y - x) * t;
    [
        (lerp(a.rect.x0, b.rect.x0), mid.rect.x0),
        (lerp(a.rect.y0, b.rect.y0), mid.rect.y0),
        (lerp(a.rect.x1, b.rect.x1), mid.rect.x1),
        (lerp(a.rect.y1, b.rect.y1), mid.rect.y1),
    ]
    .into_iter()
    .map(|(expected, actual)| f64::from((expected - actual).abs()))
    .fold(0.0, f64::max)
}

fn simplify(samples: &[TrackSample]) -> Vec<TrackSample> {
    if samples.len() <= 2 {
        return samples.to_vec();
    }
    let mut keep = vec![false; samples.len()];
    keep[0] = true;
    keep[samples.len() - 1] = true;
    let mut stack = vec![(0, samples.len() - 1)];
    while let Some((from, to)) = stack.pop() {
        let worst = (from + 1..to)
            .map(|index| {
                (
                    index,
                    deviation(&samples[from], &samples[to], &samples[index]),
                )
            })
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((index, error)) = worst
            && error > KEYFRAME_TOLERANCE
        {
            keep[index] = true;
            stack.push((from, index));
            stack.push((index, to));
        }
    }
    samples
        .iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(sample, _)| sample.clone())
        .collect()
}

fn sensitive_segment(track: &SensitiveTrack, lane: u32) -> Option<MaskSegment> {
    let samples = simplify(&track.samples);
    let first = samples.first()?;
    let center = |rect: &Rect| {
        let (x, y) = rect.center();
        XY::new(f64::from(x), f64::from(y))
    };
    let size = |rect: &Rect| XY::new(f64::from(rect.width()), f64::from(rect.height()));
    let keyed = samples.len() > 1;
    let contract = mask_effect_contract();
    Some(MaskSegment {
        start: track.start,
        end: track.end,
        track: lane,
        enabled: true,
        mask_type: MaskKind::Sensitive,
        center: center(&first.rect),
        size: size(&first.rect),
        feather: 0.0,
        opacity: 1.0,
        pixelation: contract.blur_encoding_offset + contract.default_amount,
        darkness: 0.0,
        fade_duration: 0.0,
        keyframes: MaskKeyframes {
            position: if keyed {
                samples
                    .iter()
                    .map(|sample| {
                        let c = center(&sample.rect);
                        MaskVectorKeyframe {
                            time: sample.time - track.start,
                            x: c.x,
                            y: c.y,
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            },
            size: if keyed {
                samples
                    .iter()
                    .map(|sample| {
                        let s = size(&sample.rect);
                        MaskVectorKeyframe {
                            time: sample.time - track.start,
                            x: s.x,
                            y: s.y,
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            },
            intensity: Vec::new(),
        },
    })
}

pub fn mask_segments(tracks: &[SensitiveTrack], existing: &[MaskSegment]) -> Vec<MaskSegment> {
    let first_lane = existing
        .iter()
        .map(|segment| segment.track + 1)
        .max()
        .unwrap_or(0);
    let mut lane_ends: Vec<f64> = Vec::new();
    let mut segments = Vec::new();
    let mut ordered: Vec<&SensitiveTrack> = tracks
        .iter()
        .filter(|track| track.end > track.start)
        .filter(|track| {
            !track
                .samples
                .iter()
                .all(|sample| covered_by(existing, sample))
        })
        .collect();
    ordered.sort_by(|a, b| a.start.total_cmp(&b.start));
    for track in ordered {
        let lane = match lane_ends.iter().position(|end| *end <= track.start) {
            Some(lane) => {
                lane_ends[lane] = track.end;
                lane
            }
            None => {
                lane_ends.push(track.end);
                lane_ends.len() - 1
            }
        };
        segments.extend(sensitive_segment(track, first_lane + lane as u32));
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SensitiveKind;

    fn track(start: f64, end: f64, samples: Vec<(f64, Rect)>) -> SensitiveTrack {
        SensitiveTrack {
            kind: SensitiveKind::Email,
            text: "a@b.co".into(),
            start,
            end,
            samples: samples
                .into_iter()
                .map(|(time, rect)| TrackSample { time, rect })
                .collect(),
        }
    }

    #[test]
    fn a_track_becomes_one_keyframed_sensitive_mask_that_follows_it() {
        let samples: Vec<(f64, Rect)> = (0..=20)
            .map(|index| {
                let t = 1.0 + index as f64 * 0.1;
                let y = 0.8 - index as f32 * 0.02;
                (t, Rect::new(0.2, y, 0.5, y + 0.03))
            })
            .collect();
        let segments = mask_segments(&[track(0.95, 3.05, samples.clone())], &[]);
        assert_eq!(segments.len(), 1);
        let mask = &segments[0];
        assert!(matches!(mask.mask_type, MaskKind::Sensitive));
        assert_eq!((mask.start, mask.end, mask.track), (0.95, 3.05, 0));
        assert!(
            mask.keyframes.position.len() <= 3,
            "a straight scroll needs only its end keyframes: {}",
            mask.keyframes.position.len()
        );
        for (time, rect) in samples {
            let drawn = mask_rect_at(mask, time).unwrap();
            assert!(
                drawn.intersection(&rect).area() >= rect.area() * 0.99,
                "{time}"
            );
        }
    }

    #[test]
    fn overlapping_tracks_take_separate_lanes_after_existing_masks() {
        let rect = Rect::new(0.1, 0.1, 0.2, 0.12);
        let existing = vec![MaskSegment {
            track: 1,
            ..sensitive_segment(&track(20.0, 21.0, vec![(20.0, rect)]), 0).unwrap()
        }];
        let segments = mask_segments(
            &[
                track(0.0, 2.0, vec![(0.0, rect)]),
                track(1.0, 3.0, vec![(1.0, rect)]),
                track(2.5, 4.0, vec![(2.5, rect)]),
            ],
            &existing,
        );
        let lanes: Vec<u32> = segments.iter().map(|segment| segment.track).collect();
        assert_eq!(lanes, vec![2, 3, 2]);
    }

    #[test]
    fn content_already_under_a_sensitive_mask_is_not_masked_again() {
        let rect = Rect::new(0.3, 0.3, 0.4, 0.33);
        let existing = mask_segments(
            &[track(0.0, 5.0, vec![(0.0, rect.expanded(0.01, 0.01))])],
            &[],
        );
        let again = mask_segments(
            &[track(1.0, 2.0, vec![(1.0, rect), (2.0, rect)])],
            &existing,
        );
        assert!(again.is_empty());
        let elsewhere = Rect::new(0.6, 0.6, 0.7, 0.63);
        assert_eq!(
            mask_segments(&[track(1.0, 2.0, vec![(1.0, elsewhere)])], &existing).len(),
            1
        );
    }
}
