use std::{hint::black_box, time::Duration, time::Instant};

#[path = "../src/editor_edits/indices.rs"]
mod indices;

#[derive(Clone, PartialEq, Debug)]
struct ModeledTextSegment {
    strings: [String; 4],
    optional_strings: [Option<String>; 2],
    geometry_and_timing: [f64; 10],
    styling: [f32; 8],
    track: u32,
    flags: [u8; 8],
}

fn fixture(count: usize) -> Vec<ModeledTextSegment> {
    (0..count)
        .map(|index| ModeledTextSegment {
            strings: [
                format!("Text overlay {index}: {}", "recorded content ".repeat(8)),
                String::from("Inter"),
                String::from("#FFFFFF"),
                String::from("#000000"),
            ],
            optional_strings: [Some(String::from("#121212")), Some(String::from("#AA88FF"))],
            geometry_and_timing: [index as f64; 10],
            styling: [1.; 8],
            track: 0,
            flags: [0; 8],
        })
        .collect()
}

fn remove_one_at_a_time<T>(segments: &mut Vec<T>, indices: &[usize]) -> bool {
    let sorted = indices::descending_indices(indices, segments.len());
    if sorted.is_empty() {
        return false;
    }
    for index in sorted {
        segments.remove(index);
    }
    true
}

fn sample(
    source: &[ModeledTextSegment],
    selected: &[usize],
    delete: fn(&mut Vec<ModeledTextSegment>, &[usize]) -> bool,
) -> Duration {
    let mut segments = source.to_vec();
    let started = Instant::now();
    let changed = black_box(delete(black_box(&mut segments), black_box(selected)));
    let elapsed = started.elapsed();
    assert!(changed);
    black_box(&segments);
    elapsed
}

fn run_case(name: &str, count: usize, selected: Vec<usize>, iterations: usize) {
    let source = fixture(count);
    let mut before = source.clone();
    let mut after = source.clone();
    assert_eq!(
        remove_one_at_a_time(&mut before, &selected),
        indices::delete_indices(&mut after, &selected)
    );
    assert_eq!(before, after);
    drop(before);
    drop(after);

    for _ in 0..10 {
        sample(&source, &selected, remove_one_at_a_time);
        sample(&source, &selected, indices::delete_indices);
    }

    let mut before = Vec::with_capacity(iterations);
    let mut after = Vec::with_capacity(iterations);
    for iteration in 0..iterations {
        if iteration % 2 == 0 {
            before.push(sample(&source, &selected, remove_one_at_a_time));
            after.push(sample(&source, &selected, indices::delete_indices));
        } else {
            after.push(sample(&source, &selected, indices::delete_indices));
            before.push(sample(&source, &selected, remove_one_at_a_time));
        }
    }
    before.sort_unstable();
    after.sort_unstable();
    let before = before[iterations / 2].as_secs_f64() * 1_000_000.;
    let after = after[iterations / 2].as_secs_f64() * 1_000_000.;
    println!(
        "{name:<24} segments={count:<5} deleted={:<5} before_us={before:>10.3} after_us={after:>10.3} speedup={:>7.2}x",
        selected.len(),
        before / after
    );
}

fn main() {
    println!(
        "Timeline deletion helper; modeled text segments: {} inline bytes, six owned strings. Setup/cloning and survivor destruction excluded; deletion and removed-value destruction included. Median of alternating runs, after equality checks.",
        std::mem::size_of::<ModeledTextSegment>()
    );
    run_case("single-middle-small", 64, vec![32], 2000);
    run_case("single-tail-small", 64, vec![63], 2000);
    run_case("pair-middle-small", 64, vec![16, 32], 2000);
    run_case("single-middle-large", 5000, vec![2500], 500);
    run_case("single-tail-large", 5000, vec![4999], 500);
    run_case("trailing-pair-large", 5000, vec![4998, 4999], 500);
    run_case("sparse-near-tail-large", 5000, vec![4997, 4999], 500);
    run_case("trailing-half-large", 5000, (2500..5000).collect(), 100);
    run_case(
        "alternating-half-small",
        512,
        (0..512).step_by(2).collect(),
        500,
    );
    run_case(
        "alternating-half-large",
        5000,
        (0..5000).step_by(2).collect(),
        100,
    );
    run_case("prefix-half-large", 5000, (0..2500).collect(), 100);
    run_case(
        "sparse-five-percent",
        5000,
        (0..5000).step_by(20).collect(),
        100,
    );
}
