//! Cost of acquiring GPU layer pipelines for one export-preview frame.
//!
//! Baseline mirrors what `render_preview_frame` did before pooling:
//! `RendererLayers::new_with_options` on every frame, paying full
//! shader/pipeline compilation each time. Improved measures the
//! `take_reusable_layers` / `return_reusable_layers` round trip used now.
//!
//! Run: `cargo run --release -p cap-export --example preview-layers-benchmark`
//! Needs a wgpu adapter; the software fallback is fine, the cost under test
//! is pipeline compilation, not rasterization.

use std::time::Instant;

use cap_rendering::{
    RendererLayers, create_shared_device, return_reusable_layers, take_reusable_layers,
};

const ITERATIONS: usize = 5;
const KEY: &str = "preview-layers-benchmark";

fn report(label: &str, samples: &mut [f64]) {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN timings"));
    let n = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / n;
    let p50 = samples[(n * 0.5) as usize];
    let max = samples[samples.len() - 1];
    println!(
        "{label}: n={} mean={mean:.1}ms p50={p50:.1}ms max={max:.1}ms",
        samples.len()
    );
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let shared = create_shared_device().await?;

    let mut baseline_ms = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        let layers = RendererLayers::new_with_options(
            &shared.device,
            &shared.queue,
            shared.is_software_adapter,
        );
        baseline_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        drop(layers);
    }

    return_reusable_layers(
        shared.device.clone(),
        KEY.to_string(),
        RendererLayers::new_with_options(&shared.device, &shared.queue, shared.is_software_adapter),
    );

    let mut pooled_ms = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        let layers = take_reusable_layers(&shared.device, KEY).expect("pool primed above");
        pooled_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        return_reusable_layers(shared.device.clone(), KEY.to_string(), layers);
    }

    report("baseline build layers per frame", &mut baseline_ms);
    report("pooled take layers per frame  ", &mut pooled_ms);
    let base_mean = baseline_ms.iter().sum::<f64>() / baseline_ms.len() as f64;
    let pool_mean = pooled_ms.iter().sum::<f64>() / pooled_ms.len() as f64;
    println!(
        "per-frame saving: {saved:.1}ms ({reduction:.1}x)",
        saved = base_mean - pool_mean,
        reduction = base_mean / pool_mean.max(0.001),
    );
    Ok(())
}
