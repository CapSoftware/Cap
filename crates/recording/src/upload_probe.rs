use std::{
    sync::OnceLock,
    time::Duration,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{
    StudioQuality,
    defaults::{FREE_INSTANT_MODE_MAX_RESOLUTION, PRO_INSTANT_MODE_MAX_RESOLUTION},
};

pub const LOW_BANDWIDTH_MAX_RESOLUTION: u32 = 854;
pub const HIGH_SPEED_THRESHOLD_MBPS: f64 = 15.0;
pub const STANDARD_SPEED_THRESHOLD_MBPS: f64 = 5.0;
pub const DEFAULT_PROBE_PAYLOAD_BYTES: usize = 64 * 1024;

static STARTUP_HEALTH: OnceLock<Mutex<Option<StartupHealthCheckStatus>>> = OnceLock::new();

fn startup_health_slot() -> &'static Mutex<Option<StartupHealthCheckStatus>> {
    STARTUP_HEALTH.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdaptiveUploadTier {
    High,
    Standard,
    Low,
    Offline,
}

impl AdaptiveUploadTier {
    pub fn from_mbps(mbps: f64) -> Self {
        if !mbps.is_finite() || mbps <= 0.0 {
            return Self::Offline;
        }
        if mbps >= HIGH_SPEED_THRESHOLD_MBPS {
            return Self::High;
        }
        if mbps >= STANDARD_SPEED_THRESHOLD_MBPS {
            return Self::Standard;
        }
        Self::Low
    }

    pub fn max_instant_resolution(self) -> u32 {
        match self {
            Self::High => PRO_INSTANT_MODE_MAX_RESOLUTION,
            Self::Standard => FREE_INSTANT_MODE_MAX_RESOLUTION,
            Self::Low | Self::Offline => LOW_BANDWIDTH_MAX_RESOLUTION,
        }
    }

    pub fn studio_quality(self) -> StudioQuality {
        match self {
            Self::High => StudioQuality::Ultra,
            Self::Standard => StudioQuality::Balanced,
            Self::Low | Self::Offline => StudioQuality::Compatibility,
        }
    }

    pub fn indicator_label(self, mbps: f64) -> String {
        match self {
            Self::High => format!("{mbps:.1} Mbps • HD Ready"),
            Self::Standard => format!("{mbps:.1} Mbps • 720p Adaptive"),
            Self::Low => format!("{mbps:.1} Mbps • Low Bandwidth (480p)"),
            Self::Offline => "Upload check failed — contact support".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedProbeSample {
    pub bytes_transferred: usize,
    pub elapsed: Duration,
}

impl SpeedProbeSample {
    pub fn throughput_mbps(&self) -> f64 {
        let secs = self.elapsed.as_secs_f64();
        if secs <= 0.0 || self.bytes_transferred == 0 {
            return 0.0;
        }
        let bits = (self.bytes_transferred as f64) * 8.0;
        bits / (secs * 1_000_000.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupHealthCheckStatus {
    pub upload_ok: bool,
    pub speed_mbps: f64,
    pub tier: AdaptiveUploadTier,
    pub indicator_message: String,
    pub contact_support_required: bool,
}

pub fn evaluate_startup_health(
    http_ok: bool,
    sample: Option<SpeedProbeSample>,
) -> StartupHealthCheckStatus {
    if !http_ok {
        return StartupHealthCheckStatus {
            upload_ok: false,
            speed_mbps: 0.0,
            tier: AdaptiveUploadTier::Offline,
            indicator_message:
                "Upload health check failed — please contact support".to_string(),
            contact_support_required: true,
        };
    }

    let mbps = sample.map(|s| s.throughput_mbps()).unwrap_or(0.0);
    let tier = AdaptiveUploadTier::from_mbps(mbps);
    let upload_ok = tier != AdaptiveUploadTier::Offline;

    StartupHealthCheckStatus {
        upload_ok,
        speed_mbps: mbps,
        tier,
        indicator_message: tier.indicator_label(mbps),
        contact_support_required: !upload_ok,
    }
}

pub fn record_startup_health(
    http_ok: bool,
    sample: Option<SpeedProbeSample>,
) -> StartupHealthCheckStatus {
    let status = evaluate_startup_health(http_ok, sample);
    *startup_health_slot().lock() = Some(status.clone());
    status
}

pub fn latest_startup_health() -> Option<StartupHealthCheckStatus> {
    startup_health_slot().lock().clone()
}

pub fn latest_upload_speed_mbps() -> Option<f64> {
    latest_startup_health()
        .filter(|status| status.upload_ok && status.speed_mbps > 0.0)
        .map(|status| status.speed_mbps)
}

pub fn should_run_speed_probe(is_recording_active: bool) -> bool {
    !is_recording_active
}

pub fn build_probe_payload(size_bytes: usize) -> Vec<u8> {
    let target_len = if size_bytes == 0 {
        DEFAULT_PROBE_PAYLOAD_BYTES
    } else {
        size_bytes
    };
    (0..target_len).map(|idx| (idx % 251) as u8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_upload_tiers_and_resolutions() {
        assert_eq!(AdaptiveUploadTier::from_mbps(25.0), AdaptiveUploadTier::High);
        assert_eq!(
            AdaptiveUploadTier::High.max_instant_resolution(),
            PRO_INSTANT_MODE_MAX_RESOLUTION
        );
        assert_eq!(
            AdaptiveUploadTier::from_mbps(8.5),
            AdaptiveUploadTier::Standard
        );
        assert_eq!(
            AdaptiveUploadTier::Standard.max_instant_resolution(),
            FREE_INSTANT_MODE_MAX_RESOLUTION
        );
        assert_eq!(AdaptiveUploadTier::from_mbps(2.1), AdaptiveUploadTier::Low);
        assert_eq!(
            AdaptiveUploadTier::Low.max_instant_resolution(),
            LOW_BANDWIDTH_MAX_RESOLUTION
        );
        assert_eq!(
            AdaptiveUploadTier::from_mbps(0.0),
            AdaptiveUploadTier::Offline
        );
    }

    #[test]
    fn blocks_probe_during_active_recording_and_evaluates_health() {
        assert!(should_run_speed_probe(false));
        assert!(!should_run_speed_probe(true));

        let sample = SpeedProbeSample {
            bytes_transferred: 1_000_000,
            elapsed: Duration::from_millis(500),
        };
        let healthy = record_startup_health(true, Some(sample));
        assert!(healthy.upload_ok);
        assert!(!healthy.contact_support_required);
        assert_eq!(healthy.tier, AdaptiveUploadTier::High);
        assert_eq!(latest_upload_speed_mbps(), Some(16.0));

        let failed = record_startup_health(false, None);
        assert!(!failed.upload_ok);
        assert!(failed.contact_support_required);
        assert_eq!(latest_upload_speed_mbps(), None);
    }
}
