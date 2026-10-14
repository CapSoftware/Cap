//! Model-update counts in the export-progress drain loop, at 60 msg/s with a
//! 50 ms consumer over 5 s.
//!
//! Measures update invocations, not `cx.notify()` render cost.
//!
//! Run: cargo run -p cap-desktop-gpui --example export-progress-coalesce-benchmark --release

use std::hint::black_box;
use std::time::{Duration, Instant};

const MESSAGE_RATE_PER_SEC: u64 = 60;
const CONSUMER_CADENCE_MS: u64 = 50;
const RUN_SECS: u64 = 5;

#[derive(Default)]
struct MockExportUi {
    rendered: u32,
    total_frames: u32,
    phase: u8,
    label: String,
}

#[inline(never)]
fn mock_update(ui: &mut MockExportUi, rendered: u32, total: u32) {
    ui.rendered = rendered;
    ui.total_frames = total;
    ui.phase = 1;
    ui.label = format!("{rendered} / {total} frames");
    black_box(&ui.label);
}

fn report(label: &str, samples: &mut [f64]) {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
    let n = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / n;
    let p50 = samples[(n * 0.50) as usize];
    let p95 = samples[(n * 0.95) as usize];
    println!("{label}: n={} mean={mean:.2}us p50={p50:.2}us p95={p95:.2}us", samples.len());
}

fn spawn_producer() -> flume::Receiver<(u32, u32)> {
    let (tx, rx) = flume::unbounded::<(u32, u32)>();
    let total = (MESSAGE_RATE_PER_SEC * RUN_SECS) as u32;
    std::thread::spawn(move || {
        let interval = Duration::from_nanos(1_000_000_000 / MESSAGE_RATE_PER_SEC);
        for i in 1..=total {
            let _ = tx.send((i.min(total), total));
            std::thread::sleep(interval);
        }
    });
    rx
}

fn run_old() -> (u64, Vec<f64>, (u32, u32)) {
    let rx = spawn_producer();
    let mut ui = MockExportUi::default();
    let mut updates = 0;
    let mut costs = Vec::new();
    loop {
        while let Ok((rendered, total)) = rx.try_recv() {
            let started = Instant::now();
            mock_update(&mut ui, rendered, total);
            black_box(&mut ui);
            updates += 1;
            costs.push(started.elapsed().as_secs_f64() * 1e6);
        }
        if rx.is_disconnected() {
            break;
        }
        std::thread::sleep(Duration::from_millis(CONSUMER_CADENCE_MS));
    }
    (updates, costs, (ui.rendered, ui.total_frames))
}

fn run_new() -> (u64, Vec<f64>, (u32, u32)) {
    let rx = spawn_producer();
    let mut ui = MockExportUi::default();
    let mut updates = 0;
    let mut costs = Vec::new();
    loop {
        let mut latest: Option<(u32, u32)> = None;
        while let Ok((rendered, total)) = rx.try_recv() {
            latest = Some((rendered, total));
        }
        if let Some((rendered, total)) = latest {
            let started = Instant::now();
            mock_update(&mut ui, rendered, total);
            black_box(&mut ui);
            updates += 1;
            costs.push(started.elapsed().as_secs_f64() * 1e6);
        }
        if rx.is_disconnected() {
            break;
        }
        std::thread::sleep(Duration::from_millis(CONSUMER_CADENCE_MS));
    }
    (updates, costs, (ui.rendered, ui.total_frames))
}

fn main() {
    println!(
        "export progress drain: {MESSAGE_RATE_PER_SEC} msg/s for {RUN_SECS}s, consumer every {CONSUMER_CADENCE_MS}ms"
    );
    let (old_updates, mut old_costs, old_final) = run_old();
    let (new_updates, mut new_costs, new_final) = run_new();

    assert_eq!(old_final, new_final, "visible end state must match");
    assert_eq!(old_final.0, old_final.1, "progress must reach 100%");

    println!("old updates: {old_updates}");
    println!("new updates: {new_updates}");
    println!(
        "update reduction: {:.1}x",
        old_updates as f64 / new_updates as f64
    );
    println!("final UI state old={old_final:?} new={new_final:?} (identical)");
    report("old per-update cost", &mut old_costs);
    report("new per-update cost", &mut new_costs);
}
