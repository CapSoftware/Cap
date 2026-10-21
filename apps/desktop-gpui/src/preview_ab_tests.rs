use std::collections::HashMap;
use std::hash::{DefaultHasher, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cap_editor::{AudioOutput, EditorFrameFormat, EditorFrameOutput, EditorInstance};
use cap_project::XY;
use cap_verify::fixture::{self, FixtureSpec, SegmentSpec, Timing, VideoTrackSpec};

use crate::editor_window::{PumpStats, bgra_frame_image_timed, frame_image_timed, request_frame};

const FRAMES: u32 = 48;
const WARMUP: u32 = 6;

fn spec(width: u32, height: u32) -> FixtureSpec {
    FixtureSpec {
        name: format!("preview-ab-{width}x{height}"),
        segments: vec![SegmentSpec {
            display: VideoTrackSpec::new(width, height, 30, Timing::Constant { duration: 2.0 }),
            camera: None,
            mic: None,
            system_audio: None,
        }],
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn p95(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * 0.95).round() as usize]
}

#[test]
#[ignore = "scratch A/B, run explicitly"]
fn editor_preview_copies_ab() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let shared = runtime
        .block_on(cap_rendering::create_shared_device())
        .expect("wgpu device");
    let info = shared.adapter.get_info();
    println!(
        "adapter: {} | backend {:?} | type {:?} | driver {} {} | software={}",
        info.name,
        info.backend,
        info.device_type,
        info.driver,
        info.driver_info,
        shared.is_software_adapter
    );
    println!();
    println!(
        "| preview | path | output | request to frame ms p50 | p95 | PumpStats convert µs p50 | p95 | frames | parity vs main |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");

    for (label, source_size, base) in [
        ("Half (default)", (1920, 1080), XY::new(1248, 702)),
        ("Full 1080p", (1920, 1080), XY::new(1920, 1080)),
        ("4K", (3840, 2160), XY::new(3840, 2160)),
    ] {
        let source =
            fixture::ensure_fixture(&spec(source_size.0, source_size.1), fixture::write_fixture)
                .expect("fixture");
        let mut hashes: HashMap<&'static str, Vec<(u32, u64)>> = HashMap::new();
        let mut latency: HashMap<&'static str, Vec<f64>> = HashMap::new();
        let mut convert: HashMap<&'static str, Vec<f64>> = HashMap::new();
        let mut output_size = HashMap::new();
        for round in 0..2 {
            for (name, format) in [
                ("main (Rgba)", EditorFrameFormat::Rgba),
                ("branch (Bgra)", EditorFrameFormat::Bgra),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let work = dir.path().join("project.cap");
                copy_dir(&source, &work);
                let (tx, rx) = flume::unbounded::<(EditorFrameOutput, Instant)>();
                let device = cap_rendering::SharedWgpuDevice {
                    instance: shared.instance.clone(),
                    adapter: shared.adapter.clone(),
                    device: shared.device.clone(),
                    queue: shared.queue.clone(),
                    is_software_adapter: shared.is_software_adapter,
                };
                let instance = runtime
                    .block_on(EditorInstance::new_with_audio_output_and_frame_format(
                        work,
                        |_| {},
                        Box::new(move |output, _| {
                            let _ = tx.send((output, Instant::now()));
                        }),
                        Some(device),
                        format,
                        Arc::new(AudioOutput::new_headless(Box::new(|_, _| {}))),
                    ))
                    .expect("editor instance");
                let stats = PumpStats::default();
                for frame_number in 0..FRAMES {
                    let requested = Instant::now();
                    request_frame(&instance, frame_number, base);
                    let (output, arrived) = loop {
                        let (output, arrived) = rx
                            .recv_timeout(Duration::from_secs(120))
                            .expect("frame arrives");
                        let number = match &output {
                            EditorFrameOutput::Rgba(frame) | EditorFrameOutput::Bgra(frame) => {
                                frame.frame_number
                            }
                            _ => panic!("unexpected output"),
                        };
                        if number == frame_number {
                            break (output, arrived);
                        }
                    };
                    let before = stats.snapshot();
                    let image = match output {
                        EditorFrameOutput::Rgba(frame) => {
                            assert_eq!(format, EditorFrameFormat::Rgba);
                            frame_image_timed(&frame, &stats)
                        }
                        EditorFrameOutput::Bgra(frame) => {
                            assert_eq!(format, EditorFrameFormat::Bgra);
                            bgra_frame_image_timed(frame, &stats)
                        }
                        _ => unreachable!(),
                    }
                    .expect("frame converts");
                    let spent = stats.snapshot().since(before);
                    if frame_number >= WARMUP {
                        latency
                            .entry(name)
                            .or_default()
                            .push(arrived.duration_since(requested).as_secs_f64() * 1e3);
                        convert
                            .entry(name)
                            .or_default()
                            .push(spent.convert_nanos as f64 / 1e3);
                    }
                    output_size.insert(name, image.size(0));
                    if round == 0 {
                        let mut hasher = DefaultHasher::new();
                        hasher.write(image.as_bytes(0).unwrap());
                        hashes
                            .entry(name)
                            .or_default()
                            .push((frame_number, hasher.finish()));
                    }
                }
                runtime.block_on(instance.dispose());
            }
        }
        let parity = hashes["main (Rgba)"] == hashes["branch (Bgra)"];
        let distinct = hashes["main (Rgba)"]
            .iter()
            .map(|(_, hash)| *hash)
            .collect::<std::collections::HashSet<_>>()
            .len();
        for name in ["main (Rgba)", "branch (Bgra)"] {
            let latency = latency.get_mut(name).unwrap();
            let count = latency.len();
            let convert = convert.get_mut(name).unwrap();
            let size = output_size[name];
            println!(
                "| {label} | {name} | {}x{} | {:.2} | {:.2} | {:.0} | {:.0} | {count} | {} |",
                size.width.0,
                size.height.0,
                median(latency),
                p95(latency),
                median(convert),
                p95(convert),
                if name.starts_with("main") {
                    format!("{distinct} distinct frames")
                } else if parity {
                    "byte-identical".to_string()
                } else {
                    "MISMATCH".to_string()
                }
            );
        }
        assert!(parity, "{label}: BGRA frames differ from RGBA frames");
    }
}
