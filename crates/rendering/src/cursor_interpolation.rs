use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
};

use cap_project::{ClickSpringConfig, CursorClickEvent, CursorEvents, CursorMoveEvent, XY};

use crate::{
    Coord, RawDisplayUVSpace,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

/// Click anticipation windows: the spring target snaps to the click position
/// once the next click is <=500ms away, and the spring
/// profile stiffens 175ms before the click. The early snap relies on the
/// spring gliding there; no extra heuristics.
const CLICK_LOOKAHEAD_TARGET_MS: f64 = 500.0;
const CLICK_SPRING_WINDOW_MS: f64 = 175.0;
const SHAKE_THRESHOLD_UV: f64 = 0.015;
const SHAKE_DETECTION_WINDOW_MS: f64 = 100.0;
const DECIMATE_FPS: f64 = 60.0;
const DECIMATE_MIN_DIST_UV: f64 = 1.0 / 1920.0;
const SIMULATION_STEP_MS: f64 = 1000.0 / 60.0;
const SPRING_SETTLE_EXTRA_MS: f64 = 300.0;
/// Per-step one-pole coefficient for adapting the phase lead when the active
/// spring profile changes; ~130ms time constant at the 60Hz simulation step,
/// so profile switches ease in without popping the target.
const LEAD_SMOOTHING: f64 = 0.12;

/// A spring-mass-damper chasing a moving target trails it by friction/tension
/// seconds at steady state (independent of mass). Sampling the target that far
/// ahead cancels the trail so the smoothed cursor sits where the real cursor
/// was at render time instead of visibly lagging behind the video.
fn spring_lag_ms(config: &SpringMassDamperSimulationConfig) -> f64 {
    if config.tension <= 0.0 {
        return 0.0;
    }
    f64::from(config.friction / config.tension) * 1000.0
}

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
        let idx = self.clicks[self.next_click_index..].partition_point(|c| c.time_ms <= time_ms);
        self.clicks
            .get(self.next_click_index + idx)
            .is_some_and(|c| c.time_ms - time_ms <= CLICK_SPRING_WINDOW_MS)
    }
}

fn next_click_within(
    clicks: &[CursorClickEvent],
    time_ms: f64,
    window_ms: f64,
) -> Option<&CursorClickEvent> {
    let idx = clicks.partition_point(|c| c.time_ms <= time_ms);
    clicks.get(idx).filter(|c| c.time_ms - time_ms <= window_ms)
}

fn position_at_time(
    moves: &[CursorMoveEvent],
    time_ms: f64,
    moves_are_ordered: bool,
) -> (f64, f64) {
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
    let window = if moves_are_ordered && !time_ms.is_nan() {
        let end = moves.partition_point(|event| event.time_ms <= time_ms);
        end.checked_sub(1).and_then(|start| moves.get(start..=end))
    } else {
        moves
            .windows(2)
            .find(|w| time_ms >= w[0].time_ms && time_ms < w[1].time_ms)
    };
    window
        .and_then(|w| {
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
    while *hint > 0 && moves[*hint].time_ms > time_ms {
        *hint -= 1;
    }
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
        interpolate_raw_cursor(cursor, time_ms)
    }
}

fn interpolate_raw_cursor(
    cursor: &CursorEvents,
    time_ms: f64,
) -> Option<InterpolatedCursorPosition> {
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

    cursor.moves.windows(2).find_map(|chunk| {
        if time_ms >= chunk[0].time_ms && time_ms < chunk[1].time_ms {
            let c = &chunk[0];
            let next = &chunk[1];
            let delta_ms = (next.time_ms - c.time_ms) as f32;
            let dt = (delta_ms / 1000.0).max(0.000_1);
            let velocity = XY::new(((next.x - c.x) as f32) / dt, ((next.y - c.y) as f32) / dt);
            Some(InterpolatedCursorPosition {
                position: Coord::new(XY { x: c.x, y: c.y }),
                velocity,
                cursor_id: c.cursor_id.clone(),
            })
        } else {
            None
        }
    })
}

const CURSOR_VARIANT_CACHE_CAPACITY: usize = 2;

struct CursorTimelineVariant {
    settings: [u32; 6],
    timeline: Arc<PrecomputedCursorTimeline>,
}

pub struct PrecomputedCursorTimeline {
    timeline: Vec<SmoothedCursorEvent>,
    raw_cursor: CursorEvents,
    has_smoothing: bool,
    variants: Mutex<Vec<CursorTimelineVariant>>,
}

impl PrecomputedCursorTimeline {
    pub fn new(
        cursor: &CursorEvents,
        smoothing: Option<SpringMassDamperSimulationConfig>,
        click_spring: Option<ClickSpringConfig>,
    ) -> Self {
        if cursor.moves.is_empty() || smoothing.is_none() {
            return Self {
                timeline: vec![],
                raw_cursor: cursor.clone(),
                has_smoothing: false,
                variants: Mutex::new(Vec::new()),
            };
        }

        let smoothing_config = smoothing.unwrap();
        let filtered_moves = filter_cursor_shake(&cursor.moves);
        let prepared_moves = decimate_cursor_moves(filtered_moves.as_ref());
        let timeline = build_smoothed_timeline(
            cursor,
            prepared_moves.as_ref(),
            smoothing_config,
            click_spring,
        );

        Self {
            timeline,
            raw_cursor: CursorEvents::default(),
            has_smoothing: true,
            variants: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn cached_variant(
        &self,
        cursor: &CursorEvents,
        smoothing: SpringMassDamperSimulationConfig,
        click_spring: ClickSpringConfig,
    ) -> Arc<Self> {
        let settings = [
            smoothing.tension.to_bits(),
            smoothing.mass.to_bits(),
            smoothing.friction.to_bits(),
            click_spring.tension.to_bits(),
            click_spring.mass.to_bits(),
            click_spring.friction.to_bits(),
        ];
        let mut variants = self.variants.lock().unwrap();
        if let Some(index) = variants.iter().position(|entry| entry.settings == settings) {
            let entry = variants.remove(index);
            let timeline = Arc::clone(&entry.timeline);
            variants.push(entry);
            return timeline;
        }

        let timeline = Arc::new(Self::new(cursor, Some(smoothing), Some(click_spring)));
        if variants.len() == CURSOR_VARIANT_CACHE_CAPACITY {
            variants.remove(0);
        }
        variants.push(CursorTimelineVariant {
            settings,
            timeline: Arc::clone(&timeline),
        });
        timeline
    }

    pub fn interpolate(&self, time_secs: f32) -> Option<InterpolatedCursorPosition> {
        let time_ms = (time_secs * 1000.0) as f64;
        if self.has_smoothing {
            interpolate_timeline(&self.timeline, time_ms)
        } else {
            interpolate_raw_cursor(&self.raw_cursor, time_ms)
        }
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

    let moves_are_ordered =
        !cursor.clicks.is_empty() && moves.is_sorted_by(|a, b| a.time_ms <= b.time_ms);
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
    let mut target_hint: usize = 0;
    let mut cid_hint: usize = 0;

    events.push(SmoothedCursorEvent {
        time: 0.0,
        position: start_pos,
        velocity: XY::new(0.0, 0.0),
        cursor_id: moves[0].cursor_id.clone(),
    });

    let mut t_ms = SIMULATION_STEP_MS;
    let mut lead_ms = spring_lag_ms(&smoothing_config);

    while t_ms <= settle_end {
        let clamped_t = t_ms.min(end_time_ms);

        context.advance_to(t_ms);
        let config = presets.config(context.profile(t_ms));
        sim.set_config(config);
        lead_ms += (spring_lag_ms(&config) - lead_ms) * LEAD_SMOOTHING;

        // The spring's target leads the raw path by the profile's own lag so
        // the smoothed output lands on the real cursor position at time t.
        // The drawn cursor icon must not lead: it samples the raw timeline.
        let lead_t = (clamped_t + lead_ms).min(end_time_ms);
        let (cx, cy) = position_at_time_hinted(moves, lead_t, &mut target_hint);
        let _ = position_at_time_hinted(moves, clamped_t, &mut cid_hint);
        let cid = cursor_id_at_time(moves, clamped_t, cid_hint).to_string();

        let target = if let Some(click) =
            next_click_within(&cursor.clicks, t_ms, CLICK_LOOKAHEAD_TARGET_MS)
        {
            let (tx, ty) =
                position_at_time(moves, click.time_ms.min(end_time_ms), moves_are_ordered);
            XY::new(tx as f32, ty as f32)
        } else {
            XY::new(cx as f32, cy as f32)
        };

        sim.set_target_position(target);

        sim.run(SIMULATION_STEP_MS as f32);

        events.push(SmoothedCursorEvent {
            time: t_ms as f32,
            position: sim.position,
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
            let end = events.partition_point(|event| event.time <= query);
            match end
                .checked_sub(1)
                .and_then(|start| events.get(start..=end))
                .filter(|w| w[0].time <= query && query < w[1].time)
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
        if let Cow::Owned(v) = decimated {
            assert!(v.len() < moves.len());
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

        context.advance_to(100.0);
        assert_eq!(context.profile(100.0), SpringProfile::Snappy);
    }

    #[test]
    fn spring_context_default_when_click_far() {
        let clicks = vec![click_event(2000.0, true)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(100.0);
        assert_eq!(context.profile(100.0), SpringProfile::Default);
    }

    #[test]
    fn spring_context_stiffens_175ms_before_click() {
        let clicks = vec![click_event(300.0, true)];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(100.0);
        assert_eq!(context.profile(100.0), SpringProfile::Default);

        context.advance_to(150.0);
        assert_eq!(context.profile(150.0), SpringProfile::Snappy);
    }

    #[test]
    fn click_target_snap_glides_ahead_of_click() {
        let mut moves: Vec<_> = (0..=5)
            .map(|i| cursor_move(f64::from(i) * 100.0, 0.1, 0.1))
            .collect();
        moves.push(cursor_move(600.0, 0.9, 0.9));
        let clicks = vec![click_event(600.0, true)];
        let cursor = CursorEvents { moves, clicks };

        let smoothing = SpringMassDamperSimulationConfig {
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
        };

        let x_at = |t_ms: f64| {
            interpolate_cursor_with_click_spring(
                &cursor,
                (t_ms / 1000.0) as f32,
                Some(smoothing),
                None,
            )
            .unwrap()
            .position
            .coord
            .x
        };

        // The click at 600ms enters the 500ms lookahead window at t=100ms:
        // before that the spring rests on the raw path, after it the target
        // is the click position and the spring glides there early.
        let before_window = x_at(80.0);
        assert!(
            before_window < 0.12,
            "moved before lookahead window opened: x={before_window:.4}"
        );

        let mid_glide = x_at(300.0);
        assert!(
            mid_glide > 0.4,
            "no anticipation glide toward click by t=300ms: x={mid_glide:.4}"
        );

        let near_click = x_at(590.0);
        assert!(
            near_click > 0.8,
            "cursor not near click position just before click: x={near_click:.4}"
        );
    }

    #[test]
    fn smoothed_cursor_tracks_moving_target_without_lag() {
        // Constant-velocity motion: 0.2 UV/s along x for 3 seconds, sampled
        // every 10ms like the real recorder.
        let velocity_uv_per_ms = 0.0002;
        let moves: Vec<_> = (0..=300)
            .map(|i| {
                let t = i as f64 * 10.0;
                cursor_move(t, 0.1 + t * velocity_uv_per_ms, 0.5)
            })
            .collect();
        let cursor = CursorEvents {
            moves,
            clicks: vec![],
        };

        let smoothing = SpringMassDamperSimulationConfig {
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
        };

        // Without phase-lead compensation the spring trails a moving target
        // by friction/tension = 149ms, i.e. ~0.030 UV at this velocity. The
        // compensated output must sit within a couple of simulation steps of
        // the true position throughout steady-state motion.
        for t_ms in [1000.0f64, 1500.0, 2000.0, 2500.0] {
            let smoothed = interpolate_cursor_with_click_spring(
                &cursor,
                (t_ms / 1000.0) as f32,
                Some(smoothing),
                None,
            )
            .unwrap();
            let expected_x = 0.1 + t_ms * velocity_uv_per_ms;
            let err = (smoothed.position.coord.x - expected_x).abs();
            assert!(
                err < 0.01,
                "smoothed cursor off by {err:.4} UV ({:.0}ms of motion) at t={t_ms}ms",
                err / velocity_uv_per_ms
            );
        }
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
    fn linear_position_at_time(moves: &[CursorMoveEvent], time_ms: f64) -> (f64, f64) {
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

    fn linear_build_smoothed_timeline(
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
        let mut target_hint: usize = 0;
        let mut cid_hint: usize = 0;

        events.push(SmoothedCursorEvent {
            time: 0.0,
            position: start_pos,
            velocity: XY::new(0.0, 0.0),
            cursor_id: moves[0].cursor_id.clone(),
        });

        let mut t_ms = SIMULATION_STEP_MS;
        let mut lead_ms = spring_lag_ms(&smoothing_config);

        while t_ms <= settle_end {
            let clamped_t = t_ms.min(end_time_ms);

            context.advance_to(t_ms);
            let config = presets.config(context.profile(t_ms));
            sim.set_config(config);
            lead_ms += (spring_lag_ms(&config) - lead_ms) * LEAD_SMOOTHING;

            let lead_t = (clamped_t + lead_ms).min(end_time_ms);
            let (cx, cy) = position_at_time_hinted(moves, lead_t, &mut target_hint);
            let _ = position_at_time_hinted(moves, clamped_t, &mut cid_hint);
            let cid = cursor_id_at_time(moves, clamped_t, cid_hint).to_string();

            let target = if let Some(click) =
                next_click_within(&cursor.clicks, t_ms, CLICK_LOOKAHEAD_TARGET_MS)
            {
                let (tx, ty) = linear_position_at_time(moves, click.time_ms.min(end_time_ms));
                XY::new(tx as f32, ty as f32)
            } else {
                XY::new(cx as f32, cy as f32)
            };

            sim.set_target_position(target);

            sim.run(SIMULATION_STEP_MS as f32);

            events.push(SmoothedCursorEvent {
                time: t_ms as f32,
                position: sim.position,
                velocity: sim.velocity,
                cursor_id: cid,
            });

            t_ms += SIMULATION_STEP_MS;
        }

        events
    }

    fn linear_interpolate_timeline(
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

        let (a, b) = if events[idx].time <= query
            && idx + 1 < events.len()
            && query < events[idx + 1].time
        {
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

    fn assert_position_bits(
        expected: Option<InterpolatedCursorPosition>,
        actual: Option<InterpolatedCursorPosition>,
    ) {
        match (expected, actual) {
            (None, None) => {}
            (Some(expected), Some(actual)) => {
                assert_eq!(
                    expected.position.coord.x.to_bits(),
                    actual.position.coord.x.to_bits()
                );
                assert_eq!(
                    expected.position.coord.y.to_bits(),
                    actual.position.coord.y.to_bits()
                );
                assert_eq!(expected.velocity.x.to_bits(), actual.velocity.x.to_bits());
                assert_eq!(expected.velocity.y.to_bits(), actual.velocity.y.to_bits());
                assert_eq!(expected.cursor_id, actual.cursor_id);
            }
            (expected, actual) => panic!("cursor position mismatch: {expected:?} != {actual:?}"),
        }
    }

    fn assert_timeline_bits(expected: &[SmoothedCursorEvent], actual: &[SmoothedCursorEvent]) {
        assert_eq!(expected.len(), actual.len());
        for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
            assert_eq!(
                expected.time.to_bits(),
                actual.time.to_bits(),
                "time at {index}"
            );
            assert_eq!(
                expected.position.x.to_bits(),
                actual.position.x.to_bits(),
                "position.x at {index}"
            );
            assert_eq!(
                expected.position.y.to_bits(),
                actual.position.y.to_bits(),
                "position.y at {index}"
            );
            assert_eq!(
                expected.velocity.x.to_bits(),
                actual.velocity.x.to_bits(),
                "velocity.x at {index}"
            );
            assert_eq!(
                expected.velocity.y.to_bits(),
                actual.velocity.y.to_bits(),
                "velocity.y at {index}"
            );
            assert_eq!(expected.cursor_id, actual.cursor_id, "cursor_id at {index}");
        }
    }

    fn sampled_event(time: f32, index: usize) -> SmoothedCursorEvent {
        SmoothedCursorEvent {
            time,
            position: XY::new(index as f32 * 0.013, index as f32 * -0.007),
            velocity: XY::new(index as f32 * -0.002, index as f32 * 0.003),
            cursor_id: (index % 3).to_string(),
        }
    }

    fn dense_cursor(duration_secs: usize) -> CursorEvents {
        CursorEvents {
            moves: (0..=duration_secs * 120)
                .map(|index| {
                    let mut event = cursor_move(
                        index as f64 * 1000.0 / 120.0,
                        (index % 479) as f64 / 479.0,
                        (index % 283) as f64 / 283.0,
                    );
                    event.cursor_id = (index / 31 % 3).to_string();
                    event
                })
                .collect(),
            clicks: (1..duration_secs * 2)
                .map(|index| click_event(index as f64 * 500.0, index % 2 != 0))
                .collect(),
        }
    }

    #[test]
    fn smoothed_timeline_releases_unused_raw_events_without_changing_output() {
        let cursor = dense_cursor(8);
        let filtered = filter_cursor_shake(&cursor.moves);
        let moves = decimate_cursor_moves(filtered.as_ref());
        let expected = linear_build_smoothed_timeline(
            &cursor,
            &moves,
            DEFAULT_CLICK_SPRING,
            Some(ClickSpringConfig::default()),
        );
        let timeline = PrecomputedCursorTimeline::new(
            &cursor,
            Some(DEFAULT_CLICK_SPRING),
            Some(ClickSpringConfig::default()),
        );

        assert!(timeline.has_smoothing);
        assert!(timeline.raw_cursor.moves.is_empty());
        assert!(timeline.raw_cursor.clicks.is_empty());
        assert_timeline_bits(&expected, &timeline.timeline);
        drop(moves);
        drop(filtered);
        drop(cursor);

        for index in 0..=500 {
            let time_secs = index as f32 * 0.017_137;
            assert_position_bits(
                linear_interpolate_timeline(&expected, (time_secs * 1000.0) as f64),
                timeline.interpolate(time_secs),
            );
        }
    }

    #[test]
    fn style_cursor_variants_preserve_motion_and_click_spring_output() {
        let cursor = dense_cursor(3);
        let base = PrecomputedCursorTimeline::new(
            &cursor,
            Some(DEFAULT_CLICK_SPRING),
            Some(ClickSpringConfig::default()),
        );
        for changed in 0..6 {
            let mut smoothing = DEFAULT_CLICK_SPRING;
            let mut click = ClickSpringConfig::default();
            match changed {
                0 => smoothing.tension += 100.0,
                1 => smoothing.mass += 0.5,
                2 => smoothing.friction += 10.0,
                3 => click.tension += 100.0,
                4 => click.mass += 0.5,
                _ => click.friction += 10.0,
            }
            let variant = base.cached_variant(&cursor, smoothing, click);
            for time in [-0.1, 0.0, 0.175, 0.5, 1.0, 1.5, 2.9, 3.5] {
                assert_position_bits(
                    interpolate_cursor_with_click_spring(
                        &cursor,
                        time,
                        Some(smoothing),
                        Some(click),
                    ),
                    variant.interpolate(time),
                );
            }
            let reused = base.cached_variant(&cursor, smoothing, click);
            assert!(Arc::ptr_eq(&variant, &reused));
        }
        assert!(base.raw_cursor.moves.is_empty());
        assert!(base.raw_cursor.clicks.is_empty());
    }

    #[test]
    fn style_cursor_variant_cache_evicts_unused_history_and_preserves_base() {
        let cursor = dense_cursor(2);
        let base = PrecomputedCursorTimeline::new(&cursor, Some(DEFAULT_CLICK_SPRING), None);
        let original = base.interpolate(0.8);
        let click = ClickSpringConfig::default();
        let a = DEFAULT_CLICK_SPRING;
        let b = SpringMassDamperSimulationConfig {
            tension: 800.0,
            ..a
        };
        let c = SpringMassDamperSimulationConfig {
            tension: 1100.0,
            ..a
        };
        let first = base.cached_variant(&cursor, a, click);
        let second = base.cached_variant(&cursor, b, click);
        let old_second = Arc::downgrade(&second);
        drop(second);
        assert!(Arc::ptr_eq(&first, &base.cached_variant(&cursor, a, click)));
        let third = base.cached_variant(&cursor, c, click);
        assert!(old_second.upgrade().is_none());
        assert_eq!(
            base.variants.lock().unwrap().len(),
            CURSOR_VARIANT_CACHE_CAPACITY
        );
        assert!(Arc::ptr_eq(&third, &base.cached_variant(&cursor, c, click)));
        assert_position_bits(original, base.interpolate(0.8));
        let first_output = first.interpolate(0.8);
        let weak_first = Arc::downgrade(&first);
        drop(base.cached_variant(&cursor, b, click));
        assert_eq!(Arc::strong_count(&first), 1);
        assert_position_bits(first_output, first.interpolate(0.8));
        drop(first);
        assert!(weak_first.upgrade().is_none());
        drop(third);
        drop(base);
    }

    #[test]
    fn style_cursor_variants_are_scoped_to_their_recording_source() {
        let first = dense_cursor(2);
        let mut second = first.clone();
        for event in &mut second.moves {
            event.x = 1.0 - event.x;
        }
        let a = PrecomputedCursorTimeline::new(&first, Some(DEFAULT_CLICK_SPRING), None);
        let b = PrecomputedCursorTimeline::new(&second, Some(DEFAULT_CLICK_SPRING), None);
        let smoothing = SpringMassDamperSimulationConfig {
            tension: 700.0,
            ..DEFAULT_CLICK_SPRING
        };
        let click = ClickSpringConfig::default();
        let av = a.cached_variant(&first, smoothing, click);
        let bv = b.cached_variant(&second, smoothing, click);
        assert!(!Arc::ptr_eq(&av, &bv));
        for time in [0.0, 0.2, 1.0, 1.9] {
            assert_position_bits(
                interpolate_cursor_with_click_spring(&first, time, Some(smoothing), Some(click)),
                av.interpolate(time),
            );
            assert_position_bits(
                interpolate_cursor_with_click_spring(&second, time, Some(smoothing), Some(click)),
                bv.interpolate(time),
            );
        }
    }

    #[test]
    fn concurrent_style_cursor_queries_share_one_variant() {
        let cursor = dense_cursor(3);
        let base = PrecomputedCursorTimeline::new(&cursor, Some(DEFAULT_CLICK_SPRING), None);
        let barrier = std::sync::Barrier::new(8);
        let variants = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        base.cached_variant(
                            &cursor,
                            DEFAULT_CLICK_SPRING,
                            ClickSpringConfig::default(),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(
            variants
                .iter()
                .all(|variant| Arc::ptr_eq(variant, &variants[0]))
        );
        assert_eq!(base.variants.lock().unwrap().len(), 1);
    }

    #[test]
    fn raw_and_empty_timelines_preserve_source_events() {
        let cursor = dense_cursor(2);
        let timeline = PrecomputedCursorTimeline::new(&cursor, None, None);
        assert!(!timeline.has_smoothing);
        assert_eq!(timeline.raw_cursor.moves.len(), cursor.moves.len());
        assert_eq!(timeline.raw_cursor.clicks.len(), cursor.clicks.len());
        for time_secs in [-1.0, 0.0, 0.017, 0.5, 1.0, 2.0, 3.0] {
            assert_position_bits(
                interpolate_cursor(&cursor, time_secs, None),
                timeline.interpolate(time_secs),
            );
        }

        let empty = CursorEvents {
            moves: Vec::new(),
            clicks: vec![click_event(100.0, true)],
        };
        let timeline = PrecomputedCursorTimeline::new(&empty, Some(DEFAULT_CLICK_SPRING), None);
        assert!(!timeline.has_smoothing);
        assert!(timeline.raw_cursor.moves.is_empty());
        assert_eq!(timeline.raw_cursor.clicks.len(), 1);
        assert!(timeline.interpolate(0.1).is_none());
    }

    #[test]
    fn cursor_position_lookup_matches_linear_reference() {
        let cases = [
            vec![],
            vec![0.0],
            vec![f64::NAN],
            vec![0.0, 0.0, 10.0, 10.0, 20.0, 100.0, 100.0],
            vec![-0.0, 0.0, 0.0, 10.0, 100.0],
            vec![0.0, 20.0, 10.0, 50.0, 100.0],
            vec![0.0, 10.0, f64::NAN, 30.0, 100.0],
            vec![f64::NAN, 10.0, 30.0, 100.0],
            vec![0.0, 10.0, 30.0, f64::NAN],
            vec![f64::NEG_INFINITY, 0.0, 10.0, f64::INFINITY],
            vec![0.0, 0.000_000_000_1, 20.0, 100.0],
        ];
        let queries = [
            f64::NEG_INFINITY,
            -1.0,
            -0.0,
            0.0,
            0.000_000_000_05,
            5.0,
            10.0,
            19.999,
            20.0,
            21.0,
            30.0,
            49.0,
            50.0,
            99.0,
            100.0,
            101.0,
            f64::INFINITY,
            f64::NAN,
        ];
        for times in cases {
            let moves: Vec<_> = times
                .iter()
                .enumerate()
                .map(|(index, &time)| cursor_move(time, index as f64 * 0.17, index as f64 * -0.11))
                .collect();
            let ordered = moves.is_sorted_by(|a, b| a.time_ms <= b.time_ms);
            for query in queries {
                let expected = linear_position_at_time(&moves, query);
                let actual = position_at_time(&moves, query, ordered);
                assert_eq!(
                    expected.0.to_bits(),
                    actual.0.to_bits(),
                    "x for {times:?} at {query}"
                );
                assert_eq!(
                    expected.1.to_bits(),
                    actual.1.to_bits(),
                    "y for {times:?} at {query}"
                );
            }
        }
    }

    #[test]
    fn complete_smoothed_timeline_matches_linear_reference() {
        for variant in 0..7 {
            let mut cursor = dense_cursor(8);
            match variant {
                1 => cursor.moves[50].time_ms = cursor.moves[49].time_ms,
                2 => cursor.moves.swap(50, 100),
                3 => cursor.moves[100].time_ms = f64::NAN,
                4 => cursor.clicks.reverse(),
                5 => cursor.clicks.clear(),
                6 => cursor.moves[100].time_ms = f64::NEG_INFINITY,
                _ => {}
            }
            let filtered = filter_cursor_shake(&cursor.moves);
            let moves = decimate_cursor_moves(filtered.as_ref());
            for config in [
                DEFAULT_CLICK_SPRING,
                DRAG_SPRING,
                SpringMassDamperSimulationConfig {
                    tension: 470.0,
                    mass: 3.0,
                    friction: 70.0,
                },
            ] {
                for click_spring in [None, Some(ClickSpringConfig::default())] {
                    let expected =
                        linear_build_smoothed_timeline(&cursor, &moves, config, click_spring);
                    let actual = build_smoothed_timeline(&cursor, &moves, config, click_spring);
                    assert_timeline_bits(&expected, &actual);
                    for index in 0..=500 {
                        let query = index as f64 * 17.137;
                        assert_position_bits(
                            linear_interpolate_timeline(&expected, query),
                            interpolate_timeline(&actual, query),
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn timeline_lookup_matches_linear_reference_at_long_times_and_duplicate_timestamps() {
        assert_position_bits(
            linear_interpolate_timeline(&[], 0.0),
            interpolate_timeline(&[], 0.0),
        );
        for duration_hours in [0.0, 1.0, 20.0] {
            for interval_ms in [1.0, SIMULATION_STEP_MS] {
                let origin_ms = duration_hours * 3_600_000.0;
                let events: Vec<_> = [0.0, SIMULATION_STEP_MS as f32]
                    .into_iter()
                    .chain(
                        (0..512)
                            .map(|index| (origin_ms + 100.0 + index as f64 * interval_ms) as f32),
                    )
                    .enumerate()
                    .map(|(index, time)| sampled_event(time, index))
                    .collect();
                for query in [
                    f64::NAN,
                    f64::NEG_INFINITY,
                    f64::INFINITY,
                    -1.0,
                    0.0,
                    origin_ms,
                    origin_ms + 10_000.0,
                ] {
                    assert_position_bits(
                        linear_interpolate_timeline(&events, query),
                        interpolate_timeline(&events, query),
                    );
                }
                for event in &events {
                    for query in [
                        event.time as f64 - 0.001,
                        event.time as f64,
                        event.time as f64 + 0.001,
                        event.time as f64 + interval_ms * 0.5,
                    ] {
                        assert_position_bits(
                            linear_interpolate_timeline(&events, query),
                            interpolate_timeline(&events, query),
                        );
                    }
                }
            }
        }
        let duplicate_origin: Vec<_> = [0.0, 0.0, 0.0, 16.0, 16.0, 32.0]
            .into_iter()
            .enumerate()
            .map(|(index, time)| sampled_event(time, index))
            .collect();
        for query in [-0.0, 0.0, 0.01, 8.0, 16.0, 16.01, 24.0, 32.0] {
            assert_position_bits(
                linear_interpolate_timeline(&duplicate_origin, query),
                interpolate_timeline(&duplicate_origin, query),
            );
        }
    }

    #[test]
    #[ignore]
    fn benchmark_dense_cursor_lookup_against_linear_reference() {
        use std::{hint::black_box, time::Instant};

        for duration_secs in [60, 600] {
            let cursor = dense_cursor(duration_secs);
            let filtered = filter_cursor_shake(&cursor.moves);
            let moves = decimate_cursor_moves(filtered.as_ref());
            let started = Instant::now();
            let expected =
                linear_build_smoothed_timeline(&cursor, &moves, DEFAULT_CLICK_SPRING, None);
            let baseline_time = started.elapsed();
            let started = Instant::now();
            let actual = build_smoothed_timeline(&cursor, &moves, DEFAULT_CLICK_SPRING, None);
            let optimized_time = started.elapsed();
            assert_timeline_bits(black_box(&expected), black_box(&actual));
            println!(
                "cursor_precompute duration_secs={duration_secs} moves={} clicks={} samples={} baseline_ms={:.3} optimized_ms={:.3}",
                moves.len(),
                cursor.clicks.len(),
                actual.len(),
                baseline_time.as_secs_f64() * 1000.0,
                optimized_time.as_secs_f64() * 1000.0
            );
        }

        let events: Vec<_> = (0..=20 * 60 * 60 * 60)
            .map(|index| {
                let mut event = sampled_event((index as f64 * SIMULATION_STEP_MS) as f32, index);
                event.cursor_id = String::new();
                event
            })
            .collect();
        let queries: Vec<_> = (0..128)
            .map(|index| 72_000_000.0 - index as f64 * 171.13 - 1.0)
            .collect();
        let started = Instant::now();
        let expected: Vec<_> = queries
            .iter()
            .map(|&query| linear_interpolate_timeline(black_box(&events), black_box(query)))
            .collect();
        let baseline_time = started.elapsed();
        let started = Instant::now();
        let actual: Vec<_> = queries
            .iter()
            .map(|&query| interpolate_timeline(black_box(&events), black_box(query)))
            .collect();
        let optimized_time = started.elapsed();
        for (expected, actual) in expected.into_iter().zip(actual) {
            assert_position_bits(expected, actual);
        }
        println!(
            "cursor_seek duration_hours=20 samples={} queries={} baseline_ms={:.3} optimized_ms={:.3}",
            events.len(),
            queries.len(),
            baseline_time.as_secs_f64() * 1000.0,
            optimized_time.as_secs_f64() * 1000.0
        );
    }
}
