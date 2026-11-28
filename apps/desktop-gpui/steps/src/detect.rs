use std::collections::HashMap;

use crate::{
    Action, ButtonEvent, ClipEvents, Guide, LEFT_BUTTON, Marker, Point, PointerMove, RIGHT_BUTTON,
    Source, Step, Word,
};

const FRAME_LEAD: f64 = 0.05;
const SAME_SPOT: f64 = 0.02;
const DOUBLE_CLICK_GAP: f64 = 0.5;
const REPEAT_GAP: f64 = 1.0;
const STOP_CLICK_WINDOW: f64 = 1.0;
const DRAG_TRAVEL: f64 = 0.03;

struct Press {
    time: f64,
    button: u8,
    position: Option<Point>,
    drag_to: Option<Point>,
}

pub fn clip_steps(events: &ClipEvents, output_time: impl Fn(f64) -> Option<f64>) -> Vec<Step> {
    let path = pointer_path(events.moves);
    let mut buttons: Vec<&ButtonEvent> = events
        .buttons
        .iter()
        .filter(|event| event.time.is_finite() && output_time(event.time).is_some())
        .collect();
    buttons.sort_by(|a, b| a.time.total_cmp(&b.time));
    let mut presses = presses(&buttons, &path);
    if let Some(stopped_at) = events.stopped_at.filter(|time| time.is_finite()) {
        presses.retain(|press| press.time <= stopped_at - STOP_CLICK_WINDOW);
    }
    pointer_steps(events.clip, &presses, output_time)
}

pub fn build_guide(mut steps: Vec<Step>, markers: &[Marker], words: &[Word]) -> Guide {
    steps.sort_by(|a, b| a.time.total_cmp(&b.time));
    crate::narration::attach(words, with_markers(steps, markers))
}

fn with_markers(mut steps: Vec<Step>, markers: &[Marker]) -> Vec<Step> {
    let mut markers: Vec<&Marker> = markers
        .iter()
        .filter(|marker| marker.time.is_finite())
        .collect();
    markers.sort_by(|a, b| a.time.total_cmp(&b.time));

    let mut notes = Vec::new();
    for (index, marker) in markers.iter().enumerate() {
        let until = markers
            .get(index + 1)
            .map_or(f64::INFINITY, |next| next.time);
        let label = marker.label.trim();
        let heading = (!label.is_empty()).then(|| label.to_string());
        match steps
            .iter_mut()
            .find(|step| step.time >= marker.time && step.time < until)
        {
            Some(step) => step.heading = heading,
            None => notes.push(Step {
                time: marker.time,
                source: marker.source,
                frame_time: marker.source.time,
                action: Action::Note,
                position: None,
                drag_to: None,
                repeat: 1,
                heading,
                narration: String::new(),
            }),
        }
    }
    steps.extend(notes);
    steps.sort_by(|a, b| a.time.total_cmp(&b.time));
    steps
}

fn same_spot(a: Option<Point>, b: Option<Point>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.distance(b) <= SAME_SPOT,
        (None, None) => true,
        _ => false,
    }
}

fn pointer_steps(
    clip: u32,
    presses: &[Press],
    output_time: impl Fn(f64) -> Option<f64>,
) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut index = 0;
    while let Some(first) = presses.get(index) {
        let mut count = 1;
        let mut previous = first.time;
        while let Some(next) = presses.get(index + count) {
            let continues = next.button == first.button
                && first.drag_to.is_none()
                && next.drag_to.is_none()
                && next.time - previous <= REPEAT_GAP
                && same_spot(first.position, next.position);
            if !continues {
                break;
            }
            previous = next.time;
            count += 1;
        }
        let double =
            count == 2 && first.button == LEFT_BUTTON && previous - first.time <= DOUBLE_CLICK_GAP;
        index += count;
        let Some(time) = output_time(first.time) else {
            continue;
        };
        steps.push(Step {
            time,
            source: Source {
                clip,
                time: first.time,
            },
            frame_time: (first.time - FRAME_LEAD).max(0.0),
            action: if first.drag_to.is_some() {
                Action::Drag
            } else if double {
                Action::DoubleClick
            } else if first.button == RIGHT_BUTTON {
                Action::RightClick
            } else {
                Action::Click
            },
            position: first.position,
            drag_to: first.drag_to,
            repeat: if double { 1 } else { count as u32 },
            heading: None,
            narration: String::new(),
        });
    }
    steps
}

fn pointer_path(moves: &[PointerMove]) -> Vec<PointerMove> {
    let mut path: Vec<PointerMove> = moves
        .iter()
        .filter(|event| {
            event.time.is_finite() && event.position.x.is_finite() && event.position.y.is_finite()
        })
        .map(|event| PointerMove {
            time: event.time,
            position: Point::new(
                event.position.x.clamp(0.0, 1.0),
                event.position.y.clamp(0.0, 1.0),
            ),
        })
        .collect();
    path.sort_by(|a, b| a.time.total_cmp(&b.time));
    path
}

fn position_at(path: &[PointerMove], time: f64) -> Option<Point> {
    let after = path.partition_point(|event| event.time <= time);
    path.get(after.saturating_sub(1))
        .map(|event| event.position)
}

fn presses(buttons: &[&ButtonEvent], path: &[PointerMove]) -> Vec<Press> {
    let mut found: Vec<Press> = Vec::new();
    let mut held: HashMap<u8, usize> = HashMap::new();
    for event in buttons {
        if event.down {
            held.insert(event.button, found.len());
            found.push(Press {
                time: event.time,
                button: event.button,
                position: position_at(path, event.time),
                drag_to: None,
            });
        } else if let Some(index) = held.remove(&event.button) {
            let press = &mut found[index];
            if travelled(path, press, event.time) > DRAG_TRAVEL {
                press.drag_to = position_at(path, event.time);
            }
        }
    }
    found
}

fn travelled(path: &[PointerMove], press: &Press, released: f64) -> f64 {
    let Some(start) = press.position else {
        return 0.0;
    };
    let from = path.partition_point(|event| event.time < press.time);
    let to = path.partition_point(|event| event.time <= released);
    path.get(from..to)
        .unwrap_or_default()
        .iter()
        .map(|event| event.position.distance(start))
        .fold(0.0, f64::max)
}
