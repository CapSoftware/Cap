//! Breaks the hardware video encoder crash loop on Windows.
//!
//! Hardware encoders run vendor driver code inside Cap. When that code faults
//! (Intel's Media Foundation H264 encoder has been seen doing it on every
//! recording, after NVENC failed its self-test on an old NVIDIA card), nothing
//! can fall back, and every recording after it picks the same encoder and
//! dies again. The session marker names the hardware encoders that are live;
//! when the previous session died in a native crash inside an encoder's own
//! module, or inside the GPU driver a live encoder runs on, that encoder is
//! skipped until the next app version, and recording falls through to the
//! next encoder in the order and, at worst, libx264.

use serde_json::{Value, json};

use crate::crash_capture::{self, UncleanEnd};

const DISABLED_BY_CRASH: &str = "hardwareEncodersDisabledByCrash";

/// Call once at startup, after [`crash_capture::begin_session`] and before any
/// recording or export can open an encoder.
pub fn configure(previous: Option<&UncleanEnd>) {
    if !cfg!(target_os = "windows") {
        return;
    }
    cap_enc_ffmpeg::hardware_crash::set_hardware_encoder_observer(|name, active| {
        if active {
            crash_capture::enter_hardware_encoder(name);
        } else {
            crash_capture::exit_hardware_encoder(name);
        }
    });

    let current = env!("CARGO_PKG_VERSION");
    let raw = crate::store::store_section(crate::store::GENERAL_SETTINGS)
        .get(DISABLED_BY_CRASH)
        .cloned();
    let stored = raw.as_ref().and_then(Disabled::from_value);
    let crashed = previous.map(blamed_encoders).unwrap_or_default();
    let next = next_disabled(stored.as_ref(), &crashed, current);

    let next_value = next.as_ref().map(Disabled::to_value);
    if next_value != raw.filter(|value| !value.is_null()) {
        let value = next_value.unwrap_or(Value::Null);
        if !crate::store::set_store_setting(
            crate::store::GENERAL_SETTINGS,
            DISABLED_BY_CRASH,
            value,
        ) {
            tracing::warn!("could not save the hardware encoder crash recovery state");
        }
    }

    let module = previous
        .and_then(|previous| previous.native_crash.as_ref())
        .and_then(|crash| crash.module.as_deref());
    if !crashed.is_empty() {
        tracing::error!(
            encoders = ?crashed,
            module = ?module,
            "the previous Cap session crashed inside a hardware video encoder; recording skips it until the next app update"
        );
    } else if let Some(previous) = previous
        && previous.native_crash.is_some()
        && !previous.hardware_encoders.is_empty()
    {
        tracing::warn!(
            encoders = ?previous.hardware_encoders,
            module = ?module,
            "the previous Cap session crashed outside the live hardware video encoders and their GPU drivers; keeping them"
        );
    }
    match (&next, &stored) {
        (Some(next), _) if crashed.is_empty() => tracing::warn!(
            encoders = ?next.encoders,
            "hardware video encoders stay off after a crash in this app version"
        ),
        (None, Some(stored)) => tracing::info!(
            previous_version = %stored.version,
            encoders = ?stored.encoders,
            "app version changed; hardware video encoders that crashed get another try"
        ),
        _ => {}
    }

    cap_enc_ffmpeg::hardware_crash::set_disabled_hardware_encoders(
        next.map(|next| next.encoders).unwrap_or_default(),
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Disabled {
    version: String,
    encoders: Vec<String>,
}

impl Disabled {
    fn from_value(value: &Value) -> Option<Self> {
        let version = value.get("version")?.as_str()?.to_owned();
        let encoders = value
            .get("encoders")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        Some(Self { version, encoders })
    }

    fn to_value(&self) -> Value {
        json!({ "version": self.version, "encoders": self.encoders })
    }
}

/// What a faulting module says about the hardware encoders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    /// The encoder's own module.
    Encoder(&'static str),
    /// A GPU vendor's driver or media runtime, shared with rendering and
    /// capture: only the live encoders running on that vendor are blamed.
    /// `h264_mf` is on every list because Media Foundation loads whichever
    /// vendor's encoder transform is installed.
    Driver(&'static [&'static str]),
    /// Windows, Cap or anything else: not an encoder's doing.
    Elsewhere,
}

fn classify_module(module: &str) -> Fault {
    const INTEL: &[&str] = &["h264_qsv", "h264_mf"];
    const NVIDIA: &[&str] = &["h264_nvenc", "h264_mf"];
    const AMD: &[&str] = &["h264_amf", "h264_mf"];
    // First match wins, so each encoder transform comes before its vendor's
    // runtime (`mfx_mft*` before `mfx*`).
    const MODULES: &[(&str, Fault)] = &[
        // Media Foundation encoder transforms (Intel, NVIDIA, AMD).
        ("mfx_mft", Fault::Encoder("h264_mf")),
        ("nvencmft", Fault::Encoder("h264_mf")),
        ("amdh264enc", Fault::Encoder("h264_mf")),
        ("nvencodeapi", Fault::Encoder("h264_nvenc")),
        ("amfrt", Fault::Encoder("h264_amf")),
        // Intel: D3D drivers, shader compiler, Quick Sync runtimes.
        ("igd", Fault::Driver(INTEL)),
        ("igxe", Fault::Driver(INTEL)),
        ("igc", Fault::Driver(INTEL)),
        ("intel_gfx_api", Fault::Driver(INTEL)),
        ("libmfx", Fault::Driver(INTEL)),
        ("libvpl", Fault::Driver(INTEL)),
        ("mfx", Fault::Driver(INTEL)),
        // NVIDIA: CUDA and the D3D drivers.
        ("nvcuda", Fault::Driver(NVIDIA)),
        ("nvwgf2um", Fault::Driver(NVIDIA)),
        ("nvd3dum", Fault::Driver(NVIDIA)),
        ("nvldumd", Fault::Driver(NVIDIA)),
        ("nvlddmkm", Fault::Driver(NVIDIA)),
        // AMD: the D3D drivers.
        ("atiumd", Fault::Driver(AMD)),
        ("atidxx", Fault::Driver(AMD)),
        ("amdxx", Fault::Driver(AMD)),
    ];
    let module = module.to_ascii_lowercase();
    MODULES
        .iter()
        .find(|(prefix, _)| module.starts_with(prefix))
        .map_or(Fault::Elsewhere, |(_, fault)| *fault)
}

/// The encoders a previous session's death is blamed on. Only a native crash
/// in a known module counts: an encoder's own module names it, and a GPU
/// driver blames the live encoders running on that vendor. A kill, a fault in
/// Windows (`ntdll`, `KERNELBASE`, `ucrtbase`), in Cap, in an unknown module
/// or in no module blames nothing, since those crash for many other reasons.
fn blamed_encoders(previous: &UncleanEnd) -> Vec<String> {
    let Some(module) = previous
        .native_crash
        .as_ref()
        .and_then(|crash| crash.module.as_deref())
    else {
        return Vec::new();
    };
    match classify_module(module) {
        Fault::Encoder(encoder) => vec![encoder.to_owned()],
        Fault::Driver(encoders) => previous
            .hardware_encoders
            .iter()
            .filter(|live| encoders.contains(&live.as_str()))
            .cloned()
            .collect(),
        Fault::Elsewhere => Vec::new(),
    }
}

/// A fresh crash adds its encoders at this version; an existing disable
/// carries over within the same version; an update clears it.
fn next_disabled(stored: Option<&Disabled>, crashed: &[String], current: &str) -> Option<Disabled> {
    let mut encoders: Vec<String> = stored
        .filter(|stored| stored.version == current)
        .map(|stored| stored.encoders.clone())
        .unwrap_or_default();
    for encoder in crashed {
        if !encoders.contains(encoder) {
            encoders.push(encoder.clone());
        }
    }
    (!encoders.is_empty()).then(|| Disabled {
        version: current.to_owned(),
        encoders,
    })
}

#[cfg(test)]
mod tests {
    use super::{Disabled, Fault, blamed_encoders, classify_module, next_disabled};
    use crate::crash_capture::{NativeCrash, UncleanEnd};

    fn crash(module: Option<&str>, live: &[&str]) -> UncleanEnd {
        UncleanEnd {
            hardware_encoders: live.iter().map(|name| name.to_string()).collect(),
            native_crash: Some(NativeCrash {
                module: module.map(str::to_owned),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn modules_are_classified_by_encoder_and_vendor() {
        let encoder = |name| Fault::Encoder(name);
        assert_eq!(classify_module("mfx_mft_h264ve_64.dll"), encoder("h264_mf"));
        assert_eq!(classify_module("nvEncMFTH264x.dll"), encoder("h264_mf"));
        assert_eq!(classify_module("nvEncodeAPI64.dll"), encoder("h264_nvenc"));
        assert_eq!(classify_module("amfrt64.dll"), encoder("h264_amf"));
        assert_eq!(
            classify_module("igd10iumd64.dll"),
            Fault::Driver(&["h264_qsv", "h264_mf"])
        );
        assert_eq!(
            classify_module("libmfxhw64.dll"),
            Fault::Driver(&["h264_qsv", "h264_mf"])
        );
        assert_eq!(
            classify_module("nvwgf2umx.dll"),
            Fault::Driver(&["h264_nvenc", "h264_mf"])
        );
        assert_eq!(
            classify_module("atiumd64.dll"),
            Fault::Driver(&["h264_amf", "h264_mf"])
        );
        for elsewhere in [
            "ntdll.dll",
            "KERNELBASE.dll",
            "ucrtbase.dll",
            "mfplat.dll",
            "d3d11.dll",
            "Cap.exe",
        ] {
            assert_eq!(classify_module(elsewhere), Fault::Elsewhere, "{elsewhere}");
        }
    }

    #[test]
    fn only_a_crash_in_an_encoder_or_its_driver_blames_it() {
        // The reported crash: Intel's encoder faulted with h264_mf live.
        assert_eq!(
            blamed_encoders(&crash(Some("mfx_mft_h264ve_64.dll"), &["h264_mf"])),
            ["h264_mf"]
        );
        // The encoder's own module names it even if the marker missed it.
        assert_eq!(
            blamed_encoders(&crash(Some("mfx_mft_h264ve_64.dll"), &[])),
            ["h264_mf"]
        );
        // A vendor driver blames only that vendor's live encoders.
        assert_eq!(
            blamed_encoders(&crash(Some("nvwgf2umx.dll"), &["h264_nvenc"])),
            ["h264_nvenc"]
        );
        assert_eq!(
            blamed_encoders(&crash(Some("nvwgf2umx.dll"), &["h264_qsv"])),
            Vec::<String>::new()
        );
        assert_eq!(
            blamed_encoders(&crash(Some("igd10iumd64.dll"), &["h264_nvenc", "h264_mf"])),
            ["h264_mf"]
        );
        assert!(blamed_encoders(&crash(Some("igd10iumd64.dll"), &[])).is_empty());
        // Windows, Cap, unknown modules and no module blame nothing.
        for module in [
            Some("ntdll.dll"),
            Some("ucrtbase.dll"),
            Some("Cap.exe"),
            None,
        ] {
            assert!(
                blamed_encoders(&crash(module, &["h264_nvenc"])).is_empty(),
                "{module:?}"
            );
        }
        // A kill or force quit with an encoder live leaves no crash record.
        let killed = UncleanEnd {
            hardware_encoders: vec!["h264_mf".into()],
            ..Default::default()
        };
        assert!(blamed_encoders(&killed).is_empty());
    }

    #[test]
    fn a_crash_disables_its_encoder_until_the_next_version() {
        let disabled = |version: &str, encoders: &[&str]| Disabled {
            version: version.into(),
            encoders: encoders.iter().map(|name| name.to_string()).collect(),
        };
        let mf = ["h264_mf".to_string()];
        let qsv = ["h264_qsv".to_string()];

        assert_eq!(next_disabled(None, &[], "0.6.2"), None);
        assert_eq!(
            next_disabled(None, &mf, "0.6.2"),
            Some(disabled("0.6.2", &["h264_mf"]))
        );
        // Carries over, and the next encoder that crashes joins it.
        let after_mf = disabled("0.6.2", &["h264_mf"]);
        assert_eq!(
            next_disabled(Some(&after_mf), &[], "0.6.2"),
            Some(after_mf.clone())
        );
        assert_eq!(
            next_disabled(Some(&after_mf), &qsv, "0.6.2"),
            Some(disabled("0.6.2", &["h264_mf", "h264_qsv"]))
        );
        assert_eq!(
            next_disabled(Some(&after_mf), &mf, "0.6.2"),
            Some(after_mf.clone())
        );
        // An update gives every encoder another try.
        assert_eq!(next_disabled(Some(&after_mf), &[], "0.6.3"), None);
        assert_eq!(
            next_disabled(Some(&after_mf), &qsv, "0.6.3"),
            Some(disabled("0.6.3", &["h264_qsv"]))
        );
        // The stored shape round-trips.
        assert_eq!(Disabled::from_value(&after_mf.to_value()), Some(after_mf));
        assert_eq!(Disabled::from_value(&serde_json::json!("0.6.2")), None);
    }
}

/// Each launch runs in a child copy of this test binary: crash capture, the
/// encoder observer and the disabled list are all process-wide.
#[cfg(all(test, windows))]
mod process_tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
    };

    const CHILD: &str = "CAP_ENCODER_RECOVERY_CHILD";
    const LOGS: &str = "CAP_ENCODER_RECOVERY_LOGS";
    const TRACE_FILE: &str = "trace.log";
    const RECORD_TEST: &str = "encoder_recovery::process_tests::next_launch_after_an_encoder_crash_records_with_the_next_encoder";
    const NTDLL_CRASH: &str = "native crash: unhandled exception 0xc0000005 at 0x00007ffdc1a2f0e1 in ntdll.dll+0x0002f0e1\r\n";
    /// The line the reported crash left in the crash record.
    const INTEL_MFT_CRASH: &str = "native crash: unhandled exception 0xc0000005 at 0x00007ffda598ccd0 in mfx_mft_h264ve_64.dll+0x0013ccd0\r\n";

    /// Startup as `main` runs it: crash capture, then encoder recovery.
    fn start(logs: &Path) -> Option<crate::crash_capture::UncleanEnd> {
        let trace = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join(TRACE_FILE))
            .unwrap();
        let _ = tracing_subscriber::fmt()
            .with_writer(std::sync::Mutex::new(trace))
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .try_init();
        crate::crash_capture::install(logs);
        let previous = crate::crash_capture::begin_session(logs);
        super::configure(previous.as_ref());
        previous
    }

    fn child(kind: &str) -> bool {
        if std::env::var(CHILD).as_deref() != Ok(kind) {
            return false;
        }
        let logs = PathBuf::from(std::env::var(LOGS).unwrap());
        start(&logs);
        match kind {
            // A recording encoder opened with Media Foundation first, as the
            // NVIDIA order reaches it once NVENC fails its self-test.
            "record" => {
                ffmpeg::init().unwrap();
                let mut output = ffmpeg::format::output(&logs.join("out.mp4")).unwrap();
                let info = cap_media_info::VideoInfo::from_raw_ffmpeg(
                    ffmpeg::format::Pixel::NV12,
                    1280,
                    720,
                    30,
                );
                let encoder = cap_enc_ffmpeg::h264::H264Encoder::builder(info)
                    .with_encoder_priority_override(&["h264_mf", "libx264"])
                    .build(&mut output)
                    .unwrap();
                println!("selected encoder={}", encoder.codec_name());
                drop(encoder);
                crate::crash_capture::mark_clean_exit();
            }
            // A native fault while Media Foundation's encoder is live.
            "fault" => {
                let _session =
                    cap_enc_ffmpeg::hardware_crash::HardwareEncoderSession::begin("h264_mf");
                unsafe { std::ptr::write_volatile(std::ptr::null_mut::<u8>(), 1) }
            }
            _ => {}
        }
        true
    }

    struct Launch {
        stdout: String,
        trace: String,
        success: bool,
    }

    fn launch(test: &str, kind: &str, logs: &Path) -> Launch {
        let _ = std::fs::remove_file(logs.join(TRACE_FILE));
        let output = Command::new(std::env::current_exe().unwrap())
            .args([test, "--exact", "--nocapture", "--test-threads=1"])
            .env(CHILD, kind)
            .env(LOGS, logs)
            .env("CAP_GPUI_TAURI_STORE", logs.join("store"))
            .output()
            .unwrap();
        Launch {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            trace: std::fs::read_to_string(logs.join(TRACE_FILE)).unwrap_or_default(),
            success: output.status.success(),
        }
    }

    /// What each launch chose, for the test output.
    fn report(label: &str, launch: &Launch) {
        let lines = launch
            .stdout
            .lines()
            .chain(launch.trace.lines())
            .filter(|line| {
                line.contains("selected encoder=")
                    || line.contains("h264_mf")
                    || line.contains("hardware video encoder")
            });
        println!("--- {label}");
        for line in lines {
            println!("{line}");
        }
    }

    fn tried_media_foundation(trace: &str) -> bool {
        trace.lines().any(|line| {
            line.contains("encoder=h264_mf")
                && (line.contains("self-test") || line.contains("Selected hardware H264 encoder"))
        })
    }

    #[test]
    fn next_launch_after_an_encoder_crash_records_with_the_next_encoder() {
        if child("record") {
            return;
        }
        assert!(
            ffmpeg::encoder::find_by_name("h264_mf").is_some(),
            "this FFmpeg build has no h264_mf"
        );

        // Without a crash, recording hands Media Foundation the encode.
        let clean = tempfile::tempdir().unwrap();
        let first = launch(RECORD_TEST, "record", clean.path());
        report("clean previous session", &first);
        assert!(first.success, "{}\n{}", first.stdout, first.trace);
        assert!(tried_media_foundation(&first.trace), "{}", first.trace);

        // The marker and crash record the reported crash left behind.
        let crashed = tempfile::tempdir().unwrap();
        std::fs::write(
            crashed.path().join("cap-gpui.session"),
            format!(
                "pid=1 started=2026-11-01T14:53:29.189Z version={} hwenc=h264_mf\n",
                env!("CARGO_PKG_VERSION")
            ),
        )
        .unwrap();
        std::fs::write(
            crashed.path().join(crate::crash_capture::CRASH_FILE),
            INTEL_MFT_CRASH,
        )
        .unwrap();
        let next = launch(RECORD_TEST, "record", crashed.path());
        report("after the Intel encoder crash", &next);
        assert!(next.success, "{}\n{}", next.stdout, next.trace);
        assert!(
            next.trace
                .contains("crashed inside a hardware video encoder"),
            "{}",
            next.trace
        );
        assert!(
            next.trace.lines().any(|line| line
                .contains("Skipping hardware H264 encoder disabled after it crashed Cap")
                && line.contains("encoder=h264_mf")),
            "{}",
            next.trace
        );
        assert!(!tried_media_foundation(&next.trace), "{}", next.trace);
        assert!(
            next.stdout.contains("selected encoder=libx264"),
            "{}",
            next.stdout
        );

        // A crash in Windows itself with Media Foundation live is not blamed on it.
        let system = tempfile::tempdir().unwrap();
        std::fs::write(
            system.path().join("cap-gpui.session"),
            format!(
                "pid=1 started=2026-11-01T14:53:29.189Z version={} hwenc=h264_mf\n",
                env!("CARGO_PKG_VERSION")
            ),
        )
        .unwrap();
        std::fs::write(
            system.path().join(crate::crash_capture::CRASH_FILE),
            NTDLL_CRASH,
        )
        .unwrap();
        let after_system = launch(RECORD_TEST, "record", system.path());
        report("after a crash in ntdll", &after_system);
        assert!(
            after_system.success,
            "{}\n{}",
            after_system.stdout, after_system.trace
        );
        assert!(
            after_system
                .trace
                .contains("crashed outside the live hardware video encoders"),
            "{}",
            after_system.trace
        );
        assert!(
            tried_media_foundation(&after_system.trace),
            "{}",
            after_system.trace
        );

        // A clean launch after it keeps Media Foundation off in this version.
        let after = launch(RECORD_TEST, "record", crashed.path());
        report("the launch after that", &after);
        assert!(after.success, "{}\n{}", after.stdout, after.trace);
        assert!(
            after.trace.contains("stay off after a crash"),
            "{}",
            after.trace
        );
        assert!(!tried_media_foundation(&after.trace), "{}", after.trace);
        assert!(
            after.stdout.contains("selected encoder=libx264"),
            "{}",
            after.stdout
        );
    }

    /// A real fault with an encoder live leaves what the next launch reads:
    /// the encoder in the marker and the faulting module in the crash record.
    #[test]
    fn a_fault_with_an_encoder_live_is_recorded_for_the_next_launch() {
        if child("fault") {
            return;
        }
        let logs = tempfile::tempdir().unwrap();
        let died = launch(
            "encoder_recovery::process_tests::a_fault_with_an_encoder_live_is_recorded_for_the_next_launch",
            "fault",
            logs.path(),
        );
        assert!(!died.success);
        let marker = std::fs::read_to_string(logs.path().join("cap-gpui.session")).unwrap();
        assert!(marker.contains(" hwenc=h264_mf"), "{marker}");
        let crash_log =
            std::fs::read_to_string(logs.path().join(crate::crash_capture::CRASH_FILE)).unwrap();
        let own = std::env::current_exe().unwrap();
        let own = own.file_name().unwrap().to_string_lossy();
        assert!(crash_log.contains(&format!(" in {own}+0x")), "{crash_log}");

        // That fault was in Cap's own code, so the next launch keeps the encoder.
        let next = launch(RECORD_TEST, "record", logs.path());
        report("after a fault in Cap's own code", &next);
        assert!(next.success, "{}\n{}", next.stdout, next.trace);
        assert!(
            next.trace
                .contains("crashed outside the live hardware video encoders"),
            "{}",
            next.trace
        );
        assert!(tried_media_foundation(&next.trace), "{}", next.trace);
    }
}
