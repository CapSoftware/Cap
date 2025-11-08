use cap_project::{CursorEvents, CursorMoveEvent, XY};

use crate::{
    Coord, RawDisplayUVSpace,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

#[derive(Debug, Clone)]
pub struct InterpolatedCursorPosition {
    pub position: Coord<RawDisplayUVSpace>,
    #[allow(unused)]
    pub velocity: XY<f32>,
    pub cursor_id: String,
}

pub fn interpolate_cursor(
    cursor: &CursorEvents,
    time_secs: f32,
    smoothing: Option<SpringMassDamperSimulationConfig>,
) -> Option<InterpolatedCursorPosition> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
        return None;
    }

    if cursor.moves[0].time_ms > time_ms {
        let event = &cursor.moves[0];

        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: event.x,
                y: event.y,
            }),
            velocity: XY::new(0.0, 0.0),
            cursor_id: event.cursor_id.clone(),
        });
    }

    if let Some(event) = cursor.moves.last()
        && event.time_ms < time_ms
    {
        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: event.x,
                y: event.y,
            }),
            velocity: XY::new(0.0, 0.0),
            cursor_id: event.cursor_id.clone(),
        });
    }

    if let Some(smoothing_config) = smoothing {
        let events = get_smoothed_cursor_events(&cursor.moves, smoothing_config);
        interpolate_smoothed_position(&events, time_secs as f64, smoothing_config)
    } else {
        interpolate_spline(&cursor.moves, time_ms)
    }
}

fn interpolate_spline(
    moves: &[CursorMoveEvent],
    time_ms: f64,
) -> Option<InterpolatedCursorPosition> {
    let (segment_index, next) = moves
        .iter()
        .enumerate()
        .find(|(_, event)| event.time_ms >= time_ms)?;

    if segment_index == 0 {
        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: next.x,
                y: next.y,
            }),
            velocity: XY::new(0.0, 0.0),
            cursor_id: next.cursor_id.clone(),
        });
    }

    let prev_index = segment_index - 1;
    let prev = &moves[prev_index];

    let span_ms = (next.time_ms - prev.time_ms).max(f64::EPSILON);
    let t = ((time_ms - prev.time_ms) / span_ms).clamp(0.0, 1.0);

    if moves.len() < 4 {
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        let position = Coord::new(XY {
            x: lerp(prev.x, next.x),
            y: lerp(prev.y, next.y),
        });
        let velocity = XY::new(
            ((next.x - prev.x) / span_ms) as f32 * 1000.0,
            ((next.y - prev.y) / span_ms) as f32 * 1000.0,
        );

        return Some(InterpolatedCursorPosition {
            position,
            velocity,
            cursor_id: prev.cursor_id.clone(),
        });
    }

    let p0 = moves.get(prev_index.saturating_sub(1)).unwrap_or(prev);
    let p3 = moves.get(segment_index + 1).unwrap_or(next);

    let (x, dx_dt) = catmull_rom(p0.x, prev.x, next.x, p3.x, t);
    let (y, dy_dt) = catmull_rom(p0.y, prev.y, next.y, p3.y, t);

    let mut position = Coord::new(XY { x, y });
    position.coord.x = position.coord.x.clamp(0.0, 1.0);
    position.coord.y = position.coord.y.clamp(0.0, 1.0);

    let velocity = XY::new(
        ((dx_dt / span_ms) * 1000.0) as f32,
        ((dy_dt / span_ms) * 1000.0) as f32,
    );

    Some(InterpolatedCursorPosition {
        position,
        velocity,
        cursor_id: prev.cursor_id.clone(),
    })
}

fn catmull_rom(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> (f64, f64) {
    let t2 = t * t;
    let t3 = t2 * t;

    let a = 2.0 * p1;
    let b = -p0 + p2;
    let c = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
    let d = -p0 + 3.0 * p1 - 3.0 * p2 + p3;

    let position = 0.5 * (a + b * t + c * t2 + d * t3);
    let derivative = 0.5 * (b + 2.0 * c * t + 3.0 * d * t2);

    (position, derivative)
}

fn get_smoothed_cursor_events(
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
) -> Vec<SmoothedCursorEvent> {
    let mut last_time = 0.0;

    let mut events = vec![];

    let mut sim = SpringMassDamperSimulation::new(smoothing_config);

    sim.set_position(XY::new(moves[0].x, moves[0].y).map(|v| v as f32));
    sim.set_velocity(XY::new(0.0, 0.0));

    if moves[0].time_ms > 0.0 {
        events.push(SmoothedCursorEvent {
            time: 0.0,
            target_position: sim.position,
            position: sim.position,
            velocity: sim.velocity,
            cursor_id: moves[0].cursor_id.clone(),
        })
    }

    for (i, m) in moves.iter().enumerate() {
        let target_position = moves
            .get(i + 1)
            .map(|e| XY::new(e.x, e.y).map(|v| v as f32))
            .unwrap_or(sim.target_position);
        sim.set_target_position(target_position);

        sim.run(m.time_ms as f32 - last_time);

        last_time = m.time_ms as f32;

        events.push(SmoothedCursorEvent {
            time: m.time_ms as f32,
            target_position,
            position: sim.position,
            velocity: sim.velocity,
            cursor_id: m.cursor_id.clone(),
        });
    }

    events
}

fn interpolate_smoothed_position(
    smoothed_events: &[SmoothedCursorEvent],
    query_time: f64,
    smoothing_config: SpringMassDamperSimulationConfig,
) -> Option<InterpolatedCursorPosition> {
    if smoothed_events.is_empty() {
        return None;
    }

    let mut sim = SpringMassDamperSimulation::new(smoothing_config);

    let query_time_ms = (query_time * 1000.0) as f32;

    let cursor_id = match smoothed_events
        .windows(2)
        .find(|chunk| chunk[0].time <= query_time_ms && query_time_ms < chunk[1].time)
    {
        Some(c) => {
            sim.set_position(c[0].position);
            sim.set_velocity(c[0].velocity);
            sim.set_target_position(c[0].target_position);
            sim.run(query_time_ms - c[0].time);
            c[0].cursor_id.clone()
        }
        None => {
            let e = smoothed_events.last().unwrap();
            sim.set_position(e.position);
            sim.set_velocity(e.velocity);
            sim.set_target_position(e.target_position);
            sim.run(query_time_ms - e.time);
            e.cursor_id.clone()
        }
    };

    Some(InterpolatedCursorPosition {
        position: Coord::new(sim.position.map(|v| v as f64)),
        velocity: sim.velocity,
        cursor_id,
    })
}

#[derive(Debug)]
struct SmoothedCursorEvent {
    time: f32,
    target_position: XY<f32>,
    position: XY<f32>,
    velocity: XY<f32>,
    cursor_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn move_event(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "pointer".into(),
            time_ms,
            x,
            y,
        }
    }

    #[test]
    fn linear_fallback_blends_positions() {
        let moves = vec![move_event(0.0, 0.0, 0.0), move_event(10.0, 1.0, 1.0)];

        let interpolated = interpolate_spline(&moves, 5.0).expect("interpolated cursor");

        assert!((interpolated.position.x - 0.5).abs() < 1e-6);
        assert!((interpolated.position.y - 0.5).abs() < 1e-6);
    }

    #[test]
    fn linear_fallback_computes_velocity() {
        let moves = vec![move_event(0.0, 0.0, 0.0), move_event(20.0, 1.0, -1.0)];

        let interpolated = interpolate_spline(&moves, 10.0).expect("interpolated cursor");

        assert!((interpolated.velocity.x - 50.0).abs() < 1e-3);
        assert!((interpolated.velocity.y + 50.0).abs() < 1e-3);
    }

    #[test]
    fn spline_uses_neighbors_for_smoothing() {
        let moves = vec![
            move_event(0.0, 0.0, 0.0),
            move_event(10.0, 0.5, 0.5),
            move_event(20.0, 1.0, 1.0),
            move_event(30.0, 1.5, 1.5),
        ];

        let interpolated = interpolate_spline(&moves, 15.0).expect("interpolated cursor");

        assert!(interpolated.position.x > 0.5);
        assert!(interpolated.position.x < 1.0);
    }
}
