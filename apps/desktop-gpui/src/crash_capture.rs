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
//!   handler could see).

use std::{
    fs::{File, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// Appended to; read by `cap_utils::log_upload` under the log prefix.
pub const CRASH_FILE: &str = "cap-gpui.log.crashes";
/// Rewritten per session; the previous session's copy is kept beside it.
pub const STDERR_FILE: &str = "cap-gpui.log.stderr";
const PREVIOUS_STDERR_FILE: &str = "cap-gpui.log.stderr-previous";
const SESSION_FILE: &str = "cap-gpui.session";
/// A crash loop must not fill the disk.
const MAX_CRASH_FILE_BYTES: u64 = 512 * 1024;

static CRASH_LOG: OnceLock<File> = OnceLock::new();
static SESSION_MARKER: OnceLock<PathBuf> = OnceLock::new();

/// Call once, right after logging starts and before any other thread work.
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
    let owns_session = report_previous_session(logs_dir);
    install_panic_hook();
    native::install();
    // A second instance hands off and exits; the running one keeps its files.
    if owns_session {
        capture_stderr(logs_dir);
    }
}

/// Clears the session marker; call from the app's quit path.
pub fn mark_clean_exit() {
    if let Some(marker) = SESSION_MARKER.get() {
        let _ = std::fs::remove_file(marker);
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn record(text: &str) {
    if let Some(mut file) = CRASH_LOG.get() {
        let _ = file.write_all(text.as_bytes());
    }
}

/// False when another running Cap owns the session marker.
fn report_previous_session(logs_dir: &Path) -> bool {
    let marker = logs_dir.join(SESSION_FILE);
    let previous = std::fs::read_to_string(&marker).ok();
    match classify_previous(previous.as_deref(), std::process::id(), process_alive) {
        // Another Cap is running and owns the marker: this launch is a second
        // instance about to hand off and exit, and must not overwrite it.
        Previous::Running => return false,
        Previous::Unclean(previous) => {
            tracing::error!(previous = %previous, "the previous Cap session ended without a clean quit");
            record(&format!(
                "{} previous session ended without a clean quit: {previous}\n",
                now()
            ));
        }
        Previous::None => {}
    }
    let contents = format!(
        "pid={} started={} version={}\n",
        std::process::id(),
        now(),
        env!("CARGO_PKG_VERSION")
    );
    if std::fs::write(&marker, contents).is_ok() {
        let _ = SESSION_MARKER.set(marker);
    }
    true
}

#[derive(Debug, PartialEq, Eq)]
enum Previous {
    None,
    Running,
    Unclean(String),
}

fn classify_previous(marker: Option<&str>, own_pid: u32, alive: impl Fn(u32) -> bool) -> Previous {
    let Some(marker) = marker.map(str::trim).filter(|marker| !marker.is_empty()) else {
        return Previous::None;
    };
    let pid = marker
        .split_whitespace()
        .find_map(|field| field.strip_prefix("pid="))
        .and_then(|pid| pid.parse::<u32>().ok());
    match pid {
        Some(pid) if pid != own_pid && alive(pid) => Previous::Running,
        _ => Previous::Unclean(marker.to_string()),
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 checks existence; EPERM still means the process is there.
    unsafe { libc::kill(pid, 0) == 0 || *libc_errno() == libc::EPERM }
}

#[cfg(target_os = "linux")]
unsafe fn libc_errno() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(target_os = "macos")]
unsafe fn libc_errno() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        alive
    }
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
    let Ok(file) = File::create(&path) else {
        return;
    };
    native::redirect_stderr(file);
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

    pub fn redirect_stderr(file: File) {
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
    use super::{Previous, classify_previous};

    #[test]
    fn a_marker_left_behind_is_an_unclean_end_unless_its_process_still_runs() {
        let marker = "pid=41 started=2026-10-25T00:00:00.000Z version=0.6.1";
        assert_eq!(classify_previous(None, 7, |_| false), Previous::None);
        assert_eq!(classify_previous(Some(" \n"), 7, |_| false), Previous::None);
        assert_eq!(
            classify_previous(Some(marker), 7, |_| false),
            Previous::Unclean(marker.into())
        );
        assert_eq!(
            classify_previous(Some(marker), 7, |pid| pid == 41),
            Previous::Running
        );
        // A reused pid that is now this process is still a dead session.
        assert_eq!(
            classify_previous(Some(marker), 41, |_| true),
            Previous::Unclean(marker.into())
        );
        assert_eq!(
            classify_previous(Some("garbage"), 7, |_| true),
            Previous::Unclean("garbage".into())
        );
    }
}

/// Each case runs in a child copy of this test binary, because the handlers
/// are process-wide and the child has to actually die.
#[cfg(test)]
mod process_tests {
    use std::{path::Path, process::Command};

    const CHILD: &str = "CAP_CRASH_CAPTURE_CHILD";
    const LOGS: &str = "CAP_CRASH_CAPTURE_LOGS";

    /// In the child: install the handlers, then die the way `kind` says.
    fn child(kind: &str) -> bool {
        if std::env::var(CHILD).as_deref() != Ok(kind) {
            return false;
        }
        super::install(Path::new(&std::env::var(LOGS).unwrap()));
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
            _ => {}
        }
        true
    }

    struct Died {
        crashes: String,
        stderr: String,
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
