//! New-instance-wins single instancing.
//!
//! The app lives in the tray: closing the main window hides it, the process
//! stays. Without a guard, a `cargo run` after an edit launches a second
//! instance next to the stale one, and the tray icon and level-100 window the
//! user is looking at may still belong to the *old* build -- which reads as
//! "my change only applied on the second run". The Tauri app's single-instance
//! plugin keeps the old instance and exits the new one; for a parallel
//! implementation that is mostly launched to see fresh code, the useful
//! polarity is the reverse: the new instance terminates the old one and takes
//! over. A capture killed this way lands in the bundle's `InProgress` /
//! `NeedsRemux` recovery path rather than being lost.
//!
//! The pidfile lives in [`crate::store::app_data_dir`], so a harness run
//! pointed at a `CAP_GPUI_APP_DATA_DIR` sandbox never kills the dev app.
//!
//! Deep links need no forwarding under this polarity. The Tauri plugin's
//! callback relays a second launch's `cap-desktop://` argv to the surviving
//! old instance (`src-tauri/src/lib.rs:5193-5204`); here the launch that
//! carries the URL *is* the survivor, and [`crate::deeplink::init`] reads its
//! own argv. A URL opened while the app is already running never launches a
//! second instance on macOS at all -- the GURL AppleEvent goes straight to
//! the running process (`crate::platform::install_url_scheme_handler`).

use std::path::{Path, PathBuf};

#[cfg(windows)]
static INSTANCE_MUTEX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

#[cfg(any(windows, target_os = "macos", test))]
const MAX_FORWARDED_DEEP_LINK_BYTES: usize = 1024 * 1024;

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ForwardingEndpoint {
    pid: u32,
    port: u16,
    secret: u64,
}

fn pidfile() -> PathBuf {
    crate::store::app_data_dir().join("cap-gpui.pid")
}

pub fn acquire() {
    let path = pidfile();
    #[cfg(windows)]
    acquire_windows_instance(&path);
    #[cfg(unix)]
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(pid) = raw.trim().parse::<i32>()
        && pid > 0
        && pid != std::process::id() as i32
        && is_cap_gpui(pid)
    {
        tracing::info!(pid, "terminating the previous instance");
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..40 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if unsafe { libc::kill(pid, 0) } == 0 {
            tracing::warn!(pid, "previous instance ignored SIGTERM; killing it");
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
        tracing::warn!(%error, "could not write the instance pidfile");
    }

    #[cfg(target_os = "macos")]
    if let Err(error) = start_deep_link_forwarding(&path) {
        tracing::error!(%error, "could not start Cap GPUI deep-link forwarding");
        std::process::exit(1);
    }
}

/// Guard against pid reuse: only ever signal a process that is actually this
/// binary. `comm` is the executable path on macOS and the (15-char) image
/// name on Linux; `cap-gpui` fits both.
#[cfg(unix)]
fn is_cap_gpui(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && is_cap_gpui_image(Path::new(String::from_utf8_lossy(&output.stdout).trim()))
        })
}

fn is_cap_gpui_image(path: &Path) -> bool {
    #[cfg(windows)]
    const IMAGE_NAME: &str = "cap-gpui.exe";
    #[cfg(not(windows))]
    const IMAGE_NAME: &str = "cap-gpui";

    path.file_name()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case(IMAGE_NAME))
}

#[cfg(windows)]
fn acquire_windows_instance(path: &Path) {
    use std::hash::{Hash, Hasher};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError},
        System::Threading::CreateMutexW,
    };

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    let name = format!("Local\\CapGpui-{:016x}", hasher.finish())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    let last_error = unsafe { GetLastError() };

    if mutex.is_null() {
        tracing::error!(
            error = last_error,
            "could not acquire the Cap GPUI instance mutex"
        );
        std::process::exit(1);
    }

    if last_error == ERROR_ALREADY_EXISTS {
        for _ in 0..40 {
            if let Some(pid) = windows_instance_pid(path) {
                tracing::info!(pid, "Cap GPUI is already running; bringing it forward");
                forward_windows_deep_links(path, pid);
                activate_windows_instance(pid);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let _ = unsafe { CloseHandle(mutex) };
        std::process::exit(0);
    }

    if INSTANCE_MUTEX.set(mutex as usize).is_err() {
        let _ = unsafe { CloseHandle(mutex) };
        tracing::error!("the Cap GPUI instance mutex was initialized twice");
        std::process::exit(1);
    }

    if let Err(error) = start_deep_link_forwarding(path) {
        tracing::error!(%error, "could not start Cap GPUI deep-link forwarding");
        std::process::exit(1);
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn start_deep_link_forwarding(path: &Path) -> std::io::Result<()> {
    use std::hash::BuildHasher;

    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let endpoint = ForwardingEndpoint {
        pid: std::process::id(),
        port: listener.local_addr()?.port(),
        secret: std::collections::hash_map::RandomState::new()
            .hash_one((std::process::id(), listener.local_addr()?.port())),
    };
    let endpoint_path = path.with_extension("ipc");
    let temporary_path =
        path.with_extension(format!("ipc.{}.{:016x}.tmp", endpoint.pid, endpoint.secret));

    if let Some(parent) = endpoint_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    write_forwarding_endpoint(&temporary_path, endpoint)?;
    if let Err(error) = publish_forwarding_endpoint(&temporary_path, &endpoint_path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }

    std::thread::Builder::new()
        .name("cap-gpui-deep-link".into())
        .spawn(move || {
            for connection in listener.incoming() {
                match connection {
                    Ok(mut stream) => {
                        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                        match read_forwarded_deep_link(&mut stream, endpoint.secret) {
                            Ok(url) => crate::deeplink::submit_deep_link(&url),
                            Err(error) => {
                                tracing::warn!(%error, "rejected a forwarded Cap deep link");
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "could not accept a forwarded Cap deep link");
                    }
                }
            }
        })?;

    Ok(())
}

#[cfg(any(windows, target_os = "macos", test))]
fn write_forwarding_endpoint(path: &Path, endpoint: ForwardingEndpoint) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path)?;
    write!(
        file,
        "{}:{}:{:016x}",
        endpoint.pid, endpoint.port, endpoint.secret
    )
}

#[cfg(all(unix, target_os = "macos"))]
fn publish_forwarding_endpoint(temporary_path: &Path, endpoint_path: &Path) -> std::io::Result<()> {
    std::fs::rename(temporary_path, endpoint_path)
}

#[cfg(windows)]
fn publish_forwarding_endpoint(temporary_path: &Path, endpoint_path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(endpoint_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(temporary_path, endpoint_path)
}

#[cfg(windows)]
fn forward_windows_deep_links(path: &Path, pid: u32) {
    use std::io::Write;

    let urls = std::env::args()
        .skip(1)
        .filter(|argument| is_forwardable_deep_link(argument))
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return;
    }

    let endpoint_path = path.with_extension("ipc");
    let endpoint = (0..40).find_map(|attempt| {
        let endpoint = std::fs::read_to_string(&endpoint_path)
            .ok()
            .and_then(|contents| parse_forwarding_endpoint(&contents))
            .filter(|endpoint| endpoint.pid == pid);
        if endpoint.is_none() && attempt < 39 {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        endpoint
    });
    let Some(endpoint) = endpoint else {
        tracing::warn!("could not find the running Cap GPUI deep-link endpoint");
        return;
    };

    for url in urls {
        let result = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, endpoint.port))
            .and_then(|mut stream| {
                stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
                stream.write_all(&endpoint.secret.to_be_bytes())?;
                stream.write_all(&(url.len() as u32).to_be_bytes())?;
                stream.write_all(url.as_bytes())
            });
        if let Err(error) = result {
            tracing::warn!(%error, "could not forward a Cap deep link to the running instance");
        }
    }
}

#[cfg(any(windows, test))]
fn parse_forwarding_endpoint(contents: &str) -> Option<ForwardingEndpoint> {
    let mut parts = contents.trim().split(':');
    let pid = parts.next()?.parse().ok()?;
    let port = parts.next()?.parse().ok()?;
    let secret = u64::from_str_radix(parts.next()?, 16).ok()?;
    (pid != 0 && port != 0 && parts.next().is_none()).then_some(ForwardingEndpoint {
        pid,
        port,
        secret,
    })
}

#[cfg(any(windows, target_os = "macos", test))]
fn is_forwardable_deep_link(url: &str) -> bool {
    !url.is_empty()
        && url.len() <= MAX_FORWARDED_DEEP_LINK_BYTES
        && reqwest::Url::parse(url)
            .is_ok_and(|parsed| matches!(parsed.scheme(), "cap-desktop" | "cap"))
}

#[cfg(any(windows, target_os = "macos", test))]
fn read_forwarded_deep_link(
    reader: &mut impl std::io::Read,
    expected_secret: u64,
) -> std::io::Result<String> {
    let mut secret = [0_u8; 8];
    reader.read_exact(&mut secret)?;
    if u64::from_be_bytes(secret) != expected_secret {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "incorrect forwarding secret",
        ));
    }

    let mut size = [0_u8; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > MAX_FORWARDED_DEEP_LINK_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid forwarded deep-link size",
        ));
    }

    let mut bytes = vec![0_u8; size];
    reader.read_exact(&mut bytes)?;
    let url = String::from_utf8(bytes).map_err(|error| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, error.utf8_error())
    })?;
    if !is_forwardable_deep_link(&url) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid forwarded deep-link scheme",
        ));
    }

    Ok(url)
}

#[cfg(windows)]
fn windows_instance_pid(path: &Path) -> Option<u32> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        },
    };

    let pid = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }

    let mut image = [0_u16; 1024];
    let mut len = image.len() as u32;
    let found =
        unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut len) } != 0;
    let _ = unsafe { CloseHandle(process) };
    if !found {
        return None;
    }

    let image = PathBuf::from(std::ffi::OsString::from_wide(&image[..len as usize]));
    is_cap_gpui_image(&image).then_some(pid)
}

#[cfg(windows)]
fn activate_windows_instance(pid: u32) {
    use windows_sys::Win32::{
        Foundation::{BOOL, HWND, LPARAM, TRUE},
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SW_RESTORE,
            SetForegroundWindow, ShowWindow,
        },
    };

    struct Activation {
        pid: u32,
        visible: Option<HWND>,
        fallback: Option<HWND>,
    }

    unsafe extern "system" fn find_window(window: HWND, data: LPARAM) -> BOOL {
        let activation = unsafe { &mut *(data as *mut Activation) };
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        if owner == activation.pid {
            if activation.fallback.is_none() {
                activation.fallback = Some(window);
            }
            if activation.visible.is_none() && unsafe { IsWindowVisible(window) } != 0 {
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
    unsafe {
        EnumWindows(
            Some(find_window),
            std::ptr::addr_of_mut!(activation) as isize,
        );
    }

    if let Some(window) = activation.visible.or(activation.fallback) {
        unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ForwardingEndpoint, MAX_FORWARDED_DEEP_LINK_BYTES, is_cap_gpui_image,
        is_forwardable_deep_link, parse_forwarding_endpoint, read_forwarded_deep_link,
    };
    use std::path::Path;

    #[test]
    fn gpui_process_image_must_match_exactly() {
        #[cfg(windows)]
        let name = "cap-gpui.exe";
        #[cfg(not(windows))]
        let name = "cap-gpui";

        assert!(is_cap_gpui_image(Path::new(name)));
        assert!(is_cap_gpui_image(Path::new(&name.to_ascii_uppercase())));
        assert!(!is_cap_gpui_image(Path::new("not-cap-gpui")));
        assert!(!is_cap_gpui_image(Path::new("cap-gpui-helper")));
    }

    #[test]
    fn forwarding_endpoint_requires_a_live_instance_shape() {
        assert_eq!(
            parse_forwarding_endpoint("4321:49152:0123456789abcdef"),
            Some(ForwardingEndpoint {
                pid: 4321,
                port: 49152,
                secret: 0x0123_4567_89ab_cdef,
            })
        );
        assert_eq!(parse_forwarding_endpoint("0:49152:0123"), None);
        assert_eq!(parse_forwarding_endpoint("4321:0:0123"), None);
        assert_eq!(parse_forwarding_endpoint("4321:49152:no-secret"), None);
        assert_eq!(parse_forwarding_endpoint("4321:49152:0123:extra"), None);
    }

    #[test]
    fn forwarded_deep_links_only_accept_cap_schemes() {
        assert!(is_forwardable_deep_link("cap-desktop://auth?token=test"));
        assert!(is_forwardable_deep_link("cap://action?value=test"));
        assert!(!is_forwardable_deep_link("https://cap.so"));
        assert!(!is_forwardable_deep_link("cap-desktop-evil://auth"));
        assert!(!is_forwardable_deep_link(&format!(
            "cap://action?value={}",
            "x".repeat(MAX_FORWARDED_DEEP_LINK_BYTES)
        )));
    }

    #[test]
    fn forwarded_project_actions_use_the_existing_deep_link_protocol() {
        let action = serde_json::json!({
            "open_editor": {
                "project_path": "/tmp/Recording With Spaces.cap"
            }
        });
        let url = reqwest::Url::parse_with_params(
            "cap-desktop://action",
            &[("value", action.to_string())],
        )
        .unwrap();

        assert!(is_forwardable_deep_link(url.as_str()));
        let secret = 0x0123_4567_89ab_cdef_u64;
        let mut payload = secret.to_be_bytes().to_vec();
        payload.extend_from_slice(&(url.as_str().len() as u32).to_be_bytes());
        payload.extend_from_slice(url.as_str().as_bytes());
        let authenticated = read_forwarded_deep_link(&mut payload.as_slice(), secret).unwrap();
        let authenticated = reqwest::Url::parse(&authenticated).unwrap();
        assert!(matches!(
            crate::deeplink::DeepLinkAction::try_from(&authenticated),
            Ok(crate::deeplink::DeepLinkAction::OpenEditor { project_path })
                if project_path == Path::new("/tmp/Recording With Spaces.cap")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn forwarding_endpoint_is_private_and_never_follows_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = std::env::temp_dir().join(format!(
            "cap-gpui-forwarding-endpoint-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("endpoint.tmp");
        let endpoint = ForwardingEndpoint {
            pid: 4321,
            port: 49152,
            secret: 0x0123_4567_89ab_cdef,
        };

        super::write_forwarding_endpoint(&path, endpoint).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            parse_forwarding_endpoint(&std::fs::read_to_string(&path).unwrap()),
            Some(endpoint)
        );
        assert_eq!(
            super::write_forwarding_endpoint(&path, endpoint)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );

        let protected = root.join("protected");
        std::fs::write(&protected, "unchanged").unwrap();
        let link = root.join("endpoint-link.tmp");
        symlink(&protected, &link).unwrap();
        assert_eq!(
            super::write_forwarding_endpoint(&link, endpoint)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_to_string(&protected).unwrap(), "unchanged");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forwarded_deep_links_require_the_owner_secret_and_bounded_payload() {
        let secret = 0x0123_4567_89ab_cdef_u64;
        let url = "cap-desktop://auth?token=test";
        let mut payload = secret.to_be_bytes().to_vec();
        payload.extend_from_slice(&(url.len() as u32).to_be_bytes());
        payload.extend_from_slice(url.as_bytes());

        assert_eq!(
            read_forwarded_deep_link(&mut payload.as_slice(), secret).unwrap(),
            url
        );
        assert_eq!(
            read_forwarded_deep_link(&mut payload.as_slice(), secret + 1)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );

        let mut oversized = secret.to_be_bytes().to_vec();
        oversized.extend_from_slice(&((MAX_FORWARDED_DEEP_LINK_BYTES + 1) as u32).to_be_bytes());
        assert_eq!(
            read_forwarded_deep_link(&mut oversized.as_slice(), secret)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}
