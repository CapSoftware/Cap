use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame, software::scaling};
use std::cell::UnsafeCell;
use thread_local::ThreadLocal;

struct SendableContext(UnsafeCell<scaling::Context>);

unsafe impl Send for SendableContext {}

impl SendableContext {
    fn new(ctx: scaling::Context) -> Self {
        Self(UnsafeCell::new(ctx))
    }

    fn run(&self, input: &frame::Video, output: &mut frame::Video) -> Result<(), ffmpeg::Error> {
        unsafe { (*self.0.get()).run(input, output) }
    }
}

pub struct SwscaleConverter {
    contexts: ThreadLocal<SendableContext>,
    config: ConversionConfig,
    output_format: Pixel,
    output_width: u32,
    output_height: u32,
}

impl SwscaleConverter {
    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        Self::create_context(&config)?;

        Ok(Self {
            contexts: ThreadLocal::new(),
            output_format: config.output_format,
            output_width: config.output_width,
            output_height: config.output_height,
            config,
        })
    }

    fn create_context(config: &ConversionConfig) -> Result<scaling::Context, ConvertError> {
        let flags = if config.needs_scaling() {
            scaling::flag::Flags::BICUBIC
        } else {
            scaling::flag::Flags::FAST_BILINEAR
        };

        scaling::Context::get(
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height,
            flags,
        )
        .map_err(|_| ConvertError::UnsupportedFormat(config.input_format, config.output_format))
    }

    fn get_or_create_context(&self) -> Result<&SendableContext, ConvertError> {
        self.contexts
            .get_or_try(|| Self::create_context(&self.config).map(SendableContext::new))
    }
}

impl FrameConverter for SwscaleConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let pts = input.pts();
        let mut output =
            frame::Video::new(self.output_format, self.output_width, self.output_height);

        let context = self.get_or_create_context()?;
        context
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
