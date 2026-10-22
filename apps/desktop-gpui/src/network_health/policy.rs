use std::time::{Duration, SystemTime};

pub const MEASUREMENT_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub server: String,
    pub owner: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub bytes: usize,
    pub body_read_ms: f64,
}

impl Sample {
    fn mbps(self) -> Option<f64> {
        (self.bytes >= 1024 * 1024
            && self.bytes <= 8 * 1024 * 1024
            && self.body_read_ms.is_finite()
            && self.body_read_ms > 0.)
            .then(|| self.bytes as f64 * 8. / (self.body_read_ms * 1000.))
    }
}

#[derive(Clone, Debug)]
pub struct Measurement {
    pub scope: Scope,
    pub checked_at: SystemTime,
    pub mbps: Option<f64>,
    pub max_width: Option<u32>,
}

impl Measurement {
    pub fn from_samples(scope: Scope, samples: [Sample; 2], now: SystemTime) -> Self {
        let rates = samples[0].mbps().zip(samples[1].mbps());
        let mbps = rates.map(|(first, second)| first.max(second));
        let max_width = rates.and_then(|(first, second)| {
            if samples.iter().any(|sample| sample.body_read_ms < 500.)
                || first.max(second) > first.min(second) * 2.
            {
                return None;
            }
            match first.max(second) {
                rate if rate < 5. => Some(1280),
                rate if rate < 10. => Some(1920),
                rate if rate < 20. => Some(2560),
                _ => None,
            }
        });
        Self {
            scope,
            checked_at: now,
            mbps,
            max_width,
        }
    }

    pub fn fresh_for(&self, scope: &Scope, now: SystemTime) -> bool {
        self.scope == *scope
            && now
                .duration_since(self.checked_at)
                .is_ok_and(|age| age < MEASUREMENT_TTL)
    }
}

#[derive(Default)]
pub struct Admission {
    recording: bool,
    generation: u64,
}

impl Admission {
    pub fn begin_probe(&mut self) -> Option<u64> {
        if self.recording {
            return None;
        }
        self.invalidate();
        Some(self.generation)
    }

    pub fn accepts(&self, generation: u64) -> bool {
        !self.recording && self.generation == generation
    }

    pub fn admit_recording(&mut self) {
        self.recording = true;
        self.invalidate();
    }

    pub fn release_recording(&mut self) {
        self.recording = false;
    }

    pub fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope {
            server: "https://cap.example".into(),
            owner: "owner".into(),
        }
    }

    fn measure(first_mbps: f64, second_mbps: f64) -> Measurement {
        let sample = |mbps| Sample {
            bytes: 2 * 1024 * 1024,
            body_read_ms: 2. * 1024. * 1024. * 8. / (mbps * 1000.),
        };
        Measurement::from_samples(
            scope(),
            [sample(first_mbps), sample(second_mbps)],
            SystemTime::now(),
        )
    }

    #[test]
    fn only_repeatably_slow_samples_lower_resolution() {
        assert_eq!(measure(3., 4.).max_width, Some(1280));
        assert_eq!(measure(6., 7.).max_width, Some(1920));
        assert_eq!(measure(12., 16.).max_width, Some(2560));
        assert_eq!(measure(20., 20.).max_width, None);
    }

    #[test]
    fn a_fast_or_inconsistent_sample_preserves_quality() {
        assert_eq!(measure(3., 100.).max_width, None);
        assert_eq!(measure(3., 9.).max_width, None);
        assert_eq!(measure(100., 100.).max_width, None);
    }

    #[test]
    fn invalid_or_buffered_samples_never_apply_a_cap() {
        for duration in [0., -1., f64::NAN, f64::INFINITY] {
            let sample = Sample {
                bytes: 2 * 1024 * 1024,
                body_read_ms: duration,
            };
            let result = Measurement::from_samples(scope(), [sample; 2], SystemTime::now());
            assert_eq!(result.max_width, None);
            assert_eq!(result.mbps, None);
        }
        let sample = Sample {
            bytes: 100,
            body_read_ms: 1000.,
        };
        assert_eq!(
            Measurement::from_samples(scope(), [sample; 2], SystemTime::now()).max_width,
            None
        );
    }

    #[test]
    fn threshold_boundaries_use_the_less_restrictive_tier() {
        assert_eq!(measure(5., 5.).max_width, Some(1920));
        assert_eq!(measure(10., 10.).max_width, Some(2560));
        assert_eq!(measure(20., 20.).max_width, None);
    }

    #[test]
    fn stale_account_and_server_measurements_are_ignored() {
        let result = measure(3., 3.);
        assert!(result.fresh_for(&scope(), result.checked_at));
        assert!(!result.fresh_for(&scope(), result.checked_at + MEASUREMENT_TTL));
        let mut other = scope();
        other.owner = "other".into();
        assert!(!result.fresh_for(&other, result.checked_at));
        other = scope();
        other.server = "https://other.example".into();
        assert!(!result.fresh_for(&other, result.checked_at));
    }

    #[test]
    fn recording_admission_rejects_in_flight_and_new_probe_results() {
        let mut admission = Admission::default();
        let ticket = admission.begin_probe().unwrap();
        assert!(admission.accepts(ticket));
        admission.admit_recording();
        assert!(!admission.accepts(ticket));
        assert_eq!(admission.begin_probe(), None);
        admission.release_recording();
        assert!(!admission.accepts(ticket));
        let next = admission.begin_probe().unwrap();
        assert!(admission.accepts(next));
        assert!(!admission.accepts(ticket));
    }

    #[test]
    fn invalidation_rejects_late_results_without_entering_recording() {
        let mut admission = Admission::default();
        let ticket = admission.begin_probe().unwrap();
        admission.invalidate();
        assert!(!admission.accepts(ticket));
        assert!(admission.begin_probe().is_some());
    }

    #[test]
    fn moving_the_wall_clock_backwards_preserves_the_users_resolution() {
        let result = measure(3., 3.);
        let earlier = result
            .checked_at
            .checked_sub(Duration::from_secs(1))
            .unwrap();
        assert!(!result.fresh_for(&scope(), earlier));
    }
}
