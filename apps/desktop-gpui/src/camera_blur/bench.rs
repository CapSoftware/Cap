//! The live preview's background effect on synthetic camera frames, driven
//! through the same [`Worker`] the camera window feeds: a VideoToolbox
//! conversion of a `420v` camera frame into a 720p BGRA IOSurface ring, then
//! `Worker::process` at camera pacing. No camera is opened.
//!
//! `CAP_CAMERA_EFFECT_BENCH_IMAGES` lists photos of a person (comma
//! separated); each run pans across them so every frame differs, like sensor
//! noise and small movement do on a real camera.
//!
//! Run:
//!   CAP_CAMERA_EFFECT_BENCH_IMAGES=a.jpg,b.jpg cargo test --bin cap-gpui \
//!     camera_blur::bench -- --ignored --nocapture --test-threads=1

use super::*;
use cap_camera_effects::{BlurMaskStatus, BlurMode};
use cidre::cf;
use core_foundation::base::TCFType as _;
use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};
use std::collections::HashMap;
use std::time::Instant;

const FPS: u32 = 30;
const WARMUP_FRAMES: usize = 60;
const MEASURED_FRAMES: usize = 300;
const PAN_POSITIONS: usize = 8;
const RING_SIZE: usize = 6;

unsafe extern "C" {
    fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> libc::c_int;
}

fn images() -> Vec<image::RgbaImage> {
    let paths = std::env::var("CAP_CAMERA_EFFECT_BENCH_IMAGES")
        .expect("CAP_CAMERA_EFFECT_BENCH_IMAGES lists person photos");
    paths
        .split(',')
        .map(|path| image::open(path).expect("bench photo").to_rgba8())
        .collect()
}

fn surface_attributes() -> arc::R<cf::Dictionary> {
    let properties = cf::Dictionary::new();
    cf::Dictionary::with_keys_values(
        &[
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ],
        &[properties.as_ref(), cf::Boolean::value_true().as_ref()],
    )
    .unwrap()
}

fn with_bytes<R>(buffer: &cv::PixelBuf, body: impl FnOnce(&mut [u8], usize) -> R) -> R {
    let raw = buffer as *const cv::PixelBuf as CVPixelBufferRef;
    let wrapped = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };
    assert_eq!(wrapped.lock_base_address(0), 0);
    let stride = wrapped.get_bytes_per_row();
    let bytes = unsafe {
        std::slice::from_raw_parts_mut(
            wrapped.get_base_address().cast::<u8>(),
            stride * wrapped.get_height(),
        )
    };
    let result = body(bytes, stride);
    assert_eq!(wrapped.unlock_base_address(0), 0);
    result
}

fn camera_frames(
    photos: &[image::RgbaImage],
    width: usize,
    height: usize,
) -> Vec<Vec<arc::R<cv::PixelBuf>>> {
    let attributes = surface_attributes();
    let transfer = cidre::vt::PixelTransferSession::new().unwrap();
    let (canvas_width, canvas_height) = (width * 106 / 100, height * 106 / 100);
    photos
        .iter()
        .map(|photo| {
            let scale = (canvas_width as f64 / f64::from(photo.width()))
                .max(canvas_height as f64 / f64::from(photo.height()));
            let scaled = image::imageops::resize(
                photo,
                (f64::from(photo.width()) * scale).ceil() as u32,
                (f64::from(photo.height()) * scale).ceil() as u32,
                image::imageops::FilterType::Triangle,
            );
            let origin_x = (scaled.width() as usize - canvas_width) / 2;
            let origin_y = (scaled.height() as usize - canvas_height) / 2;
            (0..PAN_POSITIONS)
                .map(|position| {
                    let angle = position as f64 / PAN_POSITIONS as f64 * std::f64::consts::TAU;
                    let x = origin_x
                        + ((canvas_width - width) as f64 * (0.5 + 0.5 * angle.cos())) as usize;
                    let y = origin_y
                        + ((canvas_height - height) as f64 * (0.5 + 0.5 * angle.sin())) as usize;
                    let bgra = cv::PixelBuf::new(
                        width,
                        height,
                        cv::PixelFormat::_32_BGRA,
                        Some(&attributes),
                    )
                    .unwrap();
                    with_bytes(&bgra, |bytes, stride| {
                        for row in 0..height {
                            let target = &mut bytes[row * stride..][..width * 4];
                            for (column, pixel) in target.chunks_exact_mut(4).enumerate() {
                                let source =
                                    scaled.get_pixel((x + column) as u32, (y + row) as u32);
                                pixel.copy_from_slice(&[source[2], source[1], source[0], 255]);
                            }
                        }
                    });
                    let camera =
                        cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attributes))
                            .unwrap();
                    transfer.transfer(&bgra, &camera).unwrap();
                    camera
                })
                .collect()
        })
        .collect()
}

/// The camera window's conversion: the camera frame scaled into a 720p BGRA
/// IOSurface ring (`FrameConverter` with `BLUR_MAX_DIMS`).
struct Converter {
    session: arc::R<cidre::vt::PixelTransferSession>,
    ring: Vec<arc::R<cv::PixelBuf>>,
    next: usize,
    dims: (usize, usize),
}

impl Converter {
    fn new(source: (usize, usize)) -> Self {
        let scale = (BLUR_MAX_DIMS.0 as f64 / source.0 as f64)
            .min(BLUR_MAX_DIMS.1 as f64 / source.1 as f64)
            .min(1.0);
        let dims = (
            (source.0 as f64 * scale).round() as usize,
            (source.1 as f64 * scale).round() as usize,
        );
        let attributes = surface_attributes();
        let mut session = cidre::vt::PixelTransferSession::new().unwrap();
        session.set_realtime(true).unwrap();
        Self {
            session,
            ring: (0..RING_SIZE)
                .map(|_| {
                    cv::PixelBuf::new(dims.0, dims.1, cv::PixelFormat::_32_BGRA, Some(&attributes))
                        .unwrap()
                })
                .collect(),
            next: 0,
            dims,
        }
    }

    fn convert(&mut self, frame: &cv::PixelBuf, mode: BlurMode) -> BlurJob {
        let buffer = self.ring[self.next].clone();
        self.next = (self.next + 1) % RING_SIZE;
        self.session.transfer(frame, &buffer).unwrap();
        BlurJob {
            buffer: SendPixelBuf(buffer),
            width: self.dims.0 as u32,
            height: self.dims.1 as u32,
            ring_generation: 1,
            mode,
        }
    }
}

fn footprint_mb() -> f64 {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            (&mut info as *mut libc::rusage_info_v2).cast(),
        )
    };
    assert_eq!(result, 0);
    info.ri_phys_footprint as f64 / 1_048_576.0
}

fn process_cpu_ns() -> u64 {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
    let ns = |time: libc::timeval| time.tv_sec as u64 * 1_000_000_000 + time.tv_usec as u64 * 1000;
    ns(usage.ru_utime) + ns(usage.ru_stime)
}

fn thread_cpu_ns() -> u64 {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) },
        0
    );
    time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
}

fn threads() -> HashMap<u64, (String, u64)> {
    let mut out = HashMap::new();
    unsafe {
        let task = libc::mach_task_self();
        let mut list: libc::thread_act_array_t = std::ptr::null_mut();
        let mut count: libc::mach_msg_type_number_t = 0;
        if libc::task_threads(task, &mut list, &mut count) != 0 {
            return out;
        }
        for &thread in std::slice::from_raw_parts(list, count as usize) {
            let mut extended: libc::thread_extended_info = std::mem::zeroed();
            let mut extended_count = libc::THREAD_EXTENDED_INFO_COUNT;
            let mut identifier: libc::thread_identifier_info = std::mem::zeroed();
            let mut identifier_count = libc::THREAD_IDENTIFIER_INFO_COUNT;
            if libc::thread_info(
                thread,
                libc::THREAD_EXTENDED_INFO as _,
                (&mut extended as *mut libc::thread_extended_info).cast(),
                &mut extended_count,
            ) == 0
                && libc::thread_info(
                    thread,
                    libc::THREAD_IDENTIFIER_INFO as _,
                    (&mut identifier as *mut libc::thread_identifier_info).cast(),
                    &mut identifier_count,
                ) == 0
            {
                let name = std::ffi::CStr::from_ptr(extended.pth_name.as_ptr())
                    .to_string_lossy()
                    .into_owned();
                out.insert(
                    identifier.thread_id,
                    (name, extended.pth_user_time + extended.pth_system_time),
                );
            }
            mach_port_deallocate(task, thread);
        }
        libc::vm_deallocate(
            task,
            list as libc::vm_address_t,
            count as usize * std::mem::size_of::<libc::thread_act_t>(),
        );
    }
    out
}

fn thread_label(name: &str) -> &'static str {
    if name.starts_with("cap-vision") {
        "vision thread"
    } else if name.contains("camera_blur::bench") || name == "main" {
        "worker (bench thread)"
    } else if name.starts_with("tokio") {
        "gpu wait (tokio blocking)"
    } else if name.is_empty() {
        "unnamed (GCD, Vision, Metal)"
    } else {
        "other named"
    }
}

fn percentile(values: &mut [f64], percentile: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * percentile).round() as usize]
}

struct Run {
    label: String,
    process_ms: Vec<f64>,
    worker_cpu_ms: Vec<f64>,
    convert_ms: Vec<f64>,
    cpu_percent: f64,
    threads: Vec<(&'static str, f64)>,
    masks_per_second: f64,
    mask_age_ms: Vec<f64>,
    footprint_before: f64,
    footprint_steady: f64,
    footprint_peak: f64,
    footprint_after: f64,
}

fn run(
    label: String,
    frames: &[Vec<arc::R<cv::PixelBuf>>],
    mode: BlurMode,
    inference_interval: Option<Duration>,
) -> Run {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let (device, queue) = shared_device(&runtime).unwrap();
    let source = (frames[0][0].width(), frames[0][0].height());
    let mut converter = Converter::new(source);
    let footprint_before = footprint_mb();
    let mut worker = Worker::new(device, queue).unwrap();
    if let Some(interval) = inference_interval {
        worker.processor.set_inference_interval(interval);
    }
    let interval = Duration::from_secs(1) / FPS;
    let frame_at = |index: usize| {
        let photo = (index / 100) % frames.len();
        let position = index % (2 * PAN_POSITIONS - 2);
        let position = if position < PAN_POSITIONS {
            position
        } else {
            2 * PAN_POSITIONS - 2 - position
        };
        &frames[photo][position]
    };

    let mut process_ms = Vec::with_capacity(MEASURED_FRAMES);
    let mut worker_cpu_ms = Vec::with_capacity(MEASURED_FRAMES);
    let mut convert_ms = Vec::with_capacity(MEASURED_FRAMES);
    let mut mask_age_ms = Vec::with_capacity(MEASURED_FRAMES);
    let mut generations = std::collections::HashSet::new();
    let mut footprint_peak = 0.0_f64;
    let mut footprint_steady = 0.0;
    let mut window = None;
    let mut next_tick = Instant::now();
    for index in 0..WARMUP_FRAMES + MEASURED_FRAMES {
        if index == WARMUP_FRAMES {
            footprint_steady = footprint_mb();
            window = Some((Instant::now(), process_cpu_ns(), threads()));
        }
        std::thread::sleep(next_tick.saturating_duration_since(Instant::now()));
        next_tick += interval;
        let start = Instant::now();
        let job = converter.convert(frame_at(index), mode);
        let converted = start.elapsed();
        let cpu_start = thread_cpu_ns();
        let output = worker.process(&runtime, job).unwrap();
        let elapsed = start.elapsed();
        let cpu = thread_cpu_ns() - cpu_start;
        if mode == BlurMode::Remove {
            assert!(output.cutout.is_some());
        }
        drop(output);
        if index >= WARMUP_FRAMES {
            convert_ms.push(converted.as_secs_f64() * 1000.0);
            process_ms.push(elapsed.saturating_sub(converted).as_secs_f64() * 1000.0);
            worker_cpu_ms.push(cpu as f64 / 1e6);
            if let Some(status) = worker.processor.output_status()
                && let BlurMaskStatus::Ready(receipt) = status.mask
            {
                generations.insert(receipt.generation);
                mask_age_ms.push(receipt.input_submitted_at.elapsed().as_secs_f64() * 1000.0);
            }
            if index % 30 == 0 {
                footprint_peak = footprint_peak.max(footprint_mb());
            }
        }
    }
    let (window_start, cpu_start, threads_start) = window.unwrap();
    let wall = window_start.elapsed();
    let cpu_percent = (process_cpu_ns() - cpu_start) as f64 / wall.as_nanos() as f64 * 100.0;
    let mut by_label: HashMap<&'static str, u64> = HashMap::new();
    for (id, (name, end)) in threads() {
        let start = threads_start.get(&id).map_or(0, |(_, start)| *start);
        *by_label.entry(thread_label(&name)).or_default() += end.saturating_sub(start);
    }
    let mut threads = by_label
        .into_iter()
        .map(|(label, ns)| (label, ns as f64 / wall.as_nanos() as f64 * 100.0))
        .collect::<Vec<_>>();
    threads.sort_by(|a, b| b.1.total_cmp(&a.1));
    footprint_peak = footprint_peak.max(footprint_mb());
    drop(worker);
    std::thread::sleep(Duration::from_millis(500));
    Run {
        label,
        process_ms,
        worker_cpu_ms,
        convert_ms,
        cpu_percent,
        threads,
        masks_per_second: generations.len() as f64 / wall.as_secs_f64(),
        mask_age_ms,
        footprint_before,
        footprint_steady,
        footprint_peak,
        footprint_after: footprint_mb(),
    }
}

fn report(runs: &mut [Run]) {
    println!(
        "| run | process p50 / p95 ms | worker CPU ms/frame | convert ms | process CPU % of a core | masks/s | mask age p50 ms | footprint +MB steady / peak / after drop |"
    );
    println!("|---|---|---|---|---|---|---|---|");
    for run in runs.iter_mut() {
        let p50 = percentile(&mut run.process_ms, 0.5);
        let p95 = percentile(&mut run.process_ms, 0.95);
        let cpu = run.worker_cpu_ms.iter().sum::<f64>() / run.worker_cpu_ms.len() as f64;
        let convert = percentile(&mut run.convert_ms, 0.5);
        let age = if run.mask_age_ms.is_empty() {
            f64::NAN
        } else {
            percentile(&mut run.mask_age_ms, 0.5)
        };
        println!(
            "| {} | {p50:.2} / {p95:.2} | {cpu:.2} | {convert:.2} | {:.1} | {:.1} | {age:.1} | {:+.0} / {:+.0} / {:+.0} |",
            run.label,
            run.cpu_percent,
            run.masks_per_second,
            run.footprint_steady - run.footprint_before,
            run.footprint_peak - run.footprint_before,
            run.footprint_after - run.footprint_before,
        );
    }
    println!();
    println!("| run | CPU % of a core by thread |");
    println!("|---|---|");
    for run in runs.iter() {
        let threads = run
            .threads
            .iter()
            .filter(|(_, percent)| *percent >= 0.05)
            .map(|(label, percent)| format!("{label} {percent:.1}"))
            .collect::<Vec<_>>()
            .join(", ");
        println!("| {} | {threads} |", run.label);
    }
}

#[test]
#[ignore = "benchmark: needs CAP_CAMERA_EFFECT_BENCH_IMAGES"]
fn live_effect_cost() {
    let photos = images();
    let sources = std::env::var("CAP_CAMERA_EFFECT_BENCH_SOURCES")
        .unwrap_or_else(|_| "1280x720,1920x1080,3840x2160".into());
    let modes = std::env::var("CAP_CAMERA_EFFECT_BENCH_MODES")
        .unwrap_or_else(|_| "remove,heavy,light".into());
    let interval = std::env::var("CAP_CAMERA_EFFECT_BENCH_INTERVAL_MS")
        .ok()
        .map(|ms| Duration::from_millis(ms.parse().unwrap()));
    let mut runs = Vec::new();
    for source in sources.split(',') {
        let (width, height) = source.split_once('x').unwrap();
        let (width, height): (usize, usize) = (width.parse().unwrap(), height.parse().unwrap());
        let frames = camera_frames(&photos, width, height);
        for mode in modes.split(',') {
            let mode = match mode {
                "remove" => BlurMode::Remove,
                "heavy" => BlurMode::Heavy,
                "light" => BlurMode::Light,
                other => panic!("unknown mode {other}"),
            };
            runs.push(run(format!("{mode:?} {source}"), &frames, mode, interval));
        }
    }
    report(&mut runs);
}

/// Frame-synchronous outputs (each frame composited with its own mask), so
/// two configurations can be compared frame by frame.
pub(super) fn synchronous_outputs(
    frames: &[Vec<arc::R<cv::PixelBuf>>],
    mode: BlurMode,
    count: usize,
) -> Vec<Vec<u8>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let (device, queue) = shared_device(&runtime).unwrap();
    let source = (frames[0][0].width(), frames[0][0].height());
    let mut converter = Converter::new(source);
    let mut worker = Worker::new(device, queue).unwrap();
    worker.processor.set_frame_synchronous(true);
    (0..count)
        .map(|index| {
            worker.processor.set_frame_time(index as f32 / FPS as f32);
            let photo = (index / (count / frames.len()).max(1)) % frames.len();
            let job = converter.convert(&frames[photo][index % PAN_POSITIONS], mode);
            let output = worker.process(&runtime, job).unwrap();
            with_bytes(&output.buffer.0, |bytes, stride| {
                let width = output.width as usize * 4;
                let mut pixels = Vec::with_capacity(width * output.height as usize);
                for row in bytes.chunks(stride).take(output.height as usize) {
                    pixels.extend_from_slice(&row[..width]);
                }
                pixels
            })
        })
        .collect()
}

pub(super) fn compare(reference: &[Vec<u8>], candidate: &[Vec<u8>]) -> String {
    let mut iou = Vec::new();
    let mut alpha_psnr = Vec::new();
    let mut color_psnr = Vec::new();
    let mut max_alpha_error = 0u8;
    assert_eq!(reference.len(), candidate.len(), "frame count mismatch");
    for (index, (reference, candidate)) in reference.iter().zip(candidate).enumerate() {
        assert_eq!(
            reference.len(),
            candidate.len(),
            "frame {index} byte length mismatch"
        );
        let (mut intersection, mut union) = (0u64, 0u64);
        let (mut alpha_error, mut color_error) = (0f64, 0f64);
        for (a, b) in reference.chunks_exact(4).zip(candidate.chunks_exact(4)) {
            let (inside_a, inside_b) = (a[3] >= 128, b[3] >= 128);
            intersection += u64::from(inside_a && inside_b);
            union += u64::from(inside_a || inside_b);
            let difference = f64::from(a[3]) - f64::from(b[3]);
            alpha_error += difference * difference;
            max_alpha_error = max_alpha_error.max(a[3].abs_diff(b[3]));
            for channel in 0..3 {
                let over_gray = |pixel: &[u8]| {
                    let alpha = f64::from(pixel[3]) / 255.0;
                    f64::from(pixel[channel]) * alpha + 128.0 * (1.0 - alpha)
                };
                let difference = over_gray(a) - over_gray(b);
                color_error += difference * difference;
            }
        }
        let pixels = (reference.len() / 4) as f64;
        let psnr = |mse: f64| {
            if mse == 0.0 {
                f64::INFINITY
            } else {
                10.0 * (255.0 * 255.0 / mse).log10()
            }
        };
        iou.push(if union == 0 {
            1.0
        } else {
            intersection as f64 / union as f64
        });
        alpha_psnr.push(psnr(alpha_error / pixels));
        color_psnr.push(psnr(color_error / (pixels * 3.0)));
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    let min = |values: &[f64]| values.iter().copied().fold(f64::INFINITY, f64::min);
    format!(
        "IoU mean {:.4} min {:.4} | alpha PSNR mean {:.1} min {:.1} dB | composite PSNR mean {:.1} min {:.1} dB | max alpha error {max_alpha_error}",
        mean(&iou),
        min(&iou),
        mean(&alpha_psnr),
        min(&alpha_psnr),
        mean(&color_psnr),
        min(&color_psnr),
    )
}

/// Remove-mode output of this build against itself and against a saved
/// reference (`CAP_CAMERA_EFFECT_BENCH_REFERENCE`, written by the first run
/// when absent), so a change can be shown to leave the effect identical.
#[test]
#[ignore = "benchmark: needs CAP_CAMERA_EFFECT_BENCH_IMAGES"]
fn effect_output_matches_reference() {
    let photos = images();
    let frames = camera_frames(&photos, 1920, 1080);
    let count = 90;
    let first = synchronous_outputs(&frames, BlurMode::Remove, count);
    let second = synchronous_outputs(&frames, BlurMode::Remove, count);
    println!("run to run: {}", compare(&first, &second));
    if let Ok(path) = std::env::var("CAP_CAMERA_EFFECT_BENCH_REFERENCE") {
        let path = std::path::Path::new(&path);
        if path.exists() {
            let bytes = std::fs::read(path).unwrap();
            let reference = bytes
                .chunks_exact(first[0].len())
                .map(<[u8]>::to_vec)
                .collect::<Vec<_>>();
            println!("against reference: {}", compare(&reference, &first));
        } else {
            std::fs::write(path, first.concat()).unwrap();
            println!("reference written to {}", path.display());
        }
    }
}
