//! Handing this app off to the experimental gpui-native app (`cap-gpui`).
//!
//! The two apps already share one settings store and recordings library
//! (`apps/desktop-gpui/src/store.rs` reads this app's), so the `enable_gpui_app`
//! setting is not "run both": whichever app is enabled owns the session. Turning
//! it on spawns `cap-gpui` and exits this app; turning it off inside `cap-gpui`
//! reopens this one. Startup honours the same flag, so the handoff survives a
//! relaunch.
//!
//! The binary is discovered in order: `CAP_GPUI_BIN` (explicit override), the
//! installed executable directory (where Tauri bundles and signs sidecars), the
//! legacy `gpui/` resource dir, and -- in debug builds only -- the sibling
//! `apps/desktop-gpui` target dir, so the toggle works from a source checkout.
//!
//! ## The handoff marker
//!
//! A handoff that spawns a `cap-gpui` which then dies immediately would leave
//! the user with no app at all, and with a setting that keeps redirecting away
//! from the app that does work. So this side writes `cap-gpui.handoff` next to
//! the shared store before spawning, and `cap-gpui` deletes it only on clean
//! shutdown. With no live GPUI process, a surviving marker means the previous
//! session exited unexpectedly: clear the flag, tell the user, and start normally.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tracing::{info, warn};

use crate::{App, MutableState, general_settings::GeneralSettingsStore, request_app_exit};

#[cfg(windows)]
const BINARY_NAME: &str = "cap-gpui.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "cap-gpui";

#[cfg(any(target_os = "macos", windows, test))]
const MAX_FORWARDED_DEEP_LINK_BYTES: usize = 1024 * 1024;

#[cfg(any(target_os = "macos", windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GpuiForwardingEndpoint {
    pid: u32,
    port: u16,
    secret: u64,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
pub(crate) struct StartupRedirectState(std::sync::atomic::AtomicU8);

#[cfg(any(target_os = "macos", test))]
impl StartupRedirectState {
    pub(crate) fn begin_forwarding(&self) -> bool {
        self.transition(0, 1)
    }

    pub(crate) fn exit_if_pending(&self) -> bool {
        self.transition(0, 2)
    }

    pub(crate) fn exit_after_forwarding(&self) -> bool {
        self.transition(1, 2)
    }

    fn transition(&self, from: u8, to: u8) -> bool {
        self.0
            .compare_exchange(
                from,
                to,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    }
}

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

fn binary_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CAP_GPUI_BIN").map(PathBuf::from)
        && path.is_file()
    {
        return Some(path);
    }

    if let Ok(executable) = std::env::current_exe()
        && let Some(parent) = executable.parent()
        && let Some(path) = existing_file(parent.join(BINARY_NAME))
    {
        return Some(path);
    }

    if let Ok(resources) = app.path().resource_dir()
        && let Some(path) = existing_file(resources.join("gpui").join(BINARY_NAME))
    {
        return Some(path);
    }

    #[cfg(debug_assertions)]
    {
        // Whichever profile was built most recently: a fixed preference here
        // hands off to a days-old binary the moment the other profile is the
        // one being actively rebuilt.
        let target =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-gpui/target");
        let newest = ["release", "debug"]
            .into_iter()
            .filter_map(|profile| {
                let path = target.join(profile).join(BINARY_NAME);
                let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
                Some((modified, path))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path);
        if newest.is_some() {
            return newest;
        }
    }

    None
}

/// Mirror of `store::app_data_dir` in `apps/desktop-gpui`: the pidfile and the
/// handoff marker live under the shared production identifier
/// (`so.cap.desktop`), not this app's possibly-`.dev` one.
fn shared_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join("Library/Application Support/so.cap.desktop");
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into()))
                .join(".local/share")
        })
        .join("so.cap.desktop");
    base
}

fn gpui_pidfile() -> PathBuf {
    shared_data_dir().join("cap-gpui.pid")
}

/// Whether this app's own store IS the shared one. It is for the production
/// bundle (`so.cap.desktop`), but a dev build stores under a `.dev` identifier
/// while `cap-gpui` always reads and writes the shared file -- two stores that
/// silently disagree. The handoff flag therefore lives in the shared store,
/// and this app's own copy of the setting is just what its settings page
/// displays.
fn own_store_is_shared(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .is_ok_and(|dir| dir == shared_data_dir())
}

fn shared_store_path() -> PathBuf {
    // The store plugin's file for the production identifier -- the same file
    // `store::set_store_setting` in apps/desktop-gpui operates on.
    shared_data_dir().join("store")
}

fn shared_store_flag() -> Option<bool> {
    let raw = std::fs::read_to_string(shared_store_path()).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    doc.get("general_settings")?.get("enableGpuiApp")?.as_bool()
}

/// Single-key replace with everything else preserved, temp+rename atomic --
/// the same contract as the gpui app's `set_store_setting`. A missing file is
/// created with just this key; an unparseable one is refused rather than
/// replaced. Only ever called when the shared store is NOT this app's own
/// (`own_store_is_shared` false): writing the file directly under the store
/// plugin's feet would race its in-memory copy.
fn write_shared_store_flag(value: bool) {
    let path = shared_store_path();
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(doc) => doc,
            Err(error) => {
                warn!(%error, "shared store is unparseable; leaving it untouched");
                return;
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => {
            warn!(%error, "could not read the shared store");
            return;
        }
    };
    let Some(root) = doc.as_object_mut() else {
        warn!("shared store is not a JSON object; leaving it untouched");
        return;
    };
    root.entry("general_settings")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .map(|section| section.insert("enableGpuiApp".into(), serde_json::Value::Bool(value)));
    let pretty = serde_json::to_string_pretty(&doc).unwrap_or_else(|_| doc.to_string());
    let tmp = path.with_extension("tmp");
    let write = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&tmp, pretty))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(error) = write {
        warn!(%error, "could not write the shared store flag");
    }
}

fn handoff_marker() -> PathBuf {
    shared_data_dir().join("cap-gpui.handoff")
}

fn update_handoff_marker() -> PathBuf {
    shared_data_dir().join("cap-gpui.update-handoff")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UpdateHandoff {
    pid: u32,
    simulated: bool,
}

fn parse_update_handoff(contents: &str) -> Option<UpdateHandoff> {
    let contents = contents.trim();
    let (pid, simulated) = match contents.strip_prefix("simulate:") {
        Some(pid) if cfg!(debug_assertions) => (pid, true),
        Some(_) => return None,
        None => (contents, false),
    };
    let pid = pid.parse().ok()?;
    (pid != 0).then_some(UpdateHandoff { pid, simulated })
}

fn take_update_handoff() -> Option<bool> {
    let marker = update_handoff_marker();
    let contents = match std::fs::read_to_string(&marker) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(%error, "could not read the Cap GPUI update hand-off");
            return None;
        }
    };

    let Some(handoff) = parse_update_handoff(&contents) else {
        warn!("discarding an invalid Cap GPUI update hand-off");
        let _ = std::fs::remove_file(&marker);
        return None;
    };

    let expected_pid = std::fs::read_to_string(gpui_pidfile())
        .ok()
        .and_then(|contents| contents.trim().parse::<u32>().ok());
    let stale = marker
        .metadata()
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > std::time::Duration::from_secs(15 * 60));
    if expected_pid.is_some_and(|pid| pid != handoff.pid) || stale {
        warn!(
            pid = handoff.pid,
            "discarding a stale Cap GPUI update hand-off"
        );
        let _ = std::fs::remove_file(&marker);
        return None;
    }

    match std::fs::remove_file(&marker) {
        Ok(()) => {
            info!(
                pid = handoff.pid,
                "taking ownership from Cap GPUI for an update check"
            );
            Some(handoff.simulated)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            warn!(%error, "could not consume the Cap GPUI update hand-off");
            None
        }
    }
}

fn show_update_page_when_ready(app: AppHandle, simulated: bool) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..300 {
            if let Some(window) = app
                .get_webview_window("main")
                .or_else(|| app.get_webview_window("onboarding"))
            {
                match window.url() {
                    Ok(mut url) => {
                        url.set_path("/update");
                        url.set_query(Some(if simulated {
                            "source=gpui&simulateUpdate=1"
                        } else {
                            "source=gpui"
                        }));
                        if let Err(error) = window.navigate(url) {
                            warn!(%error, "could not open the updater after the GPUI hand-off");
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    Err(error) => {
                        warn!(%error, "could not read the window URL for the GPUI updater");
                    }
                }
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        warn!("no window became ready for the GPUI update hand-off");
    });
}

pub(crate) fn handle_update_handoff(app: &AppHandle) -> bool {
    let Some(simulated) = take_update_handoff() else {
        return false;
    };
    show_update_page_when_ready(app.clone(), simulated);
    true
}

/// The dev switch-back's readiness handshake (`store::classic_pending_path`
/// in apps/desktop-gpui): `cap-gpui` writes this and stays on screen until the
/// classic app deletes it, so a minutes-long dev rebuild never leaves the user
/// with no app at all.
fn classic_pending() -> PathBuf {
    shared_data_dir().join("cap-classic.pending")
}

/// The pid of the live `cap-gpui` that owns the pidfile, if there is one.
/// Spawning over a live instance would not stack: its single-instance guard
/// kills the previous process, so a handoff that relaunched unconditionally
/// would restart a session the user may be recording in.
fn running_instance_pid() -> Option<u32> {
    let pid = std::fs::read_to_string(gpui_pidfile())
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()?;

    #[cfg(target_os = "linux")]
    {
        linux_gpui_process_is_running(pid).then_some(pid)
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let alive = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && is_gpui_process_image(std::path::Path::new(
                        String::from_utf8_lossy(&output.stdout).trim(),
                    ))
            });
        alive.then_some(pid)
    }

    #[cfg(windows)]
    {
        let process_id = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[process_id]), true);
        system
            .process(process_id)
            .and_then(sysinfo::Process::exe)
            .is_some_and(is_gpui_process_image)
            .then_some(pid)
    }
}

#[cfg(target_os = "linux")]
fn linux_gpui_process_is_running(pid: u32) -> bool {
    std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| is_gpui_process_image(&path))
}

fn is_gpui_process_image(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(std::ffi::OsStr::to_str) else {
        return false;
    };
    #[cfg(target_os = "linux")]
    let name = name.strip_suffix(" (deleted)").unwrap_or(name);
    name.eq_ignore_ascii_case(BINARY_NAME)
}

#[cfg(any(target_os = "macos", windows, test))]
fn parse_gpui_forwarding_endpoint(contents: &str) -> Option<GpuiForwardingEndpoint> {
    let mut parts = contents.trim().split(':');
    let pid = parts.next()?.parse().ok()?;
    let port = parts.next()?.parse().ok()?;
    let secret = u64::from_str_radix(parts.next()?, 16).ok()?;
    (pid != 0 && port != 0 && parts.next().is_none()).then_some(GpuiForwardingEndpoint {
        pid,
        port,
        secret,
    })
}

#[cfg(any(target_os = "macos", windows, test))]
fn is_forwardable_gpui_deep_link(url: &str) -> bool {
    !url.is_empty()
        && url.len() <= MAX_FORWARDED_DEEP_LINK_BYTES
        && reqwest::Url::parse(url)
            .is_ok_and(|parsed| matches!(parsed.scheme(), "cap-desktop" | "cap"))
}

#[cfg(any(target_os = "macos", windows, test))]
fn forwarded_gpui_argument(argument: &str) -> Option<String> {
    if is_forwardable_gpui_deep_link(argument) {
        return Some(argument.to_string());
    }

    let path = match reqwest::Url::parse(argument) {
        Ok(url) if url.scheme() == "file" => url.to_file_path().ok()?,
        _ => PathBuf::from(argument),
    };
    if !path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cap"))
    {
        return None;
    }

    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let path = path.canonicalize().ok()?;
    let value = serde_json::json!({ "open_editor": { "project_path": path } }).to_string();
    let mut url = reqwest::Url::parse("cap-desktop://action").ok()?;
    url.query_pairs_mut().append_pair("value", &value);
    let url = url.to_string();
    is_forwardable_gpui_deep_link(&url).then_some(url)
}

#[cfg(any(target_os = "macos", windows))]
fn forward_deep_links_to_gpui(pid: u32, args: &[String]) -> bool {
    use std::io::Write;

    let urls = args
        .iter()
        .filter_map(|argument| forwarded_gpui_argument(argument))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return false;
    }

    let endpoint_path = gpui_pidfile().with_extension("ipc");
    let endpoint = (0..40).find_map(|attempt| {
        let endpoint = std::fs::read_to_string(&endpoint_path)
            .ok()
            .and_then(|contents| parse_gpui_forwarding_endpoint(&contents))
            .filter(|endpoint| endpoint.pid == pid);
        if endpoint.is_none() && attempt < 39 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        endpoint
    });
    let Some(endpoint) = endpoint else {
        warn!(pid, "could not find the Cap GPUI deep-link endpoint");
        return false;
    };

    let mut forwarded = false;
    for url in urls {
        let result = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, endpoint.port))
            .and_then(|mut stream| {
                stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
                stream.write_all(&endpoint.secret.to_be_bytes())?;
                stream.write_all(&(url.len() as u32).to_be_bytes())?;
                stream.write_all(url.as_bytes())
            });
        match result {
            Ok(()) => forwarded = true,
            Err(error) => warn!(%error, "could not forward a deep link to Cap GPUI"),
        }
    }

    forwarded
}

#[cfg(any(target_os = "macos", windows))]
pub(crate) fn forward_deep_links_to_active_gpui(app: &AppHandle, args: &[String]) -> bool {
    let own = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.enable_gpui_app);
    let enabled = if own_store_is_shared(app) {
        own
    } else {
        shared_store_flag().unwrap_or(false)
    };
    if !enabled {
        return false;
    }

    let Some(pid) = running_instance_pid() else {
        return false;
    };
    if !forward_deep_links_to_gpui(pid, args) {
        return false;
    }

    activate_instance(pid);
    true
}

#[cfg(target_os = "macos")]
pub(crate) fn forward_deep_links_to_gpui_when_ready(args: &[String]) -> Option<u32> {
    if !args
        .iter()
        .any(|argument| forwarded_gpui_argument(argument).is_some())
    {
        return None;
    }

    let pid = (0..40).find_map(|attempt| {
        let pid = running_instance_pid();
        if pid.is_none() && attempt < 39 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        pid
    })?;

    forward_deep_links_to_gpui(pid, args).then_some(pid)
}

#[cfg(target_os = "macos")]
pub(crate) fn activate_instance(pid: u32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    if let Some(instance) =
        unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid as _) }
    {
        unsafe {
            instance.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    }
}

#[cfg(windows)]
fn activate_instance(pid: u32) {
    use windows::{
        Win32::{
            Foundation::{HWND, LPARAM, TRUE},
            UI::WindowsAndMessaging::{
                EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SW_RESTORE,
                SetForegroundWindow, ShowWindow,
            },
        },
        core::BOOL,
    };

    struct Activation {
        pid: u32,
        visible: Option<HWND>,
        fallback: Option<HWND>,
    }

    unsafe extern "system" fn find_window(window: HWND, data: LPARAM) -> BOOL {
        let activation = unsafe { &mut *(data.0 as *mut Activation) };
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
        if owner == activation.pid {
            if activation.fallback.is_none() {
                activation.fallback = Some(window);
            }
            if activation.visible.is_none() && unsafe { IsWindowVisible(window) }.as_bool() {
                activation.visible = Some(window);
            }
        }
        TRUE
    }

    let mut activation = Activation {
        pid,
        visible: None,
        fallback: None,
    };
    let _ = unsafe {
        EnumWindows(
            Some(find_window),
            LPARAM(std::ptr::addr_of_mut!(activation) as isize),
        )
    };

    if let Some(window) = activation.visible.or(activation.fallback) {
        unsafe {
            let _ = ShowWindow(window, SW_RESTORE);
            let _ = SetForegroundWindow(window);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn activate_instance(_pid: u32) {}

#[cfg(any(target_os = "linux", test))]
fn launch_linux_activation(
    path: Option<&std::path::Path>,
    launch: impl FnOnce(&std::path::Path, &[String]) -> Result<(), String>,
) -> Result<(), String> {
    let path = path.ok_or_else(|| "Cap GPUI isn't included in this build".to_string())?;
    launch(path, &[])
}

fn write_handoff_marker() {
    let path = handoff_marker();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    if let Err(error) = std::fs::write(&path, stamp.to_string()) {
        warn!(%error, "could not write the Cap GPUI handoff marker");
    }
}

/// The child must never inherit this process's stdio. The handoff exits this
/// app, and whatever was reading those pipes (`pnpm tauri dev`'s tooling chain)
/// goes with it; `cap-gpui`'s next log line then hits EPIPE, the write panics
/// inside an ObjC run-loop callback, and the process aborts about a tenth of a
/// second after launch. Its output goes to a file instead of `/dev/null`
/// because a handoff launch has no terminal, and a startup failure there is
/// only ever diagnosable from that file.
fn spawn_detached(path: &std::path::Path, args: &[String]) -> Result<(), String> {
    use std::process::Stdio;

    let log_path = shared_data_dir().join("cap-gpui.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (stdout, stderr) = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => match file.try_clone() {
            Ok(clone) => (Stdio::from(file), Stdio::from(clone)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(error) => {
            warn!(%error, "could not open the Cap GPUI log; discarding its output");
            (Stdio::null(), Stdio::null())
        }
    };

    let mut command = std::process::Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    // Its own process group, so signals aimed at the terminal this app was
    // started from never reach the app that outlives it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch Cap GPUI: {error}"))?;
    // Reap the child when it exits so it never lingers as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn gpui_app_available(app: AppHandle) -> bool {
    binary_path(&app).is_some()
}

/// Close this app and open the native one. The setting has already been written
/// by the caller, so a failure here has to be reported rather than swallowed:
/// the page reverts it.
#[tauri::command]
#[specta::specta]
pub async fn switch_to_gpui_app(
    app: AppHandle,
    state: MutableState<'_, App>,
) -> Result<(), String> {
    if state.read().await.is_recording_active_or_pending() {
        return Err("Stop your recording before switching to the native app.".to_string());
    }
    if crate::export::export_session_active() {
        return Err(
            "Wait for your export to finish before switching to the native app.".to_string(),
        );
    }
    if crate::upload::upload_session_active() {
        return Err(
            "Wait for your upload to finish before switching to the native app.".to_string(),
        );
    }

    let path =
        binary_path(&app).ok_or_else(|| "Cap GPUI isn't included in this build".to_string())?;

    // The caller wrote this app's own store; a dev build must also set the
    // flag where `cap-gpui` and the next startup's redirect actually read it.
    if !own_store_is_shared(&app) {
        write_shared_store_flag(true);
    }

    match running_instance_pid() {
        Some(pid) => {
            #[cfg(target_os = "linux")]
            if let Err(error) = launch_linux_activation(Some(&path), spawn_detached) {
                if !own_store_is_shared(&app) {
                    write_shared_store_flag(false);
                }
                return Err(error);
            }
            #[cfg(not(target_os = "linux"))]
            activate_instance(pid);
            info!(pid, "Cap GPUI is already running; requested its controls");
        }
        None => {
            write_handoff_marker();
            info!(path = %path.display(), "handing off to Cap GPUI");
            if let Err(error) = spawn_detached(&path, &[]) {
                let _ = std::fs::remove_file(handoff_marker());
                if !own_store_is_shared(&app) {
                    write_shared_store_flag(false);
                }
                return Err(error);
            }
        }
    }

    request_app_exit(app).await;
    Ok(())
}

/// Whether this app should hand over to `cap-gpui` instead of starting.
///
/// `true` means the caller must exit before any window is created.
pub fn redirect_at_startup_if_enabled(app: &AppHandle) -> Result<bool, String> {
    let update_handoff = handle_update_handoff(app);
    let redirect = !update_handoff && redirect_decision(app)?;
    if !redirect {
        // Staying up IS the readiness signal the waiting `cap-gpui` needs --
        // and the wait can begin while this app is ALREADY running (switching
        // back with both apps up), so the signal has to keep firing, not just
        // fire once at startup.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let _ = std::fs::remove_file(classic_pending());
                handle_update_handoff(&app);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }
    Ok(redirect)
}

fn redirect_decision(app: &AppHandle) -> Result<bool, String> {
    let own = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.enable_gpui_app);
    // In a dev build the shared store is the authority: `cap-gpui`'s
    // switch-back writes false THERE, and honouring this app's own `.dev`
    // copy instead would bounce the user straight back after every
    // switch-back (the loop this replaced).
    let enabled = if own_store_is_shared(app) {
        own
    } else {
        shared_store_flag().unwrap_or(false)
    };
    if !enabled {
        if own {
            // The stale display copy: without this the Experimental page
            // shows the toggle on while the classic app owns the session.
            if let Err(error) = GeneralSettingsStore::update(app, |settings| {
                settings.enable_gpui_app = false;
            }) {
                warn!(%error, "could not reconcile the Cap GPUI setting");
            }
        }
        return Ok(false);
    }

    // The marker exists throughout a live session. Check the process first so
    // reopening Cap does not mistake a running native app for a crashed one.
    if let Some(pid) = running_instance_pid() {
        #[cfg(any(target_os = "macos", windows))]
        {
            let args = std::env::args().skip(1).collect::<Vec<_>>();
            forward_deep_links_to_gpui(pid, &args);
        }
        #[cfg(target_os = "linux")]
        launch_linux_activation(binary_path(app).as_deref(), spawn_detached)?;
        #[cfg(not(target_os = "linux"))]
        activate_instance(pid);
        info!(pid, "Cap GPUI is already running; requested its controls");
        return Ok(true);
    }

    let marker = handoff_marker();
    if marker.exists() {
        warn!("the last Cap GPUI session exited unexpectedly; taking back over");
        let _ = std::fs::remove_file(&marker);
        if let Err(error) = GeneralSettingsStore::update(app, |settings| {
            settings.enable_gpui_app = false;
        }) {
            warn!(%error, "could not clear the Cap GPUI setting");
        }
        if !own_store_is_shared(app) {
            write_shared_store_flag(false);
        }
        app.dialog()
            .message(
                "The native Cap app exited unexpectedly last time, so the classic app has been restored.",
            )
            .show(|_| {});
        return Ok(false);
    }

    let Some(path) = binary_path(app) else {
        warn!("Cap GPUI is enabled but its binary was not found; starting this app instead");
        return Ok(false);
    };

    write_handoff_marker();
    info!(path = %path.display(), "handing off to Cap GPUI at startup");
    #[cfg(any(target_os = "macos", windows))]
    let args = std::env::args()
        .skip(1)
        .filter_map(|argument| forwarded_gpui_argument(&argument))
        .collect::<Vec<_>>();
    #[cfg(not(any(target_os = "macos", windows)))]
    let args = Vec::new();
    if let Err(error) = spawn_detached(&path, &args) {
        warn!("{error}");
        let _ = std::fs::remove_file(handoff_marker());
        return Ok(false);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        BINARY_NAME, GpuiForwardingEndpoint, MAX_FORWARDED_DEEP_LINK_BYTES, StartupRedirectState,
        UpdateHandoff, forwarded_gpui_argument, is_forwardable_gpui_deep_link,
        is_gpui_process_image, parse_gpui_forwarding_endpoint, parse_update_handoff,
    };

    #[test]
    fn linux_activation_launches_the_resolved_binary_once_without_arguments() {
        let path = std::path::Path::new("/opt/cap/cap-gpui");
        let mut launches = 0;
        super::launch_linux_activation(Some(path), |selected, args| {
            launches += 1;
            assert_eq!(selected, path);
            assert!(args.is_empty());
            Ok(())
        })
        .unwrap();
        assert_eq!(launches, 1);
    }

    #[test]
    fn linux_activation_requires_a_resolved_binary_before_launch() {
        let result = super::launch_linux_activation(None, |_, _| {
            panic!("a missing GPUI binary must not be launched")
        });
        assert_eq!(result.unwrap_err(), "Cap GPUI isn't included in this build");
    }

    #[test]
    fn linux_activation_preserves_launch_failure() {
        let path = std::path::Path::new("/opt/cap/cap-gpui");
        let result = super::launch_linux_activation(Some(path), |_, _| {
            Err("Failed to launch Cap GPUI: permission denied".into())
        });
        assert_eq!(
            result.unwrap_err(),
            "Failed to launch Cap GPUI: permission denied"
        );
    }

    #[test]
    fn startup_redirect_exits_once_when_no_open_event_arrives() {
        let state = StartupRedirectState::default();

        assert!(state.exit_if_pending());
        assert!(!state.exit_if_pending());
        assert!(!state.begin_forwarding());
        assert!(!state.exit_after_forwarding());
    }

    #[test]
    fn startup_redirect_waits_for_forwarding_before_exiting_once() {
        let state = StartupRedirectState::default();

        assert!(state.begin_forwarding());
        assert!(!state.begin_forwarding());
        assert!(!state.exit_if_pending());
        assert!(state.exit_after_forwarding());
        assert!(!state.exit_after_forwarding());
    }

    #[test]
    fn update_handoff_requires_a_valid_process_id() {
        assert_eq!(
            parse_update_handoff("1234"),
            Some(UpdateHandoff {
                pid: 1234,
                simulated: false,
            })
        );
        assert_eq!(parse_update_handoff("0"), None);
        assert_eq!(parse_update_handoff("cap-gpui"), None);
        assert_eq!(parse_update_handoff("simulate:0"), None);
    }

    #[test]
    fn simulated_update_handoffs_are_debug_only() {
        let parsed = parse_update_handoff("simulate:4321");
        if cfg!(debug_assertions) {
            assert_eq!(
                parsed,
                Some(UpdateHandoff {
                    pid: 4321,
                    simulated: true,
                })
            );
        } else {
            assert_eq!(parsed, None);
        }
    }

    #[test]
    fn gpui_process_image_must_match_exactly() {
        assert!(is_gpui_process_image(std::path::Path::new(BINARY_NAME)));
        assert!(is_gpui_process_image(std::path::Path::new(
            &BINARY_NAME.to_ascii_uppercase()
        )));
        assert!(!is_gpui_process_image(std::path::Path::new("not-cap-gpui")));
        assert!(!is_gpui_process_image(std::path::Path::new(
            "cap-gpui-helper"
        )));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_check_distinguishes_live_unlinked_and_exited_processes() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join(BINARY_NAME);
        std::fs::copy("/bin/sleep", &binary).unwrap();
        let mut child = std::process::Command::new(&binary)
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id();
        let started = std::time::Instant::now();
        // spawn can return before /proc stops exposing the child's pre-exec image.
        while !std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| path == binary)
            && started.elapsed() < std::time::Duration::from_secs(5)
        {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let live = super::linux_gpui_process_is_running(pid);
        std::fs::remove_file(&binary).unwrap();
        let unlinked = super::linux_gpui_process_is_running(pid);
        child.kill().unwrap();
        let started = std::time::Instant::now();
        let mut zombie = false;
        while started.elapsed() < std::time::Duration::from_secs(5) {
            zombie = std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit_once(") ")
                    .is_some_and(|(_, state)| state.starts_with('Z'))
            });
            if zombie {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let exited = super::linux_gpui_process_is_running(pid);
        child.wait().unwrap();

        assert!(live);
        assert!(unlinked);
        assert!(zombie);
        assert!(!exited);
        assert!(!super::linux_gpui_process_is_running(pid));
        assert!(!super::linux_gpui_process_is_running(std::process::id()));
    }

    #[test]
    fn gpui_forwarding_endpoint_requires_the_owner_identity() {
        assert_eq!(
            parse_gpui_forwarding_endpoint("4321:49152:0123456789abcdef"),
            Some(GpuiForwardingEndpoint {
                pid: 4321,
                port: 49152,
                secret: 0x0123_4567_89ab_cdef,
            })
        );
        assert_eq!(parse_gpui_forwarding_endpoint("0:49152:1234"), None);
        assert_eq!(parse_gpui_forwarding_endpoint("4321:0:1234"), None);
        assert_eq!(parse_gpui_forwarding_endpoint("4321:49152:xyz"), None);
        assert_eq!(
            parse_gpui_forwarding_endpoint("4321:49152:1234:extra"),
            None
        );
    }

    #[test]
    fn forwarded_gpui_deep_links_are_scheme_and_size_limited() {
        assert!(is_forwardable_gpui_deep_link(
            "cap-desktop://signin?token=test"
        ));
        assert!(is_forwardable_gpui_deep_link(
            "cap://action?value=%22stop_recording%22"
        ));
        assert!(!is_forwardable_gpui_deep_link("https://cap.so/signin"));
        assert!(!is_forwardable_gpui_deep_link("cap-desktop-other://signin"));
        assert!(!is_forwardable_gpui_deep_link(&format!(
            "cap://action?value={}",
            "x".repeat(MAX_FORWARDED_DEEP_LINK_BYTES)
        )));
    }

    #[test]
    fn project_arguments_become_encoded_open_editor_actions() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("Recording #1 & draft.cap");
        std::fs::create_dir(&project).unwrap();

        let forwarded = forwarded_gpui_argument(project.to_str().unwrap()).unwrap();
        let url = reqwest::Url::parse(&forwarded).unwrap();
        let value = url
            .query_pairs()
            .find_map(|(key, value)| (key == "value").then_some(value.into_owned()))
            .unwrap();
        let action: serde_json::Value = serde_json::from_str(&value).unwrap();

        assert_eq!(url.scheme(), "cap-desktop");
        assert_eq!(url.host_str(), Some("action"));
        assert_eq!(
            action["open_editor"]["project_path"],
            project.canonicalize().unwrap().to_string_lossy().as_ref()
        );
    }

    #[test]
    fn forwarded_project_arguments_reject_missing_and_non_project_paths() {
        let directory = tempfile::tempdir().unwrap();
        let ordinary = directory.path().join("notes.txt");
        std::fs::write(&ordinary, "notes").unwrap();

        assert!(forwarded_gpui_argument(ordinary.to_str().unwrap()).is_none());
        assert!(
            forwarded_gpui_argument(directory.path().join("missing.cap").to_str().unwrap())
                .is_none()
        );
        assert_eq!(
            forwarded_gpui_argument("cap-desktop://signin?token=secret"),
            Some("cap-desktop://signin?token=secret".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn forwarded_project_arguments_reject_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("Recording.cap");
        let symlink = directory.path().join("Shortcut.cap");
        std::fs::create_dir(&project).unwrap();
        std::os::unix::fs::symlink(&project, &symlink).unwrap();

        assert!(forwarded_gpui_argument(symlink.to_str().unwrap()).is_none());
    }

    #[test]
    fn file_urls_become_open_editor_actions() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("Recording.cap");
        std::fs::create_dir(&project).unwrap();
        let file_url = reqwest::Url::from_file_path(&project).unwrap();

        assert!(forwarded_gpui_argument(file_url.as_str()).is_some());
    }
}
