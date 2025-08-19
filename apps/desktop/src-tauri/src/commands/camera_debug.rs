//! Tauri commands for camera preview debugging
//!
//! This module provides Tauri commands that can be called from the frontend
//! to diagnose and fix camera preview issues.

use crate::camera::{CameraDiagnostics, CameraPreview};
use serde::{Deserialize, Serialize};
use tauri::{WebviewWindow, command};
use tracing::{error, info};

#[derive(Debug, Serialize, Deserialize)]
pub struct CameraDebugReport {
    pub success: bool,
    pub message: String,
    pub details: Option<String>,
    pub fixes_applied: Vec<String>,
}

/// Test if the camera feed is working
#[command]
pub async fn test_camera_feed(
    camera_preview: tauri::State<'_, CameraPreview>,
) -> Result<CameraDebugReport, String> {
    info!("Testing camera feed via Tauri command");

    match camera_preview.test_camera_feed().await {
        Ok(true) => Ok(CameraDebugReport {
            success: true,
            message: "Camera feed is working properly".to_string(),
            details: Some("Frames are being received from the camera".to_string()),
            fixes_applied: vec![],
        }),
        Ok(false) => Ok(CameraDebugReport {
            success: false,
            message: "Camera feed is not working".to_string(),
            details: Some("No frames received or camera disconnected".to_string()),
            fixes_applied: vec![],
        }),
        Err(e) => {
            error!("Camera feed test error: {}", e);
            Ok(CameraDebugReport {
                success: false,
                message: "Camera feed test failed".to_string(),
                details: Some(format!("Error: {}", e)),
                fixes_applied: vec![],
            })
        }
    }
}

/// Get current camera loading state
#[command]
pub fn get_camera_loading_state(
    camera_preview: tauri::State<'_, CameraPreview>,
) -> Result<CameraDebugReport, String> {
    let is_loading = camera_preview.is_loading();

    Ok(CameraDebugReport {
        success: true,
        message: if is_loading {
            "Camera is currently loading"
        } else {
            "Camera has finished loading"
        }
        .to_string(),
        details: Some(format!("Loading state: {}", is_loading)),
        fixes_applied: vec![],
    })
}

/// Force show the camera window
#[command]
pub fn force_show_camera_window(
    camera_preview: tauri::State<'_, CameraPreview>,
    window: WebviewWindow,
) -> Result<CameraDebugReport, String> {
    info!("Force showing camera window via Tauri command");

    match camera_preview.force_show_window(&window) {
        Ok(_) => Ok(CameraDebugReport {
            success: true,
            message: "Camera window forced to show".to_string(),
            details: Some("Window visibility has been forced on".to_string()),
            fixes_applied: vec!["Force showed camera window".to_string()],
        }),
        Err(e) => {
            error!("Failed to force show camera window: {}", e);
            Ok(CameraDebugReport {
                success: false,
                message: "Failed to force show camera window".to_string(),
                details: Some(format!("Error: {}", e)),
                fixes_applied: vec![],
            })
        }
    }
}

/// Run comprehensive camera diagnostics
#[command]
pub async fn diagnose_camera_preview(
    camera_preview: tauri::State<'_, CameraPreview>,
    window: WebviewWindow,
) -> Result<CameraDebugReport, String> {
    info!("Running comprehensive camera diagnostics via Tauri command");

    match CameraDiagnostics::diagnose_camera_preview(&camera_preview, &window).await {
        Ok(report) => Ok(CameraDebugReport {
            success: true,
            message: "Camera diagnostics completed".to_string(),
            details: Some(report),
            fixes_applied: vec![],
        }),
        Err(e) => {
            error!("Camera diagnostics failed: {}", e);
            Ok(CameraDebugReport {
                success: false,
                message: "Camera diagnostics failed".to_string(),
                details: Some(format!("Error: {}", e)),
                fixes_applied: vec![],
            })
        }
    }
}

/// Apply quick fixes for camera preview issues
#[command]
pub async fn quick_fix_camera_preview(
    camera_preview: tauri::State<'_, CameraPreview>,
    window: WebviewWindow,
) -> Result<CameraDebugReport, String> {
    info!("Applying quick fixes for camera preview via Tauri command");

    match CameraDiagnostics::quick_fix_camera_preview(&camera_preview, &window).await {
        Ok(fixes) => Ok(CameraDebugReport {
            success: true,
            message: if fixes.is_empty() {
                "No fixes needed to be applied"
            } else {
                "Quick fixes applied successfully"
            }
            .to_string(),
            details: Some(format!("Applied {} fixes", fixes.len())),
            fixes_applied: fixes,
        }),
        Err(e) => {
            error!("Quick fix failed: {}", e);
            Ok(CameraDebugReport {
                success: false,
                message: "Quick fix failed".to_string(),
                details: Some(format!("Error: {}", e)),
                fixes_applied: vec![],
            })
        }
    }
}

/// Run full camera preview test suite
#[command]
pub async fn test_camera_preview_full(
    camera_preview: tauri::State<'_, CameraPreview>,
    window: WebviewWindow,
) -> Result<CameraDebugReport, String> {
    info!("Running full camera preview test suite via Tauri command");

    match camera_preview.test_camera_preview(window).await {
        Ok(_) => Ok(CameraDebugReport {
            success: true,
            message: "Camera preview test suite completed successfully".to_string(),
            details: Some("All tests passed - check logs for detailed results".to_string()),
            fixes_applied: vec![],
        }),
        Err(e) => {
            error!("Camera preview test suite failed: {}", e);
            Ok(CameraDebugReport {
                success: false,
                message: "Camera preview test suite failed".to_string(),
                details: Some(format!("Error: {}", e)),
                fixes_applied: vec![],
            })
        }
    }
}

/// Get window status information
#[command]
pub fn get_window_status(window: WebviewWindow) -> Result<CameraDebugReport, String> {
    let mut details = Vec::new();

    // Check visibility
    match window.is_visible() {
        Ok(visible) => details.push(format!("Visible: {}", visible)),
        Err(e) => details.push(format!("Visibility check failed: {}", e)),
    }

    // Check size
    match window.inner_size() {
        Ok(size) => details.push(format!("Size: {}x{}", size.width, size.height)),
        Err(e) => details.push(format!("Size check failed: {}", e)),
    }

    // Check position
    match window.outer_position() {
        Ok(pos) => details.push(format!("Position: {}, {}", pos.x, pos.y)),
        Err(e) => details.push(format!("Position check failed: {}", e)),
    }

    // Check if focused
    match window.is_focused() {
        Ok(focused) => details.push(format!("Focused: {}", focused)),
        Err(e) => details.push(format!("Focus check failed: {}", e)),
    }

    Ok(CameraDebugReport {
        success: true,
        message: "Window status retrieved".to_string(),
        details: Some(details.join("\n")),
        fixes_applied: vec![],
    })
}

/// Debug camera with automatic problem detection and fixing
#[command]
pub async fn debug_camera_auto_fix(
    camera_preview: tauri::State<'_, CameraPreview>,
    window: WebviewWindow,
) -> Result<CameraDebugReport, String> {
    info!("Running automatic camera debug and fix via Tauri command");

    let mut all_fixes = Vec::new();
    let mut success = true;
    let mut messages = Vec::new();

    // Step 1: Test camera feed
    match camera_preview.test_camera_feed().await {
        Ok(true) => {
            messages.push("✓ Camera feed is working".to_string());
        }
        Ok(false) => {
            messages.push("✗ Camera feed is not working".to_string());
            success = false;
        }
        Err(e) => {
            messages.push(format!("✗ Camera feed test failed: {}", e));
            success = false;
        }
    }

    // Step 2: Check window visibility
    match window.is_visible() {
        Ok(true) => {
            messages.push("✓ Window is visible".to_string());
        }
        Ok(false) => {
            messages.push("⚠ Window is not visible - attempting fix".to_string());
            if camera_preview.force_show_window(&window).is_ok() {
                all_fixes.push("Force showed camera window".to_string());
                messages.push("✓ Window forced visible".to_string());
            } else {
                messages.push("✗ Failed to force show window".to_string());
                success = false;
            }
        }
        Err(e) => {
            messages.push(format!("✗ Cannot check window visibility: {}", e));
            success = false;
        }
    }

    // Step 3: Check loading state
    if camera_preview.is_loading() {
        messages.push("⚠ Camera is still in loading state".to_string());
    } else {
        messages.push("✓ Camera has finished loading".to_string());
    }

    // Step 4: Apply additional quick fixes
    match CameraDiagnostics::quick_fix_camera_preview(&camera_preview, &window).await {
        Ok(mut fixes) => {
            all_fixes.append(&mut fixes);
        }
        Err(e) => {
            messages.push(format!("⚠ Quick fix failed: {}", e));
        }
    }

    Ok(CameraDebugReport {
        success,
        message: if success {
            "Camera debug and auto-fix completed successfully"
        } else {
            "Camera debug completed with issues found"
        }
        .to_string(),
        details: Some(messages.join("\n")),
        fixes_applied: all_fixes,
    })
}
