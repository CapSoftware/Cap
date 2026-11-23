use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
};

use cap_project::{
    ClickSpringConfig, CursorClickEvent, CursorEvents, CursorMoveEvent, ProjectConfiguration, XY,
};

use crate::{
    Coord, RawDisplayUVSpace,
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
};

/// Click anticipation windows: the spring target snaps to the press position
/// once the next button press is <=500ms away, and the spring profile
/// stiffens 175ms before the press. The early snap relies on the spring
/// gliding there; no extra heuristics. Only presses are anticipated: a
/// release ends a drag, and aiming at it would pull the cursor to the drag's
/// end while the pointer is still travelling there.
const CLICK_LOOKAHEAD_TARGET_MS: f64 = 500.0;
const CLICK_SPRING_WINDOW_MS: f64 = 175.0;
const SHAKE_THRESHOLD_UV: f64 = 0.015;
const SHAKE_DETECTION_WINDOW_MS: f64 = 100.0;
const DECIMATE_FPS: f64 = 60.0;
const DECIMATE_MIN_DIST_UV: f64 = 1.0 / 1920.0;
const SIMULATION_STEP_MS: f64 = 1000.0 / 60.0;
const SPRING_SETTLE_TIMEOUT_MS: f64 = 5000.0;
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SpringProfile {
    Default,
    Snappy,
}

struct CursorSpringPresets {
    default: SpringMassDamperSimulationConfig,
    snappy: SpringMassDamperSimulationConfig,
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
        }
    }

    fn config(&self, profile: SpringProfile) -> SpringMassDamperSimulationConfig {
        match profile {
            SpringProfile::Default => self.default,
            SpringProfile::Snappy => self.snappy,
        }
    }
}

/// The recorder stores device_query's 1-based button numbers, so the primary
/// (left) button is 1. Slot 0 is never pressed there; it is accepted as
/// primary too so hand-written event files that count from 0 keep working.
fn is_primary_button(cursor_num: u8) -> bool {
    cursor_num <= 1
}

#[derive(Clone)]
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
            if is_primary_button(click.cursor_num) {
                self.primary_button_down = click.down;
            }
            self.next_click_index += 1;
        }
    }

    /// The click spring stiffens toward an upcoming press. While the primary
    /// button is held the pointer is dragging, so the cursor keeps the default
    /// spring and follows it instead.
    fn profile(&self, time_ms: f64) -> SpringProfile {
        if !self.primary_button_down && self.has_imminent_press(time_ms) {
            SpringProfile::Snappy
        } else {
            SpringProfile::Default
        }
    }

    fn has_imminent_press(&self, time_ms: f64) -> bool {
        next_press_within(
            &self.clicks[self.next_click_index..],
            time_ms,
            CLICK_SPRING_WINDOW_MS,
        )
        .is_some()
    }

    /// The press the spring target aims at: none while the primary button is
    /// held, since the pointer is dragging and must follow its recorded path.
    fn anticipated_press(&self, time_ms: f64) -> Option<&'a CursorClickEvent> {
        if self.primary_button_down {
            return None;
        }
        next_press_within(self.clicks, time_ms, CLICK_LOOKAHEAD_TARGET_MS)
    }
}

/// The first button press after `time_ms` and at most `window_ms` ahead.
/// Releases inside the window are skipped, not treated as targets.
fn next_press_within(
    clicks: &[CursorClickEvent],
    time_ms: f64,
    window_ms: f64,
) -> Option<&CursorClickEvent> {
    let idx = clicks.partition_point(|c| c.time_ms <= time_ms);
    clicks[idx..]
        .iter()
        .take_while(|c| c.time_ms - time_ms <= window_ms)
        .find(|c| c.down)
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
        interpolate_timeline(&timeline.events, &timeline.cursor_ids, time_ms)
    } else {
        interpolate_raw_cursor(cursor, time_ms, false)
    }
}

fn interpolate_raw_cursor(
    cursor: &CursorEvents,
    time_ms: f64,
    moves_are_ordered: bool,
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

    let chunk = if moves_are_ordered {
        let end = cursor
            .moves
            .partition_point(|event| event.time_ms <= time_ms);
        cursor.moves.get(end.checked_sub(1)?..=end)?
    } else {
        cursor
            .moves
            .windows(2)
            .find(|chunk| time_ms >= chunk[0].time_ms && time_ms < chunk[1].time_ms)?
    };
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
}

const CURSOR_VARIANT_CACHE_CAPACITY: usize = 2;

struct CursorTimelineVariant {
    settings: [u32; 8],
    timeline: Arc<PrecomputedCursorTimeline>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CursorEventOrder {
    pub(crate) moves: bool,
    pub(crate) clicks: bool,
}

impl CursorEventOrder {
    pub fn new(cursor: &CursorEvents) -> Self {
        Self {
            moves: cursor.moves.is_sorted_by(|a, b| a.time_ms <= b.time_ms),
            clicks: cursor
                .clicks
                .iter()
                .try_fold(f64::NEG_INFINITY, |previous, click| {
                    (previous <= click.time_ms).then_some(click.time_ms)
                })
                .is_some(),
        }
    }

    pub(crate) fn interpolate_raw(
        self,
        cursor: &CursorEvents,
        time_secs: f32,
    ) -> Option<InterpolatedCursorPosition> {
        interpolate_raw_cursor(cursor, (time_secs * 1000.0) as f64, self.moves)
    }
}

pub struct PrecomputedCursorTimeline {
    timeline: Vec<SmoothedCursorEvent>,
    cursor_ids: Vec<String>,
    raw_cursor: CursorEvents,
    event_order: CursorEventOrder,
    has_smoothing: bool,
    hover_changes_ms: Arc<[f64]>,
    variants: Mutex<Vec<CursorTimelineVariant>>,
}

/// Times (recording ms) where the UI under the pointer visibly changed, found
/// by analysing the screen video. Shared by a segment's editor, playback and
/// export; replacing them bumps the generation so cached timelines rebuild.
#[derive(Default)]
pub struct HoverChanges {
    times_ms: Mutex<Arc<[f64]>>,
    generation: std::sync::atomic::AtomicU64,
}

impl HoverChanges {
    pub fn new(times_ms: Vec<f64>) -> Self {
        Self {
            times_ms: Mutex::new(times_ms.into()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn times_ms(&self) -> Arc<[f64]> {
        Arc::clone(&self.times_ms.lock().unwrap())
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::Acquire)
    }

    /// The generation together with the times it belongs to, so a cache can
    /// never record a newer generation than the times it was built from.
    pub fn snapshot(&self) -> (u64, Arc<[f64]>) {
        let times_ms = self.times_ms.lock().unwrap();
        (self.generation(), Arc::clone(&times_ms))
    }

    pub fn replace(&self, times_ms: Vec<f64>) {
        let mut current = self.times_ms.lock().unwrap();
        *current = times_ms.into();
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// Which interactions a smoothed cursor is anchored to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CursorAnchors {
    pub interaction: bool,
    pub hover: bool,
}

impl CursorAnchors {
    pub fn from_config(cursor: &cap_project::CursorConfiguration) -> Self {
        Self {
            interaction: cursor.interaction_anchors,
            hover: cursor.interaction_anchors && cursor.hover_anchors,
        }
    }
}

impl PrecomputedCursorTimeline {
    pub fn new(
        cursor: &CursorEvents,
        smoothing: Option<SpringMassDamperSimulationConfig>,
        click_spring: Option<ClickSpringConfig>,
    ) -> Self {
        Self::new_with_anchors(
            cursor,
            smoothing,
            click_spring,
            CursorAnchors::default(),
            &[],
        )
    }

    pub fn new_with_anchors(
        cursor: &CursorEvents,
        smoothing: Option<SpringMassDamperSimulationConfig>,
        click_spring: Option<ClickSpringConfig>,
        anchors: CursorAnchors,
        hover_changes_ms: &[f64],
    ) -> Self {
        let event_order = CursorEventOrder::new(cursor);
        if cursor.moves.is_empty() || smoothing.is_none() {
            return Self {
                timeline: vec![],
                cursor_ids: Vec::new(),
                raw_cursor: cursor.clone(),
                event_order,
                has_smoothing: false,
                hover_changes_ms: hover_changes_ms.into(),
                variants: Mutex::new(Vec::new()),
            };
        }

        let smoothing_config = smoothing.unwrap();
        let filtered_moves = filter_cursor_shake(&cursor.moves);
        let prepared_moves = decimate_cursor_moves(filtered_moves.as_ref());
        let built = if anchors.interaction {
            let with_drag_samples = keep_drag_samples(&cursor.moves, &cursor.clicks);
            build_anchored_timeline(
                cursor,
                with_drag_samples
                    .as_deref()
                    .unwrap_or(prepared_moves.as_ref()),
                smoothing_config,
                click_spring,
                if anchors.hover { hover_changes_ms } else { &[] },
            )
        } else {
            build_smoothed_timeline(
                cursor,
                prepared_moves.as_ref(),
                smoothing_config,
                click_spring,
            )
        };

        Self {
            timeline: built.events,
            cursor_ids: built.cursor_ids,
            raw_cursor: CursorEvents::default(),
            event_order,
            has_smoothing: true,
            hover_changes_ms: hover_changes_ms.into(),
            variants: Mutex::new(Vec::new()),
        }
    }

    /// Spring settings match playback and export: the base cursor, with style
    /// overrides applied later by `ProjectUniforms::new_with_precomputed_cursor`.
    pub fn from_project(
        cursor: &CursorEvents,
        hover_changes_ms: &[f64],
        project: &ProjectConfiguration,
    ) -> Self {
        let smoothing = (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });
        Self::new_with_anchors(
            cursor,
            smoothing,
            Some(project.cursor.click_spring_config()),
            CursorAnchors::from_config(&project.cursor),
            hover_changes_ms,
        )
    }

    pub(crate) fn cached_variant(
        &self,
        cursor: &CursorEvents,
        smoothing: SpringMassDamperSimulationConfig,
        click_spring: ClickSpringConfig,
        anchors: CursorAnchors,
    ) -> Arc<Self> {
        let settings = [
            smoothing.tension.to_bits(),
            smoothing.mass.to_bits(),
            smoothing.friction.to_bits(),
            click_spring.tension.to_bits(),
            click_spring.mass.to_bits(),
            click_spring.friction.to_bits(),
            u32::from(anchors.interaction),
            u32::from(anchors.hover),
        ];
        let mut variants = self.variants.lock().unwrap();
        if let Some(index) = variants.iter().position(|entry| entry.settings == settings) {
            let entry = variants.remove(index);
            let timeline = Arc::clone(&entry.timeline);
            variants.push(entry);
            return timeline;
        }

        let timeline = Arc::new(Self::new_with_anchors(
            cursor,
            Some(smoothing),
            Some(click_spring),
            anchors,
            &self.hover_changes_ms,
        ));
        if variants.len() == CURSOR_VARIANT_CACHE_CAPACITY {
            variants.remove(0);
        }
        variants.push(CursorTimelineVariant {
            settings,
            timeline: Arc::clone(&timeline),
        });
        timeline
    }

    pub(crate) fn event_order(&self) -> CursorEventOrder {
        self.event_order
    }

    pub fn interpolate(&self, time_secs: f32) -> Option<InterpolatedCursorPosition> {
        let time_ms = (time_secs * 1000.0) as f64;
        if self.has_smoothing {
            interpolate_timeline(&self.timeline, &self.cursor_ids, time_ms)
        } else {
            interpolate_raw_cursor(&self.raw_cursor, time_ms, self.event_order.moves)
        }
    }

    // Style overrides use the same source events as this timeline's constructor.
    pub(crate) fn interpolate_raw(
        &self,
        cursor: &CursorEvents,
        time_secs: f32,
    ) -> Option<InterpolatedCursorPosition> {
        self.event_order.interpolate_raw(cursor, time_secs)
    }
}

struct SmoothedTimeline {
    events: Vec<SmoothedCursorEvent>,
    cursor_ids: Vec<String>,
}

/// Unique cursor images for one spring build. Steps store an index so a long
/// recording does not allocate a `String` at every 60 Hz sample.
struct CursorIdIndex {
    ids: Vec<String>,
    last: Option<u32>,
}

impl CursorIdIndex {
    fn new() -> Self {
        Self {
            ids: Vec::new(),
            last: None,
        }
    }

    fn intern(&mut self, id: &str) -> u32 {
        if let Some(last) = self.last
            && self.ids[last as usize] == id
        {
            return last;
        }
        if let Some(index) = self.ids.iter().position(|existing| existing == id) {
            let index = index as u32;
            self.last = Some(index);
            return index;
        }
        let index = self.ids.len() as u32;
        self.ids.push(id.to_owned());
        self.last = Some(index);
        index
    }
}

fn cursor_id_string(cursor_ids: &[String], index: u32) -> String {
    cursor_ids[index as usize].clone()
}

fn build_smoothed_timeline(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
    click_spring: Option<ClickSpringConfig>,
) -> SmoothedTimeline {
    if moves.is_empty() {
        return SmoothedTimeline {
            events: vec![],
            cursor_ids: Vec::new(),
        };
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
    let settle_deadline = end_time_ms + SPRING_SETTLE_TIMEOUT_MS;

    let capacity = ((settle_deadline / SIMULATION_STEP_MS).ceil() as usize) + 2;
    let mut events = Vec::with_capacity(capacity);
    let mut target_hint: usize = 0;
    let mut cid_hint: usize = 0;
    let mut cursor_ids = CursorIdIndex::new();

    events.push(SmoothedCursorEvent {
        time: 0.0,
        position: start_pos,
        velocity: XY::new(0.0, 0.0),
        cursor_id: cursor_ids.intern(&moves[0].cursor_id),
    });

    let mut t_ms = SIMULATION_STEP_MS;
    let mut lead_ms = spring_lag_ms(&smoothing_config);

    while t_ms <= settle_deadline {
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
        let cursor_id = cursor_ids.intern(cursor_id_at_time(moves, clamped_t, cid_hint));

        let target = if let Some(click) = context.anticipated_press(t_ms) {
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
            cursor_id,
        });

        if t_ms >= end_time_ms && sim.is_at_rest() {
            break;
        }

        t_ms += SIMULATION_STEP_MS;
    }

    SmoothedTimeline {
        events,
        cursor_ids: cursor_ids.ids,
    }
}

/// Interaction anchors: moments where the rendered cursor has to sit on the
/// recorded pointer because something visible happens there (a press or
/// release, every sample of a drag, a cursor shape change). Tolerances are in
/// points of a nominal 1920x1080 display, since cursor events only store
/// display-relative positions; smaller captures make them stricter. Presses
/// and drags mark an exact spot (a button edge, the end of a drawn line), so
/// the tip must land within 2 pt, under the width of the arrow's point. A
/// hover change lights up a whole control, so 4 pt keeps the tip inside the
/// edge that lit up. A shape change is tied to an element, not a pixel, so
/// 6 pt is enough.
const ANCHOR_NOMINAL_DISPLAY: (f64, f64) = (1920.0, 1080.0);
const ANCHOR_CLICK_TOLERANCE: f64 = 2.0;
const ANCHOR_DRAG_TOLERANCE: f64 = 2.0;
const ANCHOR_HOVER_TOLERANCE: f64 = 4.0;
const ANCHOR_CURSOR_IMAGE_TOLERANCE: f64 = 6.0;
/// Anchors closer than this share one tightening: a drag samples every
/// ~16 ms and a click's press and release are ~80 ms apart, so each stays one
/// group instead of easing in and out between samples.
const ANCHOR_GROUP_GAP_MS: f64 = 100.0;
/// A group is met when every anchor is within this share of its tolerance,
/// leaving headroom for the 60 Hz step interpolation between samples.
const ANCHOR_ACCEPTED_ERROR_RATIO: f64 = 0.75;
/// Spring speed-ups tried around a group: the spring runs this many times
/// faster (tension x s^2, friction x s, so the damping ratio is unchanged).
/// Steps of about 25% keep the chosen speed-up close to the smallest that
/// works; at 32x the default spring's lag is under 5 ms, well inside a frame.
const ANCHOR_SPEED_LEVELS: [f64; 16] = [
    1.0, 1.25, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.4, 8.0, 10.0, 13.0, 16.0, 20.0, 25.0, 32.0,
];
/// The phase lead shrinks with the speed-up so the cursor keeps landing on the
/// pointer. These cap how fast the lead may change (ms of lead per ms), which
/// bounds how much the spring target slows down before a group (to 0.65x) and
/// catches up after it (to 1.4x).
const ANCHOR_LEAD_DECAY_PER_MS: f64 = 0.35;
/// Aiming at an upcoming press fades in over this long instead of jumping,
/// so a cursor that was just held on the pointer (by a shape or hover change on the
/// way) glides to the press rather than lurching there.
const ANCHOR_PRESS_AIM_BLEND_MS: f64 = 150.0;
const ANCHOR_LEAD_RISE_PER_MS: f64 = 0.4;

#[derive(Clone, Copy, Debug)]
struct InteractionAnchor {
    time_ms: f64,
    tolerance: f64,
    kind: AnchorKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AnchorKind {
    Click,
    Drag,
    Hover,
    CursorImage,
}

impl AnchorKind {
    fn tolerance(self) -> f64 {
        match self {
            Self::Click => ANCHOR_CLICK_TOLERANCE,
            Self::Drag => ANCHOR_DRAG_TOLERANCE,
            Self::Hover => ANCHOR_HOVER_TOLERANCE,
            Self::CursorImage => ANCHOR_CURSOR_IMAGE_TOLERANCE,
        }
    }
}

#[derive(Debug)]
struct AnchorGroup {
    start_ms: f64,
    end_ms: f64,
    anchors: std::ops::Range<usize>,
}

/// Spans where the primary button is held, in time order.
fn primary_drags(clicks: &[CursorClickEvent]) -> Vec<(f64, f64)> {
    let mut clicks: Vec<&CursorClickEvent> = clicks
        .iter()
        .filter(|click| is_primary_button(click.cursor_num))
        .collect();
    clicks.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let mut drags = Vec::new();
    let mut drag_start = None;
    for click in clicks {
        match (click.down, drag_start) {
            (true, None) => drag_start = Some(click.time_ms),
            (false, Some(start)) => {
                drags.push((start, click.time_ms));
                drag_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = drag_start {
        drags.push((start, f64::INFINITY));
    }
    drags
}

fn drag_at(drags: &[(f64, f64)], time_ms: f64) -> Option<usize> {
    let next = drags.partition_point(|&(start, _)| start < time_ms);
    next.checked_sub(1)
        .filter(|&index| time_ms < drags[index].1)
}

/// Shake filtering and thinning would drop samples a drag has to meet, so
/// samples inside a drag are kept exactly as recorded and only the moves
/// between drags are filtered. `None` when there is nothing to keep.
fn keep_drag_samples(
    moves: &[CursorMoveEvent],
    clicks: &[CursorClickEvent],
) -> Option<Vec<CursorMoveEvent>> {
    let drags = primary_drags(clicks);
    if !moves
        .iter()
        .any(|event| drag_at(&drags, event.time_ms).is_some())
    {
        return None;
    }

    let mut kept = Vec::with_capacity(moves.len());
    let mut start = 0;
    while start < moves.len() {
        let inside = drag_at(&drags, moves[start].time_ms).is_some();
        let end = moves[start..]
            .iter()
            .position(|event| drag_at(&drags, event.time_ms).is_some() != inside)
            .map_or(moves.len(), |offset| start + offset);
        let run = &moves[start..end];
        if inside {
            kept.extend_from_slice(run);
        } else {
            let filtered = filter_cursor_shake(run);
            kept.extend_from_slice(decimate_cursor_moves(filtered.as_ref()).as_ref());
        }
        start = end;
    }
    Some(kept)
}

/// A gap in the samples normally means the pointer stood still, so the path
/// holds there and then moves on. Inside a drag that reading is wrong when
/// the recorder missed samples: the pointer kept moving, and the jump after
/// the gap covers about as much ground per millisecond as the pointer did
/// going into it. Only those gaps are filled in a straight line. A pause
/// moves far less per millisecond across the gap and keeps the hold.
fn fill_drag_gaps<'a>(
    moves: &'a [CursorMoveEvent],
    clicks: &[CursorClickEvent],
) -> Cow<'a, [CursorMoveEvent]> {
    const MIN_SPEED_RATIO: f64 = 0.5;
    let drags = primary_drags(clicks);
    let speed = |from: &CursorMoveEvent, to: &CursorMoveEvent| {
        let dt = to.time_ms - from.time_ms;
        ((to.x - from.x).hypot(to.y - from.y) / dt).max(0.0)
    };
    let missed_samples = |index: usize| {
        let (Some(previous), Some(from), Some(to)) = (
            index.checked_sub(1).and_then(|i| moves.get(i)),
            moves.get(index),
            moves.get(index + 1),
        ) else {
            return false;
        };
        let drag = drag_at(&drags, from.time_ms);
        let lead_in = from.time_ms - previous.time_ms;
        drag.is_some()
            && drag_at(&drags, previous.time_ms) == drag
            && drag_at(&drags, to.time_ms) == drag
            && to.time_ms - from.time_ms > IDLE_GAP_THRESHOLD_MS
            && lead_in > 0.0
            && lead_in <= IDLE_GAP_THRESHOLD_MS
            && speed(from, to) >= MIN_SPEED_RATIO * speed(previous, from)
            && speed(previous, from) > 0.0
    };
    if !(0..moves.len()).any(missed_samples) {
        return Cow::Borrowed(moves);
    }

    let mut filled = Vec::with_capacity(moves.len());
    for (index, from) in moves.iter().enumerate() {
        filled.push(from.clone());
        if missed_samples(index) {
            let to = &moves[index + 1];
            let gap = to.time_ms - from.time_ms;
            let steps = (gap / SIMULATION_STEP_MS).ceil() as usize;
            for step in 1..steps {
                let u = step as f64 / steps as f64;
                filled.push(CursorMoveEvent {
                    time_ms: from.time_ms + gap * u,
                    x: from.x + (to.x - from.x) * u,
                    y: from.y + (to.y - from.y) * u,
                    ..from.clone()
                });
            }
        }
    }
    Cow::Owned(filled)
}

fn interaction_anchors(
    cursor: &CursorEvents,
    start_ms: f64,
    end_ms: f64,
) -> Vec<InteractionAnchor> {
    let mut anchors = Vec::new();
    let mut push = |time_ms: f64, kind: AnchorKind| {
        if time_ms.is_finite() && time_ms >= start_ms && time_ms <= end_ms {
            anchors.push(InteractionAnchor {
                time_ms,
                tolerance: kind.tolerance(),
                kind,
            });
        }
    };

    for click in &cursor.clicks {
        push(click.time_ms, AnchorKind::Click);
    }
    let drags = primary_drags(&cursor.clicks);

    let mut drag_index = 0;
    let mut previous_id: Option<&str> = None;
    for event in &cursor.moves {
        if previous_id.is_some_and(|id| id != event.cursor_id) {
            push(event.time_ms, AnchorKind::CursorImage);
        }
        previous_id = Some(&event.cursor_id);

        while drags
            .get(drag_index)
            .is_some_and(|&(_, end)| end <= event.time_ms)
        {
            drag_index += 1;
        }
        if drags
            .get(drag_index)
            .is_some_and(|&(start, _)| start < event.time_ms)
        {
            push(event.time_ms, AnchorKind::Drag);
        }
    }

    anchors.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    anchors
}

fn group_anchors(anchors: &[InteractionAnchor]) -> Vec<AnchorGroup> {
    let mut groups: Vec<AnchorGroup> = Vec::new();
    for (index, anchor) in anchors.iter().enumerate() {
        if let Some(group) = groups.last_mut()
            && anchor.time_ms - group.end_ms <= ANCHOR_GROUP_GAP_MS
        {
            group.end_ms = anchor.time_ms;
            group.anchors.end = index + 1;
            continue;
        }
        groups.push(AnchorGroup {
            start_ms: anchor.time_ms,
            end_ms: anchor.time_ms,
            anchors: index..index + 1,
        });
    }
    groups
}

/// A spring speed-up held over `[start_ms, end_ms]`, eased in before and out
/// after. Stored as the lead scale `1 / speed` so overlapping speed-ups
/// combine by taking the smallest scale.
#[derive(Clone, Copy, Debug)]
struct SpeedBump {
    start_ms: f64,
    end_ms: f64,
    scale: f64,
    ramp_in_ms: f64,
    ramp_out_ms: f64,
}

impl SpeedBump {
    fn new(group: &AnchorGroup, speed: f64, base_lead_ms: f64) -> Self {
        let scale = 1.0 / speed;
        Self {
            start_ms: group.start_ms,
            end_ms: group.end_ms,
            scale,
            ramp_in_ms: base_lead_ms * (1.0 - scale) / ANCHOR_LEAD_DECAY_PER_MS,
            ramp_out_ms: base_lead_ms * (1.0 - scale) / ANCHOR_LEAD_RISE_PER_MS,
        }
    }

    fn scale_at(&self, time_ms: f64) -> f64 {
        if time_ms < self.start_ms {
            let before = self.start_ms - time_ms;
            if before >= self.ramp_in_ms {
                return 1.0;
            }
            self.scale + (1.0 - self.scale) * before / self.ramp_in_ms
        } else if time_ms > self.end_ms {
            let after = time_ms - self.end_ms;
            if after >= self.ramp_out_ms {
                return 1.0;
            }
            self.scale + (1.0 - self.scale) * after / self.ramp_out_ms
        } else {
            self.scale
        }
    }
}

#[derive(Default)]
struct SpeedSchedule {
    bumps: Vec<SpeedBump>,
    longest_ramp_out_ms: f64,
}

impl SpeedSchedule {
    fn push(&mut self, bump: SpeedBump) {
        self.longest_ramp_out_ms = self.longest_ramp_out_ms.max(bump.ramp_out_ms);
        self.bumps.push(bump);
    }

    /// Bumps are pushed in group order, so only the ones whose ease-out can
    /// still reach `time_ms` need checking.
    fn scale_at(&self, time_ms: f64, candidate: Option<&SpeedBump>) -> f64 {
        let mut scale = candidate.map_or(1.0, |bump| bump.scale_at(time_ms));
        for bump in self.bumps.iter().rev() {
            if bump.end_ms + self.longest_ramp_out_ms < time_ms {
                break;
            }
            scale = scale.min(bump.scale_at(time_ms));
        }
        scale
    }
}

#[derive(Clone)]
struct AnchoredSimulation<'a> {
    sim: SpringMassDamperSimulation,
    context: CursorSpringContext<'a>,
    lead_ms: f64,
    target: XY<f32>,
    target_hint: usize,
    step: usize,
}

struct AnchoredPlanner<'a> {
    moves: &'a [CursorMoveEvent],
    presets: CursorSpringPresets,
    moves_are_ordered: bool,
    end_time_ms: f64,
    /// Anchors that are not presses or drags, in time order: the cursor has
    /// to pass through these on its way to a press.
    waypoints: Vec<f64>,
}

impl<'a> AnchoredPlanner<'a> {
    fn step_time(step: usize) -> f64 {
        step as f64 * SIMULATION_STEP_MS
    }

    fn waypoint_between(&self, from_ms: f64, to_ms: f64) -> bool {
        let next = self.waypoints.partition_point(|&time| time <= from_ms);
        self.waypoints.get(next).is_some_and(|&time| time < to_ms)
    }

    fn last_waypoint_by(&self, time_ms: f64) -> Option<f64> {
        let next = self.waypoints.partition_point(|&time| time <= time_ms);
        next.checked_sub(1).map(|index| self.waypoints[index])
    }

    /// One 60 Hz step, mirroring `build_smoothed_timeline` except that the
    /// spring runs `1 / scale` times faster with its lead scaled to match, the
    /// target moves continuously through the step instead of jumping at step
    /// boundaries, and an upcoming press is only aimed at early when no other
    /// anchor (a shape or hover change) comes first: aiming early pulls the cursor off
    /// the pointer it still has to meet on the way.
    fn advance(&self, state: &mut AnchoredSimulation<'a>, scale: f64) {
        state.step += 1;
        let t_ms = Self::step_time(state.step);
        let clamped_t = t_ms.min(self.end_time_ms);

        state.context.advance_to(t_ms);
        let config = self.presets.config(state.context.profile(t_ms));
        state.lead_ms += (spring_lag_ms(&config) - state.lead_ms) * LEAD_SMOOTHING;

        let speed = (1.0 / scale) as f32;
        state.sim.set_config(SpringMassDamperSimulationConfig {
            tension: config.tension * speed * speed,
            mass: config.mass,
            friction: config.friction * speed,
        });

        let press = state
            .context
            .anticipated_press(t_ms)
            .filter(|click| !self.waypoint_between(t_ms - SIMULATION_STEP_MS, click.time_ms));
        let lead_t = (clamped_t + state.lead_ms * scale).min(self.end_time_ms);
        let (x, y) = position_at_time_hinted(self.moves, lead_t, &mut state.target_hint);
        let along_path = XY::new(x as f32, y as f32);
        let target = if let Some(click) = press {
            let (x, y) = position_at_time(
                self.moves,
                click.time_ms.min(self.end_time_ms),
                self.moves_are_ordered,
            );
            let aim_from = (click.time_ms - CLICK_LOOKAHEAD_TARGET_MS)
                .max(self.last_waypoint_by(t_ms).unwrap_or(f64::NEG_INFINITY));
            let aim = ((t_ms - aim_from) / ANCHOR_PRESS_AIM_BLEND_MS).clamp(0.0, 1.0) as f32;
            XY::new(
                along_path.x + (x as f32 - along_path.x) * aim,
                along_path.y + (y as f32 - along_path.y) * aim,
            )
        } else {
            along_path
        };

        let step_secs = (SIMULATION_STEP_MS / 1000.0) as f32;
        let target_velocity = XY::new(
            (target.x - state.target.x) / step_secs,
            (target.y - state.target.y) / step_secs,
        );
        state.sim.set_target_position(state.target);
        state
            .sim
            .run_toward_moving_target(SIMULATION_STEP_MS as f32, target_velocity);
        state.sim.set_target_position(target);
        state.target = target;
    }

    /// Worst anchor error in the group, as a share of each anchor's tolerance,
    /// when the group gets `candidate`. Stops early once past `give_up_above`.
    fn group_error(
        &self,
        start: &AnchoredSimulation<'a>,
        schedule: &SpeedSchedule,
        candidate: Option<&SpeedBump>,
        group: &AnchorGroup,
        anchors: &[InteractionAnchor],
        give_up_above: f64,
    ) -> f64 {
        let mut state = start.clone();
        let mut previous = state.sim.position;
        let mut worst: f64 = 0.0;
        let mut position_hint = start.target_hint;
        for anchor in &anchors[group.anchors.clone()] {
            while Self::step_time(state.step) < anchor.time_ms {
                previous = state.sim.position;
                let next_t = Self::step_time(state.step + 1);
                self.advance(&mut state, schedule.scale_at(next_t, candidate));
            }
            let t1 = Self::step_time(state.step);
            let t0 = t1 - SIMULATION_STEP_MS;
            let u = if state.step == 0 {
                1.0
            } else {
                ((anchor.time_ms - t0) / SIMULATION_STEP_MS).clamp(0.0, 1.0) as f32
            };
            let x = f64::from(previous.x + (state.sim.position.x - previous.x) * u);
            let y = f64::from(previous.y + (state.sim.position.y - previous.y) * u);
            let (px, py) = position_at_time_hinted(self.moves, anchor.time_ms, &mut position_hint);
            let error =
                ((x - px) * ANCHOR_NOMINAL_DISPLAY.0).hypot((y - py) * ANCHOR_NOMINAL_DISPLAY.1);
            worst = worst.max(error / anchor.tolerance);
            if worst > give_up_above {
                break;
            }
        }
        worst
    }

    /// The smallest speed-up that meets the group, or the best one tried when
    /// none does.
    fn choose_speed(
        &self,
        start: &AnchoredSimulation<'a>,
        schedule: &SpeedSchedule,
        group: &AnchorGroup,
        anchors: &[InteractionAnchor],
        base_lead_ms: f64,
    ) -> Option<SpeedBump> {
        let error_at = |level: usize, give_up_above: f64| -> f64 {
            let bump = (level > 0)
                .then(|| SpeedBump::new(group, ANCHOR_SPEED_LEVELS[level], base_lead_ms));
            self.group_error(
                start,
                schedule,
                bump.as_ref(),
                group,
                anchors,
                give_up_above,
            )
        };
        let meets = |level: usize| {
            error_at(level, ANCHOR_ACCEPTED_ERROR_RATIO) <= ANCHOR_ACCEPTED_ERROR_RATIO
        };

        if meets(0) {
            return None;
        }
        let mut low = 0;
        let mut high = ANCHOR_SPEED_LEVELS.len() - 1;
        let chosen = if !meets(high) {
            if error_at(0, f64::INFINITY) < error_at(high, f64::INFINITY) {
                0
            } else {
                high
            }
        } else {
            while high - low > 1 {
                let mid = (low + high) / 2;
                if meets(mid) {
                    high = mid;
                } else {
                    low = mid;
                }
            }
            high
        };
        (chosen > 0).then(|| SpeedBump::new(group, ANCHOR_SPEED_LEVELS[chosen], base_lead_ms))
    }
}

/// `build_smoothed_timeline` with interaction anchors: around each anchor
/// group the spring is sped up just enough for the cursor to meet the pointer
/// there, then eased back. Between groups the motion is the plain spring.
/// Planning is one forward pass in recording time, so seeking, edits and
/// export all read the same precomputed path.
fn build_anchored_timeline(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
    click_spring: Option<ClickSpringConfig>,
    hover_changes_ms: &[f64],
) -> SmoothedTimeline {
    if moves.is_empty() {
        return SmoothedTimeline {
            events: vec![],
            cursor_ids: Vec::new(),
        };
    }

    let filled = fill_drag_gaps(moves, &cursor.clicks);
    let moves = filled.as_ref();
    let end_time_ms = moves.last().unwrap().time_ms;
    let mut anchors = interaction_anchors(cursor, moves[0].time_ms, end_time_ms);
    anchors.extend(
        hover_changes_ms
            .iter()
            .filter(|&&time_ms| time_ms >= moves[0].time_ms && time_ms <= end_time_ms)
            .map(|&time_ms| InteractionAnchor {
                time_ms,
                tolerance: AnchorKind::Hover.tolerance(),
                kind: AnchorKind::Hover,
            }),
    );
    anchors.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let planner = AnchoredPlanner {
        moves,
        presets: CursorSpringPresets::new(smoothing_config, click_spring),
        moves_are_ordered: !cursor.clicks.is_empty()
            && moves.is_sorted_by(|a, b| a.time_ms <= b.time_ms),
        end_time_ms,
        waypoints: anchors
            .iter()
            .filter(|anchor| matches!(anchor.kind, AnchorKind::CursorImage | AnchorKind::Hover))
            .map(|anchor| anchor.time_ms)
            .collect(),
    };
    let base_lead_ms = spring_lag_ms(&smoothing_config);
    let groups = group_anchors(&anchors);
    let longest_ramp_in_ms = base_lead_ms
        * (1.0 - 1.0 / ANCHOR_SPEED_LEVELS[ANCHOR_SPEED_LEVELS.len() - 1])
        / ANCHOR_LEAD_DECAY_PER_MS;

    let start_pos = XY::new(moves[0].x as f32, moves[0].y as f32);
    let mut sim = SpringMassDamperSimulation::new(smoothing_config);
    sim.set_position(start_pos);
    sim.set_velocity(XY::new(0.0, 0.0));
    sim.set_target_position(start_pos);
    let mut state = AnchoredSimulation {
        sim,
        context: CursorSpringContext::new(&cursor.clicks),
        lead_ms: base_lead_ms,
        target: start_pos,
        target_hint: 0,
        step: 0,
    };

    let settle_deadline = end_time_ms + SPRING_SETTLE_TIMEOUT_MS;
    let capacity = ((settle_deadline / SIMULATION_STEP_MS).ceil() as usize) + 2;
    let mut events = Vec::with_capacity(capacity);
    let mut cursor_ids = CursorIdIndex::new();
    let mut cid_hint: usize = 0;
    events.push(SmoothedCursorEvent {
        time: 0.0,
        position: start_pos,
        velocity: XY::new(0.0, 0.0),
        cursor_id: cursor_ids.intern(&moves[0].cursor_id),
    });

    let mut schedule = SpeedSchedule::default();
    let mut next_group = 0;

    loop {
        while let Some(group) = groups.get(next_group)
            && AnchoredPlanner::step_time(state.step + 1) > group.start_ms - longest_ramp_in_ms
        {
            if let Some(bump) =
                planner.choose_speed(&state, &schedule, group, &anchors, base_lead_ms)
            {
                schedule.push(bump);
            }
            next_group += 1;
        }

        let t_ms = AnchoredPlanner::step_time(state.step + 1);
        if t_ms > settle_deadline {
            break;
        }
        planner.advance(&mut state, schedule.scale_at(t_ms, None));

        let clamped_t = t_ms.min(end_time_ms);
        let _ = position_at_time_hinted(moves, clamped_t, &mut cid_hint);
        events.push(SmoothedCursorEvent {
            time: t_ms as f32,
            position: state.sim.position,
            velocity: state.sim.velocity,
            cursor_id: cursor_ids.intern(cursor_id_at_time(moves, clamped_t, cid_hint)),
        });

        if t_ms >= end_time_ms && next_group >= groups.len() && state.sim.is_at_rest() {
            break;
        }
    }

    SmoothedTimeline {
        events,
        cursor_ids: cursor_ids.ids,
    }
}

fn interpolate_timeline(
    events: &[SmoothedCursorEvent],
    cursor_ids: &[String],
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
            cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
        });
    }

    if query >= events.last().unwrap().time {
        let e = events.last().unwrap();
        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
            velocity: e.velocity,
            cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
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
                        cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
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
        cursor_id: cursor_id_string(cursor_ids, a.cursor_id),
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
    cursor_id: u32,
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
            cursor_num: 1,
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
        assert!(context.primary_button_down);
        assert_eq!(context.profile(280.0), SpringProfile::Default);

        // The release 50ms ahead ends the drag; it is not a click to stiffen for.
        context.advance_to(450.0);
        assert_eq!(context.profile(450.0), SpringProfile::Default);
        assert!(context.anticipated_press(450.0).is_none());

        context.advance_to(620.0);
        assert!(!context.primary_button_down);
        assert_eq!(context.profile(620.0), SpringProfile::Default);
    }

    fn secondary_click_event(time_ms: f64, down: bool) -> CursorClickEvent {
        CursorClickEvent {
            cursor_num: 2,
            ..click_event(time_ms, down)
        }
    }

    #[test]
    fn recorded_and_zero_based_primary_buttons_both_start_a_drag() {
        for cursor_num in [0, 1] {
            let clicks = vec![
                CursorClickEvent {
                    cursor_num,
                    ..click_event(100.0, true)
                },
                CursorClickEvent {
                    cursor_num,
                    ..click_event(900.0, false)
                },
            ];
            let mut context = CursorSpringContext::new(&clicks);
            context.advance_to(300.0);
            assert!(context.primary_button_down, "{cursor_num}");
        }

        let clicks = vec![secondary_click_event(100.0, true)];
        let mut context = CursorSpringContext::new(&clicks);
        context.advance_to(300.0);
        assert!(!context.primary_button_down);
    }

    #[test]
    fn a_drag_does_not_aim_at_a_press_after_its_release() {
        // Pressed at 300ms, released at 1200ms, then a click elsewhere at
        // 1400ms: mid-drag the target stays on the pointer.
        let clicks = vec![
            click_event(300.0, true),
            click_event(1200.0, false),
            click_event(1400.0, true),
        ];
        let mut context = CursorSpringContext::new(&clicks);
        context.advance_to(1000.0);
        assert!(context.anticipated_press(1000.0).is_none());
        assert_eq!(context.profile(1000.0), SpringProfile::Default);

        context.advance_to(1250.0);
        assert_eq!(
            context.anticipated_press(1250.0).map(|click| click.time_ms),
            Some(1400.0)
        );
    }

    #[test]
    fn a_press_of_another_button_mid_drag_is_not_anticipated() {
        let clicks = vec![
            click_event(100.0, true),
            secondary_click_event(400.0, true),
            secondary_click_event(450.0, false),
            click_event(900.0, false),
        ];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(300.0);
        assert_eq!(context.profile(300.0), SpringProfile::Default);
        assert!(context.anticipated_press(300.0).is_none());
    }

    #[test]
    fn spring_context_anticipates_presses_but_not_releases() {
        let clicks = vec![
            secondary_click_event(100.0, true),
            secondary_click_event(300.0, false),
            click_event(700.0, true),
        ];
        let mut context = CursorSpringContext::new(&clicks);

        context.advance_to(200.0);
        assert_eq!(context.profile(200.0), SpringProfile::Default);
        assert_eq!(
            context.anticipated_press(200.0).map(|click| click.time_ms),
            Some(700.0)
        );

        context.advance_to(250.0);
        assert_eq!(
            context.anticipated_press(250.0).map(|click| click.time_ms),
            Some(700.0)
        );

        context.advance_to(600.0);
        assert_eq!(context.profile(600.0), SpringProfile::Snappy);
    }

    fn horizontal_drag(release_ms: Option<f64>) -> CursorEvents {
        // The pointer rests at x=0.15 until 400ms, travels to x=0.75 by
        // 1200ms with the primary button held from 300ms, then rests.
        let moves = (0..=150)
            .map(|i| {
                let t = f64::from(i) * 10.0;
                let u = ((t - 400.0) / 800.0).clamp(0.0, 1.0);
                cursor_move(t, 0.15 + 0.6 * u, 0.5)
            })
            .collect();
        let mut clicks = vec![click_event(300.0, true)];
        if let Some(release_ms) = release_ms {
            clicks.push(click_event(release_ms, false));
        }
        CursorEvents { moves, clicks }
    }

    fn smoothed_x(cursor: &CursorEvents, t_ms: f64) -> f64 {
        let smoothing = SpringMassDamperSimulationConfig {
            tension: 470.0,
            mass: 3.0,
            friction: 70.0,
        };
        interpolate_cursor_with_click_spring(cursor, (t_ms / 1000.0) as f32, Some(smoothing), None)
            .unwrap()
            .position
            .coord
            .x
    }

    #[test]
    fn dragging_cursor_follows_the_pointer_instead_of_the_release_point() {
        let released = horizontal_drag(Some(1200.0));
        let release_far_ahead = horizontal_drag(Some(2200.0));
        let never_released = horizontal_drag(None);

        // Until the button comes up the upcoming release must not change the
        // path at all, wherever and whether it happens. The last simulation
        // step before the release may land a hair past 1200ms, so stop at the
        // step before it.
        for t in (0..1180).step_by(10) {
            let t = f64::from(t);
            let x = smoothed_x(&released, t);
            assert_eq!(x.to_bits(), smoothed_x(&release_far_ahead, t).to_bits());
            assert_eq!(x.to_bits(), smoothed_x(&never_released, t).to_bits());
        }

        // Mid-drag the cursor sits on the pointer (x=0.525 at 900ms), not on
        // the release point at x=0.75.
        let mid_drag = smoothed_x(&released, 900.0);
        assert!(
            (mid_drag - 0.525).abs() < 0.01,
            "dragging cursor at x={mid_drag:.4}, pointer at 0.525"
        );
    }

    #[test]
    fn dragging_cursor_lands_on_the_release_point_without_overshoot() {
        // A hand slows down before letting go: ease in and out from x=0.15 at
        // 400ms to x=0.75 at 1200ms, released on arrival.
        let pointer = |t: f64| {
            let u = ((t - 400.0) / 800.0).clamp(0.0, 1.0);
            0.15 + 0.6 * u * u * (3.0 - 2.0 * u)
        };
        let moves = (0..=300)
            .map(|i| {
                let t = f64::from(i) * 10.0;
                cursor_move(t, pointer(t), 0.5)
            })
            .collect();
        let cursor = CursorEvents {
            moves,
            clicks: vec![click_event(300.0, true), click_event(1200.0, false)],
        };

        // It never overshoots the release point and settles on it shortly
        // after.
        for t in (400..3000).step_by(5) {
            let x = smoothed_x(&cursor, f64::from(t));
            assert!(x < 0.7505, "overshoot to x={x:.4} at {t}ms");
        }
        let settled = smoothed_x(&cursor, 1500.0);
        assert!(
            (settled - 0.75).abs() < 0.003,
            "cursor at x={settled:.4} 300ms after the drag ends at 0.75"
        );
    }

    #[test]
    fn click_after_a_drag_is_still_anticipated() {
        let mut cursor = horizontal_drag(Some(1200.0));
        cursor.moves.extend((151..=250).map(|i| {
            let t = f64::from(i) * 10.0;
            let u = ((t - 1600.0) / 400.0).clamp(0.0, 1.0);
            cursor_move(t, 0.75 - 0.5 * u, 0.5)
        }));
        cursor.clicks.push(click_event(2000.0, true));
        cursor.clicks.push(click_event(2080.0, false));

        let at_press = smoothed_x(&cursor, 2000.0);
        assert!(
            (at_press - 0.25).abs() < 0.01,
            "cursor at x={at_press:.4} when the click lands at 0.25"
        );
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

    #[test]
    fn smoothed_cursor_reaches_final_recorded_position() {
        let cursor = CursorEvents {
            moves: vec![cursor_move(0.0, 0.1, 0.2), cursor_move(1000.0, 0.9, 0.8)],
            clicks: vec![],
        };
        let smoothing = SpringMassDamperSimulationConfig {
            tension: 80.0,
            mass: 2.5,
            friction: 28.0,
        };

        let settled = interpolate_cursor(&cursor, 10.0, Some(smoothing)).unwrap();

        assert!((settled.position.coord.x - 0.9).abs() < 1e-6);
        assert!((settled.position.coord.y - 0.8).abs() < 1e-6);
        assert_eq!(settled.velocity, XY::new(0.0, 0.0));
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

    struct OracleCursorEvent {
        time: f32,
        position: XY<f32>,
        velocity: XY<f32>,
        cursor_id: String,
    }

    fn linear_build_smoothed_timeline(
        cursor: &CursorEvents,
        moves: &[CursorMoveEvent],
        smoothing_config: SpringMassDamperSimulationConfig,
        click_spring: Option<ClickSpringConfig>,
    ) -> Vec<OracleCursorEvent> {
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
        let settle_deadline = end_time_ms + SPRING_SETTLE_TIMEOUT_MS;

        let capacity = ((settle_deadline / SIMULATION_STEP_MS).ceil() as usize) + 2;
        let mut events = Vec::with_capacity(capacity);
        let mut target_hint: usize = 0;
        let mut cid_hint: usize = 0;

        events.push(OracleCursorEvent {
            time: 0.0,
            position: start_pos,
            velocity: XY::new(0.0, 0.0),
            cursor_id: moves[0].cursor_id.clone(),
        });

        let mut t_ms = SIMULATION_STEP_MS;
        let mut lead_ms = spring_lag_ms(&smoothing_config);

        while t_ms <= settle_deadline {
            let clamped_t = t_ms.min(end_time_ms);

            context.advance_to(t_ms);
            let config = presets.config(context.profile(t_ms));
            sim.set_config(config);
            lead_ms += (spring_lag_ms(&config) - lead_ms) * LEAD_SMOOTHING;

            let lead_t = (clamped_t + lead_ms).min(end_time_ms);
            let (cx, cy) = position_at_time_hinted(moves, lead_t, &mut target_hint);
            let _ = position_at_time_hinted(moves, clamped_t, &mut cid_hint);
            let cursor_id = cursor_id_at_time(moves, clamped_t, cid_hint).to_string();

            let target = if let Some(click) = context.anticipated_press(t_ms) {
                let (tx, ty) = linear_position_at_time(moves, click.time_ms.min(end_time_ms));
                XY::new(tx as f32, ty as f32)
            } else {
                XY::new(cx as f32, cy as f32)
            };

            sim.set_target_position(target);

            sim.run(SIMULATION_STEP_MS as f32);

            events.push(OracleCursorEvent {
                time: t_ms as f32,
                position: sim.position,
                velocity: sim.velocity,
                cursor_id,
            });

            if t_ms >= end_time_ms && sim.is_at_rest() {
                break;
            }

            t_ms += SIMULATION_STEP_MS;
        }

        events
    }

    fn oracle_interpolate_timeline(
        events: &[OracleCursorEvent],
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

        let end = events.partition_point(|event| event.time <= query);
        let Some(window) = end
            .checked_sub(1)
            .and_then(|start| events.get(start..=end))
            .filter(|window| window[0].time <= query && query < window[1].time)
        else {
            let e = events.last().unwrap();
            return Some(InterpolatedCursorPosition {
                position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
                velocity: e.velocity,
                cursor_id: e.cursor_id.clone(),
            });
        };
        let (a, b) = (&window[0], &window[1]);
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

    fn linear_interpolate_timeline(
        events: &[SmoothedCursorEvent],
        cursor_ids: &[String],
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
                cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
            });
        }

        if query >= events.last().unwrap().time {
            let e = events.last().unwrap();
            return Some(InterpolatedCursorPosition {
                position: Coord::new(XY::new(e.position.x as f64, e.position.y as f64)),
                velocity: e.velocity,
                cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
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
                        cursor_id: cursor_id_string(cursor_ids, e.cursor_id),
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
            cursor_id: cursor_id_string(cursor_ids, a.cursor_id),
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

    fn assert_timeline_bits(
        expected: &[OracleCursorEvent],
        actual: &[SmoothedCursorEvent],
        cursor_ids: &[String],
    ) {
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
            assert_eq!(
                expected.cursor_id, cursor_ids[actual.cursor_id as usize],
                "cursor_id at {index}"
            );
        }
    }

    fn sample_cursor_ids() -> Vec<String> {
        vec!["0".into(), "1".into(), "2".into()]
    }

    fn sampled_event(time: f32, index: usize) -> SmoothedCursorEvent {
        SmoothedCursorEvent {
            time,
            position: XY::new(index as f32 * 0.013, index as f32 * -0.007),
            velocity: XY::new(index as f32 * -0.002, index as f32 * 0.003),
            cursor_id: (index % 3) as u32,
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
        assert!(timeline.cursor_ids.len() <= 3);
        assert!(timeline.timeline.len() > timeline.cursor_ids.len());
        assert_timeline_bits(&expected, &timeline.timeline, &timeline.cursor_ids);
        drop(moves);
        drop(filtered);
        drop(cursor);

        for index in 0..=500 {
            let time_secs = index as f32 * 0.017_137;
            assert_position_bits(
                oracle_interpolate_timeline(&expected, (time_secs * 1000.0) as f64),
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
            let variant = base.cached_variant(&cursor, smoothing, click, CursorAnchors::default());
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
            let reused = base.cached_variant(&cursor, smoothing, click, CursorAnchors::default());
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
        let first = base.cached_variant(&cursor, a, click, CursorAnchors::default());
        let second = base.cached_variant(&cursor, b, click, CursorAnchors::default());
        let old_second = Arc::downgrade(&second);
        drop(second);
        assert!(Arc::ptr_eq(
            &first,
            &base.cached_variant(&cursor, a, click, CursorAnchors::default())
        ));
        let third = base.cached_variant(&cursor, c, click, CursorAnchors::default());
        assert!(old_second.upgrade().is_none());
        assert_eq!(
            base.variants.lock().unwrap().len(),
            CURSOR_VARIANT_CACHE_CAPACITY
        );
        assert!(Arc::ptr_eq(
            &third,
            &base.cached_variant(&cursor, c, click, CursorAnchors::default())
        ));
        assert_position_bits(original, base.interpolate(0.8));
        let first_output = first.interpolate(0.8);
        let weak_first = Arc::downgrade(&first);
        drop(base.cached_variant(&cursor, b, click, CursorAnchors::default()));
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
        let av = a.cached_variant(&first, smoothing, click, CursorAnchors::default());
        let bv = b.cached_variant(&second, smoothing, click, CursorAnchors::default());
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
                            CursorAnchors::default(),
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
    fn raw_timeline_lookup_matches_linear_reference() {
        let cases = [
            vec![],
            vec![0.0],
            vec![f64::NAN],
            vec![0.0, 0.0, 10.0, 10.0, 20.0, 100.0, 100.0],
            vec![-0.0, 0.0, 0.0, 10.0, 100.0],
            vec![0.0, 20.0, 10.0, 50.0, 100.0],
            vec![0.0, 10.0, f64::NAN, 30.0, 100.0],
            vec![f64::NAN, 10.0, 30.0, 100.0],
            vec![0.0, 10.0, f64::NAN],
            vec![f64::NEG_INFINITY, 0.0, 10.0, f64::INFINITY],
            vec![0.0, f64::INFINITY, 10.0, 100.0],
        ];
        for times in cases {
            let cursor = CursorEvents {
                moves: times
                    .iter()
                    .enumerate()
                    .map(|(index, &time)| {
                        let mut event =
                            cursor_move(time, index as f64 * 0.13, index as f64 * -0.07);
                        event.cursor_id = index.to_string();
                        event
                    })
                    .collect(),
                clicks: Vec::new(),
            };
            let timeline = PrecomputedCursorTimeline::new(&cursor, None, None);
            let queries = [
                -1.0, -0.0, 0.0, 0.001, 0.009, 0.01, 0.019, 0.02, 0.05, 0.1, 1.0,
            ]
            .into_iter()
            .chain([f32::NAN, f32::NEG_INFINITY, f32::INFINITY])
            .chain(times.iter().flat_map(|&time| {
                let time = (time / 1000.0) as f32;
                [time.next_down(), time, time.next_up()]
            }));
            for time in queries {
                assert_position_bits(
                    interpolate_cursor(&cursor, time, None),
                    timeline.interpolate(time),
                );
                assert_position_bits(
                    interpolate_cursor(&cursor, time, None),
                    timeline.interpolate_raw(&cursor, time),
                );
            }
        }
    }

    #[test]
    fn raw_style_lookup_reuses_smoothed_source_order_without_retaining_events() {
        let cursor = dense_cursor(2);
        let timeline = PrecomputedCursorTimeline::new(&cursor, Some(DEFAULT_CLICK_SPRING), None);
        assert!(timeline.raw_cursor.moves.is_empty());
        assert!(timeline.raw_cursor.clicks.is_empty());
        for time in [1.7, 0.4, 2.0, 0.0, -1.0, 0.017, 1.7] {
            assert_position_bits(
                interpolate_cursor(&cursor, time, None),
                timeline.interpolate_raw(&cursor, time),
            );
        }
    }

    #[test]
    #[ignore]
    fn benchmark_raw_cursor_frame_lookup() {
        use std::{hint::black_box, time::Instant};

        for duration_secs in [60, 600, 3600] {
            let cursor = CursorEvents {
                moves: (0..=duration_secs * 60)
                    .map(|index| {
                        let mut event = cursor_move(
                            index as f64 * 1000.0 / 60.0,
                            (index % 479) as f64 / 479.0,
                            (index % 283) as f64 / 283.0,
                        );
                        event.cursor_id = (index / 31 % 3).to_string();
                        event
                    })
                    .collect(),
                clicks: Vec::new(),
            };
            let started = Instant::now();
            let timeline = PrecomputedCursorTimeline::new(&cursor, None, None);
            println!(
                "raw_cursor_setup duration_secs={duration_secs} moves={} setup_ms={:.3}",
                cursor.moves.len(),
                started.elapsed().as_secs_f64() * 1000.0,
            );

            for workload in ["start", "middle", "end", "random_seek"] {
                let mut baseline = Vec::new();
                let mut optimized = Vec::new();
                for frame in 0..544 {
                    let time = match workload {
                        "start" => 1.0 + (frame % 120) as f32 / 60.0,
                        "middle" => duration_secs as f32 * 0.5 + (frame % 120) as f32 / 60.0,
                        "end" => duration_secs as f32 - 3.0 + (frame % 120) as f32 / 60.0,
                        _ => (frame * 104729 % 1009) as f32 / 1009.0 * duration_secs as f32,
                    };
                    let queries = [time, (time - 1.0 / 60.0).max(0.0), (time - 0.4).max(0.0)];
                    for query in queries {
                        assert_position_bits(
                            interpolate_cursor(&cursor, query, None),
                            timeline.interpolate_raw(&cursor, query),
                        );
                    }
                    let measure =
                        |interpolate: &dyn Fn(f32) -> Option<InterpolatedCursorPosition>| {
                            let started = Instant::now();
                            let positions = queries.map(|time| interpolate(black_box(time)));
                            let elapsed = started.elapsed().as_secs_f64() * 1e6;
                            drop(black_box(positions));
                            elapsed
                        };
                    let old = |time| interpolate_cursor(black_box(&cursor), time, None);
                    let new = |time| black_box(&timeline).interpolate_raw(black_box(&cursor), time);
                    let (old_us, new_us) = if frame % 2 == 0 {
                        (measure(&old), measure(&new))
                    } else {
                        let new_us = measure(&new);
                        (measure(&old), new_us)
                    };
                    if frame >= 32 {
                        baseline.push(old_us);
                        optimized.push(new_us);
                    }
                }
                baseline.sort_by(f64::total_cmp);
                optimized.sort_by(f64::total_cmp);
                let p50 = baseline.len() / 2;
                let p95 = baseline.len() * 95 / 100;
                println!(
                    "raw_cursor_frame duration_secs={duration_secs} workload={workload} frames={} queries_per_frame=3 baseline_p50_us={:.3} baseline_p95_us={:.3} optimized_p50_us={:.3} optimized_p95_us={:.3}",
                    baseline.len(),
                    baseline[p50],
                    baseline[p95],
                    optimized[p50],
                    optimized[p95],
                );
            }
        }
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
                SpringMassDamperSimulationConfig {
                    tension: 1000.0,
                    mass: 1.0,
                    friction: 40.0,
                },
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
                    assert_timeline_bits(&expected, &actual.events, &actual.cursor_ids);
                    for index in 0..=500 {
                        let query = index as f64 * 17.137;
                        assert_position_bits(
                            oracle_interpolate_timeline(&expected, query),
                            interpolate_timeline(&actual.events, &actual.cursor_ids, query),
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn timeline_lookup_matches_linear_reference_at_long_times_and_duplicate_timestamps() {
        assert_position_bits(
            linear_interpolate_timeline(&[], &[], 0.0),
            interpolate_timeline(&[], &[], 0.0),
        );
        let cursor_ids = sample_cursor_ids();
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
                        linear_interpolate_timeline(&events, &cursor_ids, query),
                        interpolate_timeline(&events, &cursor_ids, query),
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
                            linear_interpolate_timeline(&events, &cursor_ids, query),
                            interpolate_timeline(&events, &cursor_ids, query),
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
                linear_interpolate_timeline(&duplicate_origin, &cursor_ids, query),
                interpolate_timeline(&duplicate_origin, &cursor_ids, query),
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
            assert_timeline_bits(
                black_box(&expected),
                black_box(&actual.events),
                black_box(&actual.cursor_ids),
            );
            println!(
                "cursor_precompute duration_secs={duration_secs} moves={} clicks={} samples={} baseline_ms={:.3} optimized_ms={:.3}",
                moves.len(),
                cursor.clicks.len(),
                actual.events.len(),
                baseline_time.as_secs_f64() * 1000.0,
                optimized_time.as_secs_f64() * 1000.0
            );
        }

        let events: Vec<_> = (0..=20 * 60 * 60 * 60)
            .map(|index| {
                let mut event = sampled_event((index as f64 * SIMULATION_STEP_MS) as f32, index);
                event.cursor_id = 0;
                event
            })
            .collect();
        let cursor_ids = [String::new()];
        let queries: Vec<_> = (0..128)
            .map(|index| 72_000_000.0 - index as f64 * 171.13 - 1.0)
            .collect();
        let started = Instant::now();
        let expected: Vec<_> = queries
            .iter()
            .map(|&query| {
                linear_interpolate_timeline(black_box(&events), &cursor_ids, black_box(query))
            })
            .collect();
        let baseline_time = started.elapsed();
        let started = Instant::now();
        let actual: Vec<_> = queries
            .iter()
            .map(|&query| interpolate_timeline(black_box(&events), &cursor_ids, black_box(query)))
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

    mod anchors {
        use super::*;

        const W: f64 = 1920.0;
        const H: f64 = 1080.0;

        fn spring() -> SpringMassDamperSimulationConfig {
            SpringMassDamperSimulationConfig {
                tension: 470.0,
                mass: 3.0,
                friction: 70.0,
            }
        }

        fn sampled(
            path: impl Fn(f64) -> (f64, f64),
            id_at: impl Fn(f64) -> &'static str,
        ) -> Vec<CursorMoveEvent> {
            (0..=240)
                .map(|i| {
                    let t = f64::from(i) * 10.0;
                    let (x, y) = path(t);
                    CursorMoveEvent {
                        cursor_id: id_at(t).into(),
                        ..cursor_move(t, x / W, y / H)
                    }
                })
                .collect()
        }

        fn travel(t: f64) -> (f64, f64) {
            let u = ((t - 400.0) / 800.0).clamp(0.0, 1.0);
            (300.0 + 1000.0 * u, 500.0)
        }

        fn eased(t: f64) -> (f64, f64) {
            let u = ((t - 400.0) / 800.0).clamp(0.0, 1.0);
            (300.0 + 1000.0 * u * u * (3.0 - 2.0 * u), 500.0)
        }

        fn flick(t: f64) -> (f64, f64) {
            let u = ((t - 400.0) / 150.0).clamp(0.0, 1.0);
            (300.0 + 1200.0 * u, 500.0)
        }

        fn arrow(_: f64) -> &'static str {
            "arrow"
        }

        fn clicks(times: &[(f64, bool)]) -> Vec<CursorClickEvent> {
            times
                .iter()
                .map(|&(t, down)| click_event(t, down))
                .collect()
        }

        struct Scenario {
            name: &'static str,
            cursor: CursorEvents,
            probes: Vec<f64>,
        }

        fn scenarios() -> Vec<Scenario> {
            vec![
                Scenario {
                    name: "free travel",
                    cursor: CursorEvents {
                        moves: sampled(travel, arrow),
                        clicks: vec![],
                    },
                    probes: vec![700.0, 900.0, 1100.0],
                },
                Scenario {
                    name: "click arrival",
                    cursor: CursorEvents {
                        moves: sampled(travel, arrow),
                        clicks: clicks(&[(1200.0, true), (1260.0, false)]),
                    },
                    probes: vec![1200.0, 1260.0],
                },
                Scenario {
                    name: "cursor image change",
                    cursor: CursorEvents {
                        moves: sampled(travel, |t| if t >= 900.0 { "text" } else { "arrow" }),
                        clicks: vec![],
                    },
                    probes: vec![900.0],
                },
                Scenario {
                    name: "drag, release 1200",
                    cursor: CursorEvents {
                        moves: sampled(travel, arrow),
                        clicks: clicks(&[(400.0, true), (1200.0, false)]),
                    },
                    probes: vec![700.0, 900.0, 1100.0],
                },
                Scenario {
                    name: "drag, release 2200",
                    cursor: CursorEvents {
                        moves: sampled(travel, arrow),
                        clicks: clicks(&[(400.0, true), (2200.0, false)]),
                    },
                    probes: vec![700.0, 900.0, 1100.0],
                },
                Scenario {
                    name: "eased drag",
                    cursor: CursorEvents {
                        moves: sampled(eased, arrow),
                        clicks: clicks(&[(400.0, true), (1200.0, false)]),
                    },
                    probes: vec![500.0, 700.0, 900.0, 1100.0],
                },
                Scenario {
                    name: "flick",
                    cursor: CursorEvents {
                        moves: sampled(flick, arrow),
                        clicks: vec![],
                    },
                    probes: vec![450.0, 550.0, 700.0],
                },
            ]
        }

        fn timeline(cursor: &CursorEvents, anchors: bool) -> PrecomputedCursorTimeline {
            PrecomputedCursorTimeline::new_with_anchors(
                cursor,
                Some(spring()),
                None,
                CursorAnchors {
                    interaction: anchors,
                    hover: false,
                },
                &[],
            )
        }

        fn rendered(timeline: &PrecomputedCursorTimeline, t: f64) -> (f64, f64) {
            let p = timeline
                .interpolate((t / 1000.0) as f32)
                .unwrap()
                .position
                .coord;
            (p.x * W, p.y * H)
        }

        fn recorded(cursor: &CursorEvents, t: f64) -> (f64, f64) {
            let (x, y) = position_at_time(&cursor.moves, t, true);
            (x * W, y * H)
        }

        fn error(cursor: &CursorEvents, timeline: &PrecomputedCursorTimeline, t: f64) -> f64 {
            let (rx, ry) = rendered(timeline, t);
            let (px, py) = recorded(cursor, t);
            (rx - px).hypot(ry - py)
        }

        /// Largest distance past the final resting x, in nominal points.
        fn overshoot(cursor: &CursorEvents, timeline: &PrecomputedCursorTimeline) -> f64 {
            let rest = recorded(cursor, 2400.0).0;
            (0..=2400)
                .map(|t| rendered(timeline, f64::from(t)).0 - rest)
                .fold(0.0, f64::max)
        }

        /// Peak acceleration and jerk of the rendered path sampled at 120 Hz,
        /// in nominal points per second^2 and per second^3.
        fn peak_derivatives(timeline: &PrecomputedCursorTimeline) -> (f64, f64) {
            let dt = 1.0 / 120.0;
            let xs: Vec<f64> = (0..=288)
                .map(|i| {
                    let (x, y) = rendered(timeline, f64::from(i) * dt * 1000.0);
                    x.hypot(y)
                })
                .collect();
            let v: Vec<f64> = xs.windows(2).map(|w| (w[1] - w[0]) / dt).collect();
            let a: Vec<f64> = v.windows(2).map(|w| (w[1] - w[0]) / dt).collect();
            let j: Vec<f64> = a.windows(2).map(|w| (w[1] - w[0]) / dt).collect();
            let peak = |values: &[f64]| values.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
            (peak(&a), peak(&j))
        }

        #[test]
        #[ignore = "prints the probe table used in the pull request"]
        fn print_probe_table() {
            println!("scenario | probe ms | plain error | anchored error");
            for scenario in scenarios() {
                let plain = timeline(&scenario.cursor, false);
                let anchored = timeline(&scenario.cursor, true);
                for &t in &scenario.probes {
                    println!(
                        "{} | {t} | {:.3} | {:.3}",
                        scenario.name,
                        error(&scenario.cursor, &plain, t),
                        error(&scenario.cursor, &anchored, t)
                    );
                }
                let (plain_a, plain_j) = peak_derivatives(&plain);
                let (anchored_a, anchored_j) = peak_derivatives(&anchored);
                println!(
                    "{} | overshoot {:.3} / {:.3} | peak accel {:.0} / {:.0} | peak jerk {:.0} / {:.0}",
                    scenario.name,
                    overshoot(&scenario.cursor, &plain),
                    overshoot(&scenario.cursor, &anchored),
                    plain_a,
                    anchored_a,
                    plain_j,
                    anchored_j
                );
            }
        }

        fn scenario(name: &str) -> CursorEvents {
            scenarios()
                .into_iter()
                .find(|s| s.name == name)
                .unwrap()
                .cursor
        }

        #[test]
        fn a_drag_stays_on_the_pointer() {
            for name in ["drag, release 1200", "drag, release 2200", "eased drag"] {
                let cursor = scenario(name);
                let plain = timeline(&cursor, false);
                let anchored = timeline(&cursor, true);
                let plain_worst = (450..=1150)
                    .step_by(10)
                    .map(|t| error(&cursor, &plain, f64::from(t)))
                    .fold(0.0, f64::max);
                assert!(plain_worst > 5.0, "{name}: plain spring {plain_worst:.3}");
                for t in (450..=1150).step_by(10) {
                    let t = f64::from(t);
                    let e = error(&cursor, &anchored, t);
                    assert!(e <= ANCHOR_DRAG_TOLERANCE, "{name}: {e:.3} pt off at {t}ms");
                }
            }
        }

        #[test]
        fn a_drag_does_not_overshoot_more_than_the_plain_spring() {
            for name in ["drag, release 1200", "eased drag"] {
                let cursor = scenario(name);
                let plain = overshoot(&cursor, &timeline(&cursor, false));
                let anchored = overshoot(&cursor, &timeline(&cursor, true));
                assert!(
                    anchored <= plain.max(0.5),
                    "{name}: {anchored:.3} vs {plain:.3}"
                );
            }
        }

        #[test]
        fn the_cursor_meets_a_shape_change() {
            let cursor = scenario("cursor image change");
            let anchored = timeline(&cursor, true);
            let e = error(&cursor, &anchored, 900.0);
            assert!(e <= ANCHOR_CURSOR_IMAGE_TOLERANCE, "{e:.3}");
            assert_eq!(
                anchored.interpolate(0.95).unwrap().cursor_id,
                "text",
                "the shape still switches on the recorded sample"
            );
        }

        #[test]
        fn a_shape_change_on_the_way_to_a_click_is_met() {
            let cursor = CursorEvents {
                moves: sampled(travel, |t| if t >= 905.0 { "text" } else { "arrow" }),
                clicks: clicks(&[(1200.0, true), (1260.0, false)]),
            };
            let anchored = timeline(&cursor, true);
            let e = error(&cursor, &anchored, 910.0);
            assert!(
                e <= ANCHOR_CURSOR_IMAGE_TOLERANCE,
                "{e:.3} at the shape change"
            );
            let e = error(&cursor, &anchored, 1200.0);
            assert!(e <= ANCHOR_CLICK_TOLERANCE, "{e:.3} at the press");
        }

        #[test]
        fn samples_missing_mid_drag_do_not_make_the_cursor_jump() {
            let mut cursor = scenario("eased drag");
            cursor
                .moves
                .retain(|m| !(800.0 < m.time_ms && m.time_ms < 920.0));
            let plain = timeline(&cursor, false);
            let anchored = timeline(&cursor, true);
            let e = error(&cursor, &anchored, 920.0);
            let plain_e = error(&cursor, &plain, 920.0);
            assert!(
                e <= plain_e,
                "{e:.3} after the gap, plain spring {plain_e:.3}"
            );
            let worst = |timeline: &PrecomputedCursorTimeline| {
                (800..=1000)
                    .map(|t| {
                        let t = f64::from(t);
                        (rendered(timeline, t).0 - rendered(timeline, t - 1.0).0).abs()
                    })
                    .fold(0.0, f64::max)
            };
            assert!(
                worst(&anchored) <= worst(&plain) * 1.5,
                "largest 1 ms step {:.3} vs {:.3}",
                worst(&anchored),
                worst(&plain)
            );
        }

        #[test]
        fn a_small_back_and_forth_while_drawing_is_kept() {
            let path = |t: f64| {
                let wiggle = if (500.0..=566.0).contains(&t) {
                    20.0 * (1.0 - ((t - 533.0) / 33.0).abs())
                } else {
                    0.0
                };
                (300.0 + 0.2 * (t - 300.0).max(0.0) + wiggle, 500.0)
            };
            let cursor = CursorEvents {
                moves: (0..=110)
                    .map(|i| {
                        let t = f64::from(i) * 11.0;
                        let (x, y) = path(t);
                        cursor_move(t, x / W, y / H)
                    })
                    .collect(),
                clicks: clicks(&[(200.0, true), (1100.0, false)]),
            };
            assert!(
                filter_cursor_shake(&cursor.moves).len() < cursor.moves.len(),
                "the wiggle is small enough for the shake filter"
            );
            let anchored = timeline(&cursor, true);
            let e = error(&cursor, &anchored, 528.0);
            assert!(
                e <= 2.0 * ANCHOR_DRAG_TOLERANCE,
                "{e:.3} at the top of the wiggle"
            );
        }

        #[test]
        fn a_pause_between_two_drags_is_not_filled_in() {
            let mut moves: Vec<_> = (0..=20)
                .map(|i| {
                    let t = f64::from(i) * 16.0;
                    cursor_move(t, (300.0 + t) / W, 500.0 / H)
                })
                .collect();
            moves.extend((0..=20).map(|i| {
                let t = 900.0 + f64::from(i) * 16.0;
                cursor_move(t, (700.0 + (t - 900.0)) / W, 500.0 / H)
            }));
            let cursor = CursorEvents {
                moves,
                clicks: clicks(&[(0.0, true), (330.0, false), (880.0, true), (1300.0, false)]),
            };
            assert!(keep_drag_samples(&cursor.moves, &cursor.clicks).is_some());
            assert_eq!(
                fill_drag_gaps(&cursor.moves, &cursor.clicks).len(),
                cursor.moves.len(),
                "no samples are invented across the release and the next press"
            );
        }

        #[test]
        fn a_pause_inside_a_drag_keeps_the_cursor_still() {
            let mut moves: Vec<_> = (0..=30)
                .map(|i| {
                    let t = f64::from(i) * 16.0;
                    cursor_move(t, (300.0 + t) / W, 500.0 / H)
                })
                .collect();
            moves.extend((0..=20).map(|i| {
                let t = 2480.0 + f64::from(i) * 16.0;
                cursor_move(t, (800.0 + (t - 2480.0)) / W, 500.0 / H)
            }));
            let cursor = CursorEvents {
                moves,
                clicks: clicks(&[(0.0, true), (2900.0, false)]),
            };
            assert_eq!(
                fill_drag_gaps(&cursor.moves, &cursor.clicks).len(),
                cursor.moves.len(),
                "a two second pause is not treated as missed samples"
            );
            let anchored = timeline(&cursor, true);
            let (x, _) = rendered(&anchored, 1500.0);
            assert!((x - 780.0).abs() < 1.0, "cursor at x={x:.2} mid-pause");
        }

        #[test]
        fn a_click_lands_on_the_press() {
            let cursor = scenario("click arrival");
            let anchored = timeline(&cursor, true);
            for t in [1200.0, 1260.0] {
                let e = error(&cursor, &anchored, t);
                assert!(e <= ANCHOR_CLICK_TOLERANCE, "{e:.3} at {t}");
            }
        }

        #[test]
        fn travel_without_interactions_keeps_the_plain_spring_shape() {
            for name in ["free travel", "flick"] {
                let cursor = scenario(name);
                assert!(
                    interaction_anchors(&cursor, 0.0, 2400.0).is_empty(),
                    "{name}"
                );
                let plain = timeline(&cursor, false);
                let anchored = timeline(&cursor, true);
                let (plain_a, plain_j) = peak_derivatives(&plain);
                let (anchored_a, anchored_j) = peak_derivatives(&anchored);
                assert!(
                    anchored_a <= plain_a * 1.05,
                    "{name}: {anchored_a} vs {plain_a}"
                );
                assert!(
                    anchored_j <= plain_j * 1.05,
                    "{name}: {anchored_j} vs {plain_j}"
                );
                assert!(
                    overshoot(&cursor, &anchored) <= overshoot(&cursor, &plain) + 0.5,
                    "{name}"
                );
            }
        }

        #[test]
        fn anchored_timelines_are_deterministic_for_any_seek_order() {
            let cursor = scenario("eased drag");
            let first = timeline(&cursor, true);
            let second = timeline(&cursor, true);
            let forward: Vec<u64> = (0..=2400)
                .step_by(7)
                .map(|t| {
                    first
                        .interpolate(t as f32 / 1000.0)
                        .unwrap()
                        .position
                        .coord
                        .x
                        .to_bits()
                })
                .collect();
            let mut backward: Vec<u64> = (0..=2400_u16)
                .step_by(7)
                .rev()
                .map(|t| {
                    second
                        .interpolate(t as f32 / 1000.0)
                        .unwrap()
                        .position
                        .coord
                        .x
                        .to_bits()
                })
                .collect();
            backward.reverse();
            assert_eq!(forward, backward);
        }

        /// `CAP_CURSOR_JSON=<cursor.json>[:...]`: anchor errors on a real
        /// recording, and the cost of building both timelines for it and for
        /// the same input repeated out to 30 minutes.
        #[test]
        #[ignore = "reads recordings named by CAP_CURSOR_JSON"]
        fn real_recording_anchor_report() {
            let Ok(paths) = std::env::var("CAP_CURSOR_JSON") else {
                return;
            };
            for path in paths.split(':') {
                let cursor = CursorEvents::load_from_file(std::path::Path::new(path)).unwrap();
                let Some(end) = cursor.moves.last().map(|m| m.time_ms) else {
                    continue;
                };
                let plain = timeline(&cursor, false);
                let anchored = timeline(&cursor, true);
                let anchors = interaction_anchors(&cursor, cursor.moves[0].time_ms, end);
                let mut rows: Vec<(f64, f64, f64)> = anchors
                    .iter()
                    .map(|a| {
                        (
                            a.tolerance,
                            error(&cursor, &plain, a.time_ms),
                            error(&cursor, &anchored, a.time_ms),
                        )
                    })
                    .collect();
                for (label, tolerance) in [("press/release/drag", 2.0), ("shape change", 6.0)] {
                    let mut plain_errors: Vec<f64> = rows
                        .iter()
                        .filter(|r| r.0 == tolerance)
                        .map(|r| r.1)
                        .collect();
                    let mut anchored_errors: Vec<f64> = rows
                        .iter()
                        .filter(|r| r.0 == tolerance)
                        .map(|r| r.2)
                        .collect();
                    if plain_errors.is_empty() {
                        continue;
                    }
                    plain_errors.sort_by(f64::total_cmp);
                    anchored_errors.sort_by(f64::total_cmp);
                    let p = |v: &[f64], q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
                    let met = anchored_errors.iter().filter(|e| **e <= tolerance).count();
                    println!(
                        "{path} | {label} | n {} | plain p50 {:.2} p95 {:.2} max {:.2} | anchored p50 {:.2} p95 {:.2} max {:.2} | within tolerance {met}/{}",
                        plain_errors.len(),
                        p(&plain_errors, 0.5),
                        p(&plain_errors, 0.95),
                        p(&plain_errors, 1.0),
                        p(&anchored_errors, 0.5),
                        p(&anchored_errors, 0.95),
                        p(&anchored_errors, 1.0),
                        anchored_errors.len()
                    );
                }
                for anchor in anchors
                    .iter()
                    .filter(|a| a.tolerance == ANCHOR_CURSOR_IMAGE_TOLERANCE)
                {
                    println!(
                        "{path} | shape change at {:.0} ms | plain {:.2} | anchored {:.2}",
                        anchor.time_ms,
                        error(&cursor, &plain, anchor.time_ms),
                        error(&cursor, &anchored, anchor.time_ms)
                    );
                }
                rows.clear();

                let span = end - cursor.moves[0].time_ms + 1000.0;
                let copies = ((30.0 * 60_000.0) / span).ceil() as usize;
                let mut long = CursorEvents::default();
                for copy in 0..copies {
                    let shift = copy as f64 * span;
                    long.moves
                        .extend(cursor.moves.iter().map(|m| CursorMoveEvent {
                            time_ms: m.time_ms + shift,
                            ..m.clone()
                        }));
                    long.clicks
                        .extend(cursor.clicks.iter().map(|c| CursorClickEvent {
                            time_ms: c.time_ms + shift,
                            ..c.clone()
                        }));
                }
                let without_interactions = CursorEvents {
                    moves: long
                        .moves
                        .iter()
                        .map(|m| CursorMoveEvent {
                            cursor_id: "arrow".into(),
                            ..m.clone()
                        })
                        .collect(),
                    clicks: vec![],
                };
                let long_end = long.moves.last().map_or(0.0, |m| m.time_ms);
                let groups = group_anchors(&interaction_anchors(&long, 0.0, long_end)).len();
                for (label, events, anchors) in [
                    ("plain spring", &long, false),
                    ("anchored, no interactions", &without_interactions, true),
                    ("anchored", &long, true),
                ] {
                    let mut best = f64::INFINITY;
                    for _ in 0..5 {
                        let started = std::time::Instant::now();
                        std::hint::black_box(timeline(events, anchors));
                        best = best.min(started.elapsed().as_secs_f64() * 1000.0);
                    }
                    println!(
                        "{path} | 30 min build | {label} | {best:.1} ms | moves {} clicks {} groups {groups}",
                        long.moves.len(),
                        long.clicks.len()
                    );
                }
            }
        }

        #[test]
        fn anchors_cover_presses_releases_drag_samples_and_shape_changes() {
            let mut cursor = CursorEvents {
                moves: sampled(travel, |t| if t >= 900.0 { "text" } else { "arrow" }),
                clicks: clicks(&[(400.0, true), (600.0, false)]),
            };
            cursor.clicks.push(CursorClickEvent {
                cursor_num: 2,
                ..click_event(1500.0, true)
            });
            let anchors = interaction_anchors(&cursor, 0.0, 2400.0);
            let at = |tolerance: f64| -> Vec<f64> {
                anchors
                    .iter()
                    .filter(|a| a.tolerance == tolerance)
                    .map(|a| a.time_ms)
                    .collect()
            };
            assert_eq!(at(ANCHOR_CURSOR_IMAGE_TOLERANCE), vec![900.0]);
            let presses_and_drag = at(ANCHOR_CLICK_TOLERANCE);
            assert_eq!(presses_and_drag.first(), Some(&400.0));
            assert!(presses_and_drag.contains(&500.0));
            assert!(presses_and_drag.contains(&600.0));
            assert!(presses_and_drag.contains(&1500.0));
            assert!(!presses_and_drag.contains(&700.0));
        }
    }
}
