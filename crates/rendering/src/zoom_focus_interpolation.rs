use cap_project::{ClickSpringConfig, CursorEvents, ScreenMovementSpring, XY, ZoomSegment};

use crate::{
    Coord, RawDisplayUVSpace,
    cursor_interpolation::{
        InterpolatedCursorPosition, interpolate_cursor, interpolate_cursor_with_click_spring,
    },
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

struct ZoomFocusPrecomputeSim {
    sim: SpringMassDamperSimulation,
    last_integrated_ms: f64,
}

const SAMPLE_INTERVAL_MS: f64 = 8.0;
const CLUSTER_WIDTH_RATIO: f64 = 0.5;
const CLUSTER_HEIGHT_RATIO: f64 = 0.7;

#[derive(Clone)]
struct SmoothedFocusEvent {
    time: f64,
    position: XY<f32>,
}

struct ClickCluster {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    start_time_ms: f64,
}

impl ClickCluster {
    fn new(x: f64, y: f64, time_ms: f64) -> Self {
        Self {
            min_x: x,
            max_x: x,
            min_y: y,
            max_y: y,
            start_time_ms: time_ms,
        }
    }

    fn can_add(&self, x: f64, y: f64, max_w: f64, max_h: f64) -> bool {
        let new_w = self.max_x.max(x) - self.min_x.min(x);
        let new_h = self.max_y.max(y) - self.min_y.min(y);
        new_w <= max_w && new_h <= max_h
    }

    fn add(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
    }

    fn center(&self) -> (f64, f64) {
        (
            (self.min_x + self.max_x) / 2.0,
            (self.min_y + self.max_y) / 2.0,
        )
    }
}

fn build_clusters(
    cursor_events: &CursorEvents,
    segment_start_secs: f64,
    segment_end_secs: f64,
    zoom_amount: f64,
) -> Vec<ClickCluster> {
    let start_ms = segment_start_secs * 1000.0;
    let end_ms = segment_end_secs * 1000.0;
    let cluster_w = CLUSTER_WIDTH_RATIO / zoom_amount;
    let cluster_h = CLUSTER_HEIGHT_RATIO / zoom_amount;

    let events_in_range: Vec<&cap_project::CursorMoveEvent> = cursor_events
        .moves
        .iter()
        .filter(|m| m.time_ms >= start_ms && m.time_ms <= end_ms)
        .collect();

    if events_in_range.is_empty() {
        let fallback = cursor_events
            .moves
            .iter()
            .rev()
            .find(|m| m.time_ms <= start_ms)
            .or_else(|| cursor_events.moves.iter().find(|m| m.time_ms >= start_ms));

        if let Some(evt) = fallback {
            return vec![ClickCluster::new(evt.x, evt.y, evt.time_ms)];
        }
        return vec![];
    }

    let mut clusters = Vec::new();
    let first = events_in_range[0];
    let mut current = ClickCluster::new(first.x, first.y, first.time_ms);

    for evt in &events_in_range[1..] {
        if current.can_add(evt.x, evt.y, cluster_w, cluster_h) {
            current.add(evt.x, evt.y);
        } else {
            clusters.push(current);
            current = ClickCluster::new(evt.x, evt.y, evt.time_ms);
        }
    }
    clusters.push(current);

    clusters
}

fn cluster_center_at_time(clusters: &[ClickCluster], time_ms: f64) -> Option<(f64, f64)> {
    clusters
        .iter()
        .rev()
        .find(|c| c.start_time_ms <= time_ms)
        .or_else(|| clusters.first())
        .map(|c| c.center())
}

struct SegmentClusters {
    start_secs: f64,
    end_secs: f64,
    clusters: Vec<ClickCluster>,
}

pub struct ZoomFocusInterpolator {
    events: Option<Vec<SmoothedFocusEvent>>,
    precompute_sim: Option<ZoomFocusPrecomputeSim>,
    cursor_events: std::sync::Arc<CursorEvents>,
    cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
    click_spring: ClickSpringConfig,
    screen_spring: ScreenMovementSpring,
    duration_secs: f64,
    segment_clusters: Vec<SegmentClusters>,
}

impl ZoomFocusInterpolator {
    pub fn new(
        cursor_events: &CursorEvents,
        cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
        click_spring: ClickSpringConfig,
        screen_spring: ScreenMovementSpring,
        duration_secs: f64,
        zoom_segments: &[ZoomSegment],
    ) -> Self {
        let segment_clusters = Self::build_segment_clusters(cursor_events, zoom_segments);
        Self {
            events: None,
            precompute_sim: None,
            cursor_events: std::sync::Arc::new(cursor_events.clone()),
            cursor_smoothing,
            click_spring,
            screen_spring,
            duration_secs,
            segment_clusters,
        }
    }

    pub fn new_arc(
        cursor_events: std::sync::Arc<CursorEvents>,
        cursor_smoothing: Option<SpringMassDamperSimulationConfig>,
        click_spring: ClickSpringConfig,
        screen_spring: ScreenMovementSpring,
        duration_secs: f64,
        zoom_segments: &[ZoomSegment],
    ) -> Self {
        let segment_clusters = Self::build_segment_clusters(cursor_events.as_ref(), zoom_segments);
        Self {
            events: None,
            precompute_sim: None,
            cursor_events,
            cursor_smoothing,
            click_spring,
            screen_spring,
            duration_secs,
            segment_clusters,
        }
    }

    fn build_segment_clusters(
        cursor_events: &CursorEvents,
        zoom_segments: &[ZoomSegment],
    ) -> Vec<SegmentClusters> {
        zoom_segments
            .iter()
            .filter(|s| matches!(s.mode, cap_project::ZoomMode::Auto))
            .map(|s| SegmentClusters {
                start_secs: s.start,
                end_secs: s.end,
                clusters: build_clusters(cursor_events, s.start, s.end, s.amount),
            })
            .collect()
    }

    fn cluster_focus_at(&self, time_secs: f64) -> Option<(f64, f64)> {
        let time_ms = time_secs * 1000.0;
        self.segment_clusters
            .iter()
            .find(|sc| time_secs > sc.start_secs && time_secs <= sc.end_secs)
            .and_then(|sc| cluster_center_at_time(&sc.clusters, time_ms))
    }

    fn interpolate_cursor_at(&self, time_secs: f32) -> Option<InterpolatedCursorPosition> {
        match self.cursor_smoothing {
            Some(cfg) => interpolate_cursor_with_click_spring(
                self.cursor_events.as_ref(),
                time_secs,
                Some(cfg),
                Some(self.click_spring),
            ),
            None => interpolate_cursor(self.cursor_events.as_ref(), time_secs, None),
        }
    }

    fn focus_target_at(&self, time_secs: f32) -> XY<f32> {
        if let Some((cx, cy)) = self.cluster_focus_at(time_secs as f64) {
            return XY::new(cx as f32, cy as f32);
        }

        if let Some(cursor) = self.interpolate_cursor_at(time_secs) {
            XY::new(
                cursor.position.coord.x as f32,
                cursor.position.coord.y as f32,
            )
        } else {
            XY::new(0.5, 0.5)
        }
    }

    pub fn ensure_precomputed_until(&mut self, time_secs: f32) {
        let duration_ms = self.duration_secs * 1000.0;
        let need_ms = (f64::from(time_secs) * 1000.0).clamp(0.0, duration_ms);

        if self.cursor_events.moves.is_empty() {
            if self.events.is_none() {
                self.events = Some(vec![]);
            }
            return;
        }

        if let Some(ref events) = self.events
            && let Some(last) = events.last()
            && last.time + f64::EPSILON >= need_ms
        {
            return;
        }

        if self.events.is_none() {
            let spring_config = SpringMassDamperSimulationConfig {
                tension: self.screen_spring.stiffness,
                mass: self.screen_spring.mass,
                friction: self.screen_spring.damping,
            };
            let mut sim = SpringMassDamperSimulation::new(spring_config);
            let initial_pos = self.focus_target_at(0.0);
            sim.set_position(initial_pos);
            sim.set_velocity(XY::new(0.0, 0.0));
            sim.set_target_position(initial_pos);
            self.events = Some(vec![SmoothedFocusEvent {
                time: 0.0,
                position: initial_pos,
            }]);
            self.precompute_sim = Some(ZoomFocusPrecomputeSim {
                sim,
                last_integrated_ms: 0.0,
            });
        }

        loop {
            let (next_ms, step_ms) = {
                let Some(ps) = self.precompute_sim.as_ref() else {
                    break;
                };
                if ps.last_integrated_ms + f64::EPSILON >= need_ms {
                    break;
                }
                let next_ms = (ps.last_integrated_ms + SAMPLE_INTERVAL_MS).min(duration_ms);
                if next_ms <= ps.last_integrated_ms + f64::EPSILON {
                    break;
                }
                let step_ms = next_ms - ps.last_integrated_ms;
                (next_ms, step_ms)
            };
            let time_secs = (next_ms / 1000.0) as f32;
            let target = self.focus_target_at(time_secs);
            let Some(ps) = self.precompute_sim.as_mut() else {
                break;
            };
            let Some(events) = self.events.as_mut() else {
                break;
            };
            ps.sim.set_target_position(target);
            ps.sim.run(step_ms as f32);
            ps.last_integrated_ms = next_ms;
            events.push(SmoothedFocusEvent {
                time: next_ms,
                position: XY::new(
                    ps.sim.position.x.clamp(0.0, 1.0),
                    ps.sim.position.y.clamp(0.0, 1.0),
                ),
            });
        }

        if let Some(ps) = self.precompute_sim.as_ref()
            && ps.last_integrated_ms + f64::EPSILON >= duration_ms
        {
            self.precompute_sim = None;
        }
    }

    pub fn precompute(&mut self) {
        self.ensure_precomputed_until(self.duration_secs as f32);
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
        let target = self.focus_target_at(time_secs);
        Coord::new(XY::new(target.x as f64, target.y as f64))
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
