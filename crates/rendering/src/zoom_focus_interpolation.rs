use cap_project::{CursorEvents, ScreenMovementSpring, XY, ZoomSegment};

use crate::{
    Coord, RawDisplayUVSpace,
    cursor_interpolation::interpolate_cursor,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

const SAMPLE_INTERVAL_MS: f64 = 8.0;

#[derive(Clone)]
struct SmoothedFocusEvent {
    time: f64,
    position: XY<f32>,
}

pub struct ZoomFocusInterpolator {
    events: Option<Vec<SmoothedFocusEvent>>,
    cursor_events: std::sync::Arc<CursorEvents>,
    cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
    screen_spring: ScreenMovementSpring,
    duration_secs: f64,
}

impl ZoomFocusInterpolator {
    pub fn new(
        cursor_events: &CursorEvents,
        cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
        screen_spring: ScreenMovementSpring,
        duration_secs: f64,
    ) -> Self {
        Self {
            events: None,
            cursor_events: std::sync::Arc::new(cursor_events.clone()),
            cursor_smoothing,
            screen_spring,
            duration_secs,
        }
    }

    pub fn new_arc(
        cursor_events: std::sync::Arc<CursorEvents>,
        cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
        screen_spring: ScreenMovementSpring,
        duration_secs: f64,
    ) -> Self {
        Self {
            events: None,
            cursor_events,
            cursor_smoothing,
            screen_spring,
            duration_secs,
        }
    }

    pub fn precompute(&mut self) {
        if self.events.is_some() {
            return;
        }

        if self.cursor_events.moves.is_empty() {
            self.events = Some(vec![]);
            return;
        }

        let spring_config = SpringMassDamperSimulationConfig {
            tension: self.screen_spring.stiffness,
            mass: self.screen_spring.mass,
            friction: self.screen_spring.damping,
        };

        let mut sim = SpringMassDamperSimulation::new(spring_config);

        let first_cursor = interpolate_cursor(&self.cursor_events, 0.0, self.cursor_smoothing);
        let initial_pos = first_cursor
            .map(|c| XY::new(c.position.coord.x as f32, c.position.coord.y as f32))
            .unwrap_or(XY::new(0.5, 0.5));

        sim.set_position(initial_pos);
        sim.set_velocity(XY::new(0.0, 0.0));
        sim.set_target_position(initial_pos);

        let mut events = vec![SmoothedFocusEvent {
            time: 0.0,
            position: initial_pos,
        }];

        let duration_ms = self.duration_secs * 1000.0;
        let mut current_time_ms = 0.0;

        while current_time_ms < duration_ms {
            current_time_ms += SAMPLE_INTERVAL_MS;
            let time_secs = (current_time_ms / 1000.0) as f32;

            if let Some(cursor) =
                interpolate_cursor(&self.cursor_events, time_secs, self.cursor_smoothing)
            {
                let target = XY::new(
                    cursor.position.coord.x as f32,
                    cursor.position.coord.y as f32,
                );
                sim.set_target_position(target);
            }

            sim.run(SAMPLE_INTERVAL_MS as f32);

            events.push(SmoothedFocusEvent {
                time: current_time_ms,
                position: XY::new(
                    sim.position.x.clamp(0.0, 1.0),
                    sim.position.y.clamp(0.0, 1.0),
                ),
            });
        }

        self.events = Some(events);
    }

    pub fn interpolate(&self, time_secs: f32) -> Coord<RawDisplayUVSpace> {
        let time_ms = (time_secs * 1000.0) as f64;

        if self.cursor_events.moves.is_empty() {
            return Coord::new(XY::new(0.5, 0.5));
        }

        if let Some(ref events) = self.events {
            self.interpolate_from_events(events, time_ms)
        } else {
            self.interpolate_direct(time_secs)
        }
    }

    fn interpolate_direct(&self, time_secs: f32) -> Coord<RawDisplayUVSpace> {
        if let Some(cursor) =
            interpolate_cursor(&self.cursor_events, time_secs, self.cursor_smoothing)
        {
            Coord::new(XY::new(
                cursor.position.coord.x.clamp(0.0, 1.0),
                cursor.position.coord.y.clamp(0.0, 1.0),
            ))
        } else {
            Coord::new(XY::new(0.5, 0.5))
        }
    }

    fn interpolate_from_events(
        &self,
        events: &[SmoothedFocusEvent],
        time_ms: f64,
    ) -> Coord<RawDisplayUVSpace> {
        if events.is_empty() {
            return Coord::new(XY::new(0.5, 0.5));
        }

        if time_ms <= events[0].time {
            let pos = events[0].position;
            return Coord::new(XY::new(pos.x as f64, pos.y as f64));
        }

        if let Some(last) = events.last()
            && time_ms >= last.time
        {
            return Coord::new(XY::new(last.position.x as f64, last.position.y as f64));
        }

        let idx = events
            .binary_search_by(|e| {
                e.time
                    .partial_cmp(&time_ms)
                    .unwrap_or(std::cmp::Ordering::Less)
            })
            .unwrap_or_else(|i| i.saturating_sub(1));

        let curr = &events[idx];
        let next = events.get(idx + 1).unwrap_or(curr);

        if (next.time - curr.time).abs() < f64::EPSILON {
            return Coord::new(XY::new(curr.position.x as f64, curr.position.y as f64));
        }

        let t = ((time_ms - curr.time) / (next.time - curr.time)).clamp(0.0, 1.0) as f32;

        let lerped = XY::new(
            curr.position.x + (next.position.x - curr.position.x) * t,
            curr.position.y + (next.position.y - curr.position.y) * t,
        );

        Coord::new(XY::new(lerped.x as f64, lerped.y as f64))
    }
}

#[allow(dead_code)]
pub fn apply_edge_snap_to_focus(
    focus: Coord<RawDisplayUVSpace>,
    segment: &ZoomSegment,
) -> Coord<RawDisplayUVSpace> {
    let position = (focus.x, focus.y);
    let zoom_amount = segment.amount;
    let edge_snap_ratio = segment.edge_snap_ratio;

    let viewport_half = 0.5 / zoom_amount;
    let snap_threshold = edge_snap_ratio / zoom_amount;

    let snap_axis = |pos: f64| -> f64 {
        if pos < snap_threshold {
            viewport_half
        } else if pos > 1.0 - snap_threshold {
            1.0 - viewport_half
        } else {
            pos.clamp(viewport_half, 1.0 - viewport_half)
        }
    };

    Coord::new(XY::new(snap_axis(position.0), snap_axis(position.1)))
}
