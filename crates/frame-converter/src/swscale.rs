use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame, software::scaling};
use parking_lot::Mutex;

pub struct SwscaleConverter {
    context: Mutex<scaling::Context>,
    output_format: Pixel,
    output_width: u32,
    output_height: u32,
}

impl SwscaleConverter {
    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        let flags = if config.needs_scaling() {
            scaling::flag::Flags::BICUBIC
        } else {
            scaling::flag::Flags::FAST_BILINEAR
        };

        let context = scaling::Context::get(
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height,
            flags,
        )
        .map_err(|_| ConvertError::UnsupportedFormat(config.input_format, config.output_format))?;

        Ok(Self {
            context: Mutex::new(context),
            output_format: config.output_format,
            output_width: config.output_width,
            output_height: config.output_height,
        })
    }
}

impl FrameConverter for SwscaleConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let pts = input.pts();
        let mut output =
            frame::Video::new(self.output_format, self.output_width, self.output_height);

        self.context
            .lock()
            .run(&input, &mut output)
            .map_err(|e| ConvertError::ConversionFailed(e.to_string()))?;

        output.set_pts(pts);
        Ok(output)
    }

    fn name(&self) -> &'static str {
        "swscale"
    }

    fn backend(&self) -> ConverterBackend {
        ConverterBackend::Swscale
    }
}

unsafe impl Send for SwscaleConverter {}
unsafe impl Sync for SwscaleConverter {}
