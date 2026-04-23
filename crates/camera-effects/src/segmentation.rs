use anyhow::Context;
use ort::session::Session;
use ort::value::Value;

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
