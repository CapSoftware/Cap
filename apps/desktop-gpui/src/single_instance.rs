use std::path::{Path, PathBuf};

#[cfg(windows)]
static INSTANCE_MUTEX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
static INSTANCE_LOCK: std::sync::OnceLock<MacInstanceLock> = std::sync::OnceLock::new();

#[cfg(any(windows, target_os = "macos", target_os = "linux", test))]
const MAX_FORWARDED_DEEP_LINK_BYTES: usize = 1024 * 1024;

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ForwardingEndpoint {
    pid: u32,
    port: u16,
    secret: u64,
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum ForwardedRequest {
    DeepLink(String),
    #[cfg(target_os = "macos")]
    Reopen,
}

#[cfg(target_os = "macos")]
const REOPEN_ACK: u8 = 1;

fn pidfile() -> PathBuf {
    crate::store::app_data_dir().join("cap-gpui.pid")
}

pub fn acquire() {
    let path = pidfile();
    #[cfg(target_os = "macos")]
    {
        let lock = match acquire_macos_instance(
            &path,
            std::env::args().skip(1),
            activate_macos_instance,
        ) {
            Ok(Some(lock)) => lock,
            Ok(None) => std::process::exit(0),
            Err(error) => {
                tracing::error!(%error, "Could not acquire the Cap GPUI instance lock");
                std::process::exit(1);
            }
        };
        if INSTANCE_LOCK.set(lock).is_err() {
            tracing::error!("The Cap GPUI instance lock was initialized twice");
            std::process::exit(1);
        }
        if let Err(error) = publish_macos_pidfile(&path) {
            tracing::error!(%error, "Could not publish the Cap GPUI instance pidfile");
            std::process::exit(1);
        }
    }
    #[cfg(windows)]
    acquire_windows_instance(&path);
    #[cfg(target_os = "linux")]
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(pid) = raw.trim().parse::<i32>()
        && pid > 0
        && pid != std::process::id() as i32
        && is_cap_gpui(pid)
    {
        match forward_linux_reopen(&path, pid as u32) {
            Ok(()) => tracing::info!(pid, "Requested the existing Cap GPUI controls"),
            Err(error) => tracing::warn!(
                pid,
                %error,
                "Could not reopen Cap GPUI; the existing instance remains unchanged"
            ),
        }
        std::process::exit(0);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
            tracing::warn!(%error, "could not write the instance pidfile");
        }
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = start_linux_reopen(&path) {
        tracing::error!(%error, "could not start Cap GPUI activation");
        std::process::exit(1);
    }

    #[cfg(target_os = "macos")]
    if let Err(error) = start_deep_link_forwarding(&path) {
        tracing::error!(%error, "could not start Cap GPUI deep-link forwarding");
        std::process::exit(1);
    }
}

/// Linux zombies retain their comm name but lose their exe link.
#[cfg(unix)]
fn is_cap_gpui(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| is_cap_gpui_image(&path))
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;

        let mut buffer = [0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        length > 0
            && buffer
                .split(|byte| *byte == 0)
                .next()
                .is_some_and(|path| is_cap_gpui_image(Path::new(std::ffi::OsStr::from_bytes(path))))
    }
}

fn is_cap_gpui_image(path: &Path) -> bool {
    #[cfg(windows)]
    const IMAGE_NAME: &str = "cap-gpui.exe";
    #[cfg(not(windows))]
    const IMAGE_NAME: &str = "cap-gpui";

    let Some(name) = path.file_name().and_then(std::ffi::OsStr::to_str) else {
        return false;
    };
    #[cfg(target_os = "linux")]
    let name = name.strip_suffix(" (deleted)").unwrap_or(name);
    name.eq_ignore_ascii_case(IMAGE_NAME)
}

#[cfg(target_os = "macos")]
struct MacInstanceLock {
    file: std::fs::File,
    owner_pid: libc::pid_t,
}

#[cfg(target_os = "macos")]
impl MacInstanceLock {
    fn acquire(path: &Path) -> std::io::Result<Option<Self>> {
        use std::os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        };

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::other(
                "The Cap GPUI instance lock is not a private file",
            ));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return if error.kind() == std::io::ErrorKind::WouldBlock {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let current = path.symlink_metadata()?;
        if !current.is_file() || current.dev() != metadata.dev() || current.ino() != metadata.ino()
        {
            return Err(std::io::Error::other("The Cap GPUI instance lock changed"));
        }
        Ok(Some(Self {
            file,
            owner_pid: unsafe { libc::getpid() },
        }))
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacInstanceLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        // A fork child must not unlock its parent's shared file description.
        if self.owner_pid == unsafe { libc::getpid() }
            && unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) } != 0
        {
            tracing::warn!(error = %std::io::Error::last_os_error(), "Could not release the Cap GPUI instance lock");
        }
    }
}

#[cfg(target_os = "macos")]
fn read_macos_instance_file(path: &Path) -> std::io::Result<String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid Cap GPUI instance metadata",
        ));
    }
    let mut bytes = Vec::new();
    file.take(129).read_to_end(&mut bytes)?;
    if bytes.len() > 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Cap GPUI instance metadata changed",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid Cap GPUI instance metadata encoding",
        )
    })
}

#[cfg(target_os = "macos")]
fn macos_instance_pid(path: &Path) -> std::io::Result<Option<u32>> {
    let raw = match read_macos_instance_file(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(raw
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0 && *pid != std::process::id() as i32 && is_cap_gpui(*pid))
        .map(|pid| pid as u32))
}

#[cfg(target_os = "macos")]
fn acquire_macos_instance(
    path: &Path,
    arguments: impl Iterator<Item = String>,
    activate: impl FnOnce(u32),
) -> std::io::Result<Option<MacInstanceLock>> {
    let lock = MacInstanceLock::acquire(&path.with_extension("lock"))?;
    let mut incumbent = macos_instance_pid(path)?;
    if lock.is_none() {
        for _ in 0..40 {
            if incumbent.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            incumbent = macos_instance_pid(path)?;
        }
    }
    if let Some(pid) = incumbent {
        if let Err(error) = forward_macos_deep_links(path, pid, arguments) {
            tracing::warn!(pid, %error, "Could not forward to Cap GPUI; the existing instance remains unchanged");
        }
        if macos_instance_pid(path)? == Some(pid) {
            activate(pid);
        }
        return Ok(None);
    }
    if lock.is_none() {
        tracing::warn!("Cap GPUI is still starting; the existing instance remains unchanged");
    }
    Ok(lock)
}

#[cfg(target_os = "macos")]
fn publish_macos_pidfile(path: &Path) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    let temporary_path = path.with_extension(format!("pid.{}.tmp", crate::store::new_uuid_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary_path)?;
    let result = write!(file, "{}", std::process::id())
        .and_then(|()| std::fs::rename(&temporary_path, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(target_os = "macos")]
fn forward_macos_deep_links(
    path: &Path,
    pid: u32,
    arguments: impl Iterator<Item = String>,
) -> std::io::Result<()> {
    let urls = arguments
        .filter(|argument| is_forwardable_deep_link(argument))
        .take(33)
        .collect::<Vec<_>>();
    if urls.len() > 32 {
        return Err(std::io::Error::other("Too many forwarded Cap deep links"));
    }
    let started = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(2);
    let endpoint = loop {
        if let Some(endpoint) = read_macos_forwarding_endpoint(&path.with_extension("ipc"), pid)? {
            break endpoint;
        }
        let remaining = forwarding_time_remaining(started, timeout)?;
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(50)));
    };
    for url in urls
        .iter()
        .map(|url| Some(url.as_str()))
        .chain(urls.is_empty().then_some(None))
    {
        if macos_instance_pid(path)? != Some(pid) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "The Cap GPUI instance changed before forwarding",
            ));
        }
        send_macos_forwarded_request(endpoint, url, started, timeout)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_macos_forwarding_endpoint(
    path: &Path,
    pid: u32,
) -> std::io::Result<Option<ForwardingEndpoint>> {
    use std::{
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };

    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.len() > 128
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Cap GPUI endpoint is not private owner metadata",
        ));
    }
    let mut contents = String::new();
    file.take(129).read_to_string(&mut contents)?;
    if contents.len() > 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Cap GPUI endpoint changed",
        ));
    }
    Ok(parse_forwarding_endpoint(&contents).filter(|endpoint| endpoint.pid == pid))
}

#[cfg(target_os = "macos")]
fn forwarding_time_remaining(
    started: std::time::Instant,
    timeout: std::time::Duration,
) -> std::io::Result<std::time::Duration> {
    timeout
        .checked_sub(started.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Cap GPUI forwarding timed out",
            )
        })
}

#[cfg(target_os = "macos")]
fn send_macos_forwarded_request(
    endpoint: ForwardingEndpoint,
    url: Option<&str>,
    started: std::time::Instant,
    timeout: std::time::Duration,
) -> std::io::Result<()> {
    use std::io::{Read, Write};

    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = std::net::TcpStream::connect_timeout(
        &address,
        forwarding_time_remaining(started, timeout)?,
    )?;
    stream.set_nonblocking(true)?;
    let bytes = url.unwrap_or_default().as_bytes();
    let mut payload = Vec::with_capacity(12 + bytes.len());
    payload.extend_from_slice(&endpoint.secret.to_be_bytes());
    payload.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(bytes);
    let mut pending = payload.as_slice();
    while !pending.is_empty() {
        let remaining = forwarding_time_remaining(started, timeout)?;
        match stream.write(pending) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "Cap GPUI closed its forwarding connection",
                ));
            }
            Ok(written) => pending = &pending[written..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    if url.is_none() {
        let mut acknowledgment = [0_u8; 1];
        loop {
            let remaining = forwarding_time_remaining(started, timeout)?;
            match stream.read(&mut acknowledgment) {
                Ok(1) if acknowledgment[0] == REOPEN_ACK => break,
                Ok(_) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Cap GPUI did not acknowledge the reopen request",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)))
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn acknowledge_reopen(
    writer: &mut impl std::io::Write,
    enqueue: impl FnOnce() -> bool,
) -> std::io::Result<()> {
    if !enqueue() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "Cap GPUI could not queue the reopen request",
        ));
    }
    writer.write_all(&[REOPEN_ACK])
}

#[cfg(target_os = "macos")]
fn activate_macos_instance(pid: u32) {
    use objc2::{class, msg_send, runtime::AnyObject};

    unsafe {
        let instance: *mut AnyObject = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32];
        if !instance.is_null() {
            let _: bool = msg_send![instance, activateWithOptions: 1_usize << 1];
        }
    }
}

#[cfg(target_os = "linux")]
const LINUX_REOPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(target_os = "linux")]
const MAX_LINUX_REOPEN_ACTIONS: usize = 32;

#[cfg(target_os = "linux")]
type LinuxReopenActions = Vec<crate::deeplink::DeepLinkAction>;

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct LinuxInstanceIdentity {
    pid: u32,
    started: u64,
    boot: [u8; 36],
}

#[cfg(target_os = "linux")]
fn linux_instance_identity(pid: u32) -> std::io::Result<LinuxInstanceIdentity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let fields = stat
        .rsplit_once(") ")
        .map(|(_, fields)| fields.split_whitespace().collect::<Vec<_>>())
        .ok_or_else(|| std::io::Error::other("Invalid instance process identity"))?;
    if fields
        .first()
        .is_none_or(|state| matches!(*state, "Z" | "X"))
    {
        return Err(std::io::Error::other("The instance is no longer running"));
    }
    let started = fields
        .get(19)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| std::io::Error::other("Invalid instance start identity"))?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let boot = boot
        .trim()
        .as_bytes()
        .try_into()
        .map_err(|_| std::io::Error::other("Invalid boot identity"))?;
    Ok(LinuxInstanceIdentity { pid, started, boot })
}

#[cfg(target_os = "linux")]
fn linux_reopen_address(
    path: &Path,
    owner: LinuxInstanceIdentity,
) -> std::io::Result<std::os::unix::net::SocketAddr> {
    use std::{
        hash::{Hash, Hasher},
        os::linux::net::SocketAddrExt,
    };
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("The instance directory is missing"))?
        .canonicalize()?;
    let mut scope = std::collections::hash_map::DefaultHasher::new();
    directory.hash(&mut scope);
    owner.hash(&mut scope);
    for name in [
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_ID",
        "DBUS_SESSION_BUS_ADDRESS",
        "WAYLAND_DISPLAY",
        "DISPLAY",
    ] {
        std::env::var_os(name).hash(&mut scope);
    }
    std::os::unix::net::SocketAddr::from_abstract_name(format!(
        "cap-gpui-reopen-{:016x}",
        scope.finish()
    ))
}

#[cfg(target_os = "linux")]
fn linux_reopen_payload(owner: LinuxInstanceIdentity) -> [u8; 56] {
    let mut bytes = [0; 56];
    bytes[..8].copy_from_slice(b"CAPREOP1");
    bytes[8..12].copy_from_slice(&owner.pid.to_be_bytes());
    bytes[12..20].copy_from_slice(&owner.started.to_be_bytes());
    bytes[20..].copy_from_slice(&owner.boot);
    bytes
}

#[cfg(target_os = "linux")]
fn write_linux_reopen_actions(
    writer: &mut impl std::io::Write,
    owner: LinuxInstanceIdentity,
    actions: &[u8],
) -> std::io::Result<()> {
    if actions.len() > MAX_FORWARDED_DEEP_LINK_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Too many forwarded Cap action bytes",
        ));
    }
    let mut header = linux_reopen_payload(owner);
    if !actions.is_empty() {
        header[..8].copy_from_slice(b"CAPREOP2");
    }
    writer.write_all(&header)?;
    if !actions.is_empty() {
        writer.write_all(&(actions.len() as u32).to_be_bytes())?;
        writer.write_all(actions)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn parse_linux_reopen_action(raw: &str) -> std::io::Result<crate::deeplink::DeepLinkAction> {
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid forwarded Cap action URL",
        )
    };
    if raw.len() > MAX_FORWARDED_DEEP_LINK_BYTES
        || !(raw.starts_with("cap-desktop://") || raw.starts_with("cap://"))
    {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
    crate::deeplink::DeepLinkAction::try_from(&url).map_err(|_| invalid())
}

#[cfg(target_os = "linux")]
fn linux_reopen_action_payload(
    arguments: impl IntoIterator<Item = String>,
) -> std::io::Result<Vec<u8>> {
    let mut payload = Vec::new();
    for (count, argument) in arguments
        .into_iter()
        .filter(|argument| parse_linux_reopen_action(argument).is_ok())
        .enumerate()
    {
        if count == MAX_LINUX_REOPEN_ACTIONS
            || argument.len() > MAX_FORWARDED_DEEP_LINK_BYTES.saturating_sub(payload.len() + 4)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Too many forwarded Cap actions",
            ));
        }
        payload.extend_from_slice(&(argument.len() as u32).to_be_bytes());
        payload.extend_from_slice(argument.as_bytes());
    }
    Ok(payload)
}

#[cfg(target_os = "linux")]
fn read_linux_reopen_actions(
    reader: &mut impl std::io::Read,
    owner: LinuxInstanceIdentity,
) -> std::io::Result<LinuxReopenActions> {
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid forwarded Cap action payload",
        )
    };
    let mut request = [0; 56];
    reader.read_exact(&mut request)?;
    let mut header = linux_reopen_payload(owner);
    if request == header {
        return Ok(Vec::new());
    }
    header[..8].copy_from_slice(b"CAPREOP2");
    if request != header {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The activation request belongs to another instance",
        ));
    }
    let mut size = [0; 4];
    reader.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_FORWARDED_DEEP_LINK_BYTES {
        return Err(invalid());
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    let mut remaining = payload.as_slice();
    let mut actions = Vec::new();
    while !remaining.is_empty() {
        if actions.len() == MAX_LINUX_REOPEN_ACTIONS {
            return Err(invalid());
        }
        let (size, rest) = remaining.split_first_chunk::<4>().ok_or_else(invalid)?;
        let (raw, rest) = rest
            .split_at_checked(u32::from_be_bytes(*size) as usize)
            .ok_or_else(invalid)?;
        let raw = std::str::from_utf8(raw).map_err(|_| invalid())?;
        actions.push(parse_linux_reopen_action(raw)?);
        remaining = rest;
    }
    Ok(actions)
}

#[cfg(target_os = "linux")]
fn linux_peer(stream: &std::os::unix::net::UnixStream) -> std::io::Result<libc::ucred> {
    use std::os::fd::AsRawFd;
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            std::ptr::addr_of_mut!(length),
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<libc::ucred>()
        || credentials.uid != unsafe { libc::geteuid() }
        || credentials.pid <= 0
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The activation peer is not in this user session",
        ));
    }
    Ok(credentials)
}

#[cfg(target_os = "linux")]
fn linux_reopen_channel() -> &'static (
    flume::Sender<LinuxReopenActions>,
    flume::Receiver<LinuxReopenActions>,
) {
    static CHANNEL: std::sync::OnceLock<(
        flume::Sender<LinuxReopenActions>,
        flume::Receiver<LinuxReopenActions>,
    )> = std::sync::OnceLock::new();
    CHANNEL.get_or_init(|| flume::bounded(1))
}

#[cfg(target_os = "linux")]
fn receive_linux_reopen(
    stream: &mut std::os::unix::net::UnixStream,
    owner: LinuxInstanceIdentity,
    requests: &flume::Sender<LinuxReopenActions>,
) -> std::io::Result<()> {
    use std::io::Write;
    stream.set_read_timeout(Some(std::time::Duration::from_millis(250)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_millis(250)))?;
    linux_peer(stream)?;
    let actions = read_linux_reopen_actions(stream, owner)?;
    match requests.try_send(actions) {
        Ok(()) => {}
        Err(flume::TrySendError::Full(actions)) if actions.is_empty() => {}
        Err(flume::TrySendError::Full(actions)) => {
            requests
                .send_timeout(actions, std::time::Duration::from_millis(250))
                .map_err(|_| std::io::Error::other("The activation queue is busy"))?;
        }
        Err(flume::TrySendError::Disconnected(_)) => {
            return Err(std::io::Error::other("The activation handler has closed"));
        }
    }
    stream.write_all(&[1])
}

#[cfg(target_os = "linux")]
fn start_linux_reopen(path: &Path) -> std::io::Result<()> {
    let owner = linux_instance_identity(std::process::id())?;
    let address = linux_reopen_address(path, owner)?;
    let listener = std::os::unix::net::UnixListener::bind_addr(&address)?;
    let requests = linux_reopen_channel().0.clone();
    std::thread::Builder::new()
        .name("cap-gpui-activation".into())
        .spawn(move || {
            for connection in listener.incoming() {
                let result = connection
                    .and_then(|mut stream| receive_linux_reopen(&mut stream, owner, &requests));
                if let Err(error) = result {
                    tracing::warn!(%error, "Rejected a Cap GPUI activation request");
                }
            }
        })?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn send_linux_reopen(
    address: std::os::unix::net::SocketAddr,
    owner: LinuxInstanceIdentity,
    actions: &[u8],
) -> std::io::Result<()> {
    use std::io::Read;
    let started = std::time::Instant::now();
    let mut stream = loop {
        if linux_instance_identity(owner.pid)? != owner {
            return Err(std::io::Error::other("The activation owner changed"));
        }
        match std::os::unix::net::UnixStream::connect_addr(&address) {
            Ok(stream) => break stream,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) && started.elapsed() < std::time::Duration::from_secs(1) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    };
    stream.set_read_timeout(Some(std::time::Duration::from_millis(500)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_millis(500)))?;
    if linux_peer(&stream)?.pid as u32 != owner.pid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "The activation socket belongs to another process",
        ));
    }
    write_linux_reopen_actions(&mut stream, owner, actions)?;
    let mut reply = [0];
    stream.read_exact(&mut reply)?;
    if reply != [1] || linux_instance_identity(owner.pid)? != owner {
        return Err(std::io::Error::other(
            "The activation owner did not acknowledge the request",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn forward_linux_reopen(path: &Path, pid: u32) -> std::io::Result<()> {
    let actions = linux_reopen_action_payload(std::env::args().skip(1))?;
    let owner = linux_instance_identity(pid)?;
    let address = linux_reopen_address(path, owner)?;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("cap-gpui-reopen-request".into())
        .spawn(move || {
            let _ = send.send(send_linux_reopen(address, owner, &actions));
        })?;
    receive.recv_timeout(LINUX_REOPEN_TIMEOUT).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "The activation request timed out",
        )
    })?
}

#[cfg(target_os = "linux")]
fn linux_reopen_allowed(
    phase: crate::session::Phase,
    mode: Option<crate::recording::RecordingMode>,
    cleanup_safe: bool,
) -> bool {
    cleanup_safe
        && (phase == crate::session::Phase::Idle
            || (matches!(phase, crate::session::Phase::Recording { .. })
                && mode == Some(crate::recording::RecordingMode::Studio)))
}

#[cfg(target_os = "linux")]
pub fn init_linux_reopen(cx: &mut gpui::App) {
    let requests = linux_reopen_channel().1.clone();
    cx.spawn(async move |cx| {
        while let Ok(actions) = requests.recv_async().await {
            cx.update(|cx| {
                if !actions.is_empty() {
                    for action in actions {
                        crate::deeplink::submit_action(action);
                    }
                    return;
                }
                let session = crate::session::RecordingSession::global(cx);
                let current = session.read(cx);
                if linux_reopen_allowed(current.phase, current.mode(), current.instant_cleanup_safe()) {
                    crate::app_windows::show_main_window(cx);
                } else {
                    tracing::info!("Cap controls remain hidden while recording is changing state or cannot pause");
                }
            });
        }
    })
    .detach();
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
                        match read_forwarded_request(&mut stream, endpoint.secret) {
                            Ok(ForwardedRequest::DeepLink(url)) => crate::deeplink::submit_deep_link(&url),
                            #[cfg(target_os = "macos")]
                            Ok(ForwardedRequest::Reopen) => {
                                let result = stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))
                                    .and_then(|()| acknowledge_reopen(&mut stream, crate::deeplink::submit_reopen));
                                if let Err(error) = result {
                                    tracing::warn!(%error, "could not acknowledge the Cap GPUI reopen request");
                                }
                            }
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

#[cfg(any(windows, target_os = "macos", test))]
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
fn read_forwarded_request(
    reader: &mut impl std::io::Read,
    expected_secret: u64,
) -> std::io::Result<ForwardedRequest> {
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
    #[cfg(target_os = "macos")]
    if size == 0 {
        return Ok(ForwardedRequest::Reopen);
    }
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

    Ok(ForwardedRequest::DeepLink(url))
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
        ForwardedRequest, ForwardingEndpoint, MAX_FORWARDED_DEEP_LINK_BYTES, is_cap_gpui_image,
        is_forwardable_deep_link, parse_forwarding_endpoint, read_forwarded_request,
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_check_distinguishes_live_unlinked_and_exited_processes() {
        let directory = std::env::temp_dir().join(format!(
            "cap-gpui-process-test-{}",
            crate::store::new_uuid_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        let binary = directory.join("cap-gpui");
        std::fs::copy("/bin/sleep", &binary).unwrap();
        let mut child = std::process::Command::new(&binary)
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let started = std::time::Instant::now();
        // spawn can return before /proc stops exposing the child's pre-exec image.
        while !std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| path == binary)
            && started.elapsed() < std::time::Duration::from_secs(5)
        {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let live = super::is_cap_gpui(pid);
        std::fs::remove_file(&binary).unwrap();
        let unlinked = super::is_cap_gpui(pid);
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
        let exited = super::is_cap_gpui(pid);
        child.wait().unwrap();
        std::fs::remove_dir(directory).unwrap();

        assert!(live);
        assert!(unlinked);
        assert!(zombie);
        assert!(!exited);
        assert!(!super::is_cap_gpui(pid));
        assert!(!super::is_cap_gpui(std::process::id() as i32));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_acquire_child_probe() {
        if std::env::var_os("CAP_GPUI_ACQUIRE_CHILD_PROBE").is_none() {
            return;
        }
        super::acquire();
        let marker = crate::store::app_data_dir().join("acquire-returned");
        std::fs::write(marker, std::process::id().to_string()).unwrap();
    }

    #[cfg(target_os = "linux")]
    pub(super) struct LinuxAcquireFixture {
        directory: std::path::PathBuf,
        pub(super) children: Vec<std::process::Child>,
    }

    #[cfg(target_os = "linux")]
    impl LinuxAcquireFixture {
        pub(super) fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cap-gpui-acquire-test-{}",
                crate::store::new_uuid_v4()
            ));
            std::fs::create_dir(&directory).unwrap();
            Self {
                directory,
                children: Vec::new(),
            }
        }

        pub(super) fn start_incumbent(&mut self) -> u32 {
            let binary = self.directory.join("cap-gpui");
            std::fs::copy("/bin/sleep", &binary).unwrap();
            let child = std::process::Command::new(&binary)
                .arg("30")
                .spawn()
                .unwrap();
            let pid = child.id();
            self.children.push(child);
            let started = std::time::Instant::now();
            while !std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|path| path == binary) {
                assert!(started.elapsed() < std::time::Duration::from_secs(5));
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            pid
        }

        fn launch_again(&mut self) -> u32 {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "single_instance::tests::linux_acquire_child_probe",
                    "--test-threads=1",
                ])
                .env("CAP_GPUI_ACQUIRE_CHILD_PROBE", "1")
                .env("CAP_GPUI_APP_DATA_DIR", &self.directory)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let pid = child.id();
            self.children.push(child);
            let child = self.children.last_mut().unwrap();
            let started = std::time::Instant::now();
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    return pid;
                }
                assert!(started.elapsed() < std::time::Duration::from_secs(5));
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for LinuxAcquireFixture {
        fn drop(&mut self) {
            for child in &mut self.children {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_initial_launch_owns_only_its_pidfile() {
        let mut fixture = LinuxAcquireFixture::new();
        let launched = fixture.launch_again().to_string();
        assert_eq!(
            std::fs::read_to_string(fixture.directory.join("cap-gpui.pid")).unwrap(),
            launched,
        );
        assert_eq!(
            std::fs::read_to_string(fixture.directory.join("acquire-returned")).unwrap(),
            launched,
        );
        let mut entries = std::fs::read_dir(&fixture.directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(entries, ["acquire-returned", "cap-gpui.pid"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_relaunch_preserves_live_and_unlinked_incumbent_pidfile() {
        use std::os::unix::fs::MetadataExt;

        let mut fixture = LinuxAcquireFixture::new();
        let incumbent = fixture.start_incumbent();
        let pidfile = fixture.directory.join("cap-gpui.pid");
        let original = incumbent.to_string();
        std::fs::write(&pidfile, &original).unwrap();
        let before = std::fs::metadata(&pidfile).unwrap();
        for unlinked in [false, true] {
            if unlinked {
                std::fs::remove_file(fixture.directory.join("cap-gpui")).unwrap();
            }
            fixture.launch_again();
            assert!(fixture.children[0].try_wait().unwrap().is_none());
            assert_eq!(std::fs::read_to_string(&pidfile).unwrap(), original);
            let after = std::fs::metadata(&pidfile).unwrap();
            assert_eq!(after.ino(), before.ino());
            assert_eq!(after.mtime(), before.mtime());
            assert_eq!(after.mtime_nsec(), before.mtime_nsec());
            assert_eq!(after.ctime(), before.ctime());
            assert_eq!(after.ctime_nsec(), before.ctime_nsec());
            assert!(!fixture.directory.join("acquire-returned").exists());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_relaunch_after_dead_or_stale_owner_starts_normally() {
        let mut fixture = LinuxAcquireFixture::new();
        let incumbent = fixture.start_incumbent();
        fixture.children[0].kill().unwrap();
        fixture.children[0].wait().unwrap();
        let pidfile = fixture.directory.join("cap-gpui.pid");
        for stale in [
            incumbent.to_string(),
            "not-a-pid".to_string(),
            "0".to_string(),
        ] {
            std::fs::write(&pidfile, stale).unwrap();
            let launched = fixture.launch_again().to_string();
            assert_eq!(std::fs::read_to_string(&pidfile).unwrap(), launched);
            assert_eq!(
                std::fs::read_to_string(fixture.directory.join("acquire-returned")).unwrap(),
                launched
            );
        }
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
        let authenticated = match read_forwarded_request(&mut payload.as_slice(), secret).unwrap() {
            ForwardedRequest::DeepLink(url) => url,
            #[cfg(target_os = "macos")]
            ForwardedRequest::Reopen => panic!("A project action must remain a deep link"),
        };
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
            read_forwarded_request(&mut payload.as_slice(), secret).unwrap(),
            ForwardedRequest::DeepLink(url.to_string())
        );
        assert_eq!(
            read_forwarded_request(&mut payload.as_slice(), secret + 1)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );

        let mut oversized = secret.to_be_bytes().to_vec();
        oversized.extend_from_slice(&((MAX_FORWARDED_DEEP_LINK_BYTES + 1) as u32).to_be_bytes());
        assert_eq!(
            read_forwarded_request(&mut oversized.as_slice(), secret)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        #[cfg(not(target_os = "macos"))]
        {
            let mut empty = secret.to_be_bytes().to_vec();
            empty.extend_from_slice(&0_u32.to_be_bytes());
            assert_eq!(
                read_forwarded_request(&mut empty.as_slice(), secret)
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::InvalidData
            );
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;
    use std::{
        os::{
            fd::AsRawFd,
            unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink},
        },
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct Fixture {
        directory: PathBuf,
        children: Vec<Child>,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "cap-gpui-macos-instance-{}",
                crate::store::new_uuid_v4()
            ));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .unwrap();
            Self {
                directory,
                children: Vec::new(),
            }
        }

        fn pidfile(&self) -> PathBuf {
            self.directory.join("cap-gpui.pid")
        }

        fn incumbent(&mut self) -> u32 {
            let binary = self.directory.join("cap-gpui");
            let source = self.directory.join("incumbent.c");
            let ready = self.directory.join("incumbent.ready");
            std::fs::write(
                &source,
                r#"#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    FILE *ready = fopen(argv[1], "wx");
    if (ready == NULL) return 2;
    if (fputs("ready", ready) == EOF) {
        fclose(ready);
        return 3;
    }
    if (fclose(ready) != 0) return 4;
    return getchar() == EOF ? 0 : 5;
}
"#,
            )
            .unwrap();
            let compiled = Command::new("/usr/bin/cc")
                .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                compiled.status.success(),
                "Could not compile instance fixture: {}",
                String::from_utf8_lossy(&compiled.stderr)
            );
            self.children.push(
                Command::new(binary)
                    .arg(&ready)
                    .stdin(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let child = self.children.last_mut().unwrap();
            let pid = child.id();
            wait_until(|| {
                assert_eq!(child.try_wait().unwrap(), None, "Instance fixture exited");
                std::fs::read(&ready).is_ok_and(|contents| contents == b"ready")
                    && is_cap_gpui(pid as i32)
            });
            pid
        }

        fn contender(&mut self, label: &str) {
            self.children.push(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "single_instance::macos_tests::acquire_child_probe",
                        "--test-threads=1",
                    ])
                    .env("CAP_GPUI_MACOS_INSTANCE_PROBE", &self.directory)
                    .env("CAP_GPUI_MACOS_INSTANCE_LABEL", label)
                    .env("CAP_GPUI_APP_DATA_DIR", &self.directory)
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for child in &mut self.children {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn wait_until(mut ready: impl FnMut() -> bool) {
        let started = Instant::now();
        while !ready() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "Instance fixture timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn identity(path: &Path) -> (u64, u64, Vec<u8>) {
        let metadata = path.symlink_metadata().unwrap();
        (metadata.dev(), metadata.ino(), std::fs::read(path).unwrap())
    }

    #[test]
    fn lock_is_private_exclusive_and_released_without_removing_metadata() {
        let fixture = Fixture::new();
        let path = fixture.pidfile().with_extension("lock");
        let first = MacInstanceLock::acquire(&path).unwrap().unwrap();
        assert_eq!(
            first.file.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        let flags = unsafe { libc::fcntl(first.file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
        assert!(MacInstanceLock::acquire(&path).unwrap().is_none());
        std::fs::write(fixture.pidfile(), "owner-pid").unwrap();
        std::fs::write(fixture.pidfile().with_extension("ipc"), "owner-endpoint").unwrap();
        let before = identity(&path);
        let pid_before = identity(&fixture.pidfile());
        let ipc_before = identity(&fixture.pidfile().with_extension("ipc"));
        let inherited = first.file.try_clone().unwrap();
        drop(first);
        let second = MacInstanceLock::acquire(&path).unwrap().unwrap();
        drop(inherited);
        assert!(MacInstanceLock::acquire(&path).unwrap().is_none());
        drop(second);
        assert_eq!(identity(&path), before);
        assert_eq!(identity(&fixture.pidfile()), pid_before);
        assert_eq!(
            identity(&fixture.pidfile().with_extension("ipc")),
            ipc_before
        );
    }

    #[test]
    fn lock_rejects_symlinks_and_hardlinks_without_touching_target() {
        let fixture = Fixture::new();
        let target = fixture.directory.join("protected");
        std::fs::write(&target, "unchanged").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        let before = identity(&target);
        let path = fixture.pidfile().with_extension("lock");
        symlink(&target, &path).unwrap();
        assert!(MacInstanceLock::acquire(&path).is_err());
        assert_eq!(identity(&target), before);
        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&target, &path).unwrap();
        assert!(MacInstanceLock::acquire(&path).is_err());
        assert_eq!(identity(&target), before);
    }

    #[test]
    fn live_legacy_instance_survives_failed_forwarding_without_metadata_changes() {
        let mut fixture = Fixture::new();
        let pid = fixture.incumbent();
        let path = fixture.pidfile();
        std::fs::write(&path, pid.to_string()).unwrap();
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = ForwardingEndpoint {
            pid,
            port: listener.local_addr().unwrap().port(),
            secret: 123,
        };
        write_forwarding_endpoint(&path.with_extension("ipc"), endpoint).unwrap();
        drop(listener);
        let before = identity(&path);
        let ipc_before = identity(&path.with_extension("ipc"));
        let mut activated = None;
        let result = acquire_macos_instance(
            &path,
            ["cap://action?value=\"stop_recording\"".into()].into_iter(),
            |pid| activated = Some(pid),
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(activated, Some(pid));
        assert!(fixture.children[0].try_wait().unwrap().is_none());
        assert_eq!(identity(&path), before);
        assert_eq!(identity(&path.with_extension("ipc")), ipc_before);
        assert!(
            MacInstanceLock::acquire(&path.with_extension("lock"))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn busy_startup_waits_for_legacy_pid_without_claiming_its_files() {
        let mut fixture = Fixture::new();
        let pid = fixture.incumbent();
        let path = fixture.pidfile();
        let _owner = MacInstanceLock::acquire(&path.with_extension("lock"))
            .unwrap()
            .unwrap();
        let publishing_path = path.clone();
        let publisher = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::write(publishing_path, pid.to_string()).unwrap();
        });
        let mut activated = None;
        let result = acquire_macos_instance(&path, std::iter::empty(), |pid| activated = Some(pid));
        publisher.join().unwrap();
        assert!(result.unwrap().is_none());
        assert_eq!(activated, Some(pid));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), pid.to_string());
        assert!(fixture.children[0].try_wait().unwrap().is_none());
        assert!(
            MacInstanceLock::acquire(&path.with_extension("lock"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unreadable_owner_metadata_never_admits_a_duplicate() {
        let mut fixture = Fixture::new();
        let pid = fixture.incumbent();
        let path = fixture.pidfile();
        let owner = MacInstanceLock::acquire(&path.with_extension("lock"))
            .unwrap()
            .unwrap();
        std::fs::create_dir(&path).unwrap();
        let before = path.symlink_metadata().unwrap().ino();
        assert!(
            acquire_macos_instance(&path, std::iter::empty(), |_| panic!(
                "Unreadable PID must not activate"
            ))
            .is_err()
        );
        assert_eq!(path.symlink_metadata().unwrap().ino(), before);
        assert!(
            MacInstanceLock::acquire(&path.with_extension("lock"))
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, pid.to_string()).unwrap();
        let pid_before = identity(&path);
        let endpoint_path = path.with_extension("ipc");
        std::fs::create_dir(&endpoint_path).unwrap();
        let endpoint_before = endpoint_path.symlink_metadata().unwrap().ino();
        drop(owner);
        let mut activated = None;
        assert!(
            acquire_macos_instance(
                &path,
                ["cap-desktop://auth?token=fixture".into()].into_iter(),
                |pid| activated = Some(pid)
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(activated, Some(pid));
        assert!(fixture.children[0].try_wait().unwrap().is_none());
        assert_eq!(identity(&path), pid_before);
        assert_eq!(
            endpoint_path.symlink_metadata().unwrap().ino(),
            endpoint_before
        );
    }

    #[test]
    fn forwarding_refuses_a_different_pid_and_excessive_arguments() {
        let fixture = Fixture::new();
        let path = fixture.pidfile();
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = ForwardingEndpoint {
            pid: 123,
            port: listener.local_addr().unwrap().port(),
            secret: 456,
        };
        write_forwarding_endpoint(&path.with_extension("ipc"), endpoint).unwrap();
        let before = identity(&path.with_extension("ipc"));
        let url = "cap-desktop://auth?token=fixture".to_string();
        let error = forward_macos_deep_links(&path, 789, [url.clone()].into_iter()).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(forward_macos_deep_links(&path, 123, std::iter::repeat_n(url, 33)).is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert_eq!(identity(&path.with_extension("ipc")), before);
    }

    #[test]
    fn reopen_authentication_precedes_dispatch_and_ack_requires_queue_success() {
        let secret = 123_u64;
        let mut payload = secret.to_be_bytes().to_vec();
        payload.extend_from_slice(&0_u32.to_be_bytes());
        assert_eq!(
            read_forwarded_request(&mut payload.as_slice(), secret).unwrap(),
            ForwardedRequest::Reopen
        );
        assert_eq!(
            read_forwarded_request(&mut payload.as_slice(), secret + 1)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        for length in [0, 7, 8, 11] {
            assert_eq!(
                read_forwarded_request(&mut &payload[..length], secret)
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        }
        let mut reply = Vec::new();
        assert_eq!(
            acknowledge_reopen(&mut reply, || false).unwrap_err().kind(),
            std::io::ErrorKind::BrokenPipe
        );
        assert!(reply.is_empty());
        let (queued, requests) = flume::bounded(1);
        acknowledge_reopen(&mut reply, || queued.send(()).is_ok()).unwrap();
        assert_eq!(requests.try_recv(), Ok(()));
        assert_eq!(reply, [REOPEN_ACK]);
    }

    #[test]
    fn reopen_uses_real_tcp_and_waits_for_queue_acknowledgment() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = ForwardingEndpoint {
            pid: 123,
            port: listener.local_addr().unwrap().port(),
            secret: 456,
        };
        let (queued, requests) = flume::bounded(1);
        let server = std::thread::spawn(move || {
            use std::io::Read;

            for reopen in [true, false] {
                let mut connection = None;
                wait_until(|| match listener.accept() {
                    Ok((stream, _)) => {
                        connection = Some(stream);
                        true
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
                    Err(error) => panic!("Reopen listener failed: {error}"),
                });
                let mut stream = connection.unwrap();
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                if reopen {
                    assert_eq!(
                        read_forwarded_request(&mut stream, endpoint.secret).unwrap(),
                        ForwardedRequest::Reopen
                    );
                    acknowledge_reopen(&mut stream, || queued.send(()).is_ok()).unwrap();
                } else {
                    let url = "cap-desktop://auth?token=fixture";
                    let mut expected = endpoint.secret.to_be_bytes().to_vec();
                    expected.extend_from_slice(&(url.len() as u32).to_be_bytes());
                    expected.extend_from_slice(url.as_bytes());
                    let mut received = Vec::new();
                    stream.read_to_end(&mut received).unwrap();
                    assert_eq!(received, expected);
                }
            }
            listener
        });
        let result =
            send_macos_forwarded_request(endpoint, None, Instant::now(), Duration::from_secs(2));
        let deep_link = send_macos_forwarded_request(
            endpoint,
            Some("cap-desktop://auth?token=fixture"),
            Instant::now(),
            Duration::from_secs(2),
        );
        let listener = server.join().unwrap();
        result.unwrap();
        deep_link.unwrap();
        assert_eq!(requests.try_recv(), Ok(()));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn reopen_without_ack_expires_without_changing_endpoint_metadata() {
        let fixture = Fixture::new();
        let path = fixture.pidfile().with_extension("ipc");
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = ForwardingEndpoint {
            pid: 123,
            port: listener.local_addr().unwrap().port(),
            secret: 456,
        };
        write_forwarding_endpoint(&path, endpoint).unwrap();
        let before = identity(&path);
        let result = send_macos_forwarded_request(
            endpoint,
            None,
            Instant::now(),
            Duration::from_millis(100),
        );
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(identity(&path), before);
        let expired = Instant::now().checked_sub(Duration::from_secs(2)).unwrap();
        assert_eq!(
            send_macos_forwarded_request(endpoint, None, expired, Duration::from_secs(2))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
    }

    #[test]
    fn reopen_endpoint_requires_private_unlinked_owner_file() {
        let fixture = Fixture::new();
        let path = fixture.pidfile().with_extension("ipc");
        let endpoint = ForwardingEndpoint {
            pid: 123,
            port: 456,
            secret: 789,
        };
        write_forwarding_endpoint(&path, endpoint).unwrap();
        let before = identity(&path);
        assert_eq!(
            read_macos_forwarding_endpoint(&path, 123).unwrap(),
            Some(endpoint)
        );
        assert_eq!(read_macos_forwarding_endpoint(&path, 321).unwrap(), None);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            read_macos_forwarding_endpoint(&path, 123)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let linked = fixture.directory.join("linked.ipc");
        symlink(&path, &linked).unwrap();
        assert!(read_macos_forwarding_endpoint(&linked, 123).is_err());
        std::fs::remove_file(&linked).unwrap();
        std::fs::hard_link(&path, &linked).unwrap();
        assert!(read_macos_forwarding_endpoint(&path, 123).is_err());
        assert_eq!(identity(&path), before);
    }

    #[test]
    fn duplicate_forwards_auth_and_actions_with_the_existing_protocol() {
        let mut fixture = Fixture::new();
        let pid = fixture.incumbent();
        let path = fixture.pidfile();
        std::fs::write(&path, pid.to_string()).unwrap();
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = ForwardingEndpoint {
            pid,
            port: listener.local_addr().unwrap().port(),
            secret: 123,
        };
        write_forwarding_endpoint(&path.with_extension("ipc"), endpoint).unwrap();
        let before = identity(&path.with_extension("ipc"));
        let receiver = std::thread::spawn(move || {
            let mut urls = Vec::new();
            wait_until(|| {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let ForwardedRequest::DeepLink(url) =
                            read_forwarded_request(&mut stream, endpoint.secret).unwrap()
                        else {
                            panic!("Forwarded URLs must not request reopening");
                        };
                        urls.push(url);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => panic!("Forwarding listener failed: {error}"),
                }
                urls.len() == 2
            });
            urls
        });
        let urls = [
            "cap-desktop://auth?token=fixture".to_string(),
            "cap://action?value=\"stop_recording\"".to_string(),
        ];
        let mut activated = None;
        let result = acquire_macos_instance(
            &path,
            std::iter::once("https://example.invalid".into()).chain(urls.clone()),
            |pid| activated = Some(pid),
        );
        let forwarded = receiver.join().unwrap();
        assert!(result.unwrap().is_none());
        assert_eq!(forwarded, urls);
        assert_eq!(activated, Some(pid));
        assert_eq!(identity(&path.with_extension("ipc")), before);
        assert!(fixture.children[0].try_wait().unwrap().is_none());
    }

    #[test]
    fn stale_owner_can_be_replaced_without_following_pidfile_symlink() {
        let fixture = Fixture::new();
        let path = fixture.pidfile();
        let target = fixture.directory.join("stale-pid");
        std::fs::write(&target, "not-a-pid").unwrap();
        let before = identity(&target);
        symlink(&target, &path).unwrap();
        let _owner = acquire_macos_instance(&path, std::iter::empty(), |_| {
            panic!("No incumbent should activate")
        })
        .unwrap()
        .unwrap();
        publish_macos_pidfile(&path).unwrap();
        assert!(!path.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            std::process::id().to_string()
        );
        assert_eq!(identity(&target), before);
    }

    #[test]
    fn oversized_and_fifo_metadata_fail_without_blocking_startup() {
        use std::os::unix::ffi::OsStrExt;

        let mut fixture = Fixture::new();
        let path = fixture.pidfile();
        std::fs::write(&path, [b'1'; 129]).unwrap();
        let before = identity(&path);
        assert!(
            acquire_macos_instance(&path, std::iter::empty(), |_| panic!(
                "Invalid metadata must not activate"
            ))
            .is_err()
        );
        assert_eq!(identity(&path), before);
        std::fs::remove_file(&path).unwrap();
        let fifo = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        fixture.contender("metadata");
        wait_until(|| fixture.children[0].try_wait().unwrap().is_some());
        assert!(fixture.children[0].wait().unwrap().success());
    }

    #[test]
    fn acquire_child_probe() {
        let Some(directory) = std::env::var_os("CAP_GPUI_MACOS_INSTANCE_PROBE").map(PathBuf::from)
        else {
            return;
        };
        let label = std::env::var("CAP_GPUI_MACOS_INSTANCE_LABEL").unwrap();
        assert!(matches!(label.as_str(), "a" | "b" | "metadata"));
        if label == "metadata" {
            assert!(read_macos_instance_file(&directory.join("cap-gpui.pid")).is_err());
            return;
        }
        std::fs::write(directory.join(format!("ready-{label}")), "ready").unwrap();
        wait_until(|| directory.join("go").exists());
        let path = directory.join("cap-gpui.pid");
        let owner = acquire_macos_instance(&path, std::iter::empty(), |_| {}).unwrap();
        if owner.is_some() {
            publish_macos_pidfile(&path).unwrap();
            start_deep_link_forwarding(&path).unwrap();
            std::fs::write(
                directory.join(format!("owner-{label}")),
                std::process::id().to_string(),
            )
            .unwrap();
            wait_until(|| directory.join("release").exists());
        } else {
            std::fs::write(
                directory.join(format!("duplicate-{label}")),
                std::process::id().to_string(),
            )
            .unwrap();
        }
    }

    #[test]
    fn concurrent_processes_publish_exactly_one_owner_and_preserve_its_metadata_on_exit() {
        let mut fixture = Fixture::new();
        fixture.contender("a");
        fixture.contender("b");
        wait_until(|| {
            ["a", "b"]
                .iter()
                .all(|label| fixture.directory.join(format!("ready-{label}")).exists())
        });
        std::fs::write(fixture.directory.join("go"), "go").unwrap();
        wait_until(|| {
            ["owner", "duplicate"].iter().all(|role| {
                ["a", "b"]
                    .iter()
                    .any(|label| fixture.directory.join(format!("{role}-{label}")).exists())
            })
        });
        let owners = ["a", "b"]
            .into_iter()
            .filter(|label| fixture.directory.join(format!("owner-{label}")).exists())
            .collect::<Vec<_>>();
        assert_eq!(owners.len(), 1);
        let owner = std::fs::read_to_string(fixture.directory.join(format!("owner-{}", owners[0])))
            .unwrap();
        let path = fixture.pidfile();
        let pid_before = identity(&path);
        let ipc_before = identity(&path.with_extension("ipc"));
        let lock_before = identity(&path.with_extension("lock"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), owner);
        assert_eq!(
            parse_forwarding_endpoint(
                &std::fs::read_to_string(path.with_extension("ipc")).unwrap()
            )
            .unwrap()
            .pid
            .to_string(),
            owner
        );
        assert!(
            MacInstanceLock::acquire(&path.with_extension("lock"))
                .unwrap()
                .is_none()
        );
        std::fs::write(fixture.directory.join("release"), "release").unwrap();
        for child in &mut fixture.children {
            wait_until(|| child.try_wait().unwrap().is_some());
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(identity(&path), pid_before);
        assert_eq!(identity(&path.with_extension("ipc")), ipc_before);
        assert_eq!(identity(&path.with_extension("lock")), lock_before);
        let _replacement = acquire_macos_instance(&path, std::iter::empty(), |_| {
            panic!("Exited instance must not activate")
        })
        .unwrap()
        .unwrap();
        publish_macos_pidfile(&path).unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            std::process::id().to_string()
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_reopen_tests {
    use super::*;
    use crate::deeplink::DeepLinkAction;
    use std::io::{Read, Write};
    use std::os::{
        linux::net::SocketAddrExt,
        unix::net::{UnixListener, UnixStream},
    };

    fn packet(owner: LinuxInstanceIdentity, payload: &[u8]) -> Vec<u8> {
        let mut packet = Vec::new();
        write_linux_reopen_actions(&mut packet, owner, payload).unwrap();
        packet
    }

    fn action_url(action: &DeepLinkAction) -> String {
        reqwest::Url::parse_with_params(
            "cap-desktop://action",
            &[("value", serde_json::to_string(action).unwrap())],
        )
        .unwrap()
        .to_string()
    }

    fn raw_action_payload(raw: &[u8]) -> Vec<u8> {
        let mut payload = (raw.len() as u32).to_be_bytes().to_vec();
        payload.extend_from_slice(raw);
        payload
    }

    #[test]
    fn duplicate_launch_during_startup_is_authenticated_and_coalesced() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let (requests, received) = flume::bounded(1);
        for _ in 0..3 {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client.write_all(&packet(owner, &[])).unwrap();
            receive_linux_reopen(&mut server, owner, &requests).unwrap();
            let mut reply = [0];
            client.read_exact(&mut reply).unwrap();
            assert_eq!(reply, [1]);
        }
        assert_eq!(received.len(), 1);
        assert!(received.recv().unwrap().is_empty());
    }

    #[test]
    fn plain_relaunch_keeps_its_legacy_frame_and_actions_require_the_new_version() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let plain = packet(owner, &[]);
        assert_eq!(plain, linux_reopen_payload(owner));
        assert!(
            read_linux_reopen_actions(&mut plain.as_slice(), owner)
                .unwrap()
                .is_empty()
        );
        let payload =
            linux_reopen_action_payload([action_url(&DeepLinkAction::StopRecording)]).unwrap();
        let mut framed = packet(owner, &payload);
        assert_eq!(&framed[..8], b"CAPREOP2");
        framed[..8].copy_from_slice(b"CAPREOP3");
        assert_eq!(
            read_linux_reopen_actions(&mut framed.as_slice(), owner)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn client_requires_the_current_owner_acknowledgement() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let address = std::os::unix::net::SocketAddr::from_abstract_name(format!(
            "cap-gpui-owner-ack-{}",
            crate::store::new_uuid_v4()
        ))
        .unwrap();
        let listener = UnixListener::bind_addr(&address).unwrap();
        let (requests, received) = flume::bounded(1);
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            receive_linux_reopen(&mut stream, owner, &requests)
        });
        send_linux_reopen(address, owner, &[]).unwrap();
        worker.join().unwrap().unwrap();
        assert!(received.recv().unwrap().is_empty());
    }

    #[test]
    fn editor_and_settings_actions_remain_ordered_until_initialization() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let expected = vec![
            DeepLinkAction::OpenEditor {
                project_path: "/tmp/recording.cap".into(),
            },
            DeepLinkAction::OpenSettings {
                page: Some("general".into()),
            },
        ];
        let payload = linux_reopen_action_payload(expected.iter().map(action_url)).unwrap();
        let (requests, received) = flume::bounded(1);
        let (mut server, mut client) = UnixStream::pair().unwrap();
        client.write_all(&packet(owner, &payload)).unwrap();
        receive_linux_reopen(&mut server, owner, &requests).unwrap();
        let mut reply = [0];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(reply, [1]);
        assert_eq!(received.len(), 1);
        assert_eq!(received.recv().unwrap(), expected);
    }

    #[test]
    fn action_queue_saturation_never_acknowledges_dropped_actions() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let payload =
            linux_reopen_action_payload([action_url(&DeepLinkAction::StopRecording)]).unwrap();
        let (requests, received) = flume::bounded(1);
        requests.send(Vec::new()).unwrap();
        let (mut server, mut client) = UnixStream::pair().unwrap();
        client.write_all(&packet(owner, &payload)).unwrap();
        assert!(receive_linux_reopen(&mut server, owner, &requests).is_err());
        drop(server);
        let mut reply = [0];
        assert!(client.read_exact(&mut reply).is_err());
        assert!(received.recv().unwrap().is_empty());
        assert!(received.is_empty());
    }

    #[test]
    fn action_payload_bounds_apply_before_reading_or_accumulating_more_urls() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let url = action_url(&DeepLinkAction::OpenSettings { page: None });
        let payload =
            linux_reopen_action_payload(vec![url.clone(); MAX_LINUX_REOPEN_ACTIONS]).unwrap();
        assert_eq!(
            read_linux_reopen_actions(&mut packet(owner, &payload).as_slice(), owner)
                .unwrap()
                .len(),
            MAX_LINUX_REOPEN_ACTIONS
        );
        assert!(
            linux_reopen_action_payload(vec![url.clone(); MAX_LINUX_REOPEN_ACTIONS + 1]).is_err()
        );
        let payload = raw_action_payload(url.as_bytes()).repeat(MAX_LINUX_REOPEN_ACTIONS + 1);
        assert!(read_linux_reopen_actions(&mut packet(owner, &payload).as_slice(), owner).is_err());
        let mut oversized = linux_reopen_payload(owner).to_vec();
        oversized[..8].copy_from_slice(b"CAPREOP2");
        oversized.extend_from_slice(&((MAX_FORWARDED_DEEP_LINK_BYTES + 1) as u32).to_be_bytes());
        let mut oversized = std::io::Cursor::new(oversized);
        assert_eq!(
            read_linux_reopen_actions(&mut oversized, owner)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
        assert_eq!(oversized.position(), 60);
        let mut written = Vec::new();
        assert!(
            write_linux_reopen_actions(
                &mut written,
                owner,
                &vec![0; MAX_FORWARDED_DEEP_LINK_BYTES + 1],
            )
            .is_err()
        );
        assert!(written.is_empty());
        let oversized = format!(
            "cap://action?value={}",
            "x".repeat(MAX_FORWARDED_DEEP_LINK_BYTES)
        );
        assert!(linux_reopen_action_payload([oversized]).unwrap().is_empty());
        let large = action_url(&DeepLinkAction::OpenSettings {
            page: Some("x".repeat(MAX_FORWARDED_DEEP_LINK_BYTES / 2)),
        });
        assert!(linux_reopen_action_payload([large.clone(), large]).is_err());
    }

    #[test]
    fn malformed_action_packets_never_reach_the_app_or_expose_the_url() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let (requests, received) = flume::bounded(1);
        for raw in [
            b"".as_slice(),
            b"not a URL",
            b"https://action?value=%22stop_recording%22",
            b"cap://auth?token=private-secret",
            b"cap://action?value=private-secret",
            b"cap://action?value=%22private-secret%22",
            b"cap://action?value=%FF\xff",
        ] {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client
                .write_all(&packet(owner, &raw_action_payload(raw)))
                .unwrap();
            let error = receive_linux_reopen(&mut server, owner, &requests).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert!(!error.to_string().contains("private-secret"));
            assert!(received.is_empty());
        }
    }

    #[test]
    fn argv_filter_preserves_supported_schemes_and_excludes_invalid_actions() {
        assert!(
            linux_reopen_action_payload(["--foreground".into()])
                .unwrap()
                .is_empty()
        );
        for scheme in ["cap", "cap-desktop"] {
            let raw = format!("{scheme}://action?value=%22stop_recording%22");
            assert_eq!(
                parse_linux_reopen_action(&raw).unwrap(),
                DeepLinkAction::StopRecording
            );
            assert!(!linux_reopen_action_payload([raw]).unwrap().is_empty());
        }
        for raw in [
            "cap://auth?token=private-secret",
            "cap://action?value=private-secret",
        ] {
            assert!(
                linux_reopen_action_payload([raw.into()])
                    .unwrap()
                    .is_empty()
            );
        }
        let valid = action_url(&DeepLinkAction::OpenSettings { page: None });
        let mixed = linux_reopen_action_payload([
            "cap://action?value=private-secret".into(),
            valid.clone(),
        ])
        .unwrap();
        assert_eq!(mixed, linux_reopen_action_payload([valid]).unwrap());
    }

    #[test]
    fn truncated_action_packets_never_reach_the_app() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let (requests, received) = flume::bounded(1);
        let payload =
            linux_reopen_action_payload([action_url(&DeepLinkAction::StopRecording)]).unwrap();
        let complete = packet(owner, &payload);
        for size in [56, 58, complete.len() - 1] {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client.write_all(&complete[..size]).unwrap();
            client.shutdown(std::net::Shutdown::Write).unwrap();
            assert!(receive_linux_reopen(&mut server, owner, &requests).is_err());
            assert!(received.is_empty());
        }
        for malformed in [vec![0; 3], 10_u32.to_be_bytes().to_vec()] {
            assert!(
                read_linux_reopen_actions(&mut packet(owner, &malformed).as_slice(), owner)
                    .is_err()
            );
        }
    }

    #[test]
    fn stale_pid_start_and_boot_requests_never_reach_the_app() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let mut stale_pid = owner;
        stale_pid.pid = stale_pid.pid.wrapping_add(1);
        let mut stale_start = owner;
        stale_start.started = stale_start.started.wrapping_add(1);
        let mut stale_boot = owner;
        stale_boot.boot[0] ^= 1;
        let payload =
            linux_reopen_action_payload([action_url(&DeepLinkAction::StopRecording)]).unwrap();
        let (requests, received) = flume::bounded(1);
        for stale in [stale_pid, stale_start, stale_boot] {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client.write_all(&packet(stale, &payload)).unwrap();
            let error = receive_linux_reopen(&mut server, owner, &requests).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
            assert!(received.is_empty());
        }
    }

    #[test]
    fn truncated_request_never_reaches_the_app() {
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let (requests, received) = flume::bounded(1);
        let (mut server, mut client) = UnixStream::pair().unwrap();
        client
            .write_all(&linux_reopen_payload(owner)[..55])
            .unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        assert!(receive_linux_reopen(&mut server, owner, &requests).is_err());
        assert!(received.is_empty());
    }

    #[test]
    fn kernel_credentials_identify_the_actual_peer() {
        let (server, _client) = UnixStream::pair().unwrap();
        let peer = linux_peer(&server).unwrap();
        assert_eq!(peer.pid as u32, std::process::id());
        assert_eq!(peer.uid, unsafe { libc::geteuid() });
    }

    #[test]
    fn client_refuses_a_socket_served_by_another_process() {
        let mut fixture = super::tests::LinuxAcquireFixture::new();
        let pid = fixture.start_incumbent();
        let owner = linux_instance_identity(pid).unwrap();
        let address = std::os::unix::net::SocketAddr::from_abstract_name(format!(
            "cap-gpui-wrong-peer-{}",
            crate::store::new_uuid_v4()
        ))
        .unwrap();
        let _listener = UnixListener::bind_addr(&address).unwrap();
        let error = send_linux_reopen(address, owner, &[]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(fixture.children[0].try_wait().unwrap().is_none());
    }

    #[test]
    fn long_instance_directories_use_no_filesystem_socket() {
        let directory = std::env::temp_dir()
            .join(format!(
                "cap-gpui-reopen-scope-{}",
                crate::store::new_uuid_v4()
            ))
            .join("a".repeat(150));
        std::fs::create_dir_all(&directory).unwrap();
        let owner = linux_instance_identity(std::process::id()).unwrap();
        let address = linux_reopen_address(&directory.join("cap-gpui.pid"), owner).unwrap();
        assert!(address.as_pathname().is_none());
        assert!(address.as_abstract_name().unwrap().len() < 107);
        assert!(std::fs::read_dir(&directory).unwrap().next().is_none());
        std::fs::remove_dir(&directory).unwrap();
        std::fs::remove_dir(directory.parent().unwrap()).unwrap();
    }

    #[test]
    fn reopen_never_finalizes_instant_or_an_unconfirmed_transition() {
        use crate::{recording::RecordingMode, session::Phase};
        for phase in [
            Phase::Idle,
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            for mode in [
                None,
                Some(RecordingMode::Studio),
                Some(RecordingMode::Instant),
            ] {
                assert!(!linux_reopen_allowed(phase, mode, false));
                let expected = phase == Phase::Idle
                    || (matches!(phase, Phase::Recording { .. })
                        && mode == Some(RecordingMode::Studio));
                assert_eq!(linux_reopen_allowed(phase, mode, true), expected);
            }
        }
    }
}
