use crate::{ProbeRequest, audio, probe, project::LoadedProject, video};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::{Path, PathBuf},
    sync::{
        Mutex, Once,
        atomic::{AtomicUsize, Ordering},
    },
};

struct PeakAllocator;

static LIVE_BYTES: AtomicUsize = AtomicUsize::new(0);
static PEAK_BYTES: AtomicUsize = AtomicUsize::new(0);

fn grew(bytes: usize) {
    let live = LIVE_BYTES.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK_BYTES.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for PeakAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            grew(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE_BYTES.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                LIVE_BYTES.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: PeakAllocator = PeakAllocator;

/// The engine's frames are Rust allocations (decoded planes, converted
/// frames, the plane pool), so a refusal that happens before decoding keeps
/// the heap far below a single 40-million-pixel frame (60 MB as NV12).
const REFUSAL_HEAP_BUDGET: usize = 16 << 20;

/// Heap measurements need the process to themselves.
static HEAVY: Mutex<()> = Mutex::new(());

fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        crate::init_engine().unwrap();
    });
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn project(display: &str) -> tempfile::TempDir {
    project_with_mic(display, None)
}

fn project_with_mic(display: &str, mic: Option<&str>) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy(fixture(display), directory.path().join("display.mp4")).unwrap();
    let mut meta = serde_json::json!({
        "pretty_name": "Source limit",
        "display": { "path": "display.mp4", "fps": 30 }
    });
    if let Some(mic) = mic {
        std::fs::copy(fixture(mic), directory.path().join("mic.m4a")).unwrap();
        meta["audio"] = serde_json::json!({ "path": "mic.m4a" });
    }
    std::fs::write(
        directory.path().join("recording-meta.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("project-config.json"),
        serde_json::to_vec(&cap_project::ProjectConfiguration::default()).unwrap(),
    )
    .unwrap();
    directory
}

/// A project of `display` and `mic` fixtures under their own extensions,
/// edited down to its first `edit` seconds when one is given.
fn project_from(display: &str, mic: Option<&str>, edit: Option<f64>) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let stage = |name: &str, role: &str| {
        let staged = format!("{role}.{}", name.rsplit('.').next().unwrap());
        std::fs::copy(fixture(name), directory.path().join(&staged)).unwrap();
        staged
    };
    let mut meta = serde_json::json!({
        "pretty_name": "Source limit",
        "display": { "path": stage(display, "display"), "fps": 30 }
    });
    if let Some(mic) = mic {
        meta["audio"] = serde_json::json!({ "path": stage(mic, "mic") });
    }
    let mut config = cap_project::ProjectConfiguration::default();
    if let Some(end) = edit {
        config.timeline = serde_json::from_value(serde_json::json!({
            "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": end }],
            "zoomSegments": []
        }))
        .unwrap();
    }
    std::fs::write(
        directory.path().join("recording-meta.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("project-config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    directory
}

fn audio_request(project: &Path, section: [i64; 2]) -> audio::AudioRequest {
    audio::AudioRequest {
        project: project.to_path_buf(),
        fps: 30,
        section,
        preroll: 0,
        out: project.join("section.aac"),
    }
}

fn probe_request(project: &Path) -> ProbeRequest {
    ProbeRequest {
        project: project.to_path_buf(),
        fps: 30,
        resolution: [1920, 1080],
        span_step: None,
    }
}

fn video_request(project: &Path, frames: [u32; 2]) -> video::VideoRequest {
    video::VideoRequest {
        project: project.to_path_buf(),
        fps: 30,
        resolution: [1920, 1080],
        bpp: 0.3,
        frames,
        threads: Some(2),
        out: project.join("chunk.h264"),
        waveform_levels: None,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// Peak heap growth while `run` executes.
fn peak_heap_during<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let baseline = LIVE_BYTES.load(Ordering::Relaxed);
    PEAK_BYTES.store(baseline, Ordering::Relaxed);
    let result = run();
    let peak = PEAK_BYTES.load(Ordering::Relaxed).saturating_sub(baseline);
    (result, peak)
}

#[test]
fn source_over_the_pixel_limit_is_refused_before_any_frame_is_allocated() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("over-limit.mp4");
    let runtime = runtime();

    let ((probed, rendered), peak) = peak_heap_during(|| {
        (
            runtime.block_on(probe(probe_request(project.path()))),
            runtime.block_on(video::render(video_request(project.path(), [0, 1]))),
        )
    });

    let probe_error = format!("{:#}", probed.expect_err("probe accepted 8000x5008"));
    let render_error = format!("{:#}", rendered.err().expect("render accepted 8000x5008"));
    for error in [&probe_error, &render_error] {
        assert!(
            error.contains("8000x5008") && error.contains("40000000 pixels"),
            "{error}"
        );
    }
    assert!(
        peak < REFUSAL_HEAP_BUDGET,
        "refusing 8000x5008 grew the heap by {peak} bytes"
    );
}

#[test]
fn source_at_the_pixel_limit_is_accepted() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("at-limit.mp4");

    let probed = runtime()
        .block_on(probe(probe_request(project.path())))
        .unwrap();
    assert_eq!(probed["total_frames"], 1);
}

/// The engine encodes frames read back to system memory only on Linux. 8K
/// UHD is the largest frame the renderer converts without downscaling it
/// first (`yuv_converter.rs`).
#[cfg(target_os = "linux")]
#[test]
fn large_source_under_the_limit_still_renders() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("8k-uhd.mp4");
    let runtime = runtime();

    let probed = runtime
        .block_on(probe(probe_request(project.path())))
        .unwrap();
    let rendered = runtime
        .block_on(video::render(video_request(project.path(), [0, 1])))
        .unwrap();
    assert_eq!(rendered.frames, 1);
    assert_eq!(rendered.sizes.len(), 1);
    assert_eq!(
        [rendered.width, rendered.height],
        [
            probed["width"].as_u64().unwrap() as u32,
            probed["height"].as_u64().unwrap() as u32
        ]
    );
}

/// FFmpeg allocates decoded frames outside the Rust heap, so these cases run
/// in a child process and compare its peak RSS with a small control. One
/// 8192x8192 frame is about 100 MB.
const FFMPEG_RSS_BUDGET: u64 = 48 << 20;
const RSS_CASE: &str = "CAP_RENDER_FARM_RSS_CASE";

#[test]
fn rss_case_child() {
    let Ok(case) = std::env::var(RSS_CASE) else {
        return;
    };
    init();
    let runtime = runtime();
    match case.as_str() {
        "probe-small" => {
            let project = project("small.mp4");
            runtime
                .block_on(probe(probe_request(project.path())))
                .unwrap();
        }
        "probe-video-as-mic" => {
            let project = project_with_mic("small.mp4", Some("understated.mp4"));
            runtime
                .block_on(probe(probe_request(project.path())))
                .unwrap();
        }
        "decode-small" => {
            let decoder = runtime
                .block_on(cap_rendering::decoder::spawn_decoder(
                    "screen",
                    fixture("small.mp4"),
                    30,
                    0.0,
                    true,
                ))
                .unwrap();
            runtime
                .block_on(decoder.get_frame_initial(0.0))
                .expect("no frame from small.mp4");
        }
        "decode-understated" => {
            let error = runtime
                .block_on(cap_rendering::decoder::spawn_decoder(
                    "screen",
                    fixture("understated.mp4"),
                    30,
                    0.0,
                    true,
                ))
                .err()
                .expect("opened a decoder for an 8192x8192 stream");
            assert!(error.contains("8192x8192"), "{error}");
        }
        "probe-mic-ogg-100h" => {
            let project = project_from("small.mp4", Some("mic-100h.ogg"), None);
            report_outcome(runtime.block_on(probe(probe_request(project.path()))));
        }
        "audio-mic-ogg-100h" => {
            let project = project_from("small.mp4", Some("mic-100h.ogg"), Some(1.0));
            report_outcome(
                runtime.block_on(audio::render(audio_request(project.path(), [0, 48_000]))),
            );
        }
        "probe-display-webm-100h" => {
            let project = project_from("display-100h.webm", None, None);
            report_outcome(runtime.block_on(probe(probe_request(project.path()))));
        }
        "audio-webm-mic-on-20h-display" => {
            let project = project_from("display-20h.webm", Some("mic-live.webm"), Some(1.0));
            report_outcome(
                runtime.block_on(audio::render(audio_request(project.path(), [0, 48_000]))),
            );
        }
        other => panic!("unknown case {other}"),
    }
    #[cfg(unix)]
    println!("{RSS_PEAK}{}", own_peak_rss());
}

const RSS_PEAK: &str = "rss_peak=";
const OUTCOME: &str = "outcome=";

fn report_outcome<T>(result: anyhow::Result<T>) {
    match result {
        Ok(_) => println!("{OUTCOME}ok"),
        Err(error) => println!("{OUTCOME}{error:#}"),
    }
}

/// This process's own peak RSS, so no earlier child's peak can mask it. On
/// Linux `ru_maxrss` keeps the spawning test process's peak across exec, so a
/// case spawned while other tests ran reported their memory; VmHWM is the
/// child's own.
#[cfg(unix)]
fn own_peak_rss() -> u64 {
    #[cfg(target_os = "linux")]
    if let Some(kilobytes) = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmHWM:"))?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
    {
        return kilobytes * 1024;
    }
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
    let peak = usage.ru_maxrss as u64;
    if cfg!(target_os = "macos") {
        peak
    } else {
        peak * 1024
    }
}

#[cfg(unix)]
fn child_peak_rss(case: &str) -> u64 {
    child_run(case).0
}

/// A case's own peak RSS, and its outcome when it reports one.
#[cfg(unix)]
fn child_run(case: &str) -> (u64, String) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "source_limit_tests::rss_case_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(RSS_CASE, case)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{case} failed: {}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let peak = stdout
        .lines()
        .find_map(|line| line.split_once(RSS_PEAK))
        .and_then(|(_, peak)| peak.split_whitespace().next()?.parse().ok())
        .unwrap_or_else(|| panic!("{case} reported no peak:\n{stdout}"));
    let outcome = stdout
        .lines()
        .find_map(|line| line.split_once(OUTCOME))
        .map(|(_, outcome)| outcome.to_owned())
        .unwrap_or_default();
    (peak, outcome)
}

#[cfg(unix)]
fn peak_rss_against(control: &str, case: &str) -> (u64, u64) {
    (child_peak_rss(control), child_peak_rss(case))
}

#[cfg(unix)]
#[test]
fn video_stream_in_an_audio_file_is_not_decoded() {
    let (control, probed) = peak_rss_against("probe-small", "probe-video-as-mic");
    assert!(
        probed < control + FFMPEG_RSS_BUDGET,
        "probing an 8192x8192 video named mic.m4a peaked at {probed} bytes, {control} without it"
    );
}

/// A container can declare a smaller frame than its stream carries, which
/// the header check cannot see, so the decoder's own limit has to stop it.
#[cfg(unix)]
#[test]
fn stream_larger_than_its_container_declares_is_not_decoded() {
    let (control, decoded) = peak_rss_against("decode-small", "decode-understated");
    assert!(
        decoded < control + FFMPEG_RSS_BUDGET,
        "refusing an 8192x8192 stream peaked at {decoded} bytes, {control} decoding 1080p"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn chunk_with_a_stream_larger_than_its_container_declares_fails() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("understated.mp4");
    let error = runtime()
        .block_on(video::render(video_request(project.path(), [0, 1])))
        .err()
        .expect("render decoded an 8192x8192 stream");
    let error = format!("{error:#}");
    assert!(error.contains("8192x8192"), "{error}");
}

#[test]
fn audio_that_declares_more_than_its_file_holds_is_refused_before_probing() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let runtime = runtime();
    for (mic, declared) in [
        (
            "mic-100h.ogg",
            "declares 360000 s, longer than cloud export supports",
        ),
        (
            "mic-24h.m4a",
            "declares 86400 s, longer than cloud export supports",
        ),
        ("mic-10h.ogg", "declares 36000 s in 3943 bytes"),
    ] {
        let project = project_from("small.mp4", Some(mic), None);
        let (probed, peak) =
            peak_heap_during(|| runtime.block_on(probe(probe_request(project.path()))));
        let error = format!("{:#}", probed.expect_err(mic));
        assert!(
            error.contains("mic audio") && error.contains(declared),
            "{mic}: {error}"
        );
        assert!(
            peak < REFUSAL_HEAP_BUDGET,
            "refusing {mic} grew the heap by {peak} bytes"
        );
    }
}

#[test]
fn webm_display_that_declares_100_hours_is_refused() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project_from("display-100h.webm", None, None);
    let (probed, peak) =
        peak_heap_during(|| runtime().block_on(probe(probe_request(project.path()))));
    let error = format!("{:#}", probed.expect_err("probe accepted a 100 h display"));
    assert!(
        error.contains("screen video") && error.contains("360000 s"),
        "{error}"
    );
    assert!(
        peak < REFUSAL_HEAP_BUDGET,
        "refusing a 100 h display grew the heap by {peak} bytes"
    );
}

#[test]
fn audio_beyond_the_supported_rate_or_channels_is_refused() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    for (rate, channels) in [(1_000_000u32, 1u16), (48_000, 65)] {
        let project = project_from("small.mp4", None, None);
        let block = u32::from(channels) * 2;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + block * 16).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * block).to_le_bytes());
        wav.extend_from_slice(&(block as u16).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(block * 16).to_le_bytes());
        wav.resize(wav.len() + (block * 16) as usize, 0);
        std::fs::write(project.path().join("mic.wav"), wav).unwrap();
        let meta_path = project.path().join("recording-meta.json");
        let mut meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
        meta["audio"] = serde_json::json!({ "path": "mic.wav" });
        std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();

        let error = format!(
            "{:#}",
            runtime()
                .block_on(probe(probe_request(project.path())))
                .expect_err("probe accepted the WAV")
        );
        assert!(
            error.contains(&format!("{rate} Hz with {channels} channels")),
            "{error}"
        );
    }
}

/// A browser WebM mic has no usable length, so its clip's stands in
/// (audio.rs `track_duration`). A display can declare 20 h inside the source
/// limit while the edit is 1 s: the mic's buffer has to follow the edit.
#[test]
fn a_clip_length_standing_in_for_a_webm_mic_sizes_only_what_the_edit_reads() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project_from("display-20h.webm", Some("mic-live.webm"), Some(1.0));
    let loaded = LoadedProject::load(project.path()).unwrap();
    let segment = &loaded.recordings.segments[0];
    assert_eq!(segment.display.duration, 72_000.0);
    let mic = segment.mic.as_ref().expect("mic.webm probed");
    assert!(
        crate::project::usable_duration(mic.duration).is_none(),
        "mic.webm probed a usable {} s",
        mic.duration
    );

    let (rendered, peak) = peak_heap_during(|| {
        runtime().block_on(audio::render(audio_request(project.path(), [0, 48_000])))
    });
    let rendered = rendered.unwrap();
    assert_eq!(rendered.total_samples, 48_000);
    assert!(!rendered.sizes.is_empty());
    let twenty_hours_of_mono = 72_000u64 * 48_000 * 4;
    assert!(
        peak < 64 << 20,
        "a 1 s edit of a 20 h clip grew the heap by {peak} bytes ({twenty_hours_of_mono} for its whole length)"
    );
}

#[test]
fn a_webm_mic_without_a_length_still_renders_its_clip() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project_from("display-red.webm", Some("mic-live.webm"), None);
    let rendered = runtime()
        .block_on(audio::render(audio_request(
            project.path(),
            [0, 3 * 48_000],
        )))
        .unwrap();
    assert_eq!(rendered.total_samples, 3 * 48_000);
    assert_eq!(rendered.first_packet, 0);
    assert_eq!(
        rendered.sizes.len(),
        (3 * 48_000 + 1024usize).div_ceil(1024)
    );
    assert!(rendered.sizes.iter().any(|&size| size > 16));
}

#[cfg(unix)]
#[test]
fn crafted_lengths_are_refused_within_the_probe_budget() {
    let control = child_peak_rss("probe-small");
    for (case, expected) in [
        ("probe-mic-ogg-100h", "declares 360000 s"),
        ("audio-mic-ogg-100h", "declares 360000 s"),
        ("probe-display-webm-100h", "declares 360000 s"),
        ("audio-webm-mic-on-20h-display", "ok"),
    ] {
        let (peak, outcome) = child_run(case);
        assert!(outcome.contains(expected), "{case}: {outcome}");
        assert!(
            peak < control + FFMPEG_RSS_BUDGET,
            "{case} peaked at {peak} bytes, {control} probing small.mp4"
        );
    }
}
