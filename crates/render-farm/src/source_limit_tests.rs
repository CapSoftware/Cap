use crate::{ProbeRequest, probe, video};
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
        other => panic!("unknown case {other}"),
    }
    #[cfg(unix)]
    println!("{RSS_PEAK}{}", own_peak_rss());
}

const RSS_PEAK: &str = "rss_peak=";

/// This process's own peak RSS, so no earlier child's peak can mask it.
#[cfg(unix)]
fn own_peak_rss() -> u64 {
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
    stdout
        .lines()
        .find_map(|line| line.split_once(RSS_PEAK))
        .and_then(|(_, peak)| peak.split_whitespace().next()?.parse().ok())
        .unwrap_or_else(|| panic!("{case} reported no peak:\n{stdout}"))
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
