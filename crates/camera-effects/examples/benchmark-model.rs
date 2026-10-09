#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use ort::{ep, session::Session, value::TensorRef};
    use std::time::Instant;

    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "usage: benchmark-model INPUT.rgba default|program|neural|cpu|cpu1|cpu2|cpu4"
    );
    anyhow::ensure!(
        matches!(
            args[2].as_str(),
            "default" | "program" | "neural" | "cpu" | "cpu1" | "cpu2" | "cpu4"
        ),
        "unknown execution provider configuration"
    );
    let rgba = std::fs::read(&args[1])?;
    anyhow::ensure!(rgba.len() == 256 * 256 * 4, "expected a 256x256 RGBA frame");
    cap_camera_effects::initialize_onnx_runtime()?;
    let mut provider = ep::CoreML::default();
    if args[2] == "program" || args[2] == "neural" {
        provider = provider.with_model_format(ep::coreml::ModelFormat::MLProgram);
    }
    if args[2] == "neural" {
        provider = provider.with_compute_units(ep::coreml::ComputeUnits::CPUAndNeuralEngine);
    }
    let start = Instant::now();
    let mut builder = Session::builder()?
        .with_intra_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("{error}"))?
        .with_inter_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    if let Some(threads) = args[2]
        .strip_prefix("cpu")
        .filter(|value| !value.is_empty())
    {
        builder = builder
            .with_intra_threads(threads.parse()?)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    if !args[2].starts_with("cpu") {
        builder = builder
            .with_execution_providers([provider.build().error_on_failure()])
            .map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    let mut session =
        builder.commit_from_memory(include_bytes!("../assets/selfie_segmentation.onnx"))?;
    eprintln!("init_ms={:.2}", start.elapsed().as_secs_f64() * 1000.0);
    let mut input = vec![0.0_f32; 3 * 256 * 256];
    for (index, pixel) in rgba.chunks_exact(4).enumerate() {
        for (channel, &value) in pixel.iter().take(3).enumerate() {
            input[channel * 256 * 256 + index] = f32::from(value) / 255.0;
        }
    }
    let mut timings = Vec::new();
    for _ in 0..120 {
        let value = TensorRef::from_array_view(([1usize, 3, 256, 256], input.as_slice()))?;
        let start = Instant::now();
        let output = session.run(ort::inputs!["pixel_values" => value])?;
        let (_, mask) = output["alphas"].try_extract_tensor::<f32>()?;
        anyhow::ensure!(
            mask.len() == 256 * 256 && mask.iter().all(|value| value.is_finite()),
            "invalid mask"
        );
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    timings.remove(0);
    timings.sort_by(f64::total_cmp);
    eprintln!(
        "{} p50_ms={:.2} p95_ms={:.2}",
        args[2], timings[59], timings[113]
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This benchmark compares macOS execution providers.");
}
