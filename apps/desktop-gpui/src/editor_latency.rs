//! Timestamps every preview frame through the editor's pipeline, from the
//! frame demand to the canvas paint that hands it to the compositor. Only
//! `CAP_GPUI_AUTO_LATENCY_BENCH=1` turns it on, and that bench drains the marks
//! after every scenario. Off, each mark is one `OnceLock` read.
//!
//! Stages, in pipeline order:
//! * `Input` -- the harness's synthetic pointer or edit, just before it runs.
//! * `Demand` -- `request_frame` pushed a paused preview frame number.
//! * `Rendered` -- the engine's frame callback (decode + composite + GPU).
//! * `Arrived` -- the window adopted the frame and invalidated the preview.
//! * `Painted` -- the preview canvas painted it inside a gpui frame; the
//!   compositor shows it at the next display refresh.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    Input,
    Demand,
    Rendered,
    Arrived,
    Painted,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Mark {
    pub stage: Stage,
    pub frame: u32,
    pub sequence: u64,
    pub at: Instant,
}

struct Probe {
    marks: Mutex<Vec<Mark>>,
    sizes: Mutex<Vec<(u64, [u32; 2])>>,
}

fn probe() -> Option<&'static Probe> {
    static PROBE: OnceLock<Option<Probe>> = OnceLock::new();
    PROBE
        .get_or_init(|| {
            std::env::var("CAP_GPUI_AUTO_LATENCY_BENCH")
                .is_ok_and(|value| value == "1")
                .then(|| Probe {
                    marks: Mutex::new(Vec::with_capacity(1 << 16)),
                    sizes: Mutex::new(Vec::with_capacity(1 << 16)),
                })
        })
        .as_ref()
}

pub(crate) fn enabled() -> bool {
    probe().is_some()
}

/// `CAP_GPUI_AUTO_LATENCY_BACKING_SCALE`: multiplies the window's scale
/// factor wherever the preview sizes itself to the screen, so a 1x CI display
/// can stand in for a Retina one. 1.0 unless the bench sets it.
pub(crate) fn backing_scale() -> f32 {
    static SCALE: OnceLock<f32> = OnceLock::new();
    *SCALE.get_or_init(|| {
        probe()
            .and_then(|_| std::env::var("CAP_GPUI_AUTO_LATENCY_BACKING_SCALE").ok())
            .and_then(|value| value.parse::<f32>().ok())
            .filter(|scale| scale.is_finite() && *scale > 0.0)
            .unwrap_or(1.0)
    })
}

pub(crate) fn mark(stage: Stage, frame: u32, sequence: u64) {
    let Some(probe) = probe() else {
        return;
    };
    let at = Instant::now();
    probe
        .marks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(Mark {
            stage,
            frame,
            sequence,
            at,
        });
}

/// The output size of the frame adopted under `sequence`, so a scenario can
/// tell which presentation was drawn at which resolution.
pub(crate) fn sized(sequence: u64, size: [u32; 2]) {
    let Some(probe) = probe() else {
        return;
    };
    probe
        .sizes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push((sequence, size));
}

pub(crate) fn take_sizes() -> Vec<(u64, [u32; 2])> {
    probe().map_or_else(Vec::new, |probe| {
        std::mem::take(
            &mut *probe
                .sizes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    })
}

pub(crate) fn take() -> Vec<Mark> {
    probe().map_or_else(Vec::new, |probe| {
        std::mem::take(
            &mut *probe
                .marks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    })
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Presentation {
    pub frame: u32,
    pub rendered: Option<Instant>,
    pub arrived: Instant,
    pub painted: Instant,
}

/// Frames in paint order, each with the render and adoption it came from.
/// Arrivals that a newer frame replaced before any paint are counted in
/// `replaced`.
pub(crate) fn presentations(marks: &[Mark]) -> (Vec<Presentation>, usize) {
    let mut rendered = std::collections::HashMap::<u32, Instant>::new();
    let mut arrived = std::collections::HashMap::<u64, (u32, Option<Instant>, Instant)>::new();
    let mut painted = std::collections::HashSet::<u64>::new();
    let mut out = Vec::new();
    for mark in marks {
        match mark.stage {
            Stage::Rendered => {
                rendered.insert(mark.frame, mark.at);
            }
            Stage::Arrived => {
                arrived.insert(
                    mark.sequence,
                    (mark.frame, rendered.get(&mark.frame).copied(), mark.at),
                );
            }
            Stage::Painted => {
                if painted.insert(mark.sequence)
                    && let Some(&(frame, rendered, arrived)) = arrived.get(&mark.sequence)
                {
                    out.push(Presentation {
                        frame,
                        rendered,
                        arrived,
                        painted: mark.at,
                    });
                }
            }
            Stage::Input | Stage::Demand => {}
        }
    }
    let replaced = arrived
        .keys()
        .filter(|sequence| !painted.contains(sequence))
        .count();
    (out, replaced)
}

/// What one input produced: the frame it asked for and, when that frame
/// reached the screen before anything newer did, the presentation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct InputOutcome {
    pub target: Option<u32>,
    pub shown: Option<Presentation>,
    /// A newer input with a different target landed before this one's frame
    /// was painted.
    pub superseded: bool,
    pub at: Instant,
}

/// Pairs each `Input` with the last `Demand` before the next input (a trim
/// drag publishes the edit, then moves the preview time), and that demand with
/// the first presentation of the same frame from a render that includes the
/// input. A presentation painted after the screen already showed a newer
/// input's frame does not count: a drag that swings back to the same frame a
/// second later is a new request, not a late answer to the old one.
pub(crate) fn input_outcomes(marks: &[Mark], shown: &[Presentation]) -> Vec<InputOutcome> {
    let mut outcomes: Vec<InputOutcome> = Vec::new();
    let mut in_flight = Vec::new();
    let mut pending: Option<u32> = None;
    for mark in marks {
        match mark.stage {
            Stage::Input => {
                in_flight.push(pending);
                outcomes.push(InputOutcome {
                    target: None,
                    shown: None,
                    superseded: false,
                    at: mark.at,
                });
            }
            Stage::Demand => {
                pending = Some(mark.frame);
                if let Some(outcome) = outcomes.last_mut() {
                    outcome.target = Some(mark.frame);
                }
            }
            Stage::Rendered => {
                if pending == Some(mark.frame) {
                    pending = None;
                }
            }
            Stage::Arrived | Stage::Painted => {}
        }
    }
    // Paused preview renders run one at a time, each from the newest request,
    // and `Rendered` marks their end, not their start. A request whose frame
    // has not been rendered since is still owed a render that may have begun
    // before the input and carry the old project; when the next render to
    // finish is that frame, only a render finishing after it includes the
    // input. Any other render started after the input.
    let fresh_after: Vec<(Instant, bool)> = outcomes
        .iter()
        .zip(&in_flight)
        .map(|(outcome, in_flight)| {
            let next = marks
                .iter()
                .find(|mark| mark.stage == Stage::Rendered && mark.at > outcome.at);
            match (in_flight, next) {
                (Some(frame), Some(next)) if next.frame == *frame => (next.at, true),
                _ => (outcome.at, false),
            }
        })
        .collect();
    let includes = |index: usize, presentation: &Presentation| {
        let (from, strict) = fresh_after[index];
        let Some(rendered) = presentation.rendered else {
            return false;
        };
        if strict {
            rendered > from
        } else {
            rendered >= from
        }
    };
    for index in 0..outcomes.len() {
        let Some(target) = outcomes[index].target else {
            continue;
        };
        let at = outcomes[index].at;
        let answers_newer = |presentation: &Presentation| {
            presentation.frame != target
                && (index + 1..outcomes.len()).any(|newer| {
                    outcomes[newer].target == Some(presentation.frame)
                        && includes(newer, presentation)
                })
        };
        let mut presentation = None;
        for candidate in shown.iter().filter(|candidate| candidate.painted > at) {
            if answers_newer(candidate) {
                break;
            }
            if candidate.frame == target && includes(index, candidate) {
                presentation = Some(*candidate);
                break;
            }
        }
        let deadline = presentation.map(|presentation| presentation.painted);
        let superseded = outcomes[index + 1..].iter().any(|newer| {
            newer.target.is_some_and(|frame| frame != target)
                && deadline.is_none_or(|deadline| newer.at < deadline)
        });
        outcomes[index].shown = presentation;
        outcomes[index].superseded = superseded;
    }
    outcomes
}

pub(crate) fn millis(from: Instant, to: Instant) -> f64 {
    to.saturating_duration_since(from).as_secs_f64() * 1000.0
}

pub(crate) fn percentiles(samples: &mut [f64]) -> Option<[f64; 4]> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f64::total_cmp);
    let at = |share: f64| samples[((samples.len() as f64 - 1.0) * share).round() as usize];
    Some([at(0.5), at(0.95), at(0.99), samples[samples.len() - 1]])
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    fn mark(stage: Stage, frame: u32, sequence: u64, at: Instant) -> Mark {
        Mark {
            stage,
            frame,
            sequence,
            at,
        }
    }

    #[test]
    fn a_frame_replaced_before_paint_is_not_a_presentation() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Rendered, 10, 0, at(base, 1)),
            mark(Stage::Arrived, 10, 1, at(base, 2)),
            mark(Stage::Rendered, 11, 0, at(base, 3)),
            mark(Stage::Arrived, 11, 2, at(base, 4)),
            mark(Stage::Painted, 11, 2, at(base, 9)),
            mark(Stage::Painted, 11, 2, at(base, 20)),
        ];
        let (shown, replaced) = presentations(&marks);
        assert_eq!(replaced, 1);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].frame, 11);
        assert_eq!(shown[0].rendered, Some(at(base, 3)));
        assert_eq!(shown[0].painted, at(base, 9));
    }

    #[test]
    fn an_input_is_answered_by_a_render_after_it_not_an_older_copy() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Rendered, 5, 0, at(base, 0)),
            mark(Stage::Arrived, 5, 1, at(base, 1)),
            mark(Stage::Input, 0, 0, at(base, 2)),
            mark(Stage::Demand, 5, 0, at(base, 2)),
            mark(Stage::Painted, 5, 1, at(base, 3)),
            mark(Stage::Rendered, 5, 0, at(base, 10)),
            mark(Stage::Arrived, 5, 2, at(base, 11)),
            mark(Stage::Painted, 5, 2, at(base, 18)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert_eq!(outcomes.len(), 1);
        let shown = outcomes[0].shown.expect("the re-render was painted");
        assert_eq!(millis(outcomes[0].at, shown.painted), 16.0);
        assert!(!outcomes[0].superseded);
    }

    #[test]
    fn a_newer_input_before_the_paint_supersedes() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Input, 0, 0, at(base, 0)),
            mark(Stage::Demand, 1, 0, at(base, 0)),
            mark(Stage::Input, 0, 0, at(base, 8)),
            mark(Stage::Demand, 2, 0, at(base, 8)),
            mark(Stage::Rendered, 2, 0, at(base, 12)),
            mark(Stage::Arrived, 2, 1, at(base, 13)),
            mark(Stage::Painted, 2, 1, at(base, 16)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert!(outcomes[0].shown.is_none());
        assert!(outcomes[0].superseded);
        assert_eq!(outcomes[1].shown.map(|shown| shown.frame), Some(2));
        assert!(!outcomes[1].superseded);
    }

    #[test]
    fn the_last_demand_of_an_input_is_its_target() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Input, 0, 0, at(base, 0)),
            mark(Stage::Demand, 7, 0, at(base, 0)),
            mark(Stage::Demand, 9, 0, at(base, 0)),
            mark(Stage::Rendered, 9, 0, at(base, 5)),
            mark(Stage::Arrived, 9, 1, at(base, 6)),
            mark(Stage::Painted, 9, 1, at(base, 12)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert_eq!(outcomes[0].target, Some(9));
        assert_eq!(
            outcomes[0].shown.map(|shown| millis(base, shown.painted)),
            Some(12.0)
        );
    }

    #[test]
    fn a_frame_revisited_after_newer_ones_is_not_a_late_answer() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Input, 0, 0, at(base, 0)),
            mark(Stage::Demand, 4, 0, at(base, 0)),
            mark(Stage::Input, 0, 0, at(base, 8)),
            mark(Stage::Demand, 5, 0, at(base, 8)),
            mark(Stage::Rendered, 5, 0, at(base, 12)),
            mark(Stage::Arrived, 5, 1, at(base, 13)),
            mark(Stage::Painted, 5, 1, at(base, 16)),
            mark(Stage::Input, 0, 0, at(base, 1000)),
            mark(Stage::Demand, 4, 0, at(base, 1000)),
            mark(Stage::Rendered, 4, 0, at(base, 1004)),
            mark(Stage::Arrived, 4, 2, at(base, 1005)),
            mark(Stage::Painted, 4, 2, at(base, 1016)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert!(outcomes[0].shown.is_none());
        assert!(outcomes[0].superseded);
        assert_eq!(outcomes[1].shown.map(|shown| shown.frame), Some(5));
        assert_eq!(
            outcomes[2]
                .shown
                .map(|shown| millis(outcomes[2].at, shown.painted)),
            Some(16.0)
        );
    }

    #[test]
    fn a_render_in_flight_at_the_input_does_not_answer_it() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Input, 0, 0, at(base, 0)),
            mark(Stage::Demand, 3, 0, at(base, 0)),
            mark(Stage::Input, 0, 0, at(base, 4)),
            mark(Stage::Demand, 3, 0, at(base, 4)),
            mark(Stage::Rendered, 3, 0, at(base, 9)),
            mark(Stage::Arrived, 3, 1, at(base, 10)),
            mark(Stage::Painted, 3, 1, at(base, 16)),
            mark(Stage::Rendered, 3, 0, at(base, 20)),
            mark(Stage::Arrived, 3, 2, at(base, 21)),
            mark(Stage::Painted, 3, 2, at(base, 33)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert_eq!(
            outcomes[0].shown.map(|shown| millis(base, shown.painted)),
            Some(16.0)
        );
        assert_eq!(
            outcomes[1].shown.map(|shown| millis(base, shown.painted)),
            Some(33.0)
        );
    }

    #[test]
    fn a_request_queued_behind_a_render_is_in_flight_at_the_next_input() {
        let base = Instant::now();
        let marks = [
            mark(Stage::Demand, 2, 0, at(base, 0)),
            mark(Stage::Demand, 3, 0, at(base, 1)),
            mark(Stage::Rendered, 2, 0, at(base, 5)),
            mark(Stage::Input, 0, 0, at(base, 6)),
            mark(Stage::Demand, 3, 0, at(base, 6)),
            mark(Stage::Rendered, 3, 0, at(base, 10)),
            mark(Stage::Arrived, 3, 1, at(base, 11)),
            mark(Stage::Painted, 3, 1, at(base, 12)),
            mark(Stage::Rendered, 3, 0, at(base, 15)),
            mark(Stage::Arrived, 3, 2, at(base, 16)),
            mark(Stage::Painted, 3, 2, at(base, 28)),
        ];
        let (shown, _) = presentations(&marks);
        let outcomes = input_outcomes(&marks, &shown);
        assert_eq!(
            outcomes[0].shown.map(|shown| millis(base, shown.painted)),
            Some(28.0)
        );
    }

    #[test]
    fn percentiles_pick_nearest_ranks() {
        let mut samples: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentiles(&mut samples), Some([51.0, 95.0, 99.0, 100.0]));
        assert_eq!(percentiles(&mut []), None);
    }
}
