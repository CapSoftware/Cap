use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static NEXT_PHASE_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Phase {
    active: Option<ActivePhase>,
}

struct ActivePhase {
    name: &'static str,
    id: u64,
    started: Instant,
}

impl Phase {
    pub(crate) fn start(name: &'static str) -> Self {
        let active = tracing::enabled!(target: "cap_rendering::readiness", tracing::Level::DEBUG)
            .then(|| {
                let active = ActivePhase {
                    name,
                    id: NEXT_PHASE_ID.fetch_add(1, Ordering::Relaxed),
                    started: Instant::now(),
                };
                active.emit("start");
                active
            });
        Self { active }
    }

    pub(crate) fn mark(&self, event: &'static str) {
        if let Some(active) = &self.active {
            active.emit(event);
        }
    }

    pub(crate) fn finish(mut self, outcome: &'static str) {
        if let Some(active) = self.active.take() {
            active.emit(outcome);
        }
    }
}

impl ActivePhase {
    fn emit(&self, event: &'static str) {
        tracing::debug!(
            target: "cap_rendering::readiness",
            phase = self.name,
            phase_id = self.id,
            event,
            elapsed_ms = self.started.elapsed().as_secs_f64() * 1_000.0,
            "Renderer readiness phase"
        );
    }
}

impl Drop for Phase {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            active.emit("dropped_before_finish");
        }
    }
}

pub(crate) fn measure<T>(name: &'static str, operation: impl FnOnce() -> T) -> T {
    let phase = Phase::start(name);
    let output = operation();
    phase.finish("returned");
    output
}
