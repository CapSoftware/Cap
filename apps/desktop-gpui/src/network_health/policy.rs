use std::time::{Duration, SystemTime};

pub const MEASUREMENT_TTL: Duration = Duration::from_secs(15 * 60);
pub const AUTOMATIC_PROBE_INTERVAL: Duration = Duration::from_secs(10 * 60);
const MIN_PROBE_BYTES: usize = 1024 * 1024;
const MAX_PROBE_BYTES: usize = 8 * 1024 * 1024;
const MIN_BODY_READ_MS: f64 = 500.0;
const MAX_RATE_RATIO: f64 = 2.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub server: String,
    pub owner: String,
    pub organization: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub bytes: usize,
    pub body_read_ms: f64,
}

impl Sample {
    pub fn mbps(self) -> Option<f64> {
        if !(MIN_PROBE_BYTES..=MAX_PROBE_BYTES).contains(&self.bytes)
            || !self.body_read_ms.is_finite()
            || self.body_read_ms <= 0.0
        {
            return None;
        }
        Some((self.bytes as f64 * 8.0) / (self.body_read_ms * 1_000.0))
    }

    fn caps_allowed(self) -> bool {
        self.mbps().is_some() && self.body_read_ms >= MIN_BODY_READ_MS
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Measurement {
    pub scope: Scope,
    pub organization: String,
    pub checked_at: SystemTime,
    pub mbps: Option<f64>,
    pub max_width: Option<u32>,
}

impl Measurement {
    pub fn from_samples(
        scope: Scope,
        organization: String,
        samples: [Sample; 2],
        now: SystemTime,
    ) -> Self {
        let rates = samples[0].mbps().zip(samples[1].mbps());
        let mbps = rates.map(|(a, b)| a.max(b));
        let max_width = rates.and_then(|(first, second)| {
            if !samples[0].caps_allowed() || !samples[1].caps_allowed() {
                return None;
            }
            let faster = first.max(second);
            let slower = first.min(second);
            if faster > slower * MAX_RATE_RATIO {
                return None;
            }
            if faster < 5.0 {
                Some(1280)
            } else if faster < 10.0 {
                Some(1920)
            } else if faster < 20.0 {
                Some(2560)
            } else {
                None
            }
        });
        Self {
            scope,
            organization,
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

    pub fn max_width_for(
        &self,
        scope: &Scope,
        organization: Option<&str>,
        now: SystemTime,
    ) -> Option<u32> {
        self.fresh_for(scope, now)
            .then_some(())
            .filter(|()| organization == Some(self.organization.as_str()))
            .and(self.max_width)
    }
}

#[derive(Debug, Default)]
pub struct Admission {
    recording: bool,
    transfers: usize,
    generation: u64,
}

impl Admission {
    pub fn begin_probe(&mut self) -> Option<u64> {
        if self.recording || self.transfers > 0 {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        Some(self.generation)
    }

    pub fn admit_recording(&mut self) {
        self.recording = true;
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn release_recording(&mut self) {
        self.recording = false;
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn admit_transfer(&mut self) {
        self.transfers = self.transfers.saturating_add(1);
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn release_transfer(&mut self) {
        self.transfers = self.transfers.saturating_sub(1);
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    pub fn accepts(&self, generation: u64) -> bool {
        !self.recording && self.transfers == 0 && self.generation == generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope {
            server: "https://cap.so".into(),
            owner: "user-1".into(),
            organization: Some("org-1".into()),
        }
    }

    fn sample(mbps: f64, ms: f64) -> Sample {
        Sample {
            bytes: ((mbps * ms * 1_000.0) / 8.0) as usize,
            body_read_ms: ms,
        }
    }

    #[test]
    fn only_repeatably_slow_samples_lower_resolution() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let very_slow = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(3.5, 4_500.0), sample(4.2, 3_800.0)],
            now,
        );
        assert_eq!(very_slow.max_width, Some(1280));

        let slow = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(7.5, 2_200.0), sample(8.5, 1_900.0)],
            now,
        );
        assert_eq!(slow.max_width, Some(1920));

        let medium = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(12.0, 1_400.0), sample(15.0, 1_100.0)],
            now,
        );
        assert_eq!(medium.max_width, Some(2560));

        let fast = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(25.0, 650.0), sample(30.0, 550.0)],
            now,
        );
        assert_eq!(fast.max_width, None);
    }

    #[test]
    fn buffered_inconsistent_or_invalid_samples_do_not_lower_resolution() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let buffered = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [
                Sample {
                    bytes: 2 * 1024 * 1024,
                    body_read_ms: 400.0,
                },
                Sample {
                    bytes: 2 * 1024 * 1024,
                    body_read_ms: 450.0,
                },
            ],
            now,
        );
        assert_eq!(buffered.max_width, None);

        let inconsistent = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(4.0, 4_000.0), sample(12.0, 1_400.0)],
            now,
        );
        assert_eq!(inconsistent.max_width, None);

        let invalid = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [
                Sample {
                    bytes: 512,
                    body_read_ms: 4_000.0,
                },
                sample(4.0, 4_000.0),
            ],
            now,
        );
        assert_eq!(invalid.mbps, None);
        assert_eq!(invalid.max_width, None);
    }

    #[test]
    fn stale_or_other_account_measurements_do_not_apply() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let measurement = Measurement::from_samples(
            scope(),
            "org-1".into(),
            [sample(3.5, 4_500.0), sample(4.2, 3_800.0)],
            now,
        );

        assert!(measurement.fresh_for(&scope(), now + Duration::from_secs(60)));
        assert_eq!(
            measurement.max_width_for(&scope(), Some("org-1"), now + Duration::from_secs(60)),
            Some(1280)
        );
        assert_eq!(
            measurement.max_width_for(&scope(), Some("org-2"), now + Duration::from_secs(60)),
            None
        );
        assert_eq!(
            measurement.max_width_for(&scope(), None, now + Duration::from_secs(60)),
            None
        );
        assert!(!measurement.fresh_for(&scope(), now + MEASUREMENT_TTL));
        assert!(!measurement.fresh_for(&scope(), now - Duration::from_secs(1)));

        let other_org = Scope {
            organization: Some("org-2".into()),
            ..scope()
        };
        assert!(!measurement.fresh_for(&other_org, now));
    }

    #[test]
    fn recording_admission_rejects_in_flight_probe() {
        let mut admission = Admission::default();
        let ticket = admission.begin_probe().expect("idle probe");
        assert!(admission.accepts(ticket));

        admission.admit_recording();
        assert!(!admission.accepts(ticket));
        assert!(admission.begin_probe().is_none());

        admission.release_recording();
        assert!(!admission.accepts(ticket));
        let next = admission.begin_probe().expect("idle after release");
        assert!(admission.accepts(next));
    }

    #[test]
    fn background_transfer_rejects_in_flight_probe_until_all_transfers_finish() {
        let mut admission = Admission::default();
        let ticket = admission.begin_probe().expect("idle probe");

        admission.admit_transfer();
        admission.admit_transfer();
        assert!(!admission.accepts(ticket));
        assert!(admission.begin_probe().is_none());

        admission.release_transfer();
        assert!(admission.begin_probe().is_none());

        admission.release_transfer();
        let next = admission.begin_probe().expect("idle after transfers");
        assert!(admission.accepts(next));
    }
}
