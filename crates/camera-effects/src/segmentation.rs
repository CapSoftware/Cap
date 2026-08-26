use anyhow::Context;
use ort::session::Session;
use ort::value::TensorRef;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
use std::path::PathBuf;

#[cfg(target_os = "macos")]
const ORT_LIBRARY_NAME: &str = "libonnxruntime.dylib";
#[cfg(target_os = "linux")]
const ORT_LIBRARY_NAME: &str = "libonnxruntime.so";
#[cfg(target_os = "windows")]
const ORT_LIBRARY_NAME: &str = "onnxruntime.dll";

const MODEL_BYTES: &[u8] = include_bytes!("../assets/selfie_segmentation.onnx");
const MODEL_INPUT_SIZE: usize = 256;
const MODEL_CHANNEL_SIZE: usize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;

pub struct SegmentationModel {
    session: Session,
    input: Vec<f32>,
    output: Vec<f32>,
}

impl SegmentationModel {
    pub fn new() -> anyhow::Result<Self> {
        let session = create_session()?;
        Ok(Self {
            session,
            input: vec![0.0; 3 * MODEL_CHANNEL_SIZE],
            output: Vec::with_capacity(MODEL_CHANNEL_SIZE),
        })
    }

    pub fn run_inference(&mut self, rgba_256x256: &[u8]) -> anyhow::Result<&[f32]> {
        populate_rgb_planes(&mut self.input, rgba_256x256);
        let input_value = TensorRef::from_array_view((
            [1usize, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE],
            self.input.as_slice(),
        ))
        .context("Failed to create input tensor")?;

        let outputs = self
            .session
            .run(ort::inputs!["pixel_values" => input_value])
            .context("ONNX inference failed")?;

        let output_value = &outputs["alphas"];
        let (_shape, raw_data) = output_value
            .try_extract_tensor::<f32>()
            .context("Failed to extract output tensor")?;

        self.output.clear();
        self.output.extend_from_slice(raw_data);
        Ok(&self.output)
    }
}

fn populate_rgb_planes(input: &mut [f32], rgba: &[u8]) {
    let (red, rest) = input.split_at_mut(MODEL_CHANNEL_SIZE);
    let (green, blue) = rest.split_at_mut(MODEL_CHANNEL_SIZE);

    for (index, pixel) in rgba.chunks_exact(4).take(MODEL_CHANNEL_SIZE).enumerate() {
        red[index] = f32::from(pixel[0]) / 255.0;
        green[index] = f32::from(pixel[1]) / 255.0;
        blue[index] = f32::from(pixel[2]) / 255.0;
    }
}

fn create_session() -> anyhow::Result<Session> {
    init_runtime()?;

    let mut builder = Session::builder()
        .context("Failed to create ONNX session builder")?
        .with_intra_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("Failed to disable ONNX intra-op spinning: {error}"))?
        .with_inter_op_spinning(false)
        .map_err(|error| anyhow::anyhow!("Failed to disable ONNX inter-op spinning: {error}"))?;

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

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn init_runtime() -> anyhow::Result<()> {
    let path = onnx_runtime_library_path().context("Failed to find ONNX Runtime library")?;

    let _ = ort::init_from(&path)
        .with_context(|| format!("Failed to load ONNX Runtime from {}", path.display()))?
        .commit();

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub(crate) fn onnx_runtime_library_path() -> Option<PathBuf> {
    std::env::var_os("ORT_DYLIB_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            onnx_runtime_candidates()
                .into_iter()
                .find(|path| path.exists())
        })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn init_runtime() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn onnx_runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe()
        && let Some(exe_dir) = exe.parent()
    {
        candidates.push(exe_dir.join(ORT_LIBRARY_NAME));

        if let Some(contents_dir) = exe_dir.parent() {
            candidates.push(
                contents_dir
                    .join("Resources")
                    .join("onnxruntime")
                    .join("lib")
                    .join(ORT_LIBRARY_NAME),
            );
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/native-deps/onnxruntime/lib")
            .join(ORT_LIBRARY_NAME),
    );

    candidates
}

// `error_on_failure` is load-bearing in both registrars: without it ort swallows
// registration failures and returns Ok (it only logs through its own internal
// logger), so a CPU-only runtime DLL would make the "registered" log a false
// positive while inference silently runs on CPU.

#[cfg(target_os = "macos")]
fn try_register_coreml(
    builder: ort::session::builder::SessionBuilder,
) -> ort::session::builder::SessionBuilder {
    match builder.with_execution_providers([
        ort::execution_providers::CoreMLExecutionProvider::default()
            .build()
            .error_on_failure(),
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
        ort::execution_providers::DirectMLExecutionProvider::default()
            .build()
            .error_on_failure(),
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

#[cfg(test)]
mod tests {
    use super::{MODEL_CHANNEL_SIZE, populate_rgb_planes};

    #[test]
    fn rgba_pixels_are_written_to_normalized_rgb_planes() {
        let mut input = vec![f32::NAN; 3 * MODEL_CHANNEL_SIZE];
        let mut rgba = vec![0; 4 * MODEL_CHANNEL_SIZE];
        rgba[..8].copy_from_slice(&[255, 128, 64, 17, 32, 16, 8, 222]);
        let last_pixel = rgba.len() - 4;
        rgba[last_pixel..].copy_from_slice(&[10, 20, 30, 40]);

        populate_rgb_planes(&mut input, &rgba);

        assert_eq!(input[0], 1.0);
        assert_eq!(input[1], 32.0 / 255.0);
        assert_eq!(input[MODEL_CHANNEL_SIZE], 128.0 / 255.0);
        assert_eq!(input[MODEL_CHANNEL_SIZE + 1], 16.0 / 255.0);
        assert_eq!(input[2 * MODEL_CHANNEL_SIZE], 64.0 / 255.0);
        assert_eq!(input[2 * MODEL_CHANNEL_SIZE + 1], 8.0 / 255.0);
        assert_eq!(input[MODEL_CHANNEL_SIZE - 1], 10.0 / 255.0);
        assert_eq!(input[2 * MODEL_CHANNEL_SIZE - 1], 20.0 / 255.0);
        assert_eq!(input[3 * MODEL_CHANNEL_SIZE - 1], 30.0 / 255.0);
    }

    #[test]
    fn rgba_planes_are_overwritten_without_reallocating() {
        let mut input = vec![0.0; 3 * MODEL_CHANNEL_SIZE];
        let mut rgba = vec![0; 4 * MODEL_CHANNEL_SIZE];
        let pointer = input.as_ptr();
        rgba[..4].copy_from_slice(&[255, 0, 0, 255]);

        populate_rgb_planes(&mut input, &rgba);
        rgba[..4].copy_from_slice(&[0, 255, 128, 0]);
        populate_rgb_planes(&mut input, &rgba);

        assert_eq!(input.as_ptr(), pointer);
        assert_eq!(input[0], 0.0);
        assert_eq!(input[MODEL_CHANNEL_SIZE], 1.0);
        assert_eq!(input[2 * MODEL_CHANNEL_SIZE], 128.0 / 255.0);
    }
}
