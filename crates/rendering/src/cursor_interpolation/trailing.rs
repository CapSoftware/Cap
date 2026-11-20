//! Trailing follow. The cursor chases the recorded pointer on its spring
//! without sampling ahead, so on a free glide it trails by the spring's own
//! lag and comes to rest softly. Interaction anchors (presses, releases, drag
//! samples, hover and shape changes) are still met: for each group of anchors
//! the planner picks how far ahead in time the spring target runs (its lead)
//! and, only when no lead is enough, how much faster the spring runs around
//! the group. A lead is raised while the pointer rests, where running ahead in
//! time moves nothing, or else ramped in over the last 400 ms, and it decays
//! after the group at a bounded rate so the target never visibly jumps.
//!
//! Everything runs in recording time on 1 ms steps, so playback, seeking and
//! export read one deterministic path.

use cap_project::{CursorEvents, CursorMoveEvent, XY};

use super::{
    ANCHOR_ACCEPTED_ERROR_RATIO, ANCHOR_GROUP_GAP_MS as GROUP_GAP_MS,
    ANCHOR_LEAD_DECAY_PER_MS as LEAD_DECAY_PER_MS, ANCHOR_SPEED_LEVELS, AnchorKind, CursorIdIndex,
    SIMULATION_STEP_MS, SPRING_SETTLE_TIMEOUT_MS, SmoothedCursorEvent, SmoothedTimeline,
    cursor_id_at_time, interaction_anchors, position_at_time_hinted,
};
use crate::spring_mass_damper::SpringMassDamperSimulationConfig;

/// Positions are planned in points of a 1512 x 982 display (a 14-inch
/// laptop), so the anchor tolerances are about the size they look on the
/// displays most recordings come from.
const DISPLAY_POINTS: (f64, f64) = (1512.0, 982.0);
/// Samples further apart than this mean the pointer stood still in between,
/// so the path holds the earlier sample instead of sliding to the next.
const HOLD_GAP_MS: f64 = 40.0;
/// A group that cannot be met is planned together with the previous one
/// when it starts within this long of it.
const MERGE_GAP_MS: f64 = 400.0;
const MAX_LEAD_MS: f64 = 600.0;
/// How far before a group the target may start running ahead.
const APPROACH_WINDOW_MS: f64 = 1500.0;
/// Without a rest to hide it in, a lead ramps in over at most this long.
const COMPRESSION_WINDOW_MS: f64 = 400.0;
/// While a lead ramps in or out, the target moves through recording time at
/// between 0.65x and 1.4x real time.
const MAX_COMPRESSION_RATE: f64 = 1.4;
const SPEED_BLEND_IN_MS: f64 = 250.0;
const SPEED_BLEND_OUT_MS: f64 = 300.0;
/// The spring's speed-up is re-read this often.
const SPEED_BUCKET_MS: f64 = 4.0;
/// Within this many points of the target, and slower than this many points
/// per second, an axis snaps onto the target.
const SNAP_PT: f64 = 0.01;
const KNOT_EPSILON_MS: f64 = 0.001;

#[derive(Clone, Copy, Debug)]
struct Sample {
    t: f64,
    x: f64,
    y: f64,
}

struct Path {
    samples: Vec<Sample>,
    /// Spans where the pointer moves, in time order.
    moving: Vec<(f64, f64)>,
}

impl Path {
    fn new(samples: Vec<Sample>) -> Self {
        let mut moving: Vec<(f64, f64)> = Vec::new();
        for pair in samples.windows(2) {
            let (previous, current) = (pair[0], pair[1]);
            if previous.x == current.x && previous.y == current.y {
                continue;
            }
            let start = if current.t - previous.t <= HOLD_GAP_MS {
                previous.t
            } else {
                current.t
            };
            match moving.last_mut() {
                Some(last) if last.1 >= start => last.1 = last.1.max(current.t),
                _ => moving.push((start, current.t.max(start + 1e-6))),
            }
        }
        Self { samples, moving }
    }

    fn start_ms(&self) -> f64 {
        self.samples[0].t
    }

    fn position_at(&self, t: f64) -> (f64, f64) {
        let next = self.samples.partition_point(|sample| sample.t <= t);
        let Some(index) = next.checked_sub(1) else {
            return (self.samples[0].x, self.samples[0].y);
        };
        let a = self.samples[index];
        match self.samples.get(next) {
            Some(b) if b.t - a.t <= HOLD_GAP_MS && b.t != a.t => {
                let u = (t - a.t) / (b.t - a.t);
                (a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u)
            }
            _ => (a.x, a.y),
        }
    }

    /// The moving span starting at `t`, or else the last one starting before.
    fn moving_index_by(&self, t: f64) -> Option<usize> {
        let index = self.moving.partition_point(|range| range.0 < t);
        if self.moving.get(index).is_some_and(|range| range.0 == t) {
            Some(index)
        } else {
            index.checked_sub(1)
        }
    }

    fn is_still_between(&self, a: f64, b: f64) -> bool {
        let (a, b) = if b < a { (b, a) } else { (a, b) };
        self.moving_index_by(b)
            .is_none_or(|index| self.moving[index].1 <= a)
    }

    /// The rest that ends where the last moving span starting by `t` begins.
    fn last_rest_ending_by(&self, t: f64) -> Option<(f64, f64)> {
        let index = self.moving_index_by(t)?;
        let start = index
            .checked_sub(1)
            .map_or(f64::NEG_INFINITY, |previous| self.moving[previous].1);
        Some((start, self.moving[index].0))
    }
}

type Knot = (f64, f64);

/// Planned lead in ms, piecewise linear between knots in time order: the
/// committed knots followed by a candidate's.
#[derive(Clone, Copy)]
struct Lead<'a> {
    committed: &'a [Knot],
    extra: &'a [Knot],
}

impl<'a> Lead<'a> {
    fn new(committed: &'a [Knot], extra: &'a [Knot]) -> Self {
        Self { committed, extra }
    }

    fn knot(&self, index: usize) -> Option<Knot> {
        match index.checked_sub(self.committed.len()) {
            None => Some(self.committed[index]),
            Some(extra) => self.extra.get(extra).copied(),
        }
    }

    fn planned_at(&self, t: f64) -> f64 {
        let next = self.committed.partition_point(|knot| knot.0 <= t)
            + self.extra.partition_point(|knot| knot.0 <= t);
        let Some(a) = next.checked_sub(1).and_then(|index| self.knot(index)) else {
            return 0.0;
        };
        match self.knot(next) {
            Some(b) if b.0 != a.0 => a.1 + (b.1 - a.1) * (t - a.0) / (b.0 - a.0),
            _ => a.1,
        }
    }

    fn at(&self, t: f64) -> f64 {
        self.planned_at(t).max(0.0)
    }
}

/// Knots that let a lead of `lead_ms` held at `from_ms` run out: at once when
/// the pointer is still for that long, so dropping the lead moves nothing,
/// otherwise at the bounded decay rate.
fn lead_decay(path: &Path, from_ms: f64, lead_ms: f64) -> Vec<Knot> {
    if lead_ms <= 0.0 {
        vec![(from_ms, 0.0)]
    } else if path.is_still_between(from_ms, from_ms + lead_ms) {
        vec![(from_ms, lead_ms), (from_ms + KNOT_EPSILON_MS, 0.0)]
    } else {
        vec![
            (from_ms, lead_ms),
            (from_ms + lead_ms / LEAD_DECAY_PER_MS, 0.0),
        ]
    }
}

/// A spring speed-up over one group: eased in on a log scale before it and
/// out after it.
#[derive(Clone, Copy, Debug)]
struct SpeedBump {
    ramp_in_start: f64,
    full_start: f64,
    full_end: f64,
    ramp_out_end: f64,
    log_speed: f64,
}

impl SpeedBump {
    fn new(group: &Group, anchor_ms: f64, speed: f64) -> Self {
        Self {
            ramp_in_start: anchor_ms.max(group.start - SPEED_BLEND_IN_MS),
            full_start: group.start,
            full_end: group.end,
            ramp_out_end: group.end + SPEED_BLEND_OUT_MS,
            log_speed: speed.ln(),
        }
    }

    fn log_speed_at(&self, t: f64) -> f64 {
        if t < self.full_start {
            let ramp = self.full_start - self.ramp_in_start;
            return if ramp <= 0.0 {
                self.log_speed
            } else {
                self.log_speed * (t - self.ramp_in_start) / ramp
            };
        }
        if t <= self.full_end {
            return self.log_speed;
        }
        let ramp = self.ramp_out_end - self.full_end;
        if ramp <= 0.0 {
            0.0
        } else {
            self.log_speed * (self.ramp_out_end - t) / ramp
        }
    }

    fn covers(&self, t: f64) -> bool {
        self.ramp_in_start <= t && t < self.ramp_out_end
    }
}

/// Committed speed-ups plus an optional candidate. The spring runs at the
/// largest speed-up covering a moment, never slower than its own pace.
#[derive(Clone, Copy)]
struct Speed<'a> {
    committed: &'a [SpeedBump],
    candidate: Option<&'a SpeedBump>,
    /// The longest committed speed-up. They are sorted by start, so one that
    /// starts more than this long before a moment has ended by it, and a
    /// lookup stops there instead of scanning every earlier speed-up.
    longest: f64,
}

impl<'a> Speed<'a> {
    fn new(committed: &'a [SpeedBump], candidate: Option<&'a SpeedBump>) -> Self {
        let longest = committed
            .iter()
            .map(|bump| bump.ramp_out_end - bump.ramp_in_start)
            .fold(0.0, f64::max);
        Self {
            committed,
            candidate,
            longest,
        }
    }

    fn at(&self, t: f64) -> f64 {
        let covering = self.committed[..self
            .committed
            .partition_point(|bump| bump.ramp_in_start <= t)]
            .iter()
            .rev()
            .take_while(|bump| bump.ramp_in_start >= t - self.longest)
            .chain(self.candidate)
            .filter(|bump| bump.covers(t))
            .map(|bump| bump.log_speed_at(t));
        covering.fold(0.0_f64, f64::max).exp()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct State {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

impl State {
    fn resting_at((x, y): (f64, f64)) -> Self {
        Self {
            x,
            y,
            vx: 0.0,
            vy: 0.0,
        }
    }
}

struct Spring<'a> {
    path: &'a Path,
    tension: f64,
    friction: f64,
    mass: f64,
}

impl Spring<'_> {
    fn lag_ms(&self) -> f64 {
        if self.tension <= 0.0 {
            0.0
        } else {
            self.friction / self.tension * 1000.0
        }
    }

    /// Advances from `from` to `to` in 1 ms steps aligned to whole ms, the
    /// target being the path `lead` ms ahead. While an axis still closes on
    /// its target faster than the undamped spring would carry it there, it
    /// is critically damped, so the cursor never overshoots the pointer.
    /// `on_ms` sees the state at every whole ms reached.
    fn run(
        &self,
        lead: Lead,
        speed: Speed,
        from: f64,
        to: f64,
        mut state: State,
        mut on_ms: impl FnMut(f64, State),
    ) -> State {
        let mut t = from;
        let mut bucket = f64::NAN;
        let (mut tension, mut friction, mut omega, mut critical) = (0.0, 0.0, 0.0, 0.0);
        while t < to {
            let next = to.min(t.floor() + 1.0);
            let dt = next - t;
            let (tx, ty) = self.path.position_at(next + lead.at(next));
            if self.mass <= 0.0 || self.tension <= 0.0 {
                state = State::resting_at((tx, ty));
            } else if !(state.x == tx && state.y == ty && state.vx == 0.0 && state.vy == 0.0) {
                let step_bucket = (next / SPEED_BUCKET_MS).floor() * SPEED_BUCKET_MS;
                if step_bucket != bucket {
                    bucket = step_bucket;
                    let s = speed.at(step_bucket);
                    tension = self.tension * s * s;
                    friction = self.friction * s;
                    omega = (tension / self.mass).sqrt();
                    critical = friction.max(2.0 * (self.mass * tension).sqrt());
                }
                let h = dt / 1000.0;
                let (dx, dy) = (tx - state.x, ty - state.y);
                let damping = |v: f64, d: f64| {
                    if v * d > 0.0 && v.abs() > d.abs() * omega {
                        critical
                    } else {
                        friction
                    }
                };
                let (cx, cy) = (damping(state.vx, dx), damping(state.vy, dy));
                state.vx += (dx * tension - state.vx * cx) / self.mass * h;
                state.vy += (dy * tension - state.vy * cy) / self.mass * h;
                state.x += state.vx * h;
                state.y += state.vy * h;
                if state.vx.abs() < SNAP_PT && (state.x - tx).abs() < SNAP_PT {
                    state.x = tx;
                    state.vx = 0.0;
                }
                if state.vy.abs() < SNAP_PT && (state.y - ty).abs() < SNAP_PT {
                    state.y = ty;
                    state.vy = 0.0;
                }
            }
            t = next;
            if t == t.floor() {
                on_ms(t, state);
            }
        }
        state
    }
}

#[derive(Clone, Debug)]
struct Group {
    start: f64,
    end: f64,
    /// (time, tolerance in points)
    points: Vec<(f64, f64)>,
}

fn group_points(mut points: Vec<(f64, f64)>) -> Vec<Group> {
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut groups: Vec<Group> = Vec::new();
    for point in points {
        match groups.last_mut() {
            Some(group) if point.0 - group.end <= GROUP_GAP_MS => {
                group.points.push(point);
                group.end = point.0;
            }
            _ => groups.push(Group {
                start: point.0,
                end: point.0,
                points: vec![point],
            }),
        }
    }
    groups
}

#[derive(Clone, Debug)]
struct Choice {
    error_ratio: f64,
    end_state: State,
    knots: Vec<Knot>,
    bump: Option<SpeedBump>,
}

impl Choice {
    fn end_lead_ms(&self) -> f64 {
        self.knots.last().map_or(0.0, |knot| knot.1)
    }
}

struct LeadRaise {
    at_ms: f64,
    jump_to_ms: f64,
}

/// Plans one group against what is already committed before it.
struct GroupPlan<'a> {
    spring: &'a Spring<'a>,
    group: &'a Group,
    anchor_ms: f64,
    anchor_lead_ms: f64,
    anchor_state: State,
    lead: &'a [Knot],
    speed: &'a [SpeedBump],
    window_start: f64,
    committed_states: Option<Vec<State>>,
}

impl<'a> GroupPlan<'a> {
    #[allow(clippy::too_many_arguments)]
    fn new(
        spring: &'a Spring<'a>,
        group: &'a Group,
        anchor_ms: f64,
        anchor_lead_ms: f64,
        anchor_state: State,
        lead: &'a [Knot],
        speed: &'a [SpeedBump],
    ) -> Self {
        Self {
            spring,
            group,
            anchor_ms,
            anchor_lead_ms,
            anchor_state,
            lead,
            speed,
            window_start: anchor_ms
                .max(group.start - APPROACH_WINDOW_MS - MAX_LEAD_MS)
                .floor(),
            committed_states: None,
        }
    }

    fn path(&self) -> &Path {
        self.spring.path
    }

    /// The smallest speed-up whose best lead meets the group, or the best
    /// plan found when none does.
    fn choose(&mut self) -> Choice {
        let levels = ANCHOR_SPEED_LEVELS;
        let mut tried: Vec<(usize, Choice)> = Vec::new();
        let mut lead_for = |plan: &mut Self, level: usize| -> Choice {
            if let Some((_, choice)) = tried.iter().find(|(tried, _)| *tried == level) {
                return choice.clone();
            }
            let choice = plan.choose_lead_for(levels[level]);
            tried.push((level, choice.clone()));
            choice
        };

        let first = lead_for(self, 0);
        if first.error_ratio <= ANCHOR_ACCEPTED_ERROR_RATIO {
            return first;
        }
        let (mut low, mut high) = (0, levels.len() - 1);
        let fastest = lead_for(self, high);
        if fastest.error_ratio > ANCHOR_ACCEPTED_ERROR_RATIO {
            return if fastest.error_ratio < first.error_ratio {
                fastest
            } else {
                first
            };
        }
        while high - low > 1 {
            let mid = (low + high) / 2;
            if lead_for(self, mid).error_ratio <= ANCHOR_ACCEPTED_ERROR_RATIO {
                high = mid;
            } else {
                low = mid;
            }
        }
        lead_for(self, high)
    }

    /// The smallest lead that meets the group at `speed`, trying 0 and then
    /// doublings from an eighth of the sped-up spring's lag up to the
    /// maximum; or the lead closest to meeting it.
    fn choose_lead_for(&mut self, speed: f64) -> Choice {
        let lag = self.spring.lag_ms() / speed;
        let mut leads = vec![0.0];
        let mut lead = lag / 8.0;
        while lead > 0.0 && lead < MAX_LEAD_MS {
            leads.push(lead);
            lead *= 2.0;
        }
        leads.push(MAX_LEAD_MS);
        leads.sort_by(f64::total_cmp);
        leads.dedup();

        let mut results: Vec<Option<Choice>> = Vec::with_capacity(leads.len());
        let mut best: Option<usize> = None;
        for (index, &lead) in leads.iter().enumerate() {
            let best_error = best
                .and_then(|best| results[best].as_ref())
                .map_or(f64::INFINITY, |choice| choice.error_ratio);
            let result = self.try_lead(lead, speed, ANCHOR_ACCEPTED_ERROR_RATIO.max(best_error));
            if let Some(choice) = &result {
                if choice.error_ratio <= ANCHOR_ACCEPTED_ERROR_RATIO {
                    let choice = choice.clone();
                    return if index == 0 {
                        choice
                    } else {
                        self.refine_lead(leads[index - 1], lead, choice, speed)
                    };
                }
                if choice.error_ratio < best_error {
                    best = Some(index);
                }
            }
            results.push(result);
        }

        match best {
            None => self
                .try_lead(0.0, speed, f64::INFINITY)
                .expect("a zero lead always has knots"),
            Some(index) => {
                let found = results[index].clone().expect("best is a tried lead");
                self.minimize_lead(
                    leads[index.saturating_sub(1)],
                    leads[(index + 1).min(leads.len() - 1)],
                    found,
                    speed,
                )
            }
        }
    }

    /// Bisects between a failing and a meeting lead for a smaller one that
    /// still meets the group.
    fn refine_lead(&mut self, mut low: f64, mut high: f64, found: Choice, speed: f64) -> Choice {
        let mut best = found;
        for _ in 0..6 {
            if high - low <= 0.5 {
                break;
            }
            let mid = (low + high) / 2.0;
            match self.try_lead(mid, speed, f64::INFINITY) {
                Some(choice) if choice.error_ratio <= ANCHOR_ACCEPTED_ERROR_RATIO => {
                    best = choice;
                    high = mid;
                }
                _ => low = mid,
            }
        }
        best
    }

    /// Golden-section search for the lead with the smallest error around
    /// the best one tried.
    fn minimize_lead(&mut self, mut low: f64, mut high: f64, found: Choice, speed: f64) -> Choice {
        let ratio = (5.0_f64.sqrt() - 1.0) / 2.0;
        let mut best = found;
        for _ in 0..12 {
            if high - low <= 0.25 {
                break;
            }
            let a = high - (high - low) * ratio;
            let b = low + (high - low) * ratio;
            let at_a = self.try_lead(a, speed, f64::INFINITY);
            let at_b = self.try_lead(b, speed, f64::INFINITY);
            let error_a = at_a.as_ref().map_or(f64::INFINITY, |c| c.error_ratio);
            let error_b = at_b.as_ref().map_or(f64::INFINITY, |c| c.error_ratio);
            if let Some(choice) = at_a
                && error_a < best.error_ratio
            {
                best = choice;
            }
            if let Some(choice) = at_b
                && error_b < best.error_ratio
            {
                best = choice;
            }
            if best.error_ratio <= ANCHOR_ACCEPTED_ERROR_RATIO {
                return best;
            }
            if error_a < error_b {
                high = b;
            } else {
                low = a;
            }
        }
        best
    }

    /// Worst anchor error in the group, as a share of each anchor's
    /// tolerance, with a lead of `lead_ms` at `speed`. Stops once past
    /// `give_up_above`.
    fn try_lead(&mut self, lead_ms: f64, speed: f64, give_up_above: f64) -> Option<Choice> {
        let (knots, changes_from) = self.lead_knots(lead_ms)?;
        let bump = (speed > 1.0).then(|| SpeedBump::new(self.group, self.anchor_ms, speed));
        let start = changes_from
            .min(bump.map_or(f64::INFINITY, |bump| bump.ramp_in_start))
            .min(self.group.start);
        let mut from = self.window_start.max(start.floor());
        let mut state = self.committed_state_at(from);
        let lead = Lead::new(self.lead, &knots);
        let speed_schedule = Speed::new(self.speed, bump.as_ref());
        let mut worst: f64 = 0.0;
        for &(time, tolerance) in &self.group.points {
            state = self
                .spring
                .run(lead, speed_schedule, from, time, state, |_, _| {});
            from = time;
            let (px, py) = self.path().position_at(time);
            let error = (state.x - px).hypot(state.y - py);
            worst = worst.max(error / tolerance);
            if worst > give_up_above {
                break;
            }
        }
        Some(Choice {
            error_ratio: worst,
            end_state: state,
            knots,
            bump,
        })
    }

    /// The committed motion, with the previous group's lead running out, at
    /// whole ms from the window start to the group start.
    fn committed_state_at(&mut self, t: f64) -> State {
        if self.committed_states.is_none() {
            let decay = lead_decay(self.path(), self.anchor_ms, self.anchor_lead_ms);
            let lead = Lead::new(self.lead, &decay);
            let speed = Speed::new(self.speed, None);
            let first = self.spring.run(
                lead,
                speed,
                self.anchor_ms,
                self.window_start,
                self.anchor_state,
                |_, _| {},
            );
            let count = (self.group.start.ceil() - self.window_start + 1.0).max(1.0) as usize;
            let mut states = Vec::with_capacity(count);
            states.push(first);
            let mut state = first;
            for index in 1..count {
                let at = self.window_start + index as f64;
                state = self.spring.run(lead, speed, at - 1.0, at, state, |_, _| {});
                states.push(state);
            }
            self.committed_states = Some(states);
        }
        let states = self.committed_states.as_ref().unwrap();
        let index = (t - self.window_start).max(0.0) as usize;
        states[index.min(states.len() - 1)]
    }

    /// Lead knots for a lead of `lead_ms` held over the group, and the time
    /// they start to differ from the committed plan.
    fn lead_knots(&self, lead_ms: f64) -> Option<(Vec<Knot>, f64)> {
        let decay = lead_decay(self.path(), self.anchor_ms, self.anchor_lead_ms);
        let planned = |t: f64| Lead::new(&[], &decay).planned_at(t);
        if lead_ms <= 0.0 {
            let mut knots: Vec<Knot> = decay
                .iter()
                .copied()
                .filter(|knot| knot.0 < self.group.end)
                .collect();
            knots.push((self.group.end, planned(self.group.end)));
            return Some((knots, self.group.start));
        }
        let raise = self.find_lead_raise(lead_ms, planned)?;
        let mut knots: Vec<Knot> = decay
            .iter()
            .copied()
            .filter(|knot| knot.0 < raise.at_ms)
            .collect();
        knots.extend([
            (raise.at_ms, planned(raise.at_ms)),
            (raise.at_ms + KNOT_EPSILON_MS, raise.jump_to_ms),
            (self.group.start, lead_ms),
            (self.group.end, lead_ms),
        ]);
        Some((knots, raise.at_ms))
    }

    /// Where the lead rises to `lead_ms`: preferably inside a rest, jumping
    /// to as much of it as the rest hides, otherwise ramping in over the
    /// last 400 ms before the group. Either way the target then moves at a
    /// bounded rate until the group starts.
    fn find_lead_raise(&self, lead_ms: f64, planned: impl Fn(f64) -> f64) -> Option<LeadRaise> {
        let start = self.group.start;
        let earliest = self.anchor_ms.max(start - APPROACH_WINDOW_MS);
        let paced = |at: f64, jump: f64| {
            let rate = (start + lead_ms - (at + jump)) / (start - at);
            (1.0 - LEAD_DECAY_PER_MS..=MAX_COMPRESSION_RATE).contains(&rate)
        };

        let mut rest = self.path().last_rest_ending_by(start + lead_ms);
        while let Some((rest_start, rest_end)) = rest
            && rest_end > earliest
        {
            let at = (start - 1.0).min(earliest.max(rest_end - lead_ms));
            let current = planned(at);
            let jump = lead_ms.min(rest_end - at);
            if at >= self.anchor_ms
                && at + jump.min(current) >= rest_start
                && at + jump.max(current) <= rest_end
                && paced(at, jump)
            {
                return Some(LeadRaise {
                    at_ms: at,
                    jump_to_ms: jump,
                });
            }
            rest = self.path().last_rest_ending_by(rest_start);
        }

        let at = self.anchor_ms.max(start - COMPRESSION_WINDOW_MS);
        if at >= start {
            return None;
        }
        let current = planned(at);
        paced(at, current).then_some(LeadRaise {
            at_ms: at,
            jump_to_ms: current,
        })
    }
}

/// `build_smoothed_timeline` for the trailing follow.
pub(super) fn build_trailing_timeline(
    cursor: &CursorEvents,
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
    interaction: bool,
    hover_changes_ms: &[f64],
) -> SmoothedTimeline {
    if moves.is_empty() {
        return SmoothedTimeline {
            events: vec![],
            cursor_ids: Vec::new(),
        };
    }

    let (width, height) = DISPLAY_POINTS;
    let mut samples: Vec<Sample> = moves
        .iter()
        .filter(|event| event.time_ms.is_finite())
        .map(|event| Sample {
            t: event.time_ms,
            x: event.x * width,
            y: event.y * height,
        })
        .collect();
    if samples.is_empty() {
        return SmoothedTimeline {
            events: vec![],
            cursor_ids: Vec::new(),
        };
    }
    samples.sort_by(|a, b| a.t.total_cmp(&b.t));
    // Presses after the last move still count: the pointer rests there.
    let end_time_ms = cursor
        .clicks
        .iter()
        .map(|click| click.time_ms)
        .filter(|time| time.is_finite())
        .fold(samples.last().unwrap().t, f64::max);
    let path = Path::new(samples);

    let mut points: Vec<(f64, f64)> = Vec::new();
    if interaction {
        points.extend(
            interaction_anchors(cursor, path.start_ms(), end_time_ms)
                .iter()
                .map(|anchor| (anchor.time_ms, anchor.tolerance)),
        );
        points.extend(
            hover_changes_ms
                .iter()
                .filter(|&&time| time >= path.start_ms() && time <= end_time_ms)
                .map(|&time| (time, AnchorKind::Hover.tolerance())),
        );
    }

    let spring = Spring {
        path: &path,
        tension: f64::from(smoothing_config.tension),
        friction: f64::from(smoothing_config.friction),
        mass: f64::from(smoothing_config.mass),
    };
    let origin = path.start_ms().floor().min(0.0);
    let (lead, speed) = plan(&spring, group_points(points), origin);

    let lead_view = Lead::new(&lead, &[]);
    let speed_view = Speed::new(&speed, None);
    let initial = State::resting_at(path.position_at(origin + lead_view.at(origin)));

    let settle_deadline = end_time_ms + SPRING_SETTLE_TIMEOUT_MS;
    let capacity = ((settle_deadline / SIMULATION_STEP_MS).ceil().max(0.0) as usize) + 2;
    let mut events = Vec::with_capacity(capacity);
    let mut cursor_ids = CursorIdIndex::new();
    let mut cid_hint = 0;
    let mut push = |time: f64, state: State, events: &mut Vec<SmoothedCursorEvent>| {
        let clamped = time.min(end_time_ms);
        let _ = position_at_time_hinted(moves, clamped, &mut cid_hint);
        events.push(SmoothedCursorEvent {
            time: time as f32,
            position: XY::new((state.x / width) as f32, (state.y / height) as f32),
            velocity: XY::new((state.vx / width) as f32, (state.vy / height) as f32),
            cursor_id: cursor_ids.intern(cursor_id_at_time(moves, clamped, cid_hint)),
        });
    };

    // Whole-ms states, read at the 60 Hz step times by interpolation.
    let mut previous = (origin, initial);
    let mut next_step = 0usize;
    let mut state = initial;
    let mut t = origin;
    let chunk_ms = 250.0;
    while t < settle_deadline {
        let to = (t + chunk_ms).min(settle_deadline);
        let mut settled_at = None;
        state = spring.run(lead_view, speed_view, t, to, state, |time, current| {
            let step_time = |step: usize| step as f64 * SIMULATION_STEP_MS;
            while step_time(next_step) <= time {
                let at = step_time(next_step);
                let (t0, s0) = previous;
                let u = if time > t0 {
                    (at - t0) / (time - t0)
                } else {
                    1.0
                };
                let u = u.clamp(0.0, 1.0);
                let blended = State {
                    x: s0.x + (current.x - s0.x) * u,
                    y: s0.y + (current.y - s0.y) * u,
                    vx: s0.vx + (current.vx - s0.vx) * u,
                    vy: s0.vy + (current.vy - s0.vy) * u,
                };
                push(at, blended, &mut events);
                next_step += 1;
            }
            previous = (time, current);
            if settled_at.is_none() && time >= end_time_ms && current.vx == 0.0 && current.vy == 0.0
            {
                let target = path.position_at(time + lead_view.at(time));
                if current.x == target.0 && current.y == target.1 {
                    settled_at = Some(time);
                }
            }
        });
        t = to;
        if settled_at.is_some() {
            break;
        }
    }
    if events.is_empty() {
        push(0.0, state, &mut events);
    }

    SmoothedTimeline {
        events,
        cursor_ids: cursor_ids.ids,
    }
}

/// One forward pass over the groups. A group that cannot be met and starts
/// soon after the previous one is planned together with it instead.
fn plan(spring: &Spring, mut groups: Vec<Group>, origin: f64) -> (Vec<Knot>, Vec<SpeedBump>) {
    struct Committed {
        group: Group,
        choice: Choice,
        lead_before: usize,
        /// Where this group's speed-up went, so dropping the group (the last
        /// one committed) takes exactly that out again.
        speed_inserted: Option<usize>,
    }

    let path = spring.path;
    let mut lead: Vec<Knot> = Vec::new();
    let mut speed: Vec<SpeedBump> = Vec::new();
    let mut committed: Vec<Committed> = Vec::new();
    let mut index = 0;
    while index < groups.len() {
        let group = groups[index].clone();
        let previous = committed.last();
        let anchor_ms = previous.map_or(origin, |previous| previous.group.end);
        let anchor_lead_ms = previous.map_or(0.0, |previous| previous.choice.end_lead_ms());
        let anchor_state = previous.map_or_else(
            || State::resting_at(path.position_at(origin)),
            |previous| previous.choice.end_state,
        );
        let choice = GroupPlan::new(
            spring,
            &group,
            anchor_ms,
            anchor_lead_ms,
            anchor_state,
            &lead,
            &speed,
        )
        .choose();

        if choice.error_ratio > 1.0
            && let Some(previous) = committed.last()
            && group.start - previous.group.end <= MERGE_GAP_MS
        {
            let previous = committed.pop().unwrap();
            lead.truncate(previous.lead_before);
            if let Some(at) = previous.speed_inserted {
                speed.remove(at);
            }
            let mut points = previous.group.points;
            points.extend(group.points);
            groups[index] = Group {
                start: previous.group.start,
                end: group.end,
                points,
            };
            continue;
        }

        let lead_before = lead.len();
        lead.extend(choice.knots.iter().copied());
        let speed_inserted = choice.bump.map(|bump| {
            let at = speed.partition_point(|existing| existing.ramp_in_start <= bump.ramp_in_start);
            speed.insert(at, bump);
            at
        });
        committed.push(Committed {
            group,
            choice,
            lead_before,
            speed_inserted,
        });
        index += 1;
    }

    let (end_ms, end_lead_ms) = committed.last().map_or((origin, 0.0), |last| {
        (last.group.end, last.choice.end_lead_ms())
    });
    lead.extend(lead_decay(path, end_ms, end_lead_ms));
    (lead, speed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(points: &[(f64, f64, f64)]) -> Path {
        Path::new(points.iter().map(|&(t, x, y)| Sample { t, x, y }).collect())
    }

    #[test]
    fn samples_far_apart_hold_instead_of_sliding() {
        let path = path(&[(0.0, 0.0, 0.0), (100.0, 100.0, 0.0), (120.0, 120.0, 0.0)]);
        assert_eq!(path.position_at(50.0), (0.0, 0.0));
        assert_eq!(path.position_at(110.0), (110.0, 0.0));
        assert_eq!(path.moving, vec![(100.0, 120.0)]);
        assert!(path.is_still_between(10.0, 90.0));
        assert!(!path.is_still_between(90.0, 110.0));
        assert_eq!(
            path.last_rest_ending_by(500.0),
            Some((f64::NEG_INFINITY, 100.0))
        );
    }

    #[test]
    fn lead_interpolates_across_committed_and_candidate_knots() {
        let committed = [(0.0, 0.0), (100.0, 50.0)];
        let extra = [(100.0, 50.0), (200.0, 0.0)];
        let lead = Lead::new(&committed, &extra);
        assert_eq!(lead.at(-5.0), 0.0);
        assert_eq!(lead.at(50.0), 25.0);
        assert_eq!(lead.at(150.0), 25.0);
        assert_eq!(lead.at(300.0), 0.0);
    }

    #[test]
    fn a_speed_lookup_skipping_ended_speed_ups_reads_the_same() {
        let bumps: Vec<SpeedBump> = (0..400)
            .map(|index| {
                let start = index as f64 * 37.0 + (index % 7) as f64 * 11.0;
                let group = Group {
                    start,
                    end: start + 20.0 + (index % 5) as f64 * 90.0,
                    points: vec![],
                };
                SpeedBump::new(&group, start - 400.0, 1.0 + (index % 9) as f64 * 0.4)
            })
            .collect();
        let mut sorted = bumps.clone();
        sorted.sort_by(|a, b| a.ramp_in_start.total_cmp(&b.ramp_in_start));
        let speed = Speed::new(&sorted, None);
        for step in 0..4000 {
            let t = step as f64 * 4.0;
            let full = sorted
                .iter()
                .filter(|bump| bump.covers(t))
                .map(|bump| bump.log_speed_at(t))
                .fold(0.0_f64, f64::max)
                .exp();
            assert_eq!(speed.at(t), full, "{t}");
        }
    }

    #[test]
    fn speed_bumps_blend_on_a_log_scale() {
        let group = Group {
            start: 1000.0,
            end: 1100.0,
            points: vec![],
        };
        let bump = SpeedBump::new(&group, 0.0, 4.0);
        let speed = Speed::new(&[], Some(&bump));
        assert_eq!(speed.at(500.0), 1.0);
        assert!((speed.at(875.0) - 2.0).abs() < 1e-9);
        assert!((speed.at(1050.0) - 4.0).abs() < 1e-9);
        assert!((speed.at(1250.0) - 2.0).abs() < 1e-9);
        assert_eq!(speed.at(1400.0), 1.0);
    }

    const SPRING: SpringMassDamperSimulationConfig = SpringMassDamperSimulationConfig {
        tension: 125.0,
        mass: 1.5,
        friction: 12.0,
    };

    fn moves_along(
        from: (f64, f64),
        to: (f64, f64),
        start_ms: f64,
        duration_ms: f64,
    ) -> Vec<CursorMoveEvent> {
        let mut moves = vec![CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "0".into(),
            time_ms: 0.0,
            x: from.0,
            y: from.1,
        }];
        let steps = (duration_ms / (1000.0 / 120.0)).round() as usize;
        for step in 1..=steps {
            let u = step as f64 / steps as f64;
            moves.push(CursorMoveEvent {
                active_modifiers: vec![],
                cursor_id: "0".into(),
                time_ms: start_ms + duration_ms * u,
                x: from.0 + (to.0 - from.0) * u,
                y: from.1 + (to.1 - from.1) * u,
            });
        }
        moves
    }

    fn click(time_ms: f64, down: bool) -> cap_project::CursorClickEvent {
        cap_project::CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 1,
            cursor_id: "0".into(),
            time_ms,
            down,
        }
    }

    fn position(timeline: &SmoothedTimeline, time_ms: f64) -> (f64, f64) {
        let p = super::super::interpolate_timeline(&timeline.events, &timeline.cursor_ids, time_ms)
            .unwrap()
            .position
            .coord;
        (p.x, p.y)
    }

    fn distance_pt(a: (f64, f64), b: (f64, f64)) -> f64 {
        ((a.0 - b.0) * DISPLAY_POINTS.0).hypot((a.1 - b.1) * DISPLAY_POINTS.1)
    }

    /// Chasing a steady glide the clamp holds the spring at the edge of
    /// critical damping, so it trails by sqrt(mass / tension): 110 ms here.
    #[test]
    fn a_free_glide_trails_the_pointer_by_the_spring_lag() {
        let moves = moves_along((0.1, 0.5), (0.9, 0.5), 100.0, 3000.0);
        let cursor = CursorEvents {
            moves: moves.clone(),
            clicks: vec![],
        };
        let timeline = build_trailing_timeline(&cursor, &moves, SPRING, true, &[]);
        let speed_uv_per_ms = 0.8 / 3000.0;
        for time_ms in [1500.0, 2000.0, 2500.0] {
            let (x, _) = position(&timeline, time_ms);
            let pointer_x = 0.1 + (time_ms - 100.0) * speed_uv_per_ms;
            let lag_ms = (pointer_x - x) / speed_uv_per_ms;
            let expected = (1.5f64 / 125.0).sqrt() * 1000.0;
            assert!(
                (lag_ms - expected).abs() < 2.0,
                "lag {lag_ms} ms at {time_ms}"
            );
        }
        let (x, y) = position(&timeline, 6000.0);
        assert_eq!((x as f32, y as f32), (0.9, 0.5));
    }

    #[test]
    fn a_press_soon_after_a_move_still_lands_on_the_pointer() {
        // The move ends 200 ms before the press, its last sample long before
        // the press, so the press lies past the recorded moves.
        let moves = moves_along((0.2, 0.3), (0.6, 0.7), 100.0, 600.0);
        let cursor = CursorEvents {
            moves: moves.clone(),
            clicks: vec![click(900.0, true), click(980.0, false)],
        };
        let target = (0.6, 0.7);
        let anchored = build_trailing_timeline(&cursor, &moves, SPRING, true, &[]);
        for time_ms in [900.0, 980.0] {
            let error = distance_pt(position(&anchored, time_ms), target);
            assert!(
                error <= 2.0 * ANCHOR_ACCEPTED_ERROR_RATIO + 0.05,
                "{error} pt at {time_ms}"
            );
        }
        let free = build_trailing_timeline(&cursor, &moves, SPRING, false, &[]);
        assert!(distance_pt(position(&free, 900.0), target) > 2.0);
        // To get there in time the cursor runs ahead of the pointer through
        // the move, setting off a little before it.
        let (x, _) = position(&anchored, 400.0);
        let pointer_x = 0.2 + 0.4 * (300.0 / 600.0);
        assert!(x > pointer_x, "cursor at {x}, pointer at {pointer_x}");
        assert_eq!(position(&anchored, 0.0), (0.2f32 as f64, 0.3f32 as f64));
    }
}
