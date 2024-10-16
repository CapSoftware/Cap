use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, RwLock,
};
use std::time::{Duration, Instant};

// TODO: Move to utils mod?

pub trait CloneFrom<T> {
    fn clone_from(value: &T) -> Self;
}

pub trait CloneInto<T> {
    fn clone_into(&self) -> T;
}

impl<S, T> CloneFrom<T> for S
where
    T: CloneInto<S>,
{
    fn clone_from(value: &T) -> Self {
        value.clone_into()
    }
}

pub trait PipelineClock: Clone + Send + 'static {
    fn start(&mut self);

    fn stop(&mut self);
}

pub trait LocalTimestamp: Sized + Clone {
    fn elapsed_since(&self, other: &Self) -> Duration;
}

impl LocalTimestamp for () {
    fn elapsed_since(&self, _other: &Self) -> Duration {
        Duration::ZERO
    }
}

impl LocalTimestamp for Instant {
    fn elapsed_since(&self, other: &Self) -> Duration {
        self.duration_since(*other)
    }
}

#[derive(Debug, Clone)]
pub struct RawNanoseconds(pub u64);

impl LocalTimestamp for RawNanoseconds {
    fn elapsed_since(&self, other: &Self) -> Duration {
        Duration::from_nanos(self.0) - Duration::from_nanos(other.0)
    }
}

#[derive(Debug, Clone)]
pub struct SynchronisedClock<T: LocalTimestamp> {
    local_start_time: Option<Instant>,
    global_start_time: Arc<RwLock<Instant>>,
    first_local_timestamp: Option<T>,
    // We could store the `Duration` here, but that would be more expensive than using an atomic integer.
    resume_offset_nanoseconds: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
}

impl<Source: LocalTimestamp, Target: LocalTimestamp> CloneInto<SynchronisedClock<Target>>
    for SynchronisedClock<Source>
{
    fn clone_into(&self) -> SynchronisedClock<Target> {
        let SynchronisedClock {
            global_start_time,
            resume_offset_nanoseconds,
            running,
            ..
        } = self.clone();

        SynchronisedClock {
            global_start_time,
            resume_offset_nanoseconds,
            running,
            local_start_time: None,
            first_local_timestamp: None,
        }
    }
}

impl<T: LocalTimestamp> SynchronisedClock<T> {
    pub fn init() -> SynchronisedClock<()> {
        SynchronisedClock::<()>::new()
    }

    pub fn new() -> Self {
        Self {
            local_start_time: None,
            global_start_time: Arc::new(RwLock::new(Instant::now())),
            first_local_timestamp: None,
            resume_offset_nanoseconds: Arc::new(AtomicU64::new(0)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    fn set_running(&self, value: bool) {
        self.running.store(value, Ordering::Release);
    }

    fn resume_offset(&self) -> Duration {
        let nanos = self.resume_offset_nanoseconds.load(Ordering::Acquire);

        Duration::from_nanos(nanos)
    }

    fn update_resume_offset(&self, delta: Duration) {
        let delta_nanos = delta.as_nanos().try_into().unwrap();
        self.resume_offset_nanoseconds
            .fetch_add(delta_nanos, Ordering::AcqRel);
    }

    pub fn timestamp_for(&mut self, local: T) -> Option<i64> {
        let now = Instant::now();

        if !self.running() {
            return None;
        }

        if let Ok(global_start_time) = self.global_start_time.read() {
            // TODO: Cache some of this calculation thread-locally?

            if self.local_start_time.is_none()
                || self.local_start_time.unwrap() < *global_start_time
            {
                tracing::info!("Just resumed, resetting local state");
                self.local_start_time = Some(now);
                self.first_local_timestamp = Some(local.clone());
            }

            let local_start_time = self.local_start_time.as_ref().unwrap();
            let first_local_timestamp = self.first_local_timestamp.as_ref().unwrap();

            let total_offset =
                local_start_time.duration_since(*global_start_time) + self.resume_offset();
            let elapsed_time = local.elapsed_since(first_local_timestamp) + total_offset;
            let timestamp = elapsed_time.as_micros().try_into().unwrap();

            Some(timestamp)
        } else {
            // TODO: Try clearing poison? Right now just re-panic if the panic that caused the poison somehow did not stop the app
            panic!("Pipeline clock has been poisoned!")
        }
    }
}

impl PipelineClock for SynchronisedClock<()> {
    fn start(&mut self) {
        if !self.running() {
            let mut start_time = self.global_start_time.write().unwrap();

            let now = Instant::now();
            *start_time = now;
            self.set_running(true);
        }
    }

    fn stop(&mut self) {
        if self.running() {
            self.set_running(false);

            let now = Instant::now();
            let start_time = self.global_start_time.read().unwrap();
            self.update_resume_offset(now - *start_time);
        }
    }
}
