use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::time::Duration;

use crate::{OutputFormat, write_json};

/// Version of the machine-readable JSON contracts the CLI emits. Bump on breaking changes so an
/// agent can detect drift via `cap version`/`cap doctor`.
pub const SCHEMA_VERSION: u32 = 2;

#[cfg(windows)]
const BINARY_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const BINARY_SUFFIX: &str = "";

const BUNDLED_BINARIES: [&str; 3] = ["cap-cli", "cap-exporter", "cap-muxer"];

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Distribution {
    Bundled,
    Development,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub family: &'static str,
}

impl PlatformInfo {
    fn current() -> Self {
        Self {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            family: std::env::consts::FAMILY,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryRef {
    pub name: String,
    pub path: String,
    pub present: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub schema_version: u32,
    pub name: &'static str,
    pub version: &'static str,
    pub platform: PlatformInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    pub distribution: Distribution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle: Option<BundleInfo>,
    pub bundled_binaries: Vec<BinaryRef>,
}

impl VersionInfo {
    pub fn collect() -> Self {
        // The CLI is normally invoked through the installed shim (a symlink), and on macOS
        // `current_exe()` returns that symlink path verbatim — so resolve it to the real binary before
        // deriving distribution/bundle/sidecar paths, which all live next to the real executable.
        let exe = std::env::current_exe()
            .ok()
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe));
        let distribution = exe
            .as_deref()
            .map(distribution)
            .unwrap_or(Distribution::Unknown);

        Self {
            schema_version: SCHEMA_VERSION,
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            platform: PlatformInfo::current(),
            executable_path: exe.as_deref().map(display_path),
            distribution,
            bundle: exe.as_deref().and_then(bundle_info),
            bundled_binaries: exe.as_deref().map(sibling_binaries).unwrap_or_default(),
        }
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn sibling_path(exe: &Path, name: &str) -> Option<PathBuf> {
    exe.parent()
        .map(|dir| dir.join(format!("{name}{BINARY_SUFFIX}")))
}

fn sibling_binaries(exe: &Path) -> Vec<BinaryRef> {
    BUNDLED_BINARIES
        .into_iter()
        .filter_map(|name| {
            let path = sibling_path(exe, name)?;
            Some(BinaryRef {
                name: name.to_string(),
                present: path.exists(),
                path: display_path(&path),
            })
        })
        .collect()
}

fn in_app_bundle(exe: &Path) -> bool {
    let Some(macos_dir) = exe.parent() else {
        return false;
    };
    macos_dir.file_name().is_some_and(|n| n == "MacOS")
        && macos_dir
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n == "Contents")
}

fn in_target_dir(exe: &Path) -> bool {
    let components: Vec<_> = exe
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let has_target = components.contains(&"target");
    let has_profile = components.iter().any(|c| *c == "debug" || *c == "release");
    has_target && has_profile
}

fn distribution(exe: &Path) -> Distribution {
    // A real bundle never runs from a `target/{debug,release}` directory, so the
    // cargo-output location is the most reliable dev signal even when the bundled
    // sidecars happen to have been copied alongside the dev binary.
    if in_app_bundle(exe) {
        return Distribution::Bundled;
    }
    if in_target_dir(exe) {
        return Distribution::Development;
    }

    let bundled = sibling_path(exe, "cap-exporter").is_some_and(|p| p.exists())
        || sibling_path(exe, "cap-muxer").is_some_and(|p| p.exists());

    if bundled {
        Distribution::Bundled
    } else {
        Distribution::Unknown
    }
}

fn bundle_info(exe: &Path) -> Option<BundleInfo> {
    if !in_app_bundle(exe) {
        return None;
    }

    // exe = <App>.app/Contents/MacOS/<bin>
    let app_root = exe.parent()?.parent()?.parent()?;
    if !app_root
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
    {
        return None;
    }

    let info_plist = app_root.join("Contents/Info.plist");
    let version = std::fs::read_to_string(&info_plist)
        .ok()
        .and_then(|plist| plist_string_value(&plist, "CFBundleShortVersionString"));

    Some(BundleInfo {
        path: display_path(app_root),
        version,
    })
}

fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{key}</key>");
    let after_key = &plist[plist.find(&key_tag)? + key_tag.len()..];
    let open = "<string>";
    let start = after_key.find(open)? + open.len();
    let end = after_key[start..].find("</string>")?;
    Some(after_key[start..start + end].trim().to_string())
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
    Unknown,
}

/// Closed vocabulary of diagnostic check ids. Pinned by a test so agents can branch on a stable set;
/// adding/renaming a variant is a schema change (bump `SCHEMA_VERSION`).
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckId {
    Ffmpeg,
    ScreenRecordingPermission,
    #[cfg(target_os = "macos")]
    ScreenCaptureKit,
    CliInstall,
}

impl CheckId {
    fn label(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::ScreenRecordingPermission => "screenRecordingPermission",
            #[cfg(target_os = "macos")]
            Self::ScreenCaptureKit => "screenCaptureKit",
            Self::CliInstall => "cliInstall",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: CheckId,
    pub status: CheckStatus,
    pub message: String,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    #[cfg(target_os = "macos")]
    Granted,
    #[cfg(target_os = "macos")]
    Denied,
    #[cfg(target_os = "macos")]
    NotDetermined,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub screen_recording: PermissionStatus,
    pub camera: PermissionStatus,
    pub microphone: PermissionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(target_os = "macos")]
fn permissions() -> Permissions {
    use cidre::av;

    macro_rules! media_status {
        ($media:expr) => {
            match av::CaptureDevice::authorization_status_for_media_type($media) {
                Ok(av::AuthorizationStatus::NotDetermined) => PermissionStatus::NotDetermined,
                Ok(av::AuthorizationStatus::Authorized) => PermissionStatus::Granted,
                Ok(_) => PermissionStatus::Denied,
                Err(_) => PermissionStatus::Unknown,
            }
        };
    }

    let screen_recording = if scap_screencapturekit::has_permission() {
        PermissionStatus::Granted
    } else {
        PermissionStatus::Denied
    };

    Permissions {
        screen_recording,
        camera: media_status!(av::MediaType::video()),
        microphone: media_status!(av::MediaType::audio()),
        reason: None,
    }
}

#[cfg(not(target_os = "macos"))]
fn permissions() -> Permissions {
    Permissions {
        screen_recording: PermissionStatus::Unknown,
        camera: PermissionStatus::Unknown,
        microphone: PermissionStatus::Unknown,
        reason: Some(
            "Capture permission status is only queryable on macOS; this platform does not gate \
             screen capture behind a runtime check"
                .to_string(),
        ),
    }
}

fn ffmpeg_check() -> Check {
    match ffmpeg::init() {
        Ok(()) => Check {
            id: CheckId::Ffmpeg,
            status: CheckStatus::Ok,
            message: format!("libavformat {} initialised", avformat_version()),
        },
        Err(e) => Check {
            id: CheckId::Ffmpeg,
            status: CheckStatus::Fail,
            message: format!("FFmpeg failed to initialise: {e}"),
        },
    }
}

fn avformat_version() -> String {
    let raw = unsafe { ffmpeg::ffi::avformat_version() };
    format!("{}.{}.{}", raw >> 16, (raw >> 8) & 0xff, raw & 0xff)
}

fn permission_check(permissions: &Permissions) -> Check {
    match permissions.screen_recording {
        #[cfg(target_os = "macos")]
        PermissionStatus::Granted => Check {
            id: CheckId::ScreenRecordingPermission,
            status: CheckStatus::Ok,
            message: "Screen recording permission granted".to_string(),
        },
        PermissionStatus::Unknown => Check {
            id: CheckId::ScreenRecordingPermission,
            status: CheckStatus::Unknown,
            message: permissions
                .reason
                .clone()
                .unwrap_or_else(|| "Screen recording permission status unknown".to_string()),
        },
        #[cfg(target_os = "macos")]
        PermissionStatus::Denied | PermissionStatus::NotDetermined => Check {
            id: CheckId::ScreenRecordingPermission,
            status: CheckStatus::Warn,
            message: "Screen recording permission not granted; recording will fail until it is \
                      enabled in System Settings"
                .to_string(),
        },
    }
}

#[cfg(target_os = "macos")]
async fn screen_capture_kit_check(permissions: &Permissions) -> Check {
    if !matches!(permissions.screen_recording, PermissionStatus::Granted) {
        return Check {
            id: CheckId::ScreenCaptureKit,
            status: CheckStatus::Warn,
            message: "ScreenCaptureKit stream availability was not checked because screen recording permission is not granted".to_string(),
        };
    }

    let content = match tokio::time::timeout(
        Duration::from_secs(3),
        cidre::sc::ShareableContent::current(),
    )
    .await
    {
        Ok(Ok(content)) => content,
        Ok(Err(error)) => {
            return Check {
                id: CheckId::ScreenCaptureKit,
                status: CheckStatus::Fail,
                message: format!("ScreenCaptureKit failed to return shareable content: {error}"),
            };
        }
        Err(_) => {
            return Check {
                id: CheckId::ScreenCaptureKit,
                status: CheckStatus::Fail,
                message: "ScreenCaptureKit timed out while reading shareable content".to_string(),
            };
        }
    };

    let process_content = match tokio::time::timeout(
        Duration::from_secs(3),
        cidre::sc::ShareableContent::current_process(),
    )
    .await
    {
        Ok(Ok(content)) => Some(content),
        Ok(Err(_)) | Err(_) => None,
    };

    let display_count = content.displays().len();
    let window_count = content.windows().len();
    let process_display_count = process_content
        .as_ref()
        .map(|content| content.displays().len())
        .unwrap_or(0);
    let process_window_count = process_content
        .as_ref()
        .map(|content| content.windows().len())
        .unwrap_or(0);

    if display_count == 0 && process_display_count == 0 {
        return Check {
            id: CheckId::ScreenCaptureKit,
            status: CheckStatus::Fail,
            message: format!(
                "ScreenCaptureKit returned no displays; live screen recording will fail in this process. Windows visible: {window_count}, current-process windows visible: {process_window_count}"
            ),
        };
    }

    Check {
        id: CheckId::ScreenCaptureKit,
        status: CheckStatus::Ok,
        message: format!(
            "ScreenCaptureKit returned {display_count} display(s), {window_count} window(s), {process_display_count} current-process display(s), and {process_window_count} current-process window(s)"
        ),
    }
}

fn install_check(install: &Result<cap_cli_install::CliInstallStatus, String>) -> Check {
    match install {
        Ok(status) if status.installed && status.on_path => Check {
            id: CheckId::CliInstall,
            status: CheckStatus::Ok,
            message: format!("`cap` is installed at {} and on PATH", status.shim_path),
        },
        Ok(status) if status.installed => Check {
            id: CheckId::CliInstall,
            status: CheckStatus::Warn,
            message: format!(
                "`cap` is installed at {} but its directory is not on PATH. Run: {}",
                status.shim_path, status.shell_command
            ),
        },
        Ok(status) => Check {
            id: CheckId::CliInstall,
            status: CheckStatus::Warn,
            message: status
                .conflict
                .clone()
                .unwrap_or_else(|| "`cap` shim is not installed".to_string()),
        },
        Err(e) => Check {
            id: CheckId::CliInstall,
            status: CheckStatus::Unknown,
            message: format!("Could not determine install status: {e}"),
        },
    }
}

#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn capture_ready(permissions: &Permissions, checks: &[Check]) -> bool {
    let permission_ready = match permissions.screen_recording {
        #[cfg(target_os = "macos")]
        PermissionStatus::Granted => true,
        PermissionStatus::Unknown => true,
        #[cfg(target_os = "macos")]
        PermissionStatus::Denied | PermissionStatus::NotDetermined => false,
    };

    if !permission_ready {
        return false;
    }

    #[cfg(target_os = "macos")]
    if checks
        .iter()
        .any(|check| check.id == CheckId::ScreenCaptureKit && check.status != CheckStatus::Ok)
    {
        return false;
    }

    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationsInfo {
    pub rule_count: usize,
    pub enabled_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doctor {
    pub schema_version: u32,
    pub version: VersionInfo,
    pub permissions: Permissions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<cap_cli_install::CliInstallStatus>,
    pub checks: Vec<Check>,
    /// Automation rules shared with Cap Desktop that the CLI honors after capture/upload.
    pub automations: AutomationsInfo,
    /// Overall health: false when a required check (e.g. ffmpeg) failed.
    pub ok: bool,
    /// Whether a screen recording can start right now (screen recording permission granted).
    pub capture_ready: bool,
}

pub fn run_version(format: OutputFormat) -> Result<(), String> {
    let info = VersionInfo::collect();

    match format {
        OutputFormat::Json => write_json(&info),
        OutputFormat::Text => {
            println!("{} {}", info.name, info.version);
            println!(
                "platform: {} {} ({})",
                info.platform.os, info.platform.arch, info.platform.family
            );
            if let Some(path) = &info.executable_path {
                println!("executable: {path}");
            }
            println!("distribution: {}", distribution_label(info.distribution));
            if let Some(bundle) = &info.bundle {
                match &bundle.version {
                    Some(version) => println!("desktop bundle: {} ({version})", bundle.path),
                    None => println!("desktop bundle: {}", bundle.path),
                }
            }
            Ok(())
        }
    }
}

fn distribution_label(distribution: Distribution) -> &'static str {
    match distribution {
        Distribution::Bundled => "bundled",
        Distribution::Development => "development",
        Distribution::Unknown => "unknown",
    }
}

pub async fn run_doctor(format: OutputFormat) -> Result<(), String> {
    let version = VersionInfo::collect();
    let permissions = permissions();
    let install = cap_cli_install::status();

    let mut checks = vec![ffmpeg_check(), permission_check(&permissions)];

    #[cfg(target_os = "macos")]
    checks.push(screen_capture_kit_check(&permissions).await);

    checks.push(install_check(&install));

    let ok = !checks
        .iter()
        .any(|check| matches!(check.status, CheckStatus::Fail));
    let capture_ready = capture_ready(&permissions, &checks);

    let (rule_count, enabled_count) = crate::automation::rule_counts();

    let doctor = Doctor {
        schema_version: SCHEMA_VERSION,
        version,
        permissions,
        install: install.ok(),
        checks,
        automations: AutomationsInfo {
            rule_count,
            enabled_count,
        },
        ok,
        capture_ready,
    };

    match format {
        OutputFormat::Json => write_json(&doctor)?,
        OutputFormat::Text => {
            println!(
                "cap {} ({})",
                doctor.version.version,
                distribution_label(doctor.version.distribution)
            );
            if let Some(path) = &doctor.version.executable_path {
                println!("  executable: {path}");
            }
            println!("  capture ready: {}", doctor.capture_ready);
            println!(
                "  automations: {} rule(s), {} enabled",
                doctor.automations.rule_count, doctor.automations.enabled_count
            );
            println!();
            for check in &doctor.checks {
                println!(
                    "[{}] {}: {}",
                    status_glyph(check.status),
                    check.id.label(),
                    check.message
                );
            }
            println!();
            println!(
                "{}",
                if doctor.ok {
                    "All required checks passed"
                } else {
                    "Some checks failed"
                }
            );
        }
    }

    // Exit 0 even when checks fail: `doctor` is a report, not a gate. Agents branch on the `ok` /
    // `captureReady` fields rather than the exit code, so a produced report is a success.
    Ok(())
}

fn status_glyph(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Ok => "ok",
        CheckStatus::Warn => "warn",
        CheckStatus::Fail => "fail",
        CheckStatus::Unknown => "????",
    }
}
