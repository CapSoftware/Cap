use anyhow::Result;
use ort::{environment::Environment, session::SessionBuilder, tensor::InputTensor};
use std::path::Path;

pub struct BackgroundRemover {
    session: ort::Session,
    input_width: usize,
    input_height: usize,
}

pub const MODEL_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/background-removal.onnx");

impl BackgroundRemover {
    pub fn new(model_path: impl AsRef<Path>) -> Result<Self> {
        let env = Environment::builder()
            .with_name("cap-bg-removal")
            .with_log_level(ort::LoggingLevel::Warning)
            .build()?;
        let session = SessionBuilder::new(&env)?.with_model_from_file(model_path)?;
        // TODO: derive from model. Using 256x256 as common default
        Ok(Self {
            session,
            input_width: 256,
            input_height: 256,
        })
    }

    pub fn remove_background(
        &self,
        frame: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>> {
        // Resize the frame into the expected input size
        let img = image::RgbaImage::from_raw(width, height, frame.to_vec())
            .ok_or_else(|| anyhow::anyhow!("invalid image"))?;
        let resized = image::imageops::resize(
            &img,
            self.input_width as u32,
            self.input_height as u32,
            image::imageops::FilterType::Triangle,
        );
        // Convert to Tensor
        let input: Vec<f32> = resized
            .pixels()
            .flat_map(|p| p.0.iter().map(|c| *c as f32 / 255.0))
            .collect();
        let tensor = InputTensor::from_array(
            ndarray::Array::from_shape_vec(
                (1, self.input_height, self.input_width, 4),
                input,
            )?
            .into_dyn(),
        );
        let outputs = self.session.run(vec![tensor])?;
        let mask = outputs[0]
            .float_array()
            .map_err(|_| anyhow::anyhow!("invalid output"))?;
        // Upscale mask and apply
        let mut out = frame.to_vec();
        for (y, row) in mask.axis_iter(ndarray::Axis(1)).enumerate() {
            for (x, &val) in row.iter().enumerate() {
                let out_x = x * width as usize / self.input_width;
                let out_y = y * height as usize / self.input_height;
                let idx = (out_y * width as usize + out_x) * 4 + 3;
                let alpha = (val.clamp(0.0, 1.0) * 255.0) as u8;
                if idx < out.len() {
                    out[idx] = alpha;
                }
            }
        }
        Ok(out)
    }
}

