#[cfg(feature = "onnx")]
use std::path::Path;

#[cfg(feature = "onnx")]
use ort::session::{Session, builder::GraphOptimizationLevel};
#[cfg(feature = "onnx")]
use ort::value::TensorRef;

use crate::Error;
use crate::fbank::Window;
#[cfg(feature = "onnx")]
use crate::fbank::{Fbank, NUM_BINS};

/// Turns a stretch of 16 kHz mono speech into a speaker embedding. Returned
/// vectors are L2-normalised so a dot product is the cosine similarity.
pub trait Embed: Send {
    fn dim(&self) -> usize;
    /// Identifies the model, so voice profiles made with another model are
    /// never compared with this one.
    fn model_id(&self) -> &str;
    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, Error>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    pub input: String,
    pub output: String,
    pub dim: usize,
    pub sample_scale: f32,
    pub mean_normalize: bool,
    pub window: Window,
}

#[cfg(feature = "onnx")]
pub struct OnnxEmbedder {
    session: Session,
    info: ModelInfo,
    fbank: Fbank,
    feats: Vec<f32>,
}

#[cfg(feature = "onnx")]
impl OnnxEmbedder {
    /// Loads a filterbank-input speaker model. The ONNX Runtime library must
    /// already be initialised by the caller.
    ///
    /// `optimize` must stay off for the CAM++ family: ONNX Runtime 1.24 folds
    /// its graph for the export's example length, after which every shorter
    /// input embeds to noise (cosine ~0 against the unoptimised graph).
    pub fn load(path: &Path, threads: usize, optimize: bool) -> Result<Self, Error> {
        let level = if optimize {
            GraphOptimizationLevel::Level3
        } else {
            GraphOptimizationLevel::Disable
        };
        let session = Session::builder()
            .map_err(Error::runtime)?
            .with_optimization_level(level)
            .map_err(Error::runtime)?
            .with_intra_threads(threads.max(1))
            .map_err(Error::runtime)?
            .with_inter_threads(1)
            .map_err(Error::runtime)?
            .with_intra_op_spinning(false)
            .map_err(Error::runtime)?
            .with_inter_op_spinning(false)
            .map_err(Error::runtime)?
            .commit_from_file(path)
            .map_err(Error::runtime)?;
        let info = model_info(&session, path)?;
        Ok(Self {
            fbank: Fbank::new(info.window),
            session,
            info,
            feats: Vec::new(),
        })
    }

    pub fn info(&self) -> &ModelInfo {
        &self.info
    }

    fn run(&mut self, window: &[f32]) -> Result<Vec<f32>, Error> {
        let frames = Fbank::frames(window.len());
        if frames == 0 {
            return Err(Error::TooShort);
        }
        self.feats.clear();
        self.fbank.compute(
            window,
            self.info.sample_scale,
            self.info.mean_normalize,
            &mut self.feats,
        );
        let input = TensorRef::from_array_view(([1, frames, NUM_BINS], &*self.feats))
            .map_err(Error::runtime)?;
        let outputs = self
            .session
            .run(ort::inputs![self.info.input.as_str() => input])
            .map_err(Error::runtime)?;
        let (_, data) = outputs[self.info.output.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(Error::runtime)?;
        if data.len() != self.info.dim {
            return Err(Error::Model(format!(
                "expected {} values, got {}",
                self.info.dim,
                data.len()
            )));
        }
        Ok(normalized(data))
    }
}

#[cfg(feature = "onnx")]
impl Embed for OnnxEmbedder {
    fn dim(&self) -> usize {
        self.info.dim
    }

    fn model_id(&self) -> &str {
        &self.info.id
    }

    /// One window per run: on a single CPU thread a batch of windows costs
    /// about 2.5 times more per window than running them one by one.
    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, Error> {
        windows.iter().map(|w| self.run(w)).collect()
    }
}

#[cfg(feature = "onnx")]
fn model_info(session: &Session, path: &Path) -> Result<ModelInfo, Error> {
    let input = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or_else(|| Error::Model("model has no inputs".into()))?;
    let output = session
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or_else(|| Error::Model("model has no outputs".into()))?;
    let meta = session.metadata().map_err(Error::runtime)?;
    let custom = |key: &str| meta.custom(key);
    let dim = custom("output_dim")
        .and_then(|d| d.parse::<usize>().ok())
        .ok_or_else(|| Error::Model("model metadata lacks output_dim".into()))?;
    if custom("sample_rate").is_some_and(|r| r != "16000") {
        return Err(Error::Model("model is not 16 kHz".into()));
    }
    let normalized_samples = custom("normalize_samples").is_none_or(|v| v != "0");
    // Each family's training recipe: one family trains on Hamming windows
    // over samples in 16-bit range, the other on Povey windows over [-1, 1].
    let window = if normalized_samples {
        Window::Povey
    } else {
        Window::Hamming
    };
    let id = custom("url")
        .or_else(|| custom("comment"))
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    Ok(ModelInfo {
        id: format!("{id}#{dim}"),
        input,
        output,
        dim,
        sample_scale: if normalized_samples { 1.0 } else { 32_768.0 },
        mean_normalize: true,
        window,
    })
}

pub fn normalized(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter().map(|x| x / norm).collect()
    } else {
        v.to_vec()
    }
}
