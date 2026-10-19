//! Real-time scheduling for the verification suite's input sources.
//!
//! Hosted runners start jobs at utility QoS (scheduler base priority 20) and
//! every thread inherits it. A blocking sleep at that tier may be coalesced
//! by up to `min(8 * requested, 150 ms)` (XNU timer coalescing with idle
//! amplification), and a successful user-interactive QoS request does not
//! lift the task's clamp: synthetic sources at QoS 33 still ran at priority
//! 20 and woke about 151 ms late (run 38766191045). The inputs a user
//! records come from a foreground app and device callbacks the system runs
//! in real time, so every input thread asks for a time constraint matching
//! its period, and the result is read back from the kernel instead of
//! trusting the request's status.

use serde::{Deserialize, Serialize};

/// A time-constraint policy in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Constraint {
    pub period_ms: f64,
    pub computation_ms: f64,
    pub constraint_ms: f64,
    pub preemptible: bool,
}

/// A thread's effective scheduling state (`THREAD_EXTENDED_INFO`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadState {
    pub policy: i32,
    pub base_pri: i32,
    pub cur_pri: i32,
    pub max_pri: i32,
    pub cpu_us: u64,
}

/// Lowest scheduler priority of the real-time band (`BASEPRI_RTQUEUES`).
pub const REALTIME_PRIORITY: i32 = 97;

/// The outcome of [`request_realtime`]: every kernel status, the policy the
/// kernel reports back and the thread's effective state right after.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Realtime {
    pub requested: Constraint,
    pub qos_status: i32,
    pub policy_status: i32,
    pub readback_status: i32,
    /// The kernel answered the readback with the default policy: the thread
    /// is not time-constrained.
    pub readback_default: bool,
    pub granted: Option<Constraint>,
    pub state: Option<ThreadState>,
}

impl Realtime {
    /// `Ok` when the kernel applied the time constraint (the computation
    /// budget may be raised by the kernel, never lowered) and the thread
    /// runs in the real-time band.
    pub fn obtained(&self) -> Result<(), String> {
        if self.policy_status != 0 {
            return Err(format!(
                "thread_policy_set(TIME_CONSTRAINT) returned {}",
                self.policy_status
            ));
        }
        if self.readback_status != 0 || self.readback_default {
            return Err(format!(
                "thread_policy_get(TIME_CONSTRAINT) returned {} (default policy: {})",
                self.readback_status, self.readback_default
            ));
        }
        let Some(granted) = self.granted else {
            return Err("no time constraint read back".into());
        };
        let tick = 0.001;
        if (granted.period_ms - self.requested.period_ms).abs() > tick
            || (granted.constraint_ms - self.requested.constraint_ms).abs() > tick
            || granted.computation_ms + tick < self.requested.computation_ms
            || granted.computation_ms > granted.constraint_ms + tick
            || granted.preemptible != self.requested.preemptible
        {
            return Err(format!(
                "kernel granted {granted:?} for requested {:?}",
                self.requested
            ));
        }
        state_is_realtime(self.state)
    }
}

/// `Ok` when the thread state is in the real-time band.
pub fn state_is_realtime(state: Option<ThreadState>) -> Result<(), String> {
    match state {
        Some(state) if state.base_pri >= REALTIME_PRIORITY => Ok(()),
        Some(state) => Err(format!(
            "thread base priority {} is below the real-time band ({REALTIME_PRIORITY})",
            state.base_pri
        )),
        None => Err("thread_info(THREAD_EXTENDED_INFO) failed".into()),
    }
}

#[repr(C)]
struct ThreadExtendedInfo {
    user_time: u64,
    system_time: u64,
    cpu_usage: i32,
    policy: i32,
    run_state: i32,
    flags: i32,
    sleep_time: i32,
    cur_pri: i32,
    priority: i32,
    max_priority: i32,
    name: [u8; 64],
}

#[repr(C)]
#[derive(Default)]
struct TimeConstraintPolicy {
    period: u32,
    computation: u32,
    constraint: u32,
    preemptible: i32,
}

const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
const THREAD_TIME_CONSTRAINT_POLICY: u32 = 2;
const THREAD_EXTENDED_INFO: i32 = 5;

unsafe extern "C" {
    fn pthread_self() -> usize;
    fn pthread_mach_thread_np(thread: usize) -> u32;
    fn thread_info(thread: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    fn thread_policy_set(thread: u32, flavor: u32, policy: *const i32, count: u32) -> i32;
    fn thread_policy_get(
        thread: u32,
        flavor: u32,
        policy: *mut i32,
        count: *mut u32,
        get_default: *mut i32,
    ) -> i32;
    fn pthread_set_qos_class_self_np(qos: u32, relative_priority: i32) -> i32;
    fn mach_wait_until(deadline: u64) -> i32;
}

/// The calling thread's Mach port, owned by pthread for the thread's
/// lifetime (unlike `mach_thread_self`, it adds no port reference).
pub fn current_thread() -> u32 {
    unsafe { pthread_mach_thread_np(pthread_self()) }
}

fn ticks_per_ms() -> f64 {
    let info = cidre::mach::TimeBaseInfo::new();
    1e6 * f64::from(info.denom) / f64::from(info.numer)
}

/// Asks for user-interactive QoS and a time constraint of `period`
/// (constraint = period, preemptible) with a bounded `computation` budget,
/// then reads both back.
pub fn request_realtime(period_secs: f64, computation_secs: f64) -> Realtime {
    let per_ms = ticks_per_ms();
    let ticks = |secs: f64| (secs * 1e3 * per_ms).round() as u32;
    let requested = Constraint {
        period_ms: period_secs * 1e3,
        computation_ms: computation_secs * 1e3,
        constraint_ms: period_secs * 1e3,
        preemptible: true,
    };
    let qos_status = unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
    let thread = current_thread();
    let policy = TimeConstraintPolicy {
        period: ticks(period_secs),
        computation: ticks(computation_secs),
        constraint: ticks(period_secs),
        preemptible: 1,
    };
    let count = (std::mem::size_of::<TimeConstraintPolicy>() / 4) as u32;
    let policy_status = unsafe {
        thread_policy_set(
            thread,
            THREAD_TIME_CONSTRAINT_POLICY,
            (&raw const policy).cast(),
            count,
        )
    };
    let mut readback = TimeConstraintPolicy::default();
    let mut readback_count = count;
    let mut get_default = 0i32;
    let readback_status = unsafe {
        thread_policy_get(
            thread,
            THREAD_TIME_CONSTRAINT_POLICY,
            (&raw mut readback).cast(),
            &mut readback_count,
            &mut get_default,
        )
    };
    let ms = |ticks: u32| f64::from(ticks) / per_ms;
    Realtime {
        requested,
        qos_status,
        policy_status,
        readback_status,
        readback_default: get_default != 0,
        granted: (readback_status == 0).then(|| Constraint {
            period_ms: ms(readback.period),
            computation_ms: ms(readback.computation),
            constraint_ms: ms(readback.constraint),
            preemptible: readback.preemptible != 0,
        }),
        state: thread_state(thread),
    }
}

/// The effective scheduling state of `thread`.
pub fn thread_state(thread: u32) -> Option<ThreadState> {
    let mut info = ThreadExtendedInfo {
        user_time: 0,
        system_time: 0,
        cpu_usage: 0,
        policy: 0,
        run_state: 0,
        flags: 0,
        sleep_time: 0,
        cur_pri: 0,
        priority: 0,
        max_priority: 0,
        name: [0; 64],
    };
    let mut count = (std::mem::size_of::<ThreadExtendedInfo>() / 4) as u32;
    let status = unsafe {
        thread_info(
            thread,
            THREAD_EXTENDED_INFO,
            (&raw mut info).cast(),
            &mut count,
        )
    };
    (status == 0).then_some(ThreadState {
        policy: info.policy,
        base_pri: info.priority,
        cur_pri: info.cur_pri,
        max_pri: info.max_priority,
        cpu_us: (info.user_time + info.system_time) / 1000,
    })
}

/// Blocks until the host clock reaches `deadline` (Mach absolute ticks).
pub fn wait_until(deadline: u64) {
    unsafe { mach_wait_until(deadline) };
}
