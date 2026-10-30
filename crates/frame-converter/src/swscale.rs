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

#[cfg(test)]
mod tests {
    use super::*;

    fn convert_red(input: Pixel, output: Pixel) -> frame::Video {
        ffmpeg::init().unwrap();
        let converter =
            SwscaleConverter::new(ConversionConfig::new(input, 16, 16, output, 16, 16)).unwrap();
        let mut rgb = frame::Video::new(input, 16, 16);
        let stride = rgb.stride(0);
        let pixel: [u8; 4] = if input == Pixel::BGRA {
            [40, 40, 220, 255]
        } else {
            [220, 40, 40, 255]
        };
        for row in 0..16 {
            for col in 0..16 {
                let offset = row * stride + col * 4;
                rgb.data_mut(0)[offset..offset + 4].copy_from_slice(&pixel);
            }
        }
        converter.convert(rgb).unwrap()
    }

    #[test]
    fn rgb_to_yuv_uses_bt709_limited_range() {
        // (220, 40, 40) is Y 83.2, Cb 109.9, Cr 207.1 in BT.709 limited range;
        // swscale's BT.601 default would give Y 96.
        for input in [Pixel::BGRA, Pixel::RGBA] {
            let nv12 = convert_red(input, Pixel::NV12);
            let (y, cb, cr) = (nv12.data(0)[0], nv12.data(1)[0], nv12.data(1)[1]);
            assert!(
                y.abs_diff(83) <= 1 && cb.abs_diff(110) <= 1 && cr.abs_diff(207) <= 1,
                "{input:?} -> NV12: y={y} cb={cb} cr={cr}"
            );

            let yuv420p = convert_red(input, Pixel::YUV420P);
            let (y, cb, cr) = (yuv420p.data(0)[0], yuv420p.data(1)[0], yuv420p.data(2)[0]);
            assert!(
                y.abs_diff(83) <= 1 && cb.abs_diff(110) <= 1 && cr.abs_diff(207) <= 1,
                "{input:?} -> YUV420P: y={y} cb={cb} cr={cr}"
            );
        }
    }

    #[test]
    fn rgb_to_rgb_conversion_is_left_untouched() {
        let rgba = convert_red(Pixel::BGRA, Pixel::RGBA);
        assert_eq!(&rgba.data(0)[0..4], &[220, 40, 40, 255]);
    }
}
