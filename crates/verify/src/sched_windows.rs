//! Real-time scheduling for the verification suite's input sources, Windows.
//!
//! The same interface as the macOS module. Windows has no time-constraint
//! policy: an input thread asks for `THREAD_PRIORITY_TIME_CRITICAL` (the top
//! of its process's priority class, where audio and capture callbacks run)
//! and a 1 ms system timer resolution, and the priority is read back. Host
//! ticks are QueryPerformanceCounter ticks, the clock Cap stamps Windows
//! capture with (`Timestamp::PerformanceCounter`).

use serde::{Deserialize, Serialize};

/// Milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Constraint {
    pub period_ms: f64,
    pub computation_ms: f64,
    pub constraint_ms: f64,
    pub preemptible: bool,
}

/// A thread's scheduling state: `GetThreadPriority` in every priority field
/// and the thread's CPU time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadState {
    pub policy: i32,
    pub base_pri: i32,
    pub cur_pri: i32,
    pub max_pri: i32,
    pub cpu_us: u64,
}

/// `THREAD_PRIORITY_TIME_CRITICAL`.
pub const REALTIME_PRIORITY: i32 = 15;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Realtime {
    pub requested: Constraint,
    /// `timeBeginPeriod(1)` (`TIMERR_NOERROR` is 0).
    pub qos_status: i32,
    /// 0 when `SetThreadPriority` succeeded, else `GetLastError`.
    pub policy_status: i32,
    pub readback_status: i32,
    pub readback_default: bool,
    pub granted: Option<Constraint>,
    pub state: Option<ThreadState>,
}

impl Realtime {
    pub fn obtained(&self) -> Result<(), String> {
        if self.policy_status != 0 {
            return Err(format!(
                "SetThreadPriority(TIME_CRITICAL) failed: {}",
                self.policy_status
            ));
        }
        state_is_realtime(self.state)
    }
}

pub fn state_is_realtime(state: Option<ThreadState>) -> Result<(), String> {
    match state {
        Some(state) if state.base_pri >= REALTIME_PRIORITY => Ok(()),
        Some(state) => Err(format!(
            "thread priority {} is below time-critical ({REALTIME_PRIORITY})",
            state.base_pri
        )),
        None => Err("GetThreadPriority failed".into()),
    }
}

const THREAD_QUERY_LIMITED_INFORMATION: u32 = 0x0800;
const THREAD_PRIORITY_ERROR_RETURN: i32 = 0x7fff_ffff;
const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION: u32 = 0x0000_0002;
const TIMER_ALL_ACCESS: u32 = 0x001F_0003;
const INFINITE: u32 = 0xFFFF_FFFF;

unsafe extern "system" {
    fn GetCurrentThread() -> isize;
    fn GetCurrentThreadId() -> u32;
    fn GetLastError() -> u32;
    fn SetThreadPriority(thread: isize, priority: i32) -> i32;
    fn GetThreadPriority(thread: isize) -> i32;
    fn OpenThread(access: u32, inherit: i32, id: u32) -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn GetThreadTimes(
        thread: isize,
        creation: *mut u64,
        exit: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn QueryPerformanceCounter(count: *mut i64) -> i32;
    fn QueryPerformanceFrequency(frequency: *mut i64) -> i32;
    fn CreateWaitableTimerExW(
        attributes: *const core::ffi::c_void,
        name: *const u16,
        flags: u32,
        access: u32,
    ) -> isize;
    fn SetWaitableTimer(
        timer: isize,
        due: *const i64,
        period: i32,
        completion: *const core::ffi::c_void,
        argument: *const core::ffi::c_void,
        resume: i32,
    ) -> i32;
    fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
    fn SwitchToThread() -> i32;
}

#[link(name = "winmm")]
unsafe extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
}

pub fn current_thread() -> u32 {
    unsafe { GetCurrentThreadId() }
}

pub fn qpc_now() -> u64 {
    let mut count = 0i64;
    unsafe { QueryPerformanceCounter(&mut count) };
    count as u64
}

pub fn qpc_frequency() -> u64 {
    static FREQUENCY: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *FREQUENCY.get_or_init(|| {
        let mut frequency = 0i64;
        unsafe { QueryPerformanceFrequency(&mut frequency) };
        frequency.max(1) as u64
    })
}

/// Asks for the time-critical priority and a 1 ms timer resolution, then
/// reads the priority back.
pub fn request_realtime(period_secs: f64, computation_secs: f64) -> Realtime {
    let requested = Constraint {
        period_ms: period_secs * 1e3,
        computation_ms: computation_secs * 1e3,
        constraint_ms: period_secs * 1e3,
        preemptible: true,
    };
    let qos_status = unsafe { timeBeginPeriod(1) } as i32;
    let policy_status = if unsafe { SetThreadPriority(GetCurrentThread(), REALTIME_PRIORITY) } != 0
    {
        0
    } else {
        unsafe { GetLastError() as i32 }
    };
    let state = thread_state(current_thread());
    let granted = state
        .filter(|state| state.base_pri >= REALTIME_PRIORITY)
        .map(|_| requested);
    Realtime {
        requested,
        qos_status,
        policy_status,
        readback_status: if state.is_some() { 0 } else { -1 },
        readback_default: granted.is_none(),
        granted,
        state,
    }
}

pub fn thread_state(thread: u32) -> Option<ThreadState> {
    let handle = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, thread) };
    if handle == 0 {
        return None;
    }
    let priority = unsafe { GetThreadPriority(handle) };
    let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    let times = unsafe { GetThreadTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    (priority != THREAD_PRIORITY_ERROR_RETURN).then_some(ThreadState {
        policy: 0,
        base_pri: priority,
        cur_pri: priority,
        max_pri: REALTIME_PRIORITY,
        // FILETIME counts 100 ns intervals.
        cpu_us: if times != 0 { (kernel + user) / 10 } else { 0 },
    })
}

struct Timer(isize);

impl Drop for Timer {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { CloseHandle(self.0) };
        }
    }
}

thread_local! {
    static TIMER: Timer = Timer(unsafe {
        CreateWaitableTimerExW(
            std::ptr::null(),
            std::ptr::null(),
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
            TIMER_ALL_ACCESS,
        )
    });
}

/// How long before the deadline the timer wait ends and spinning starts.
const SPIN_SECS: f64 = 0.000_25;

/// Blocks until the host clock reaches `deadline` (QueryPerformanceCounter
/// ticks): a high-resolution waitable timer for most of the wait, then a
/// yielding spin for the last quarter millisecond.
pub fn wait_until(deadline: u64) {
    let frequency = qpc_frequency() as f64;
    let remaining = |now: u64| (deadline as f64 - now as f64) / frequency;
    let left = remaining(qpc_now());
    if left > SPIN_SECS {
        TIMER.with(|&Timer(timer)| {
            if timer != 0 {
                // Negative: relative, in 100 ns intervals.
                let due = -(((left - SPIN_SECS) * 1e7) as i64).max(1);
                unsafe {
                    if SetWaitableTimer(timer, &due, 0, std::ptr::null(), std::ptr::null(), 0) != 0
                    {
                        WaitForSingleObject(timer, INFINITE);
                    }
                }
            }
        });
    }
    while remaining(qpc_now()) > 0.0 {
        unsafe { SwitchToThread() };
    }
}
