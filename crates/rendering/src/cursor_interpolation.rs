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
        && event.time_ms <= time_ms
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
        let (pos, cursor_id, velocity) = cursor.moves.windows(2).find_map(|chunk| {
            if time_ms >= chunk[0].time_ms && time_ms < chunk[1].time_ms {
                let c = &chunk[0];
                let next = &chunk[1];
                let delta_ms = (next.time_ms - c.time_ms) as f32;
                let dt = (delta_ms / 1000.0).max(0.000_1);
                let velocity = XY::new(((next.x - c.x) as f32) / dt, ((next.y - c.y) as f32) / dt);
                Some((
                    XY::new(c.x as f32, c.y as f32),
                    c.cursor_id.clone(),
                    velocity,
                ))
            } else {
                None
            }
        })?;

        Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: pos.x as f64,
                y: pos.y as f64,
            }),
            velocity,
            cursor_id,
        })
    }
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
