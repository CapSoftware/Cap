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
pub(crate) fn init_runtime() -> anyhow::Result<()> {
    let path = onnx_runtime_library_path().context("Failed to find ONNX Runtime library")?;
    let (library, path) = preflight_runtime(&path)?;

    let _ = ort::init_from(&path)
        .with_context(|| format!("Failed to load ONNX Runtime from {}", path.display()))?
        .commit();
    drop(library);

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn preflight_runtime(path: &std::path::Path) -> anyhow::Result<(libloading::Library, PathBuf)> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let executable = std::env::current_exe().context("Failed to locate current executable")?;
        let executable_relative = executable
            .parent()
            .context("Current executable has no parent directory")?
            .join(path);
        if executable_relative.exists() {
            executable_relative
        } else {
            path.to_path_buf()
        }
    };

    // ort rc.12 constructs loader errors through its not-yet-loaded API, which
    // recursively enters its initialization lock. Validate before entering ort,
    // retaining this handle until ort has acquired its own reference.
    let library = unsafe { libloading::Library::new(&path) }
        .with_context(|| format!("Failed to load ONNX Runtime from {}", path.display()))?;
    unsafe {
        let get_api_base = library
            .get::<unsafe extern "C" fn() -> *const ort::sys::OrtApiBase>(b"OrtGetApiBase\0")
            .context("ONNX Runtime is missing OrtGetApiBase")?;
        let base = get_api_base()
            .as_ref()
            .context("ONNX Runtime returned a null API base")?;
        let version = (base.GetVersionString)();
        anyhow::ensure!(!version.is_null(), "ONNX Runtime returned a null version");
        let version = std::ffi::CStr::from_ptr(version)
            .to_str()
            .context("ONNX Runtime returned an invalid version string")?;
        validate_runtime_version(version)?;
        anyhow::ensure!(
            !(base.GetApi)(ort::sys::ORT_API_VERSION).is_null(),
            "ONNX Runtime {version} does not provide API version {}",
            ort::sys::ORT_API_VERSION
        );
    }
    Ok((library, path))
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
fn validate_runtime_version(version: &str) -> anyhow::Result<()> {
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    anyhow::ensure!(
        major == Some(1) && minor.is_some_and(|minor| minor >= ort::MINOR_VERSION),
        "Unsupported ONNX Runtime version {version:?}; expected 1.{}.x or newer compatible 1.x runtime",
        ort::MINOR_VERSION
    );
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
pub(crate) fn init_runtime() -> anyhow::Result<()> {
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

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    #[test]
    fn runtime_version_requires_compatible_major_and_api() {
        for minor in [ort::MINOR_VERSION, ort::MINOR_VERSION + 1] {
            super::validate_runtime_version(&format!("1.{minor}.0")).unwrap();
        }
        let older = format!("1.{}.0", ort::MINOR_VERSION.saturating_sub(1));
        for version in ["", "1", &older, "2.24.2", "x.24.2", "1.invalid.0"] {
            assert!(
                super::validate_runtime_version(version).is_err(),
                "{version}"
            );
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    #[test]
    fn runtime_load_failures_remain_retryable() {
        const CHILD_ENV: &str = "CAP_CAMERA_EFFECTS_LOADER_TEST_CHILD";
        if let Some(path) = std::env::var_os(CHILD_ENV) {
            assert!(crate::initialize_onnx_runtime().is_err());
            std::fs::write(&path, b"invalid ONNX Runtime library").unwrap();
            assert!(crate::initialize_onnx_runtime().is_err());
            return;
        }

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("cap-onnx-loader-{}-{unique}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(super::ORT_LIBRARY_NAME);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "segmentation::tests::runtime_load_failures_remain_retryable",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, &path)
            .env("ORT_DYLIB_PATH", &path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let timed_out = loop {
            if child.try_wait().unwrap().is_some() {
                break false;
            }
            if started.elapsed() >= std::time::Duration::from_secs(10) {
                child.kill().unwrap();
                break true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let output = child.wait_with_output().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
        assert!(!timed_out, "ONNX Runtime loader did not return after 10s");
        assert!(
            output.status.success(),
            "ONNX Runtime loader child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

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
