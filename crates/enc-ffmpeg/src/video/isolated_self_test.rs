//! Intel's Media Foundation H264 encoder (`mfx_mft_h264ve_64.dll`) faults with
//! an access violation on some frame sizes instead of returning an error
//! (#4016 on export, #3928 on recording start). FFmpeg loads it into the
//! process that opens the encoder, so the pre-flight self-test used to take
//! the whole app down before any fallback could run. On Windows the self-test
//! for the encoders that load Intel's driver code runs in a child copy of the
//! host executable instead: a fault ends only the child, the parent reads that
//! as a failed self-test and encoder selection moves to the next candidate.

use std::{
    ffi::OsString,
    io::Read,
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

use cap_media_info::VideoInfo;
use ffmpeg::{Dictionary, codec::encoder, format};
use serde::{Deserialize, Serialize};

const REQUEST_ENV: &str = "CAP_H264_SELF_TEST_REQUEST";
/// Debug builds only: makes every hardware self-test, isolated or not, fault
/// the way the Intel encoder does, so tests can prove a fault no longer takes
/// the recording or export down.
#[cfg(debug_assertions)]
const FAULT_ENV: &str = "CAP_H264_SELF_TEST_FAULT";
const VERDICT_PREFIX: &str = "cap-h264-self-test:";
const FAIL_EXIT_CODE: i32 = 3;
const CHILD_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub codec: String,
    pub options: Vec<(String, String)>,
    pub pixel_format: String,
    pub width: u32,
    pub height: u32,
    pub time_base: (i32, i32),
    pub frame_rate: (i32, i32),
    pub output_width: u32,
    pub output_height: u32,
    pub bpp: f32,
    pub crf: Option<u8>,
}

impl Request {
    pub(crate) fn new(
        codec: &str,
        options: &Dictionary<'static>,
        input_config: &VideoInfo,
        output_width: u32,
        output_height: u32,
        bpp: f32,
        crf: Option<u8>,
    ) -> Self {
        Self {
            codec: codec.to_owned(),
            options: options
                .iter()
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect(),
            pixel_format: input_config.pixel_format.name().to_owned(),
            width: input_config.width,
            height: input_config.height,
            time_base: (input_config.time_base.0, input_config.time_base.1),
            frame_rate: (input_config.frame_rate.0, input_config.frame_rate.1),
            output_width,
            output_height,
            bpp,
            crf,
        }
    }
}

struct Host {
    program: PathBuf,
    args: Vec<OsString>,
}

static HOST: OnceLock<Host> = OnceLock::new();

/// Call first in `main` of every executable that records or exports. In a
/// self-test child this runs the test and exits; otherwise it registers the
/// executable as the host the self-test children are started from.
pub fn run_child_or_register_host() {
    run_child_if_requested();
    if let Ok(program) = std::env::current_exe() {
        register_host(program, Vec::new());
    }
}

/// For executables whose `main` is not their own (test harnesses): `args`
/// must reach code that calls [`run_child_if_requested`] first.
pub fn register_host(program: PathBuf, args: Vec<OsString>) {
    let _ = HOST.set(Host { program, args });
}

/// Runs the requested self-test and exits when this process is a self-test
/// child; returns immediately otherwise.
pub fn run_child_if_requested() {
    let Some(raw) = std::env::var_os(REQUEST_ENV) else {
        return;
    };
    #[cfg(windows)]
    suppress_crash_dialogs();

    let verdict = serve(&raw.to_string_lossy());
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let code = match verdict {
        Ok(()) => {
            let _ = writeln!(stdout, "{VERDICT_PREFIX}ok");
            0
        }
        Err(reason) => {
            let reason = reason.replace(['\r', '\n'], " ");
            let _ = writeln!(stdout, "{VERDICT_PREFIX}fail {reason}");
            FAIL_EXIT_CODE
        }
    };
    let _ = stdout.flush();
    std::process::exit(code);
}

/// A crashing child must not raise Windows Error Reporting's "Cap stopped
/// working" dialog: the parent already handles the failure.
#[cfg(windows)]
fn suppress_crash_dialogs() {
    use windows::Win32::System::Diagnostics::Debug::{
        SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
    };
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
}

fn serve(raw: &str) -> Result<(), String> {
    let request: Request =
        serde_json::from_str(raw).map_err(|e| format!("unreadable self-test request: {e}"))?;
    ffmpeg::init().map_err(|e| format!("ffmpeg init: {e}"))?;

    let codec = encoder::find_by_name(&request.codec)
        .ok_or_else(|| format!("encoder {} not found", request.codec))?;
    let mut options = Dictionary::new();
    for (k, v) in &request.options {
        options.set(k, v);
    }
    let pixel_format: format::Pixel = request
        .pixel_format
        .parse()
        .map_err(|_| format!("unknown pixel format {}", request.pixel_format))?;
    let input_config = VideoInfo {
        pixel_format,
        width: request.width,
        height: request.height,
        time_base: ffmpeg::Rational(request.time_base.0, request.time_base.1),
        frame_rate: ffmpeg::Rational(request.frame_rate.0, request.frame_rate.1),
    };
    super::h264::hardware_encoder_self_test(
        codec,
        options,
        &input_config,
        request.output_width,
        request.output_height,
        request.bpp,
        request.crf,
    )
}

#[cfg(debug_assertions)]
pub(crate) fn inject_fault() -> Result<(), String> {
    match std::env::var(FAULT_ENV).as_deref() {
        Ok("access_violation") => unsafe {
            std::ptr::without_provenance_mut::<u8>(0x10).write_volatile(1);
            unreachable!()
        },
        Ok("abort") => std::process::abort(),
        Ok("hang") => loop {
            std::thread::sleep(Duration::from_secs(60));
        },
        Ok("fail") => Err("injected self-test failure".to_string()),
        _ => Ok(()),
    }
}

/// Runs the self-test in a child process. `None` when this executable never
/// registered as a host, so the caller tests in process as before.
pub(crate) fn run(request: &Request) -> Option<Result<(), String>> {
    let host = HOST.get()?;
    Some(run_with(host, request, CHILD_TIMEOUT, &[]))
}

fn run_with(
    host: &Host,
    request: &Request,
    timeout: Duration,
    extra_env: &[(&str, &str)],
) -> Result<(), String> {
    let payload =
        serde_json::to_string(request).map_err(|e| format!("encode self-test request: {e}"))?;
    let mut command = Command::new(&host.program);
    command
        .args(&host.args)
        .env(REQUEST_ENV, payload)
        .envs(extra_env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("start self-test process: {e}"))?;

    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stdout) = stdout.as_mut() {
            let _ = stdout.read_to_string(&mut text);
        }
        text
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait for self-test process: {e}"));
            }
        }
    };
    let output = reader.join().unwrap_or_default();
    match status {
        Some(status) => verdict(status, &output),
        None => Err(format!(
            "self-test process did not finish within {} s",
            timeout.as_secs()
        )),
    }
}

fn verdict(status: ExitStatus, output: &str) -> Result<(), String> {
    let line = output
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix(VERDICT_PREFIX));
    match (status.code(), line) {
        (Some(0), Some("ok")) => Ok(()),
        (Some(FAIL_EXIT_CODE), Some(line)) => {
            Err(line.strip_prefix("fail ").unwrap_or(line).trim().to_owned())
        }
        (code, _) => Err(format!(
            "encoder crashed its isolated self-test process ({})",
            describe_exit(status, code)
        )),
    }
}

fn describe_exit(status: ExitStatus, code: Option<i32>) -> String {
    match code {
        Some(code) if cfg!(windows) => format!("exit code {:#010x}", code as u32),
        Some(code) => format!("exit code {code}"),
        None => status.to_string(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CHILD_ENTRY: &str = "video::isolated_self_test::tests::self_test_child_entry";

    /// The entry a self-test child of this test binary runs; without the
    /// request variable it is a no-op.
    #[test]
    fn self_test_child_entry() {
        run_child_if_requested();
    }

    fn test_host() -> Host {
        Host {
            program: std::env::current_exe().unwrap(),
            args: vec![
                CHILD_ENTRY.into(),
                "--exact".into(),
                "--nocapture".into(),
                "--test-threads=1".into(),
            ],
        }
    }

    pub(crate) fn register_test_host() {
        let host = test_host();
        register_host(host.program, host.args);
    }

    fn gray_request(codec: &str, width: u32, height: u32) -> Request {
        let config = VideoInfo {
            pixel_format: format::Pixel::NV12,
            width,
            height,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        };
        let mut options = Dictionary::new();
        options.set("preset", "ultrafast");
        Request::new(codec, &options, &config, width, height, 0.3, None)
    }

    fn run_child(request: &Request, fault: Option<&str>, timeout: Duration) -> Result<(), String> {
        let env: Vec<(&str, &str)> = fault.map(|fault| (FAULT_ENV, fault)).into_iter().collect();
        run_with(&test_host(), request, timeout, &env)
    }

    #[test]
    fn request_survives_the_trip_to_the_child() {
        let request = gray_request("h264_mf", 1438, 812);
        let decoded: Request =
            serde_json::from_str(&serde_json::to_string(&request).unwrap()).unwrap();
        assert_eq!(decoded, request);
        assert_eq!(
            decoded.pixel_format.parse::<format::Pixel>().unwrap(),
            format::Pixel::NV12
        );
    }

    #[test]
    fn isolated_self_test_outcomes() {
        let odd = gray_request("libx264", 1438, 812);
        assert_eq!(run_child(&odd, None, CHILD_TIMEOUT), Ok(()));

        let crashed = run_child(&odd, Some("access_violation"), CHILD_TIMEOUT).unwrap_err();
        assert!(
            crashed.starts_with("encoder crashed its isolated self-test process"),
            "{crashed}"
        );

        let aborted = run_child(&odd, Some("abort"), CHILD_TIMEOUT).unwrap_err();
        assert!(
            aborted.starts_with("encoder crashed its isolated self-test process"),
            "{aborted}"
        );

        assert_eq!(
            run_child(&odd, Some("fail"), CHILD_TIMEOUT),
            Err("injected self-test failure".to_string())
        );

        let started = Instant::now();
        let hung = run_child(&odd, Some("hang"), Duration::from_secs(2)).unwrap_err();
        assert!(hung.contains("did not finish"), "{hung}");
        assert!(started.elapsed() < Duration::from_secs(10));

        let missing = run_child(
            &gray_request("h264_not_an_encoder", 64, 64),
            None,
            CHILD_TIMEOUT,
        );
        assert_eq!(
            missing,
            Err("encoder h264_not_an_encoder not found".to_string())
        );
    }

    #[test]
    fn a_child_that_prints_no_verdict_counts_as_a_crash() {
        let host = Host {
            program: std::env::current_exe().unwrap(),
            args: vec!["--list".into()],
        };
        let error =
            run_with(&host, &gray_request("libx264", 64, 64), CHILD_TIMEOUT, &[]).unwrap_err();
        assert!(
            error.starts_with("encoder crashed its isolated self-test process"),
            "{error}"
        );
    }
}
