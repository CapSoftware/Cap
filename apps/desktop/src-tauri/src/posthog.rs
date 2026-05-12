use std::{
    sync::{
        OnceLock, PoisonError, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::AppHandle;
use tracing::error;

use crate::auth::AuthStore;

#[derive(Debug)]
pub enum PostHogEvent {
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

fn posthog_event(event: PostHogEvent, distinct_id: Option<&str>) -> posthog_rs::Event {
    fn make_event(name: &str, distinct_id: Option<&str>) -> posthog_rs::Event {
        match distinct_id {
            Some(id) => posthog_rs::Event::new(name, id),
            None => posthog_rs::Event::new_anon(name),
        }
    }

    fn set(e: &mut posthog_rs::Event, key: &str, value: impl serde::Serialize) {
        e.insert_prop(key, value)
            .map_err(|err| error!("Error adding PostHog property {key}: {err:?}"))
            .ok();
    }

    match event {
        PostHogEvent::MultipartUploadComplete {
            duration,
            length,
            size,
        } => {
            let mut e = make_event("multipart_upload_complete", distinct_id);
            set(&mut e, "duration", duration.as_secs());
            set(&mut e, "length", length.as_secs());
            set(&mut e, "size", size);
            e
        }
        PostHogEvent::MultipartUploadFailed { duration, error } => {
            let mut e = make_event("multipart_upload_failed", distinct_id);
            set(&mut e, "duration", duration.as_secs());
            set(&mut e, "error", truncate_reason(error));
            e
        }
        PostHogEvent::RecordingStarted {
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
            let mut e = make_event("recording_started", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "target_kind", target_kind);
            set(&mut e, "has_camera", has_camera);
            set(&mut e, "has_mic", has_mic);
            set(&mut e, "has_system_audio", has_system_audio);
            set(&mut e, "target_fps", target_fps);
            set(&mut e, "target_width", target_width);
            set(&mut e, "target_height", target_height);
            set(&mut e, "fragmented", fragmented);
            set(&mut e, "custom_cursor_capture", custom_cursor_capture);
            e
        }
        PostHogEvent::RecordingCompleted {
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
            let mut e = make_event("recording_completed", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "status", status);
            set(&mut e, "duration_secs", duration_secs);
            set(&mut e, "segment_count", segment_count);
            set(&mut e, "track_failure_count", track_failure_count);
            if let Some(ec) = error_class {
                set(&mut e, "error_class", truncate_reason(ec));
            }
            set(&mut e, "video_frames_captured", video_frames_captured);
            set(&mut e, "video_frames_dropped", video_frames_dropped);
            set(
                &mut e,
                "drop_rate_pct",
                (drop_rate_pct * 100.0).round() / 100.0,
            );
            set(&mut e, "capture_stalls_count", capture_stalls_count);
            set(&mut e, "capture_stalls_max_ms", capture_stalls_max_ms);
            set(&mut e, "mixer_stalls_count", mixer_stalls_count);
            set(&mut e, "mixer_stalls_max_ms", mixer_stalls_max_ms);
            set(&mut e, "audio_gaps_count", audio_gaps_count);
            set(&mut e, "audio_gaps_total_ms", audio_gaps_total_ms);
            set(
                &mut e,
                "frame_drop_rate_high_count",
                frame_drop_rate_high_count,
            );
            set(&mut e, "source_restarts_count", source_restarts_count);
            set(&mut e, "muxer_crash_count", muxer_crash_count);
            set(&mut e, "audio_degraded_count", audio_degraded_count);
            set(&mut e, "dropped_mic_messages", dropped_mic_messages);
            e
        }
        PostHogEvent::RecordingMuxerCrashed {
            mode,
            reason,
            seconds_into_recording,
        } => {
            let mut e = make_event("recording_muxer_crashed", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "reason", truncate_reason(reason));
            set(
                &mut e,
                "seconds_into_recording",
                (seconds_into_recording * 1000.0).round() / 1000.0,
            );
            e
        }
        PostHogEvent::RecordingAudioDegraded {
            mode,
            reason,
            seconds_into_recording,
        } => {
            let mut e = make_event("recording_audio_degraded", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "reason", truncate_reason(reason));
            set(
                &mut e,
                "seconds_into_recording",
                (seconds_into_recording * 1000.0).round() / 1000.0,
            );
            e
        }
        PostHogEvent::RecordingRecovered {
            trigger,
            recovered_duration_secs,
            segments_recovered,
            validation_took_ms,
        } => {
            let mut e = make_event("recording_recovered", distinct_id);
            set(&mut e, "trigger", trigger);
            set(&mut e, "recovered_duration_secs", recovered_duration_secs);
            set(&mut e, "segments_recovered", segments_recovered);
            set(&mut e, "validation_took_ms", validation_took_ms);
            e
        }
        PostHogEvent::RecordingRecoveryFailed { trigger, reason } => {
            let mut e = make_event("recording_recovery_failed", distinct_id);
            set(&mut e, "trigger", trigger);
            set(&mut e, "reason", truncate_reason(reason));
            e
        }
        PostHogEvent::RecordingDiskSpaceLow {
            mode,
            bytes_remaining,
        } => {
            let mut e = make_event("recording_disk_space_low", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "bytes_remaining", bytes_remaining);
            e
        }
        PostHogEvent::RecordingDiskSpaceExhausted {
            mode,
            bytes_remaining,
        } => {
            let mut e = make_event("recording_disk_space_exhausted", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "bytes_remaining", bytes_remaining);
            e
        }
        PostHogEvent::RecordingDeviceLost { mode, subsystem } => {
            let mut e = make_event("recording_device_lost", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "subsystem", subsystem);
            e
        }
        PostHogEvent::RecordingEncoderRebuilt {
            mode,
            backend,
            attempt,
        } => {
            let mut e = make_event("recording_encoder_rebuilt", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "backend", backend);
            set(&mut e, "attempt", attempt);
            e
        }
        PostHogEvent::RecordingSourceAudioReset {
            mode,
            source,
            starvation_ms,
        } => {
            let mut e = make_event("recording_source_audio_reset", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "source", source);
            set(&mut e, "starvation_ms", starvation_ms);
            e
        }
        PostHogEvent::RecordingCaptureTargetLost { mode, target } => {
            let mut e = make_event("recording_capture_target_lost", distinct_id);
            set(&mut e, "mode", mode);
            set(&mut e, "target", target);
            e
        }
    }
}

pub fn init() {
    if let Some(env) = option_env!("VITE_POSTHOG_KEY") {
        tokio::spawn(async move {
            posthog_rs::init_global(env)
                .await
                .map_err(|err| error!("Error initializing PostHog: {err}"))
                .ok();
        });
    }
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

pub fn async_capture_event(app: &AppHandle, event: PostHogEvent) {
    if option_env!("VITE_POSTHOG_KEY").is_none() {
        return;
    }

    let live_enabled = crate::general_settings::GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|s| s.enable_telemetry)
        .unwrap_or_else(telemetry_enabled);
    TELEMETRY_ENABLED.store(live_enabled, Ordering::Release);
    if !live_enabled {
        return;
    }

    let distinct_id = AuthStore::get(app)
        .ok()
        .flatten()
        .and_then(|auth| auth.user_id);
    tokio::spawn(async move {
        let mut e = posthog_event(event, distinct_id.as_deref());

        e.insert_prop("cap_version", env!("CARGO_PKG_VERSION"))
            .map_err(|err| error!("Error adding PostHog property: {err:?}"))
            .ok();
        e.insert_prop(
            "cap_backend",
            match *API_SERVER_IS_CAP_CLOUD
                .get_or_init(Default::default)
                .read()
                .unwrap_or_else(PoisonError::into_inner)
            {
                Some(true) => "cloud",
                Some(false) => "self_hosted",
                None => "unknown",
            },
        )
        .map_err(|err| error!("Error adding PostHog property: {err:?}"))
        .ok();
        e.insert_prop("os", std::env::consts::OS)
            .map_err(|err| error!("Error adding PostHog property: {err:?}"))
            .ok();
        e.insert_prop("arch", std::env::consts::ARCH)
            .map_err(|err| error!("Error adding PostHog property: {err:?}"))
            .ok();

        posthog_rs::capture(e)
            .await
            .map_err(|err| error!("Error sending event to PostHog: {err:?}"))
            .ok();
    });
}
