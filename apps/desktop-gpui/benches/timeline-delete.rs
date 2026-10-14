use cap_project::{ImageSegment, TextSegment, ZoomMode, ZoomSegment};
use serde::Serialize;
use std::{
    fs::File,
    hint::black_box,
    io::{BufWriter, Write},
    time::{Duration, Instant},
};

#[path = "../src/editor_edits/indices.rs"]
mod indices;

fn text_fixture(count: usize) -> Vec<TextSegment> {
    (0..count)
        .map(|index| {
            serde_json::from_value(serde_json::json!({
                "start": index as f64 * 3.,
                "end": index as f64 * 3. + 2.,
                "content": format!("Text overlay {index}"),
            }))
            .expect("valid text segment")
        })
        .collect()
}

fn image_fixture(count: usize) -> Vec<ImageSegment> {
    (0..count)
        .map(|index| ImageSegment {
            start: index as f64 * 3.,
            end: index as f64 * 3. + 2.,
            path: format!("content/images/image-{index}.png"),
            name: format!("Image {index}"),
            ..Default::default()
        })
        .collect()
}

fn zoom_fixture(count: usize) -> Vec<ZoomSegment> {
    (0..count)
        .map(|index| ZoomSegment {
            start: index as f64 * 3.,
            end: index as f64 * 3. + 2.,
            amount: 2.,
            mode: ZoomMode::Auto,
            glide_direction: Default::default(),
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        })
        .collect()
}

fn remove_one_at_a_time<T>(segments: &mut Vec<T>, selected: &[usize]) -> bool {
    let sorted = indices::descending_indices(selected, segments.len());
    if sorted.is_empty() {
        return false;
    }
    for index in sorted {
        segments.remove(index);
    }
    true
}

fn sample<T: Clone>(
    source: &[T],
    selected: &[usize],
    delete: fn(&mut Vec<T>, &[usize]) -> bool,
    batch: usize,
) -> Duration {
    let mut inputs: Vec<Vec<T>> = (0..batch).map(|_| source.to_vec()).collect();
    let expected_change = selected.iter().any(|index| *index < source.len());
    let started = Instant::now();
    let mut changed = false;
    for segments in &mut inputs {
        changed |= black_box(delete(black_box(segments), black_box(selected)));
    }
    let elapsed = started.elapsed();
    assert_eq!(changed, expected_change);
    black_box(&inputs);
    elapsed
}

fn run_case<T: Clone + Serialize>(
    segment_type: &str,
    name: &str,
    source: &[T],
    selected: &[usize],
    csv: &mut Option<BufWriter<File>>,
) {
    let mut before = source.to_vec();
    let mut after = source.to_vec();
    assert_eq!(
        remove_one_at_a_time(&mut before, selected),
        indices::delete_indices(&mut after, selected)
    );
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&after).unwrap()
    );
    drop(before);
    drop(after);

    let batch = if selected.len() <= 2 {
        if source.len() <= 512 { 64 } else { 8 }
    } else {
        1
    };
    let iterations = 101;
    for _ in 0..10 {
        sample(source, selected, remove_one_at_a_time, batch);
        sample(source, selected, indices::delete_indices, batch);
    }

    let mut before = Vec::with_capacity(iterations);
    let mut after = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        let (old, new) = if iteration % 2 == 0 {
            let old = sample(source, selected, remove_one_at_a_time, batch);
            (
                old,
                sample(source, selected, indices::delete_indices, batch),
            )
        } else {
            let new = sample(source, selected, indices::delete_indices, batch);
            (sample(source, selected, remove_one_at_a_time, batch), new)
        };
        if let Some(csv) = csv.as_mut() {
            writeln!(
                csv,
                "{segment_type},{},{name},{},{},{batch},{iteration},{},{}",
                std::mem::size_of::<T>(),
                source.len(),
                selected.len(),
                old.as_nanos(),
                new.as_nanos()
            )
            .unwrap();
        }
        before.push(old);
        after.push(new);
    }
    before.sort_unstable();
    after.sort_unstable();
    let micros = |duration: Duration| duration.as_secs_f64() * 1_000_000. / batch as f64;
    let old_p50 = micros(before[iterations / 2]);
    let new_p50 = micros(after[iterations / 2]);
    let old_p95 = micros(before[iterations * 95 / 100]);
    let new_p95 = micros(after[iterations * 95 / 100]);
    println!(
        "{segment_type:<5} {name:<24} segments={:<5} selected={:<5} batch={batch:<2} before_p50_us={old_p50:>10.3} after_p50_us={new_p50:>10.3} before_p95_us={old_p95:>10.3} after_p95_us={new_p95:>10.3} speedup={:>7.2}x",
        source.len(),
        selected.len(),
        old_p50 / new_p50
    );
}

fn run_suite<T: Clone + Serialize>(
    segment_type: &str,
    fixture: fn(usize) -> Vec<T>,
    csv: &mut Option<BufWriter<File>>,
) {
    println!(
        "{segment_type}: actual cap-project type, {} inline bytes",
        std::mem::size_of::<T>()
    );
    for count in [64, 512, 5000] {
        let source = fixture(count);
        for (name, selected) in [
            ("empty-selection", vec![]),
            ("invalid-selection", vec![count, usize::MAX]),
            ("single-middle", vec![count / 2]),
            ("single-tail", vec![count - 1]),
            ("pair-head-tail", vec![0, count - 1]),
            ("pair-middle-tail", vec![count / 2, count - 1]),
            ("pair-near-tail", vec![count - 3, count - 1]),
            ("contiguous-middle", (count / 4..count / 2).collect()),
            ("prefix-half", (0..count / 2).collect()),
            ("trailing-half", (count / 2..count).collect()),
            ("alternating-half", (0..count).step_by(2).collect()),
            ("sparse-five-percent", (0..count).step_by(20).collect()),
            ("all", (0..count).collect()),
        ] {
            run_case(segment_type, name, &source, &selected, csv);
        }
    }
}

fn main() {
    println!(
        "Actual cap-project segment deletion helper. Setup/cloning and final survivor destruction excluded; normalization, deletion and removed-value destruction included. Serialized output equality checked for every case. Ten warmups; 101 alternating samples; batched small selections; p50/p95 of per-operation batch averages. 5,000 segments is a stress workload."
    );
    let mut csv = std::env::var_os("CAP_TIMELINE_BENCH_CSV")
        .map(|path| BufWriter::new(File::create(path).expect("create benchmark CSV")));
    if let Some(csv) = csv.as_mut() {
        writeln!(csv, "segment_type,inline_bytes,workload,segments,selected,batch,sample,before_total_ns,after_total_ns").unwrap();
    }
    run_suite("text", text_fixture, &mut csv);
    run_suite("image", image_fixture, &mut csv);
    run_suite("zoom", zoom_fixture, &mut csv);
    if let Some(csv) = csv.as_mut() {
        csv.flush().unwrap();
    }
}
