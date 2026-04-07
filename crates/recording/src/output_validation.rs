use std::{path::Path, time::Duration};

use cap_enc_ffmpeg::remux::{get_media_duration, probe_media_valid, probe_video_can_decode};
use tracing::{debug, info, warn};

use crate::RecordingHealth;

const DURATION_MISMATCH_THRESHOLD: f64 = 0.5;
const MIN_EXPECTED_DURATION: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct ValidationResult {
    pub health: RecordingHealth,
    pub output_duration: Option<Duration>,
}

pub fn validate_instant_recording(
    output_path: &Path,
    expected_wall_clock_duration: Duration,
) -> ValidationResult {
    if !output_path.exists() {
        return ValidationResult {
            health: RecordingHealth::Damaged {
                reason: "Output file does not exist".to_string(),
            },
            output_duration: None,
        };
    }

    let file_size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);

    if file_size == 0 {
        return ValidationResult {
            health: RecordingHealth::Damaged {
                reason: "Output file is empty".to_string(),
            },
            output_duration: None,
        };
    }

    if !probe_media_valid(output_path) {
        return ValidationResult {
            health: RecordingHealth::Damaged {
                reason: "Output file has corrupt container".to_string(),
            },
            output_duration: None,
        };
    }

    let decode_ok = probe_video_can_decode(output_path).unwrap_or(false);

    if !decode_ok {
        return ValidationResult {
            health: RecordingHealth::Damaged {
                reason: "Output video stream cannot be decoded".to_string(),
            },
            output_duration: None,
        };
    }

    let output_duration = get_media_duration(output_path);
    let mut issues = Vec::new();

    if let Some(output_dur) = output_duration
        && expected_wall_clock_duration >= MIN_EXPECTED_DURATION
    {
        let expected_secs = expected_wall_clock_duration.as_secs_f64();
        let actual_secs = output_dur.as_secs_f64();
        let ratio = actual_secs / expected_secs;

        debug!(expected_secs, actual_secs, ratio, "Output duration check");

        if ratio < DURATION_MISMATCH_THRESHOLD {
            let issue = format!(
                "Output duration ({:.1}s) is {:.0}% of expected ({:.1}s)",
                actual_secs,
                ratio * 100.0,
                expected_secs,
            );
            warn!("{issue}");
            issues.push(issue);
        } else if ratio < 0.9 {
            let issue = format!(
                "Output duration ({:.1}s) is shorter than expected ({:.1}s)",
                actual_secs, expected_secs,
            );
            info!("{issue}");
            issues.push(issue);
        }
    }

    if output_duration.is_none() {
        issues.push("Could not determine output duration".to_string());
    }

    let health = if issues.is_empty() {
        RecordingHealth::Healthy
    } else {
        RecordingHealth::Degraded { issues }
    };

    ValidationResult {
        health,
        output_duration,
    }
}
