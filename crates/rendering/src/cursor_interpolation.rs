use std::borrow::Cow;

use cap_project::{ClickSpringConfig, CursorClickEvent, CursorEvents, CursorMoveEvent, XY};

use crate::{
    Coord, RawDisplayUVSpace,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

const CLICK_LOOKAHEAD_TARGET_MS: f64 = 500.0;
const CLICK_SPRING_WINDOW_MS: f64 = 175.0;
const SHAKE_THRESHOLD_UV: f64 = 0.015;
const SHAKE_DETECTION_WINDOW_MS: f64 = 100.0;
const DECIMATE_FPS: f64 = 60.0;
const DECIMATE_MIN_DIST_UV: f64 = 1.0 / 1920.0;
const SIMULATION_STEP_MS: f64 = 1000.0 / 60.0;
const SPRING_SETTLE_EXTRA_MS: f64 = 300.0;

const DEFAULT_CLICK_SPRING: SpringMassDamperSimulationConfig = SpringMassDamperSimulationConfig {
    tension: 530.0,
    mass: 1.0,
    friction: 40.0,
};

const DRAG_SPRING: SpringMassDamperSimulationConfig = SpringMassDamperSimulationConfig {
    tension: 1000.0,
    mass: 1.0,
    friction: 40.0,
};

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
            .unwrap_or(DEFAULT_CLICK_SPRING);

        Self {
            default: base,
            snappy,
            drag: DRAG_SPRING,
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

struct CursorSpringContext<'a> {
    clicks: &'a [CursorClickEvent],
    next_click_index: usize,
    primary_button_down: bool,
}

impl<'a> CursorSpringContext<'a> {
    fn new(clicks: &'a [cap_project::CursorClickEvent]) -> Self {
        Self {
            clicks,
            next_click_index: 0,
            primary_button_down: false,
        }
    }

    fn advance_to(&mut self, time_ms: f64) {
        while let Some(click) = self.clicks.get(self.next_click_index)
            && click.time_ms <= time_ms
        {
            if click.cursor_num == 0 {
                self.primary_button_down = click.down;
            }
            self.next_click_index += 1;
        }
    }

    fn profile(&self, time_ms: f64) -> SpringProfile {
        if self.has_imminent_click(time_ms) {
            SpringProfile::Snappy
        } else if self.primary_button_down {
            SpringProfile::Drag
        } else {
            SpringProfile::Default
        }
    }

    fn has_imminent_click(&self, time_ms: f64) -> bool {
        self.clicks
            .iter()
            .any(|c| c.time_ms > time_ms && c.time_ms - time_ms <= CLICK_SPRING_WINDOW_MS)
    }
}

fn next_click_within(
    clicks: &[CursorClickEvent],
    time_ms: f64,
    window_ms: f64,
) -> Option<&CursorClickEvent> {
    clicks
        .iter()
        .find(|c| c.time_ms > time_ms && c.time_ms - time_ms <= window_ms)
}

fn position_at_time(moves: &[CursorMoveEvent], time_ms: f64) -> (f64, f64) {
    if moves.is_empty() {
        return (0.0, 0.0);
    }
    if time_ms <= moves[0].time_ms {
        return (moves[0].x, moves[0].y);
    }
    if let Some(last) = moves.last()
        && time_ms >= last.time_ms
    {
        return (last.x, last.y);
    }
    moves
        .windows(2)
        .find_map(|w| {
            if time_ms >= w[0].time_ms && time_ms < w[1].time_ms {
                let dt = w[1].time_ms - w[0].time_ms;
                if dt > IDLE_GAP_THRESHOLD_MS {
                    return Some((w[0].x, w[0].y));
                }
                let u = if dt.abs() < 1e-9 {
                    0.0
                } else {
                    (time_ms - w[0].time_ms) / dt
                };
                Some((
                    w[0].x + (w[1].x - w[0].x) * u,
                    w[0].y + (w[1].y - w[0].y) * u,
                ))
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            let l = moves.last().unwrap();
            (l.x, l.y)
        })
}

const IDLE_GAP_THRESHOLD_MS: f64 = SIMULATION_STEP_MS * 4.0;

fn position_at_time_hinted(
    moves: &[CursorMoveEvent],
    time_ms: f64,
    hint: &mut usize,
) -> (f64, f64) {
    while *hint + 1 < moves.len() && moves[*hint + 1].time_ms <= time_ms {
        *hint += 1;
    }

    let m = &moves[*hint];
    if *hint + 1 < moves.len() {
        let next = &moves[*hint + 1];
        if time_ms >= m.time_ms && time_ms < next.time_ms {
            let dt = next.time_ms - m.time_ms;
            if dt > IDLE_GAP_THRESHOLD_MS {
                return (m.x, m.y);
            }
            if dt > 1e-9 {
                let u = (time_ms - m.time_ms) / dt;
                return (m.x + (next.x - m.x) * u, m.y + (next.y - m.y) * u);
            }
        }
    }
    (m.x, m.y)
}

fn cursor_id_at_time(moves: &[CursorMoveEvent], _time_ms: f64, hint: usize) -> &str {
    if hint < moves.len() {
        return &moves[hint].cursor_id;
    }
    &moves.last().unwrap().cursor_id
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
    if cursor.moves.is_empty() {
        return None;
    }

    let time_ms = (time_secs * 1000.0) as f64;

    if let Some(smoothing_config) = smoothing {
        let filtered_moves = filter_cursor_shake(&cursor.moves);
        let prepared_moves = decimate_cursor_moves(filtered_moves.as_ref());
        let timeline = build_smoothed_timeline(
            cursor,
            prepared_moves.as_ref(),
            smoothing_config,
            click_spring,
        );
        interpolate_timeline(&timeline, time_ms)
    } else {
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

        cursor.moves.windows(2).find_map(|chunk| {
            if time_ms >= chunk[0].time_ms && time_ms < chunk[1].time_ms {
                let c = &chunk[0];
                let next = &chunk[1];
                let delta_ms = (next.time_ms - c.time_ms) as f32;
                let dt = (delta_ms / 1000.0).max(0.000_1);
                let velocity = XY::new(((next.x - c.x) as f32) / dt, ((next.y - c.y) as f32) / dt);
                Some(InterpolatedCursorPosition {
                    position: Coord::new(XY {
                        x: c.x,
                        y: c.y,
                    }),
                    velocity,
                    cursor_id: c.cursor_id.clone(),
                })
            } else {
                None
            }
        })
    }
}

fn build_smoothed_timeline(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
    click_spring: Option<ClickSpringConfig>,
) -> Vec<SmoothedCursorEvent> {
    if moves.is_empty() {
        return vec![];
    }

    let presets = CursorSpringPresets::new(smoothing_config, click_spring);
    let mut context = CursorSpringContext::new(&cursor.clicks);
    let mut sim = SpringMassDamperSimulation::new(smoothing_config);

    let start_pos = XY::new(moves[0].x as f32, moves[0].y as f32);
    sim.set_position(start_pos);
    sim.set_velocity(XY::new(0.0, 0.0));
    sim.set_target_position(start_pos);

    let end_time_ms = moves.last().unwrap().time_ms;
    let settle_end = end_time_ms + SPRING_SETTLE_EXTRA_MS;

    let capacity = ((settle_end / SIMULATION_STEP_MS).ceil() as usize) + 2;
    let mut events = Vec::with_capacity(capacity);
    let mut move_hint: usize = 0;

    events.push(SmoothedCursorEvent {
        time: 0.0,
        position: start_pos,
        velocity: XY::new(0.0, 0.0),
        cursor_id: moves[0].cursor_id.clone(),
    });

    let mut t_ms = SIMULATION_STEP_MS;

    while t_ms <= settle_end {
        let clamped_t = t_ms.min(end_time_ms);

        let (cx, cy) = position_at_time_hinted(moves, clamped_t, &mut move_hint);
        let cid = cursor_id_at_time(moves, clamped_t, move_hint).to_string();

        let target = if let Some(click) =
            next_click_within(&cursor.clicks, t_ms, CLICK_LOOKAHEAD_TARGET_MS)
        {
            let (tx, ty) = position_at_time(moves, click.time_ms.min(end_time_ms));
            XY::new(tx as f32, ty as f32)
        } else {
            XY::new(cx as f32, cy as f32)
        };

        sim.set_target_position(target);

        context.advance_to(t_ms);
        sim.set_config(presets.config(context.profile(t_ms)));

        sim.run(SIMULATION_STEP_MS as f32);

        events.push(SmoothedCursorEvent {
            time: t_ms as f32,
            position: XY::new(
                sim.position.x.clamp(0.0, 1.0),
                sim.position.y.clamp(0.0, 1.0),
            ),
            velocity: sim.velocity,
            cursor_id: cid,
        });

        t_ms += SIMULATION_STEP_MS;
    }

    events
}

fn interpolate_timeline(
    events: &[SmoothedCursorEvent],
    query_ms: f64,
) -> Option<InterpolatedCursorPosition> {
    if events.is_empty() {
        return None;
    }

    let query = query_ms as f32;

    if query <= events[0].time {
        let e = &events[0];
        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
            velocity: e.velocity,
            cursor_id: e.cursor_id.clone(),
        });
    }

    if query >= events.last().unwrap().time {
        let e = events.last().unwrap();
        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
            velocity: e.velocity,
            cursor_id: e.cursor_id.clone(),
        });
    }

    let first_time = events[0].time;
    let step = if events.len() > 1 {
        events[1].time - events[0].time
    } else {
        SIMULATION_STEP_MS as f32
    };

    let raw_idx = ((query - first_time) / step) as usize;
    let idx = raw_idx.min(events.len().saturating_sub(2));

    let (a, b) =
        if events[idx].time <= query && idx + 1 < events.len() && query < events[idx + 1].time {
            (&events[idx], &events[idx + 1])
        } else {
            match events
                .windows(2)
                .find(|w| w[0].time <= query && query < w[1].time)
            {
                Some(w) => (&w[0], &w[1]),
                None => {
                    let e = events.last().unwrap();
                    return Some(InterpolatedCursorPosition {
                        position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
                        velocity: e.velocity,
                        cursor_id: e.cursor_id.clone(),
                    });
                }
            }
        };

    let dt = b.time - a.time;
    let t = if dt.abs() < 1e-6 {
        0.0
    } else {
        ((query - a.time) / dt).clamp(0.0, 1.0)
    };
    let inv = 1.0 - t;

    Some(InterpolatedCursorPosition {
        position: Coord::new(XY::new(
            (a.position.x * inv + b.position.x * t) as f64,
            (a.position.y * inv + b.position.y * t) as f64,
        )),
        velocity: XY::new(
            a.velocity.x * inv + b.velocity.x * t,
            a.velocity.y * inv + b.velocity.y * t,
        ),
        cursor_id: a.cursor_id.clone(),
    })
}

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

fn decimate_cursor_moves<'a>(moves: &'a [CursorMoveEvent]) -> Cow<'a, [CursorMoveEvent]> {
    if moves.len() < 2 {
        return Cow::Borrowed(moves);
    }

    let frame_ms = (1000.0 / DECIMATE_FPS).floor();

    let mut out = Vec::with_capacity(moves.len());
    out.push(moves[0].clone());

    for i in 1..moves.len() {
        let curr = &moves[i];
        let last_kept = out.last().unwrap();
        if curr.cursor_id != last_kept.cursor_id {
            out.push(curr.clone());
            continue;
        }
        if i + 1 >= moves.len() {
            out.push(curr.clone());
            break;
        }
        let next = &moves[i + 1];
        let quick_succ = next.time_ms - last_kept.time_ms < frame_ms;
        let dx = curr.x - last_kept.x;
        let dy = curr.y - last_kept.y;
        let small = (dx * dx + dy * dy).sqrt() < DECIMATE_MIN_DIST_UV;
        if quick_succ || small {
            continue;
        }
        out.push(curr.clone());
    }

    if out.len() == moves.len() {
        Cow::Borrowed(moves)
    } else {
        Cow::Owned(out)
    }
}

#[derive(Debug)]
struct SmoothedCursorEvent {
    time: f32,
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
    fn decimate_thins_burst_moves() {
        let moves: Vec<_> = (0..20)
            .map(|i| cursor_move(i as f64 * 2.0, 0.5 + i as f64 * 1e-6, 0.5))
            .collect();
        let decimated = decimate_cursor_moves(&moves);
        match decimated {
            Cow::Owned(v) => assert!(v.len() < moves.len()),
            Cow::Borrowed(_) => {}
        }
    }

    #[test]
    fn spring_context_detects_dragging_between_clicks() {
        let clicks = vec![click_event(100.0, true), click_event(500.0, false)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(280.0);
        assert_eq!(context.profile(280.0), SpringProfile::Drag);

        context.advance_to(450.0);
        assert_eq!(context.profile(450.0), SpringProfile::Snappy);

        context.advance_to(620.0);
        assert_eq!(context.profile(620.0), SpringProfile::Default);
    }

    #[test]
    fn spring_context_snappy_before_imminent_click() {
        let clicks = vec![click_event(200.0, true)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(50.0);
        assert_eq!(context.profile(50.0), SpringProfile::Snappy);
    }

    #[test]
    fn spring_context_default_when_click_far() {
        let clicks = vec![click_event(2000.0, true)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(100.0);
        assert_eq!(context.profile(100.0), SpringProfile::Default);
    }

    #[test]
    fn smoothed_timeline_has_no_jumps() {
        let moves = vec![
            cursor_move(0.0, 0.1, 0.1),
            cursor_move(100.0, 0.2, 0.2),
            cursor_move(200.0, 0.3, 0.3),
            cursor_move(450.0, 0.5, 0.5),
            cursor_move(600.0, 0.8, 0.3),
        ];
        let clicks = vec![click_event(500.0, true)];
        let cursor = CursorEvents { moves, clicks };

        let smoothing = SpringMassDamperSimulationConfig {
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
        };

        let mut prev: Option<InterpolatedCursorPosition> = None;
        for t_ms in (0..700).step_by(1) {
            let t_secs = t_ms as f32 / 1000.0;
            let pos = interpolate_cursor_with_click_spring(&cursor, t_secs, Some(smoothing), None);
            if let (Some(p), Some(cur)) = (&prev, &pos) {
                let dx = (cur.position.coord.x - p.position.coord.x).abs();
                let dy = (cur.position.coord.y - p.position.coord.y).abs();
                assert!(
                    dx < 0.02 && dy < 0.02,
                    "jump at t={t_ms}ms: dx={dx:.6}, dy={dy:.6}"
                );
            }
            prev = pos;
        }
    }
}
