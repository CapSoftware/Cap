//! Leaves evidence for every way this process can end, in files the Feedback
//! page's log upload already carries.
//!
//! 0.6.1 had none of it: the log file goes through a non-blocking queue, so a
//! panic's last lines died with the process, and a fault, an abort or a stack
//! overflow wrote nothing at all. Users saw Cap vanish during an export and
//! their uploaded logs ended mid-operation. This module adds:
//!
//! - a panic hook that writes the message, location, thread and backtrace
//!   straight to [`CRASH_FILE`] before anything else can fail;
//! - fatal signal handlers (Unix) and an unhandled-exception filter plus a
//!   stack-overflow handler (Windows) that append one line with what killed
//!   the process, using only calls that are safe at that point;
//! - stderr redirected into [`STDERR_FILE`] when no terminal is attached, which
//!   is where Rust reports a stack overflow and native libraries complain;
//! - a session marker, so the next launch logs that the previous one ended
//!   without a clean quit (a kill, an out-of-memory kill, or a crash no
//!   handler could see), and whether camera background blur was running when
//!   it did.

use std::{
    fs::{File, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

/// Appended to; read by `cap_utils::log_upload` under the log prefix.
pub const CRASH_FILE: &str = "cap-gpui.log.crashes";
/// Rewritten per session; the previous session's copy is kept beside it.
pub const STDERR_FILE: &str = "cap-gpui.log.stderr";
const PREVIOUS_STDERR_FILE: &str = "cap-gpui.log.stderr-previous";
const SESSION_FILE: &str = "cap-gpui.session";
/// A crash loop must not fill the disk.
const MAX_CRASH_FILE_BYTES: u64 = 512 * 1024;
/// A native library that keeps complaining must not either; the upload only
/// carries the tail.
const MAX_STDERR_FILE_BYTES: u64 = 8 * 1024 * 1024;

static CRASH_LOG: OnceLock<File> = OnceLock::new();
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// How the previous session ended, when it did not quit cleanly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UncleanEnd {
    /// A camera background blur session was alive, or ended within
    /// [`BLUR_DISARM_LINGER`], when the process died.
    pub blur_active: bool,
}

/// Call once, right after logging starts and before any other thread work.
/// The session itself starts in [`begin_session`].
pub fn install(logs_dir: &Path) {
    let _ = std::fs::create_dir_all(logs_dir);
    let crash_path = logs_dir.join(CRASH_FILE);
    if std::fs::metadata(&crash_path).is_ok_and(|metadata| metadata.len() > MAX_CRASH_FILE_BYTES) {
        let _ = std::fs::rename(&crash_path, logs_dir.join(format!("{CRASH_FILE}-previous")));
    }
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&crash_path)
    {
        Ok(file) => {
            let _ = CRASH_LOG.set(file);
        }
        Err(error) => tracing::warn!(%error, "could not open the crash record file"),
    }
    install_panic_hook();
    native::install();
}

/// Call once this process holds the single-instance lock: a second launch
/// hands off and exits before it can touch the running instance's marker or
/// stderr file, so whatever marker is left belongs to a session that is gone.
pub fn begin_session(logs_dir: &Path) -> Option<UncleanEnd> {
    let previous = report_previous_session(logs_dir);
    capture_stderr(logs_dir);
    previous.map(|marker| UncleanEnd {
        blur_active: marker_has_blur(&marker),
    })
}

pub fn mark_clean_exit() {
    if let Some(session) = lock_session().take() {
        let _ = std::fs::remove_file(&session.path);
    }
}

/// How long the marker keeps saying blur is active after the last blur
/// session ends. D3D12, DirectML and driver faults have been seen ending the
/// process tens of seconds after blur teardown, and disarming at once would
/// miss exactly those (the Tauri app's crash sentinel uses the same window).
const BLUR_DISARM_LINGER: Duration = Duration::from_secs(120);

/// Marks a camera background blur session as alive, for
/// `cap_camera_effects::set_blur_session_observer`. Nestable.
pub fn enter_blur_session() {
    if let Some(session) = lock_session().as_mut() {
        session.enter_blur();
    }
}

/// Ends one blur session; the marker disarms once [`BLUR_DISARM_LINGER`]
/// passes with no blur session alive.
pub fn exit_blur_session() {
    let Some(generation) = lock_session().as_mut().and_then(Session::exit_blur) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("cap-blur-disarm".into())
        .spawn(move || {
            std::thread::sleep(BLUR_DISARM_LINGER);
            if let Some(session) = lock_session().as_mut() {
                session.disarm_blur(generation);
            }
        });
}

fn lock_session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Session {
    path: PathBuf,
    header: String,
    blur_depth: u32,
    /// Bumped on every enter and exit, so a scheduled disarm can tell that
    /// blur ran again after it was scheduled.
    blur_generation: u64,
    blur_armed: bool,
}

impl Session {
    fn create(path: PathBuf, header: String) -> Option<Self> {
        let session = Self {
            path,
            header,
            blur_depth: 0,
            blur_generation: 0,
            blur_armed: false,
        };
        session.write().then_some(session)
    }

    fn write(&self) -> bool {
        let blur = if self.blur_armed { " blur=1" } else { "" };
        std::fs::write(&self.path, format!("{}{blur}\n", self.header)).is_ok()
    }

    fn enter_blur(&mut self) {
        self.blur_depth += 1;
        self.blur_generation = self.blur_generation.wrapping_add(1);
        if !self.blur_armed {
            self.blur_armed = true;
            self.write();
        }
    }

    fn exit_blur(&mut self) -> Option<u64> {
        self.blur_depth = self.blur_depth.saturating_sub(1);
        self.blur_generation = self.blur_generation.wrapping_add(1);
        (self.blur_depth == 0 && self.blur_armed).then_some(self.blur_generation)
    }

    fn disarm_blur(&mut self, generation: u64) {
        if self.blur_generation == generation && self.blur_depth == 0 && self.blur_armed {
            self.blur_armed = false;
            self.write();
        }
    }
}

fn marker_has_blur(marker: &str) -> bool {
    marker.split_whitespace().any(|field| field == "blur=1")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn record(text: &str) {
    if let Some(mut file) = CRASH_LOG.get() {
        let _ = file.write_all(text.as_bytes());
    }
}

fn report_previous_session(logs_dir: &Path) -> Option<String> {
    let marker = logs_dir.join(SESSION_FILE);
    let previous = previous_session(std::fs::read_to_string(&marker).ok().as_deref());
    if let Some(previous) = &previous {
        tracing::error!(previous = %previous, "the previous Cap session ended without a clean quit");
        record(&format!(
            "{} previous session ended without a clean quit: {previous}\n",
            now()
        ));
    }
    let header = format!(
        "pid={} started={} version={}",
        std::process::id(),
        now(),
        env!("CARGO_PKG_VERSION")
    );
    *lock_session() = Session::create(marker, header);
    previous
}

/// The marker a session left behind, which only a clean quit removes.
fn previous_session(marker: Option<&str>) -> Option<String> {
    marker
        .map(str::trim)
        .filter(|marker| !marker.is_empty())
        .map(str::to_owned)
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "<unknown>".into());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|message| (*message).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());
        let thread = std::thread::current();
        let thread = thread.name().unwrap_or("<unnamed>").to_owned();
        let backtrace = std::backtrace::Backtrace::force_capture();
        // The file first: the tracing queue may never drain if this panic
        // takes the process down.
        record(&format!(
            "{} panic thread={thread} at {location}: {message}\n{backtrace}\n",
            now()
        ));
        tracing::error!(%thread, %location, %message, "panic");
        previous(info);
    }));
}

/// When nothing reads stderr (launched from a dock, a desktop file or
/// Explorer), send it to a file the log upload includes.
fn capture_stderr(logs_dir: &Path) {
    use std::io::IsTerminal as _;
    if std::io::stderr().is_terminal() {
        return;
    }
    let path = logs_dir.join(STDERR_FILE);
    if path.exists() {
        let _ = std::fs::rename(&path, logs_dir.join(PREVIOUS_STDERR_FILE));
    }
    // Append mode, so writes land at the end again after a trim.
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    native::redirect_stderr(file);
    let _ = std::thread::Builder::new()
        .name("cap-stderr-limit".into())
        .spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                trim_if_over(&path, MAX_STDERR_FILE_BYTES);
            }
        });
}

fn trim_if_over(path: &Path, max: u64) -> bool {
    if !std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > max) {
        return false;
    }
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.set_len(0))
        .is_ok()
}

#[cfg(unix)]
mod native {
    use std::{
        fs::File,
        mem::MaybeUninit,
        os::fd::{AsRawFd as _, IntoRawFd as _},
        sync::atomic::{AtomicI32, Ordering},
    };

    const SIGNALS: [libc::c_int; 6] = [
        libc::SIGSEGV,
        libc::SIGBUS,
        libc::SIGILL,
        libc::SIGFPE,
        libc::SIGABRT,
        libc::SIGTRAP,
    ];

    static CRASH_FD: AtomicI32 = AtomicI32::new(-1);
    static mut PREVIOUS: [MaybeUninit<libc::sigaction>; 6] = [const { MaybeUninit::uninit() }; 6];

    pub fn install() {
        let Some(file) = super::CRASH_LOG.get() else {
            return;
        };
        CRASH_FD.store(file.as_raw_fd(), Ordering::Release);
        for (index, signal) in SIGNALS.into_iter().enumerate() {
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = handler
                    as extern "C" fn(libc::c_int, *mut libc::siginfo_t, *mut libc::c_void)
                    as usize;
                action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
                libc::sigemptyset(&mut action.sa_mask);
                let previous = (&raw mut PREVIOUS[index]).cast::<libc::sigaction>();
                libc::sigaction(signal, &action, previous);
            }
        }
    }

    pub fn redirect_stderr(file: File) {
        let fd = file.into_raw_fd();
        unsafe {
            libc::dup2(fd, libc::STDERR_FILENO);
            libc::close(fd);
        }
    }

    /// Async-signal-safe: fixed buffers and `write(2)` only. Restores the
    /// previous action (Rust's own stack-overflow reporter for SIGSEGV and
    /// SIGBUS) and returns, so the fault repeats into it, or re-raises an
    /// asynchronous signal like SIGABRT.
    extern "C" fn handler(signal: libc::c_int, info: *mut libc::siginfo_t, _: *mut libc::c_void) {
        let mut line = Line::new();
        line.push(b"native crash: signal ");
        line.push_decimal(signal as u64);
        line.push(b" (");
        line.push(name(signal));
        line.push(b") fault address 0x");
        let address = if info.is_null() {
            0
        } else {
            fault_address(info)
        };
        line.push_hex(address);
        line.push(b" pid ");
        line.push_decimal(std::process::id() as u64);
        line.push(b"\n");
        let fd = CRASH_FD.load(Ordering::Acquire);
        if fd >= 0 {
            unsafe { libc::write(fd, line.bytes.as_ptr().cast(), line.len) };
        }
        unsafe {
            libc::write(libc::STDERR_FILENO, line.bytes.as_ptr().cast(), line.len);
            if let Some(index) = SIGNALS.iter().position(|candidate| *candidate == signal) {
                let previous = (&raw const PREVIOUS[index]).cast::<libc::sigaction>();
                libc::sigaction(signal, previous, std::ptr::null_mut());
            }
            if signal == libc::SIGABRT || signal == libc::SIGTRAP {
                libc::raise(signal);
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn fault_address(info: *mut libc::siginfo_t) -> u64 {
        unsafe { (*info).si_addr() as usize as u64 }
    }

    #[cfg(target_os = "macos")]
    fn fault_address(info: *mut libc::siginfo_t) -> u64 {
        unsafe { (*info).si_addr as usize as u64 }
    }

    fn name(signal: libc::c_int) -> &'static [u8] {
        match signal {
            libc::SIGSEGV => b"SIGSEGV",
            libc::SIGBUS => b"SIGBUS",
            libc::SIGILL => b"SIGILL",
            libc::SIGFPE => b"SIGFPE",
            libc::SIGABRT => b"SIGABRT",
            libc::SIGTRAP => b"SIGTRAP",
            _ => b"signal",
        }
    }

    struct Line {
        bytes: [u8; 160],
        len: usize,
    }

    impl Line {
        fn new() -> Self {
            Self {
                bytes: [0; 160],
                len: 0,
            }
        }

        fn push(&mut self, text: &[u8]) {
            let room = self.bytes.len() - self.len;
            let count = text.len().min(room);
            self.bytes[self.len..self.len + count].copy_from_slice(&text[..count]);
            self.len += count;
        }

        fn push_decimal(&mut self, mut value: u64) {
            let mut digits = [0u8; 20];
            let mut count = 0;
            loop {
                digits[count] = b'0' + (value % 10) as u8;
                count += 1;
                value /= 10;
                if value == 0 {
                    break;
                }
            }
            digits[..count].reverse();
            self.push(&digits[..count]);
        }

        fn push_hex(&mut self, value: u64) {
            let mut digits = [0u8; 16];
            for (index, digit) in digits.iter_mut().enumerate() {
                let nibble = ((value >> ((15 - index) * 4)) & 0xF) as u8;
                *digit = if nibble < 10 {
                    b'0' + nibble
                } else {
                    b'a' + nibble - 10
                };
            }
            self.push(&digits);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::Line;

        #[test]
        fn crash_line_formats_without_allocating() {
            let mut line = Line::new();
            line.push(b"signal ");
            line.push_decimal(11);
            line.push(b" at 0x");
            line.push_hex(0xdead_beef);
            assert_eq!(&line.bytes[..line.len], b"signal 11 at 0x00000000deadbeef");
            line.push(&[b'x'; 400]);
            assert_eq!(line.len, line.bytes.len());
        }
    }
}

#[cfg(windows)]
mod native {
    use std::{
        fs::File,
        os::windows::io::{AsRawHandle as _, IntoRawHandle as _},
        sync::atomic::{AtomicPtr, Ordering},
    };
    use windows_sys::Win32::{
        Foundation::{EXCEPTION_STACK_OVERFLOW, HANDLE, HMODULE},
        Storage::FileSystem::WriteFile,
        System::{
            Console::{STD_ERROR_HANDLE, SetStdHandle},
            Diagnostics::Debug::{
                AddVectoredExceptionHandler, EXCEPTION_POINTERS, SetUnhandledExceptionFilter,
            },
            LibraryLoader::{
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, GetModuleFileNameA,
                GetModuleHandleExA,
            },
        },
    };

    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

    static CRASH_HANDLE: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    /// The filter installed before ours, which still gets the exception.
    static PREVIOUS_FILTER: std::sync::OnceLock<
        windows_sys::Win32::System::Diagnostics::Debug::LPTOP_LEVEL_EXCEPTION_FILTER,
    > = std::sync::OnceLock::new();

    pub fn install() {
        let Some(file) = super::CRASH_LOG.get() else {
            return;
        };
        CRASH_HANDLE.store(file.as_raw_handle(), Ordering::Release);
        unsafe {
            let _ = PREVIOUS_FILTER.set(SetUnhandledExceptionFilter(Some(unhandled)));
            // First in line, so the overflow is written before Rust's own
            // handler prints its message and aborts.
            AddVectoredExceptionHandler(1, Some(stack_overflow));
        }
    }

    unsafe extern "C" {
        fn _open_osfhandle(handle: isize, flags: i32) -> i32;
        fn _dup2(from: i32, to: i32) -> i32;
    }

    const O_APPEND: i32 = 0x0008;

    /// Rust and `GetStdHandle` callers follow the standard handle; native
    /// libraries writing `fprintf(stderr, ...)` go through the C runtime's
    /// descriptor 2, which needs its own redirect.
    pub fn redirect_stderr(file: File) {
        if let Ok(crt) = file.try_clone() {
            unsafe {
                let descriptor = _open_osfhandle(crt.into_raw_handle() as isize, O_APPEND);
                if descriptor >= 0 {
                    _dup2(descriptor, 2);
                }
            }
        }
        unsafe {
            SetStdHandle(STD_ERROR_HANDLE, file.into_raw_handle() as HANDLE);
        }
    }

    unsafe extern "system" fn unhandled(pointers: *const EXCEPTION_POINTERS) -> i32 {
        write_exception(b"native crash: unhandled exception 0x", pointers);
        match PREVIOUS_FILTER.get().copied().flatten() {
            Some(previous) => unsafe { previous(pointers) },
            None => EXCEPTION_CONTINUE_SEARCH,
        }
    }

    unsafe extern "system" fn stack_overflow(pointers: *mut EXCEPTION_POINTERS) -> i32 {
        let code = unsafe { pointers.as_ref().and_then(|p| p.ExceptionRecord.as_ref()) }
            .map(|record| record.ExceptionCode);
        if code == Some(EXCEPTION_STACK_OVERFLOW) {
            write_exception(b"native crash: stack overflow 0x", pointers);
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    /// Fixed buffers only; the faulting thread may have almost no stack left.
    fn write_exception(prefix: &[u8], pointers: *const EXCEPTION_POINTERS) {
        fn push(text: &[u8], line: &mut [u8; 400], len: &mut usize) {
            let count = text.len().min(line.len() - *len);
            line[*len..*len + count].copy_from_slice(&text[..count]);
            *len += count;
        }
        let mut line = [0u8; 400];
        let mut len = 0;
        push(prefix, &mut line, &mut len);
        let record = unsafe { pointers.as_ref().and_then(|p| p.ExceptionRecord.as_ref()) };
        let (code, address) = record
            .map(|record| {
                (
                    record.ExceptionCode as u32 as u64,
                    record.ExceptionAddress as usize,
                )
            })
            .unwrap_or((0, 0));
        push(&hex(code, 8)[..8], &mut line, &mut len);
        push(b" at 0x", &mut line, &mut len);
        push(&hex(address as u64, 16)[..16], &mut line, &mut len);
        let mut module: HMODULE = std::ptr::null_mut();
        let found = address != 0
            && unsafe {
                GetModuleHandleExA(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                        | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    address as *const u8,
                    &mut module,
                )
            } != 0;
        if found {
            let mut name = [0u8; 260];
            let name_len =
                unsafe { GetModuleFileNameA(module, name.as_mut_ptr(), name.len() as u32) }
                    as usize;
            let base = name[..name_len]
                .iter()
                .rposition(|byte| *byte == b'\\')
                .map_or(0, |index| index + 1);
            push(b" in ", &mut line, &mut len);
            push(&name[base..name_len], &mut line, &mut len);
            push(b"+0x", &mut line, &mut len);
            push(
                &hex((address - module as usize) as u64, 8)[..8],
                &mut line,
                &mut len,
            );
        }
        push(b"\r\n", &mut line, &mut len);
        let handle = CRASH_HANDLE.load(Ordering::Acquire);
        if !handle.is_null() {
            let mut written = 0u32;
            unsafe {
                WriteFile(
                    handle,
                    line.as_ptr(),
                    len as u32,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
        }
    }

    fn hex(value: u64, width: usize) -> [u8; 16] {
        let mut digits = [b'0'; 16];
        for index in 0..16 {
            let nibble = ((value >> ((15 - index) * 4)) & 0xF) as u8;
            digits[index] = if nibble < 10 {
                b'0' + nibble
            } else {
                b'a' + nibble - 10
            };
        }
        let mut out = [0u8; 16];
        out[..width].copy_from_slice(&digits[16 - width..]);
        out
    }
}

#[cfg(test)]
mod marker_tests {
    use super::{Session, marker_has_blur, previous_session, trim_if_over};
    use std::io::Write as _;

    #[test]
    fn any_marker_left_behind_is_an_unclean_end() {
        let marker = "pid=41 started=2026-10-25T00:00:00.000Z version=0.6.1";
        assert_eq!(previous_session(None), None);
        assert_eq!(previous_session(Some(" \n")), None);
        assert_eq!(previous_session(Some(marker)), Some(marker.into()));
        assert_eq!(
            previous_session(Some(&format!("{marker}\n"))),
            Some(marker.into())
        );
    }

    #[test]
    fn the_marker_says_blur_while_a_session_lives_and_until_the_linger_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::SESSION_FILE);
        let header = "pid=41 started=2026-10-25T00:00:00.000Z version=0.6.1".to_string();
        let mut session = Session::create(path.clone(), header).unwrap();
        let blur = || marker_has_blur(&std::fs::read_to_string(&path).unwrap());
        assert!(!blur());

        // The camera preview and the editor overlap.
        session.enter_blur();
        session.enter_blur();
        assert!(blur());
        assert_eq!(session.exit_blur(), None);
        let generation = session
            .exit_blur()
            .expect("the last session schedules a disarm");
        assert!(blur(), "stays armed through the linger");

        // Blur started again before the disarm ran: the stale disarm does nothing.
        session.enter_blur();
        session.disarm_blur(generation);
        assert!(blur());
        let generation = session.exit_blur().unwrap();
        session.disarm_blur(generation);
        assert!(!blur());
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .starts_with("pid=41 started=")
        );
    }

    #[test]
    fn only_an_armed_marker_reads_as_blur() {
        assert!(marker_has_blur("pid=1 started=x version=0.6.2 blur=1"));
        assert!(!marker_has_blur("pid=1 started=x version=0.6.2"));
        assert!(!marker_has_blur("pid=1 started=x version=0.6.2 blur=10"));
    }

    /// The writer keeps its handle open across a trim and must keep writing
    /// at the new end, not at its old offset.
    #[test]
    fn stderr_trims_once_over_the_limit_and_keeps_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(super::STDERR_FILE);
        let mut writer = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all(&[b'x'; 64]).unwrap();
        assert!(!trim_if_over(&path, 100));
        writer.write_all(&[b'x'; 64]).unwrap();
        assert!(trim_if_over(&path, 100));
        writer.write_all(b"after the trim\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after the trim\n");
    }
}

/// Each case runs in a child copy of this test binary, because the handlers
/// are process-wide and the child has to actually die.
#[cfg(test)]
mod process_tests {
    use std::{path::Path, process::Command};

    const CHILD: &str = "CAP_CRASH_CAPTURE_CHILD";
    const LOGS: &str = "CAP_CRASH_CAPTURE_LOGS";

    fn child(kind: &str) -> bool {
        if std::env::var(CHILD).as_deref() != Ok(kind) {
            return false;
        }
        let logs = std::env::var(LOGS).unwrap();
        super::install(Path::new(&logs));
        super::begin_session(Path::new(&logs));
        match kind {
            "fault" => unsafe { std::ptr::write_volatile(std::ptr::null_mut::<u8>(), 1) },
            "overflow" => {
                #[allow(unconditional_recursion)]
                fn recurse(depth: u64) -> u64 {
                    let frame = [depth; 512];
                    std::hint::black_box(&frame);
                    recurse(depth + 1) + frame[0]
                }
                std::hint::black_box(recurse(0));
            }
            "panic" => panic!("crash capture test panic"),
            "blur-fault" => {
                super::enter_blur_session();
                unsafe { std::ptr::write_volatile(std::ptr::null_mut::<u8>(), 1) }
            }
            "native-stderr" => {
                let line = b"written by native code\n";
                #[cfg(unix)]
                unsafe {
                    libc::write(2, line.as_ptr().cast(), line.len());
                }
                #[cfg(windows)]
                unsafe {
                    unsafe extern "C" {
                        fn _write(descriptor: i32, buffer: *const u8, count: u32) -> i32;
                    }
                    _write(2, line.as_ptr(), line.len() as u32);
                }
                std::process::exit(0);
            }
            _ => {}
        }
        true
    }

    struct Died {
        crashes: String,
        stderr: String,
        captured_stderr: String,
        session: String,
        success: bool,
    }

    fn run(test: &str, kind: &str) -> Died {
        let logs = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([test, "--exact", "--nocapture", "--test-threads=1"])
            .env(CHILD, kind)
            .env(LOGS, logs.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .unwrap();
        let read = |name: &str| std::fs::read_to_string(logs.path().join(name)).unwrap_or_default();
        Died {
            crashes: read(super::CRASH_FILE),
            stderr: read(super::STDERR_FILE) + &String::from_utf8_lossy(&status.stderr),
            captured_stderr: read(super::STDERR_FILE),
            session: read(super::SESSION_FILE),
            success: status.status.success(),
        }
    }

    #[test]
    fn a_memory_fault_is_recorded_and_still_kills_the_process() {
        if child("fault") {
            return;
        }
        let died = run(
            "crash_capture::process_tests::a_memory_fault_is_recorded_and_still_kills_the_process",
            "fault",
        );
        assert!(!died.success);
        #[cfg(unix)]
        assert!(
            died.crashes.contains("SIGSEGV") || died.crashes.contains("SIGBUS"),
            "{}",
            died.crashes
        );
        #[cfg(windows)]
        assert!(
            died.crashes.contains("unhandled exception 0xc0000005"),
            "{}",
            died.crashes
        );
    }

    /// What the next launch reads to keep blur off after a blur crash.
    #[test]
    fn a_crash_during_blur_is_blamed_on_blur_next_launch() {
        if child("blur-fault") {
            return;
        }
        let died = run(
            "crash_capture::process_tests::a_crash_during_blur_is_blamed_on_blur_next_launch",
            "blur-fault",
        );
        assert!(!died.success);
        let marker = super::previous_session(Some(&died.session)).expect("an unclean marker");
        assert!(super::marker_has_blur(&marker), "{marker}");
    }

    /// What a native library prints through the C runtime's stderr.
    #[test]
    fn native_stderr_writes_reach_the_captured_file() {
        if child("native-stderr") {
            return;
        }
        let died = run(
            "crash_capture::process_tests::native_stderr_writes_reach_the_captured_file",
            "native-stderr",
        );
        assert!(died.success);
        assert!(
            died.captured_stderr.contains("written by native code"),
            "{}",
            died.stderr
        );
    }

    /// Rust's own overflow report must survive: the handler chains to it.
    #[test]
    fn a_stack_overflow_is_recorded_and_rust_still_reports_it() {
        if child("overflow") {
            return;
        }
        let died = run(
            "crash_capture::process_tests::a_stack_overflow_is_recorded_and_rust_still_reports_it",
            "overflow",
        );
        assert!(!died.success);
        #[cfg(unix)]
        assert!(
            died.crashes.contains("native crash: signal"),
            "{}",
            died.crashes
        );
        #[cfg(windows)]
        assert!(
            died.crashes.contains("stack overflow 0xc00000fd"),
            "{}",
            died.crashes
        );
        assert!(
            died.stderr.contains("overflowed its stack"),
            "{}",
            died.stderr
        );
    }

    #[test]
    fn a_panic_is_written_before_the_process_ends() {
        if child("panic") {
            return;
        }
        let died = run(
            "crash_capture::process_tests::a_panic_is_written_before_the_process_ends",
            "panic",
        );
        assert!(!died.success);
        assert!(
            died.crashes.contains("crash capture test panic"),
            "{}",
            died.crashes
        );
        assert!(
            died.crashes.contains("crash_capture.rs"),
            "{}",
            died.crashes
        );
    }
}
