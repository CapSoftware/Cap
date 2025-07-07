use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

use cap_media::diagnostics::SystemDiagnostics;
use cap_media::error_context::ErrorContext;

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct DiagnosticsReport {
    pub system: SystemDiagnostics,
    pub app_version: String,
    #[serde(with = "chrono::serde::ts_seconds")]
    #[specta(type = i64)]
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub user_description: Option<String>,
    pub error_logs: Vec<ErrorContext>,
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct DiagnosticsSubmissionResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    #[serde(rename = "localPath")]
    pub local_path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn collect_diagnostics() -> Result<SystemDiagnostics, String> {
    SystemDiagnostics::collect()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn submit_device_profile(
    app: tauri::AppHandle,
    diagnostics: SystemDiagnostics,
    description: Option<String>,
    include_errors: bool,
) -> Result<DiagnosticsSubmissionResponse, String> {
    use crate::web_api::ManagerExt;
    use serde_json::json;

    // Create a comprehensive report
    let report = DiagnosticsReport {
        system: diagnostics.clone(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: chrono::Utc::now(),
        user_description: description.clone(),
        error_logs: if include_errors {
            // Load recent error logs
            load_recent_errors().await.unwrap_or_default()
        } else {
            vec![]
        },
    };

    // Save locally for debugging
    let report_path = save_diagnostics_report(&report).await?;

    // Send to API endpoint
    let response = app
        .authed_api_request("/api/desktop/diagnostics", |client, url| {
            client.post(url).json(&json!({
                "diagnostics": diagnostics,
                "description": description,
                "includeErrors": include_errors
            }))
        })
        .await
        .map_err(|e| format!("Failed to send diagnostics: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to submit diagnostics: HTTP {}",
            response.status()
        ));
    }

    #[derive(Deserialize)]
    struct ApiResponse {
        success: bool,
        message: String,
        #[serde(rename = "profileId")]
        profile_id: Option<String>,
    }

    let api_response = response
        .json::<ApiResponse>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(DiagnosticsSubmissionResponse {
        success: api_response.success,
        message: api_response.message,
        profile_id: api_response.profile_id,
        local_path: Some(report_path.display().to_string()),
    })
}

async fn load_recent_errors() -> Result<Vec<ErrorContext>, std::io::Error> {
    let error_dir = std::path::Path::new("error_reports");
    if !error_dir.exists() {
        return Ok(vec![]);
    }

    let mut errors = vec![];
    let mut entries = tokio::fs::read_dir(error_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        if entry
            .path()
            .extension()
            .map(|e| e == "json")
            .unwrap_or(false)
        {
            if let Ok(content) = tokio::fs::read_to_string(entry.path()).await {
                if let Ok(error) = serde_json::from_str::<ErrorContext>(&content) {
                    errors.push(error);
                }
            }
        }
    }

    // Sort by timestamp, most recent first
    errors.sort_by(|a, b| match (&b.timestamp, &a.timestamp) {
        (Some(b_ts), Some(a_ts)) => b_ts.cmp(a_ts),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    // Return only the 10 most recent errors
    errors.truncate(10);

    Ok(errors)
}

async fn save_diagnostics_report(report: &DiagnosticsReport) -> Result<PathBuf, String> {
    let report_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cap")
        .join("diagnostics");

    std::fs::create_dir_all(&report_dir).map_err(|e| e.to_string())?;

    let timestamp = report.timestamp.format("%Y%m%d_%H%M%S");
    let report_path = report_dir.join(format!("diagnostics_{}.json", timestamp));

    let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;

    std::fs::write(&report_path, json).map_err(|e| e.to_string())?;

    Ok(report_path)
}

#[cfg(feature = "telemetry")]
async fn submit_to_telemetry(report: &DiagnosticsReport) -> Result<(), String> {
    // Implementation would send anonymized diagnostics to your telemetry endpoint
    // This helps you understand what hardware configurations are being used

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.cap.so/telemetry/diagnostics")
        .json(report)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to submit diagnostics: {}",
            response.status()
        ));
    }

    Ok(())
}
