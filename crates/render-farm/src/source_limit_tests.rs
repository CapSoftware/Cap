use crate::{ProbeRequest, probe, video};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    path::Path,
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

fn project(fixture: &str) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(fixture),
        directory.path().join("display.mp4"),
    )
    .unwrap();
    std::fs::write(
        directory.path().join("recording-meta.json"),
        serde_json::to_vec(&serde_json::json!({
            "pretty_name": "Source limit",
            "display": { "path": "display.mp4", "fps": 30 }
        }))
        .unwrap(),
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

/// The engine encodes frames read back to system memory, which is how it
/// runs on the farm's Linux workers and on Linux CI.
#[cfg(target_os = "linux")]
#[test]
fn source_at_the_pixel_limit_still_renders() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("at-limit.mp4");
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

/// The farm decodes with FFmpeg on Linux. A container can declare a smaller
/// frame than its stream carries, which the header check cannot see, so the
/// decoder's own limit has to stop it.
#[cfg(target_os = "linux")]
#[test]
fn stream_larger_than_its_container_declares_is_not_decoded() {
    init();
    let _heavy = HEAVY.lock().unwrap_or_else(|error| error.into_inner());
    let project = project("understated.mp4");
    let runtime = runtime();

    let probed = runtime
        .block_on(probe(probe_request(project.path())))
        .unwrap();
    assert_eq!(probed["total_frames"], 1);
    let (rendered, peak) =
        peak_heap_during(|| runtime.block_on(video::render(video_request(project.path(), [0, 1]))));

    let error = format!(
        "{:#}",
        rendered.err().expect("render decoded an 8192x8192 stream")
    );
    assert!(error.contains("8192x8192"), "{error}");
    assert!(
        peak < REFUSAL_HEAP_BUDGET,
        "refusing an 8192x8192 stream grew the heap by {peak} bytes"
    );
}
