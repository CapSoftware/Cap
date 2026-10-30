use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame, software::scaling};
use std::cell::UnsafeCell;
use thread_local::ThreadLocal;

fn is_rgb(format: Pixel) -> bool {
    format.descriptor().is_some_and(|descriptor| unsafe {
        (*descriptor.as_ptr()).flags & ffmpeg::ffi::AV_PIX_FMT_FLAG_RGB as u64 != 0
    })
}

fn use_bt709_for_rgb_input(
    converter: &mut scaling::Context,
    input: Pixel,
    output: Pixel,
) -> Result<(), ffmpeg::Error> {
    if !is_rgb(input) || is_rgb(output) {
        return Ok(());
    }
    let result = unsafe {
        let coefficients = ffmpeg::ffi::sws_getCoefficients(ffmpeg::ffi::SWS_CS_ITU709);
        ffmpeg::ffi::sws_setColorspaceDetails(
            converter.as_mut_ptr(),
            coefficients,
            1,
            coefficients,
            0,
            0,
            1 << 16,
            1 << 16,
        )
    };
    if result < 0 {
        return Err(ffmpeg::Error::from(result));
    }
    Ok(())
}

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
        .and_then(|mut ctx| {
            use_bt709_for_rgb_input(&mut ctx, config.input_format, config.output_format)
                .map_err(|error| ConvertError::ConversionFailed(error.to_string()))?;
            Ok(ctx)
        })
    }

    fn get_or_create_context(&self) -> Result<&SendableContext, ConvertError> {
        self.contexts
            .get_or_try(|| Self::create_context(&self.config).map(SendableContext::new))
    }
}

impl FrameConverter for SwscaleConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let mut output =
            frame::Video::new(self.output_format, self.output_width, self.output_height);
        self.convert_into(input, &mut output)?;
        Ok(output)
    }

    fn convert_into(
        &self,
        input: frame::Video,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        let pts = input.pts();

        let context = self.get_or_create_context()?;
        context
            .run(&input, output)
            .map_err(|e| ConvertError::ConversionFailed(e.to_string()))?;

        output.set_pts(pts);
        Ok(())
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
