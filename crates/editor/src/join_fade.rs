use cap_project::TimelineConfiguration;

/// Length of the fade on each side of a hard cut, in 48 kHz samples (5 ms).
/// Long enough that the jump between two unrelated waveforms cannot click,
/// short enough that it never audibly dips speech.
pub(crate) const JOIN_FADE_SAMPLES: usize = 240;

/// Output sample positions where playback jumps from one clip to another that
/// does not continue it in the source: a cut. Transitions already crossfade,
/// and contiguous halves of a split (even at a speed change) play through, so
/// neither is listed.
pub(crate) fn hard_cut_joins(timeline: &TimelineConfiguration, sample_rate: u32) -> Vec<usize> {
    if timeline.segments.len() < 2 {
        return Vec::new();
    }
    let holds = timeline.hold_windows();
    let mut joins = Vec::new();
    let mut effective = 0.0;
    for (index, segment) in timeline.segments.iter().enumerate() {
        let transition = timeline
            .effective_transition(index)
            .map(|transition| transition.duration);
        effective -= transition.unwrap_or(0.0);
        if index > 0 && transition.is_none() {
            let previous = &timeline.segments[index - 1];
            let continues = previous.recording_clip == segment.recording_clip
                && (previous.end - segment.start).abs() < 1e-6;
            if !continues {
                let mut output = effective;
                for (start, end) in &holds {
                    if output >= *start {
                        output += end - start;
                    } else {
                        break;
                    }
                }
                joins.push((output * f64::from(sample_rate)).round() as usize);
            }
        }
        effective += segment.duration();
    }
    joins.sort_unstable();
    joins
}

fn fade_gain(distance: usize) -> f32 {
    let t = (distance as f32 - 0.5) / JOIN_FADE_SAMPLES as f32;
    0.5 - 0.5 * (std::f32::consts::PI * t).cos()
}

pub(crate) fn apply_join_fades(samples: &mut [f32], start: usize, joins: &[usize]) {
    let frames = samples.len() / 2;
    let end = start + frames;
    let first = joins.partition_point(|join| join + JOIN_FADE_SAMPLES <= start);
    for &join in &joins[first..] {
        if join >= end + JOIN_FADE_SAMPLES {
            break;
        }
        let from = join.saturating_sub(JOIN_FADE_SAMPLES).max(start);
        let to = (join + JOIN_FADE_SAMPLES).min(end);
        for position in from..to {
            let distance = if position < join {
                join - position
            } else {
                position - join + 1
            };
            let gain = fade_gain(distance);
            let index = (position - start) * 2;
            samples[index] *= gain;
            samples[index + 1] *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{ClipTransition, ClipTransitionType, TimelineSegment};

    fn segment(recording_clip: u32, start: f64, end: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip,
            timescale: 1.0,
            start,
            end,
            name: None,
            speed_audio_mode: None,
            volume: None,
            hide_cursor: None,
            voice_eq: None,
        }
    }

    fn timeline(segments: Vec<TimelineSegment>) -> TimelineConfiguration {
        serde_json::from_value::<TimelineConfiguration>(serde_json::json!({
            "segments": [],
            "zoomSegments": [],
        }))
        .map(|mut timeline| {
            timeline.segments = segments;
            timeline
        })
        .unwrap()
    }

    #[test]
    fn only_discontinuous_boundaries_are_joins() {
        let timeline = timeline(vec![
            segment(0, 0.0, 1.0),
            segment(0, 1.0, 2.0),
            segment(0, 2.5, 3.0),
            segment(1, 0.0, 1.0),
        ]);
        assert_eq!(hard_cut_joins(&timeline, 48_000), [96_000, 120_000]);
    }

    #[test]
    fn transitions_are_not_joins() {
        let mut timeline = timeline(vec![segment(0, 0.0, 2.0), segment(0, 3.0, 5.0)]);
        timeline.transitions.push(ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 0.5,
        });
        assert!(hard_cut_joins(&timeline, 48_000).is_empty());
    }

    #[test]
    fn fades_reach_silence_at_the_join_and_are_chunking_independent() {
        let joins = [1_000usize];
        let mut whole = vec![1.0f32; 4_000];
        apply_join_fades(&mut whole, 0, &joins);
        let mut pieces = vec![1.0f32; 4_000];
        for (index, chunk) in pieces.chunks_mut(2 * 137).enumerate() {
            apply_join_fades(chunk, index * 137, &joins);
        }
        assert_eq!(whole, pieces);
        assert!(whole[999 * 2] < 0.001 && whole[1_000 * 2] < 0.001);
        assert!((whole[(1_000 - JOIN_FADE_SAMPLES) * 2] - 1.0).abs() < 0.001);
        assert_eq!(whole[(1_000 - JOIN_FADE_SAMPLES - 1) * 2], 1.0);
        assert_eq!(whole[(1_000 + JOIN_FADE_SAMPLES) * 2], 1.0);
        let steps = whole
            .chunks(2)
            .map(|frame| frame[0])
            .collect::<Vec<_>>()
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(steps < 0.01, "{steps}");
    }

    #[test]
    fn joins_at_the_buffer_edges_do_not_panic() {
        let mut samples = vec![1.0f32; 20];
        apply_join_fades(&mut samples, 0, &[0, 3, 10, 9_999]);
        apply_join_fades(&mut samples, 1_000_000, &[0, 3]);
        apply_join_fades(&mut [], 5, &[5]);
        assert!(samples[0] < 0.01);
    }
}
