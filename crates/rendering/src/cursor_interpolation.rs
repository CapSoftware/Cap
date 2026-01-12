use std::borrow::Cow;

use cap_project::{ClickSpringConfig, CursorClickEvent, CursorEvents, CursorMoveEvent, XY};

use crate::{
    Coord, RawDisplayUVSpace,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

const CLICK_REACTION_WINDOW_MS: f64 = 160.0;
const MIN_MASS: f32 = 0.1;
const SHAKE_THRESHOLD_UV: f64 = 0.015;
const SHAKE_DETECTION_WINDOW_MS: f64 = 100.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SpringProfile {
    Default,
    Snappy,
    Drag,
}

struct CursorSpringPresets {
    default: SpringMassDamperSimulationConfig,
    snappy: SpringMassDamperSimulationConfig,
    drag: SpringMassDamperSimulationConfig,
}

impl CursorSpringPresets {
    fn new(
        base: SpringMassDamperSimulationConfig,
        click_spring: Option<ClickSpringConfig>,
    ) -> Self {
        let snappy = click_spring
            .map(|c| SpringMassDamperSimulationConfig {
                tension: c.tension,
                mass: c.mass,
                friction: c.friction,
            })
            .unwrap_or(SpringMassDamperSimulationConfig {
                tension: 700.0,
                mass: 1.0,
                friction: 30.0,
            });

        Self {
            default: base,
            snappy,
            drag: scale_config(base, 0.8, 1.2, 1.3),
        }
    }

    fn config(&self, profile: SpringProfile) -> SpringMassDamperSimulationConfig {
        match profile {
            SpringProfile::Default => self.default,
            SpringProfile::Snappy => self.snappy,
            SpringProfile::Drag => self.drag,
        }
    }
}

fn scale_config(
    base: SpringMassDamperSimulationConfig,
    tension_scale: f32,
    mass_scale: f32,
    friction_scale: f32,
) -> SpringMassDamperSimulationConfig {
    SpringMassDamperSimulationConfig {
        tension: base.tension * tension_scale,
        mass: (base.mass * mass_scale).max(MIN_MASS),
        friction: base.friction * friction_scale,
    }
}

struct CursorSpringContext<'a> {
    clicks: &'a [CursorClickEvent],
    next_click_index: usize,
    last_click_time: Option<f64>,
    primary_button_down: bool,
}

impl<'a> CursorSpringContext<'a> {
    fn new(clicks: &'a [cap_project::CursorClickEvent]) -> Self {
        Self {
            clicks,
            next_click_index: 0,
            last_click_time: None,
            primary_button_down: false,
        }
    }

    fn advance_to(&mut self, time_ms: f64) {
        while let Some(click) = self.clicks.get(self.next_click_index)
            && click.time_ms <= time_ms
        {
            self.last_click_time = Some(click.time_ms);
            if click.cursor_num == 0 {
                self.primary_button_down = click.down;
            }
            self.next_click_index += 1;
        }
    }

    fn profile(&self, time_ms: f64) -> SpringProfile {
        if self.was_recent_click(time_ms) {
            SpringProfile::Snappy
        } else if self.primary_button_down {
            SpringProfile::Drag
        } else {
            SpringProfile::Default
        }
    }

    fn was_recent_click(&self, time_ms: f64) -> bool {
        self.last_click_time
            .map(|t| (time_ms - t).abs() <= CLICK_REACTION_WINDOW_MS)
            .unwrap_or(false)
    }
}

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
    interpolate_cursor_with_click_spring(cursor, time_secs, smoothing, None)
}

pub fn interpolate_cursor_with_click_spring(
    cursor: &CursorEvents,
    time_secs: f32,
    smoothing: Option<SpringMassDamperSimulationConfig>,
    click_spring: Option<ClickSpringConfig>,
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
        let filtered_moves = filter_cursor_shake(&cursor.moves);
        let prepared_moves = densify_cursor_moves(filtered_moves.as_ref());
        let events = get_smoothed_cursor_events_with_click_spring(
            cursor,
            prepared_moves.as_ref(),
            smoothing_config,
            click_spring,
        );
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

#[allow(dead_code)]
fn get_smoothed_cursor_events(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
) -> Vec<SmoothedCursorEvent> {
    get_smoothed_cursor_events_with_click_spring(cursor, moves, smoothing_config, None)
}

fn get_smoothed_cursor_events_with_click_spring(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
    click_spring: Option<ClickSpringConfig>,
) -> Vec<SmoothedCursorEvent> {
    let mut last_time = 0.0;

    let mut events = vec![];

    let mut sim = SpringMassDamperSimulation::new(smoothing_config);
    let presets = CursorSpringPresets::new(smoothing_config, click_spring);
    let mut context = CursorSpringContext::new(&cursor.clicks);

    sim.set_position(XY::new(moves[0].x, moves[0].y).map(|v| v as f32));
    sim.set_velocity(XY::new(0.0, 0.0));
    sim.set_target_position(sim.position);

    if moves[0].time_ms > 0.0 {
        events.push(SmoothedCursorEvent {
            time: 0.0,
            target_position: sim.target_position,
            position: sim.position,
            velocity: sim.velocity,
            cursor_id: moves[0].cursor_id.clone(),
        })
    }

    for m in moves.iter() {
        let target_position = XY::new(m.x, m.y).map(|v| v as f32);
        sim.set_target_position(target_position);

        context.advance_to(m.time_ms);
        let profile = context.profile(m.time_ms);
        sim.set_config(presets.config(profile));

        sim.run(m.time_ms as f32 - last_time);

        last_time = m.time_ms as f32;

        let clamped_position = XY::new(
            sim.position.x.clamp(0.0, 1.0),
            sim.position.y.clamp(0.0, 1.0),
        );

        events.push(SmoothedCursorEvent {
            time: m.time_ms as f32,
            target_position,
            position: clamped_position,
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

    let clamped_position = XY::new(
        sim.position.x.clamp(0.0, 1.0) as f64,
        sim.position.y.clamp(0.0, 1.0) as f64,
    );

    Some(InterpolatedCursorPosition {
        position: Coord::new(clamped_position),
        velocity: sim.velocity,
        cursor_id,
    })
}

const CURSOR_FRAME_DURATION_MS: f64 = 1000.0 / 60.0;
const GAP_INTERPOLATION_THRESHOLD_MS: f64 = CURSOR_FRAME_DURATION_MS * 4.0;
const MIN_CURSOR_TRAVEL_FOR_INTERPOLATION: f64 = 0.02;
const MAX_INTERPOLATED_STEPS: usize = 120;

fn filter_cursor_shake<'a>(moves: &'a [CursorMoveEvent]) -> Cow<'a, [CursorMoveEvent]> {
    if moves.len() < 3 {
        return Cow::Borrowed(moves);
    }

    let mut filtered = Vec::with_capacity(moves.len());
    filtered.push(moves[0].clone());

    let mut i = 1;
    while i < moves.len() - 1 {
        let prev = filtered.last().unwrap();
        let curr = &moves[i];
        let next = &moves[i + 1];

        if curr.cursor_id != prev.cursor_id || curr.cursor_id != next.cursor_id {
            filtered.push(curr.clone());
            i += 1;
            continue;
        }

        let time_window = next.time_ms - prev.time_ms;
        if time_window > SHAKE_DETECTION_WINDOW_MS {
            filtered.push(curr.clone());
            i += 1;
            continue;
        }

        let dir_to_curr = (curr.x - prev.x, curr.y - prev.y);
        let dir_to_next = (next.x - curr.x, next.y - curr.y);

        let dot = dir_to_curr.0 * dir_to_next.0 + dir_to_curr.1 * dir_to_next.1;
        let is_reversal = dot < 0.0;

        let displacement_curr = (dir_to_curr.0.powi(2) + dir_to_curr.1.powi(2)).sqrt();
        let displacement_next = (dir_to_next.0.powi(2) + dir_to_next.1.powi(2)).sqrt();
        let is_small_movement =
            displacement_curr < SHAKE_THRESHOLD_UV && displacement_next < SHAKE_THRESHOLD_UV;

        if is_reversal && is_small_movement {
            i += 1;
            continue;
        }

        filtered.push(curr.clone());
        i += 1;
    }

    if moves.len() > 1 {
        filtered.push(moves.last().unwrap().clone());
    }

    if filtered.len() == moves.len() {
        return Cow::Borrowed(moves);
    }

    Cow::Owned(filtered)
}

fn densify_cursor_moves<'a>(moves: &'a [CursorMoveEvent]) -> Cow<'a, [CursorMoveEvent]> {
    if moves.len() < 2 {
        return Cow::Borrowed(moves);
    }

    let requires_interpolation = moves.windows(2).any(|window| {
        let current = &window[0];
        let next = &window[1];
        should_fill_gap(current, next)
    });

    if !requires_interpolation {
        return Cow::Borrowed(moves);
    }

    let mut dense_moves = Vec::with_capacity(moves.len());
    dense_moves.push(moves[0].clone());

    for i in 0..moves.len() - 1 {
        let current = &moves[i];
        let next = &moves[i + 1];
        if should_fill_gap(current, next) {
            push_interpolated_samples(current, next, &mut dense_moves);
        } else {
            dense_moves.push(next.clone());
        }
    }

    Cow::Owned(dense_moves)
}

fn should_fill_gap(from: &CursorMoveEvent, to: &CursorMoveEvent) -> bool {
    if from.cursor_id != to.cursor_id {
        return false;
    }

    let dt_ms = (to.time_ms - from.time_ms).max(0.0);
    if dt_ms < GAP_INTERPOLATION_THRESHOLD_MS {
        return false;
    }

    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let distance = (dx * dx + dy * dy).sqrt();

    distance >= MIN_CURSOR_TRAVEL_FOR_INTERPOLATION
}

fn push_interpolated_samples(
    from: &CursorMoveEvent,
    to: &CursorMoveEvent,
    output: &mut Vec<CursorMoveEvent>,
) {
    let dt_ms = (to.time_ms - from.time_ms).max(0.0);
    if dt_ms <= 0.0 {
        output.push(to.clone());
        return;
    }

    let segments =
        ((dt_ms / CURSOR_FRAME_DURATION_MS).ceil() as usize).clamp(2, MAX_INTERPOLATED_STEPS);

    for step in 1..segments {
        let t = step as f64 / segments as f64;
        output.push(CursorMoveEvent {
            active_modifiers: to.active_modifiers.clone(),
            cursor_id: to.cursor_id.clone(),
            time_ms: from.time_ms + dt_ms * t,
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        });
    }

    output.push(to.clone());
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

    fn cursor_move(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "primary".into(),
            time_ms,
            x,
            y,
        }
    }

    fn click_event(time_ms: f64, down: bool) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_id: "primary".into(),
            cursor_num: 0,
            time_ms,
            down,
        }
    }

    #[test]
    fn densify_inserts_samples_for_large_gaps() {
        let moves = vec![cursor_move(0.0, 0.1, 0.1), cursor_move(140.0, 0.9, 0.9)];

        match densify_cursor_moves(&moves) {
            Cow::Owned(dense) => {
                assert!(dense.len() > moves.len(), "expected interpolated samples");
                assert_eq!(
                    dense.first().unwrap().time_ms,
                    moves.first().unwrap().time_ms
                );
                assert_eq!(dense.last().unwrap().time_ms, moves.last().unwrap().time_ms);
            }
            Cow::Borrowed(_) => panic!("expected densified output"),
        }
    }

    #[test]
    fn densify_skips_small_gaps_or_cursor_switches() {
        let small_gap = vec![cursor_move(0.0, 0.1, 0.1), cursor_move(30.0, 0.2, 0.2)];
        assert!(matches!(densify_cursor_moves(&small_gap), Cow::Borrowed(_)));

        let mut cursor_switch = vec![cursor_move(0.0, 0.1, 0.1), cursor_move(100.0, 0.8, 0.8)];
        cursor_switch[1].cursor_id = "text".into();
        assert!(matches!(
            densify_cursor_moves(&cursor_switch),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn spring_context_detects_dragging_between_clicks() {
        let clicks = vec![click_event(100.0, true), click_event(360.0, false)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(280.0);
        assert_eq!(context.profile(280.0), SpringProfile::Drag);

        context.advance_to(620.0);
        assert_eq!(context.profile(620.0), SpringProfile::Default);
    }

    #[test]
    fn spring_context_switches_to_snappy_near_click_events() {
        let clicks = vec![click_event(80.0, true), click_event(140.0, false)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(80.0);
        assert_eq!(context.profile(80.0), SpringProfile::Snappy);

        context.advance_to(340.0);
        assert_eq!(context.profile(340.0), SpringProfile::Default);
    }
}
