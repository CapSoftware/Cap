use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    sync::{
        OnceLock, PoisonError, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::AppHandle;
use tracing::debug;

use crate::auth::AuthStore;

/// Baked in at compile time so self-built binaries send nothing.
const CLIENT_ID: Option<&str> = option_env!("VITE_OPENPANEL_CLIENT_ID");
/// `/track` accepts origin-allowlisted requests without a client secret — the
/// same auth path the webview SDK uses — so no credential ships in the binary.
/// Must stay on the OpenPanel client's CORS allowlist alongside the webview
/// origins.
const ORIGIN: &str = "tauri://localhost";
const API_URL: Option<&str> = option_env!("VITE_OPENPANEL_API_URL");
const DEFAULT_API_URL: &str = "https://api.openpanel.dev";

#[derive(Debug)]
pub enum AnalyticsEvent {
    MultipartUploadComplete {
        duration: Duration,
        length: Duration,
        size: u64,
    },
    MultipartUploadFailed {
        duration: Duration,
        error: String,
    },
    RecordingStarted {
        mode: &'static str,
        target_kind: &'static str,
        has_camera: bool,
        has_mic: bool,
        has_system_audio: bool,
        target_fps: u32,
        target_width: u32,
        target_height: u32,
        fragmented: bool,
        custom_cursor_capture: bool,
    },
    RecordingCompleted {
        mode: &'static str,
        status: &'static str,
        duration_secs: u64,
        segment_count: u32,
        track_failure_count: u32,
        error_class: Option<String>,
        video_frames_captured: u64,
        video_frames_dropped: u64,
        drop_rate_pct: f64,
        capture_stalls_count: u64,
        capture_stalls_max_ms: u64,
        mixer_stalls_count: u64,
        mixer_stalls_max_ms: u64,
        audio_gaps_count: u64,
        audio_gaps_total_ms: u64,
        frame_drop_rate_high_count: u64,
        source_restarts_count: u64,
        muxer_crash_count: u64,
        audio_degraded_count: u64,
        dropped_mic_messages: u64,
    },
    RecordingMuxerCrashed {
        mode: &'static str,
        reason: String,
        seconds_into_recording: f64,
    },
    RecordingAudioDegraded {
        mode: &'static str,
        reason: String,
        seconds_into_recording: f64,
    },
    RecordingRecovered {
        trigger: &'static str,
        recovered_duration_secs: u64,
        segments_recovered: u32,
        validation_took_ms: u64,
    },
    RecordingRecoveryFailed {
        trigger: &'static str,
        reason: String,
    },
    RecordingDiskSpaceLow {
        mode: &'static str,
        bytes_remaining: u64,
    },
    RecordingDiskSpaceExhausted {
        mode: &'static str,
        bytes_remaining: u64,
    },
    RecordingDeviceLost {
        mode: &'static str,
        subsystem: String,
    },
    RecordingEncoderRebuilt {
        mode: &'static str,
        backend: String,
        attempt: u32,
    },
    RecordingSourceAudioReset {
        mode: &'static str,
        source: String,
        starvation_ms: u64,
    },
    RecordingCaptureTargetLost {
        mode: &'static str,
        target: String,
    },
}

fn truncate_reason(mut s: String) -> String {
    const MAX_LEN: usize = 240;
    if s.len() > MAX_LEN {
        s.truncate(MAX_LEN);
        s.push('…');
    }
    s
}

fn analytics_event(event: AnalyticsEvent) -> (&'static str, Map<String, Value>) {
    fn set(props: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
        props.insert(key.to_string(), value.into());
    }

    let mut props = Map::new();

    match event {
        AnalyticsEvent::MultipartUploadComplete {
            duration,
            length,
            size,
        } => {
            set(&mut props, "duration", duration.as_secs());
            set(&mut props, "length", length.as_secs());
            set(&mut props, "size", size);
            ("multipart_upload_complete", props)
        }
        AnalyticsEvent::MultipartUploadFailed { duration, error } => {
            set(&mut props, "duration", duration.as_secs());
            set(&mut props, "error", truncate_reason(error));
            ("multipart_upload_failed", props)
        }
        AnalyticsEvent::RecordingStarted {
            mode,
            target_kind,
            has_camera,
            has_mic,
            has_system_audio,
            target_fps,
            target_width,
            target_height,
            fragmented,
            custom_cursor_capture,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "target_kind", target_kind);
            set(&mut props, "has_camera", has_camera);
            set(&mut props, "has_mic", has_mic);
            set(&mut props, "has_system_audio", has_system_audio);
            set(&mut props, "target_fps", target_fps);
            set(&mut props, "target_width", target_width);
            set(&mut props, "target_height", target_height);
            set(&mut props, "fragmented", fragmented);
            set(&mut props, "custom_cursor_capture", custom_cursor_capture);
            ("recording_started", props)
        }
        AnalyticsEvent::RecordingCompleted {
            mode,
            status,
            duration_secs,
            segment_count,
            track_failure_count,
            error_class,
            video_frames_captured,
            video_frames_dropped,
            drop_rate_pct,
            capture_stalls_count,
            capture_stalls_max_ms,
            mixer_stalls_count,
            mixer_stalls_max_ms,
            audio_gaps_count,
            audio_gaps_total_ms,
            frame_drop_rate_high_count,
            source_restarts_count,
            muxer_crash_count,
            audio_degraded_count,
            dropped_mic_messages,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "status", status);
            set(&mut props, "duration_secs", duration_secs);
            set(&mut props, "segment_count", segment_count);
            set(&mut props, "track_failure_count", track_failure_count);
            if let Some(ec) = error_class {
                set(&mut props, "error_class", truncate_reason(ec));
            }
            set(&mut props, "video_frames_captured", video_frames_captured);
            set(&mut props, "video_frames_dropped", video_frames_dropped);
            set(
                &mut props,
                "drop_rate_pct",
                (drop_rate_pct * 100.0).round() / 100.0,
            );
            set(&mut props, "capture_stalls_count", capture_stalls_count);
            set(&mut props, "capture_stalls_max_ms", capture_stalls_max_ms);
            set(&mut props, "mixer_stalls_count", mixer_stalls_count);
            set(&mut props, "mixer_stalls_max_ms", mixer_stalls_max_ms);
            set(&mut props, "audio_gaps_count", audio_gaps_count);
            set(&mut props, "audio_gaps_total_ms", audio_gaps_total_ms);
            set(
                &mut props,
                "frame_drop_rate_high_count",
                frame_drop_rate_high_count,
            );
            set(&mut props, "source_restarts_count", source_restarts_count);
            set(&mut props, "muxer_crash_count", muxer_crash_count);
            set(&mut props, "audio_degraded_count", audio_degraded_count);
            set(&mut props, "dropped_mic_messages", dropped_mic_messages);
            ("recording_completed", props)
        }
        AnalyticsEvent::RecordingMuxerCrashed {
            mode,
            reason,
            seconds_into_recording,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "reason", truncate_reason(reason));
            set(
                &mut props,
                "seconds_into_recording",
                (seconds_into_recording * 1000.0).round() / 1000.0,
            );
            ("recording_muxer_crashed", props)
        }
        AnalyticsEvent::RecordingAudioDegraded {
            mode,
            reason,
            seconds_into_recording,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "reason", truncate_reason(reason));
            set(
                &mut props,
                "seconds_into_recording",
                (seconds_into_recording * 1000.0).round() / 1000.0,
            );
            ("recording_audio_degraded", props)
        }
        AnalyticsEvent::RecordingRecovered {
            trigger,
            recovered_duration_secs,
            segments_recovered,
            validation_took_ms,
        } => {
            set(&mut props, "trigger", trigger);
            set(
                &mut props,
                "recovered_duration_secs",
                recovered_duration_secs,
            );
            set(&mut props, "segments_recovered", segments_recovered);
            set(&mut props, "validation_took_ms", validation_took_ms);
            ("recording_recovered", props)
        }
        AnalyticsEvent::RecordingRecoveryFailed { trigger, reason } => {
            set(&mut props, "trigger", trigger);
            set(&mut props, "reason", truncate_reason(reason));
            ("recording_recovery_failed", props)
        }
        AnalyticsEvent::RecordingDiskSpaceLow {
            mode,
            bytes_remaining,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "bytes_remaining", bytes_remaining);
            ("recording_disk_space_low", props)
        }
        AnalyticsEvent::RecordingDiskSpaceExhausted {
            mode,
            bytes_remaining,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "bytes_remaining", bytes_remaining);
            ("recording_disk_space_exhausted", props)
        }
        AnalyticsEvent::RecordingDeviceLost { mode, subsystem } => {
            set(&mut props, "mode", mode);
            set(&mut props, "subsystem", subsystem);
            ("recording_device_lost", props)
        }
        AnalyticsEvent::RecordingEncoderRebuilt {
            mode,
            backend,
            attempt,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "backend", backend);
            set(&mut props, "attempt", attempt);
            ("recording_encoder_rebuilt", props)
        }
        AnalyticsEvent::RecordingSourceAudioReset {
            mode,
            source,
            starvation_ms,
        } => {
            set(&mut props, "mode", mode);
            set(&mut props, "source", source);
            set(&mut props, "starvation_ms", starvation_ms);
            ("recording_source_audio_reset", props)
        }
        AnalyticsEvent::RecordingCaptureTargetLost { mode, target } => {
            set(&mut props, "mode", mode);
            set(&mut props, "target", target);
            ("recording_capture_target_lost", props)
        }
    }
}

#[derive(Serialize)]
struct TrackPayload {
    name: &'static str,
    properties: Map<String, Value>,
    /// Omitted entirely when signed out, so OpenPanel records an anonymous
    /// device event instead of attributing it to a profile.
    #[serde(rename = "profileId", skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
}

#[derive(Serialize)]
struct TrackBody {
    #[serde(rename = "type")]
    kind: &'static str,
    payload: TrackPayload,
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        // OpenPanel derives device/OS breakdowns from the user agent.
        let user_agent = format!(
            "Cap/{} ({}; {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        reqwest::Client::builder()
            .user_agent(user_agent)
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

fn track_url() -> String {
    let base = API_URL.unwrap_or(DEFAULT_API_URL).trim_end_matches('/');
    format!("{base}/track")
}

pub fn init() {
    if CLIENT_ID.is_none() {
        return;
    }

    // Building the client loads the platform root certificates, so do it off
    // the startup path rather than on the first event.
    tokio::spawn(async {
        http_client();
    });
}

pub fn set_server_url(url: &str) {
    *API_SERVER_IS_CAP_CLOUD
        .get_or_init(Default::default)
        .write()
        .unwrap_or_else(PoisonError::into_inner) = Some(url == "https://cap.so");
}

static API_SERVER_IS_CAP_CLOUD: OnceLock<RwLock<Option<bool>>> = OnceLock::new();

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_telemetry_enabled(enabled: bool) {
    TELEMETRY_ENABLED.store(enabled, Ordering::Release);
}

pub fn telemetry_enabled() -> bool {
    TELEMETRY_ENABLED.load(Ordering::Acquire)
}

pub fn async_capture_event(app: &AppHandle, event: AnalyticsEvent) {
    let Some(client_id) = CLIENT_ID else {
        return;
    };

    let live_enabled = crate::general_settings::GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|s| s.enable_telemetry)
        .unwrap_or_else(telemetry_enabled);
    TELEMETRY_ENABLED.store(live_enabled, Ordering::Release);
    if !live_enabled {
        return;
    }

    let profile_id = AuthStore::get(app)
        .ok()
        .flatten()
        .and_then(|auth| auth.user_id);

    tokio::spawn(async move {
        let (name, mut properties) = analytics_event(event);

        properties.insert("cap_version".into(), env!("CARGO_PKG_VERSION").into());
        properties.insert(
            "cap_backend".into(),
            match *API_SERVER_IS_CAP_CLOUD
                .get_or_init(Default::default)
                .read()
                .unwrap_or_else(PoisonError::into_inner)
            {
                Some(true) => "cloud",
                Some(false) => "self_hosted",
                None => "unknown",
            }
            .into(),
        );
        properties.insert("os".into(), std::env::consts::OS.into());
        properties.insert("arch".into(), std::env::consts::ARCH.into());

        let body = TrackBody {
            kind: "track",
            payload: TrackPayload {
                name,
                properties,
                profile_id,
            },
        };

        let req = http_client()
            .post(track_url())
            .header("openpanel-client-id", client_id)
            .header("origin", ORIGIN);

        // Events are best-effort: log and drop, never retry.
        match req.json(&body).send().await {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => debug!(
                "OpenPanel rejected event {name}: HTTP {}",
                res.status().as_u16()
            ),
            Err(err) => debug!("Error sending event {name} to OpenPanel: {err:?}"),
        }
    });
}
