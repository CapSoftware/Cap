use crate::web_api::ManagerExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::RwLock;
use tokio::time::Instant;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UploadQualityPreset {
    Full,
    High,
    Medium,
    Low,
}

impl UploadQualityPreset {
    pub fn max_resolution(&self) -> u32 {
        match self {
            Self::Full => 3840,
            Self::High => 1920,
            Self::Medium => 1280,
            Self::Low => 854,
        }
    }

    pub fn from_speed_mbps(speed: f64) -> Self {
        if speed >= 20.0 {
            Self::Full
        } else if speed >= 10.0 {
            Self::High
        } else if speed >= 5.0 {
            Self::Medium
        } else {
            Self::Low
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Full => "Full (4K)",
            Self::High => "High (1080p)",
            Self::Medium => "Medium (720p)",
            Self::Low => "Low (480p)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestResult {
    pub upload_speed_mbps: f64,
    pub recommended_quality: UploadQualityPreset,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResult {
    pub server_reachable: bool,
    pub auth_valid: bool,
    pub upload_functional: bool,
    pub message: String,
    pub timestamp_ms: u64,
}

#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestUpdate {
    pub status: SpeedTestStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpeedTestStatus {
    Idle,
    Running,
    Completed(SpeedTestResult),
    Failed(String),
}

#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckUpdate {
    pub result: HealthCheckResult,
}

pub struct NetworkState {
    pub speed_test_status: SpeedTestStatus,
    pub health_check_result: Option<HealthCheckResult>,
    pub is_recording: bool,
}

impl Default for NetworkState {
    fn default() -> Self {
        Self {
            speed_test_status: SpeedTestStatus::Idle,
            health_check_result: None,
            is_recording: false,
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const SPEED_TEST_PAYLOAD_SIZE: usize = 1024 * 1024;

async fn measure_upload_speed(app: &AppHandle) -> Result<f64, String> {
    let payload = vec![0u8; SPEED_TEST_PAYLOAD_SIZE];

    let start = Instant::now();

    let response = app
        .api_request("/api/desktop/health-check", |c, url| {
            c.post(url)
                .header("Content-Type", "application/octet-stream")
                .header("X-Speed-Test", "true")
                .body(payload)
                .timeout(Duration::from_secs(30))
        })
        .await
        .map_err(|e| format!("Speed test request failed: {e}"))?;

    let elapsed = start.elapsed();

    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(format!("Speed test endpoint returned {status}"));
    }

    let bytes_sent = SPEED_TEST_PAYLOAD_SIZE as f64;
    let seconds = elapsed.as_secs_f64();
    let bits_per_second = (bytes_sent * 8.0) / seconds;
    let mbps = bits_per_second / 1_000_000.0;

    Ok(mbps)
}

async fn check_server_health(app: &AppHandle) -> HealthCheckResult {
    let server_reachable = match app
        .api_request("/api/desktop/health-check", |c, url| {
            c.get(url).timeout(Duration::from_secs(10))
        })
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    };

    if !server_reachable {
        return HealthCheckResult {
            server_reachable: false,
            auth_valid: false,
            upload_functional: false,
            message: "Cannot reach Cap server. Check your internet connection.".to_string(),
            timestamp_ms: now_millis(),
        };
    }

    let auth_valid = match app
        .authed_api_request("/api/desktop/health-check", |c, url| {
            c.get(url)
                .header("X-Auth-Check", "true")
                .timeout(Duration::from_secs(10))
        })
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    };

    let upload_functional = if auth_valid {
        let test_payload = vec![0u8; 1024];
        match app
            .authed_api_request("/api/desktop/health-check", |c, url| {
                c.post(url)
                    .header("Content-Type", "application/octet-stream")
                    .header("X-Upload-Test", "true")
                    .body(test_payload)
                    .timeout(Duration::from_secs(15))
            })
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    } else {
        false
    };

    let message = if !auth_valid {
        "Sign in to enable cloud uploads.".to_string()
    } else if !upload_functional {
        "Upload test failed. Please contact support.".to_string()
    } else {
        "All systems operational.".to_string()
    };

    HealthCheckResult {
        server_reachable,
        auth_valid,
        upload_functional,
        message,
        timestamp_ms: now_millis(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn run_speed_test(app: AppHandle) -> Result<SpeedTestResult, String> {
    let network_state = app.state::<Arc<RwLock<NetworkState>>>();

    {
        let state = network_state.read().await;
        if state.is_recording {
            return Err("Cannot run speed test during an active recording".to_string());
        }
        if matches!(state.speed_test_status, SpeedTestStatus::Running) {
            return Err("Speed test is already running".to_string());
        }
    }

    {
        let mut state = network_state.write().await;
        state.speed_test_status = SpeedTestStatus::Running;
    }
    SpeedTestUpdate {
        status: SpeedTestStatus::Running,
    }
    .emit(&app)
    .ok();

    match measure_upload_speed(&app).await {
        Ok(speed_mbps) => {
            let result = SpeedTestResult {
                upload_speed_mbps: (speed_mbps * 100.0).round() / 100.0,
                recommended_quality: UploadQualityPreset::from_speed_mbps(speed_mbps),
                timestamp_ms: now_millis(),
            };

            info!(
                speed_mbps = result.upload_speed_mbps,
                quality = ?result.recommended_quality,
                "Speed test completed"
            );

            {
                let mut state = network_state.write().await;
                state.speed_test_status = SpeedTestStatus::Completed(result.clone());
            }
            SpeedTestUpdate {
                status: SpeedTestStatus::Completed(result.clone()),
            }
            .emit(&app)
            .ok();

            Ok(result)
        }
        Err(err) => {
            warn!(error = %err, "Speed test failed");

            {
                let mut state = network_state.write().await;
                state.speed_test_status = SpeedTestStatus::Failed(err.clone());
            }
            SpeedTestUpdate {
                status: SpeedTestStatus::Failed(err.clone()),
            }
            .emit(&app)
            .ok();

            Err(err)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn run_health_check(app: AppHandle) -> Result<HealthCheckResult, String> {
    let result = check_server_health(&app).await;

    info!(
        server_reachable = result.server_reachable,
        auth_valid = result.auth_valid,
        upload_functional = result.upload_functional,
        message = %result.message,
        "Health check completed"
    );

    let network_state = app.state::<Arc<RwLock<NetworkState>>>();
    {
        let mut state = network_state.write().await;
        state.health_check_result = Some(result.clone());
    }

    HealthCheckUpdate {
        result: result.clone(),
    }
    .emit(&app)
    .ok();

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn get_network_status(
    app: AppHandle,
) -> Result<(SpeedTestStatus, Option<HealthCheckResult>), String> {
    let network_state = app.state::<Arc<RwLock<NetworkState>>>();
    let state = network_state.read().await;
    Ok((
        state.speed_test_status.clone(),
        state.health_check_result.clone(),
    ))
}

pub async fn set_recording_active(app: &AppHandle, active: bool) {
    let network_state = app.state::<Arc<RwLock<NetworkState>>>();
    let mut state = network_state.write().await;
    state.is_recording = active;
}

pub fn spawn_startup_health_check(app: AppHandle) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;

        let result = check_server_health(&app).await;
        info!(
            server_reachable = result.server_reachable,
            auth_valid = result.auth_valid,
            upload_functional = result.upload_functional,
            "Startup health check completed"
        );

        let network_state = app.state::<Arc<RwLock<NetworkState>>>();
        {
            let mut state = network_state.write().await;
            state.health_check_result = Some(result.clone());
        }

        HealthCheckUpdate {
            result: result.clone(),
        }
        .emit(&app)
        .ok();
    });
}
