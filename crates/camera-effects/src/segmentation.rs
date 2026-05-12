use anyhow::Context;
use ort::session::Session;
use ort::value::Value;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

const MODEL_BYTES: &[u8] = include_bytes!("../assets/selfie_segmentation.onnx");
const MODEL_INPUT_SIZE: usize = 256;

pub struct SegmentationModel {
    session: Session,
}

impl SegmentationModel {
    pub fn new() -> anyhow::Result<Self> {
        let session = create_session()?;
        Ok(Self { session })
    }

    pub fn run_inference(&mut self, rgba_256x256: &[u8]) -> anyhow::Result<Vec<f32>> {
        let channel_size = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
        let mut flat = vec![0.0f32; 3 * channel_size];

        let (r_plane, rest) = flat.split_at_mut(channel_size);
        let (g_plane, b_plane) = rest.split_at_mut(channel_size);

        for i in 0..channel_size {
            let px = i * 4;
            r_plane[i] = rgba_256x256[px] as f32 / 255.0;
            g_plane[i] = rgba_256x256[px + 1] as f32 / 255.0;
            b_plane[i] = rgba_256x256[px + 2] as f32 / 255.0;
        }

        let shape: Vec<usize> = vec![1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE];
        let input_value = Value::from_array((shape, flat.into_boxed_slice()))
            .context("Failed to create input tensor")?;

        let outputs = self
            .session
            .run(ort::inputs!["pixel_values" => input_value])
            .context("ONNX inference failed")?;

        let output_value = &outputs["alphas"];
        let (_shape, raw_data) = output_value
            .try_extract_tensor::<f32>()
            .context("Failed to extract output tensor")?;

        Ok(raw_data.to_vec())
    }
}

fn create_session() -> anyhow::Result<Session> {
    init_runtime()?;

    let mut builder = Session::builder().context("Failed to create ONNX session builder")?;

    #[cfg(target_os = "macos")]
    {
        builder = try_register_coreml(builder);
    }

    #[cfg(target_os = "windows")]
    {
        builder = try_register_directml(builder);
    }

    let session = builder
        .commit_from_memory(MODEL_BYTES)
        .context("Failed to load selfie segmentation model")?;

    tracing::info!(
        "Selfie segmentation model loaded, inputs: {:?}, outputs: {:?}",
        session
            .inputs()
            .iter()
            .map(|i| i.name())
            .collect::<Vec<_>>(),
        session
            .outputs()
            .iter()
            .map(|o| o.name())
            .collect::<Vec<_>>()
    );

    Ok(session)
}

#[cfg(target_os = "macos")]
fn init_runtime() -> anyhow::Result<()> {
    let path = std::env::var_os("ORT_DYLIB_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            onnx_runtime_candidates()
                .into_iter()
                .find(|path| path.exists())
        })
        .context("Failed to find macOS ONNX Runtime dylib")?;

    let _ = ort::init_from(&path)
        .with_context(|| format!("Failed to load ONNX Runtime from {}", path.display()))?
        .commit();

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn init_runtime() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn onnx_runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        candidates.push(exe_dir.join("libonnxruntime.dylib"));

        if let Some(contents_dir) = exe_dir.parent() {
            candidates.push(
                contents_dir
                    .join("Resources")
                    .join("onnxruntime")
                    .join("lib")
                    .join("libonnxruntime.dylib"),
            );
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/native-deps/onnxruntime/lib/libonnxruntime.dylib"),
    );

    candidates
}

#[cfg(target_os = "macos")]
fn try_register_coreml(
    builder: ort::session::builder::SessionBuilder,
) -> ort::session::builder::SessionBuilder {
    match builder.with_execution_providers([
        ort::execution_providers::CoreMLExecutionProvider::default().build(),
    ]) {
        Ok(b) => {
            tracing::info!("Camera background blur: CoreML execution provider registered");
            b
        }
        Err(e) => {
            tracing::warn!("Camera background blur: CoreML EP registration failed, using CPU: {e}");
            e.recover()
        }
    }
}

#[cfg(target_os = "windows")]
fn try_register_directml(
    builder: ort::session::builder::SessionBuilder,
) -> ort::session::builder::SessionBuilder {
    match builder.with_execution_providers([
        ort::execution_providers::DirectMLExecutionProvider::default().build(),
    ]) {
        Ok(b) => {
            tracing::info!("Camera background blur: DirectML execution provider registered");
            b
        }
        Err(e) => {
            tracing::warn!(
                "Camera background blur: DirectML EP registration failed, using CPU: {e}"
            );
            e.recover()
        }
    }
}
