use std::collections::HashMap;

use crate::{
    Action, ButtonEvent, Guide, LEFT_BUTTON, Marker, Point, PointerMove, RIGHT_BUTTON, Recording,
    Step,
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

pub fn build_guide(recording: &Recording) -> Guide {
    let moves = pointer_path(&recording.moves);
    let mut presses = presses(&recording.buttons, &moves);
    if recording.duration.is_finite() && recording.duration > 0.0 {
        presses.retain(|press| press.time <= recording.duration - STOP_CLICK_WINDOW);
    }
    let steps = with_markers(pointer_steps(&presses), &recording.markers);
    crate::narration::attach(recording, steps)
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
                frame_time: marker.time.max(0.0),
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

fn pointer_steps(presses: &[Press]) -> Vec<Step> {
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
        steps.push(Step {
            time: first.time,
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
        index += count;
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

fn presses(buttons: &[ButtonEvent], path: &[PointerMove]) -> Vec<Press> {
    let mut events: Vec<&ButtonEvent> = buttons
        .iter()
        .filter(|event| event.time.is_finite())
        .collect();
    events.sort_by(|a, b| a.time.total_cmp(&b.time));

    let mut found: Vec<Press> = Vec::new();
    let mut held: HashMap<u8, usize> = HashMap::new();
    for event in events {
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
