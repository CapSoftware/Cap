use ffmpeg::format;

pub(crate) fn is_rgb(format: format::Pixel) -> bool {
    format.descriptor().is_some_and(|descriptor| unsafe {
        (*descriptor.as_ptr()).flags & ffmpeg::ffi::AV_PIX_FMT_FLAG_RGB as u64 != 0
    })
}

/// Makes an RGB to YUV swscale context produce what every encoder in this
/// crate tags its stream with: BT.709, limited range (swscale defaults to
/// BT.601). RGB input is full range. Other conversions are left untouched.
pub fn use_bt709_for_rgb_input(
    converter: &mut ffmpeg::software::scaling::Context,
    input: format::Pixel,
    output: format::Pixel,
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

#[cfg(test)]
mod tests {
    use super::*;
    use ffmpeg::frame;

    fn convert_red(output: format::Pixel, bt709: bool) -> frame::Video {
        ffmpeg::init().unwrap();
        let mut converter = ffmpeg::software::scaling::Context::get(
            format::Pixel::RGBA,
            16,
            16,
            output,
            16,
            16,
            ffmpeg::software::scaling::flag::Flags::BICUBIC,
        )
        .unwrap();
        if bt709 {
            use_bt709_for_rgb_input(&mut converter, format::Pixel::RGBA, output).unwrap();
        }
        let mut rgba = frame::Video::new(format::Pixel::RGBA, 16, 16);
        let stride = rgba.stride(0);
        for row in 0..16 {
            for col in 0..16 {
                let i = row * stride + col * 4;
                rgba.data_mut(0)[i..i + 4].copy_from_slice(&[220, 40, 40, 255]);
            }
        }
        let mut out = frame::Video::new(output, 16, 16);
        converter.run(&rgba, &mut out).unwrap();
        out
    }

    #[test]
    fn rgb_input_converts_with_bt709_limited_range() {
        // (220,40,40) is Y 83.2, Cb 109.9, Cr 207.1 in BT.709 limited range
        // (BT.601 would give Y 96, Cb 101).
        let nv12 = convert_red(format::Pixel::NV12, true);
        let (y, cb, cr) = (nv12.data(0)[0], nv12.data(1)[0], nv12.data(1)[1]);
        assert!(y.abs_diff(83) <= 1 && cb.abs_diff(110) <= 1 && cr.abs_diff(207) <= 1);

        // ProRes 4444's 10-bit planes: the same colour at 4x the scale.
        let yuva = convert_red(format::Pixel::YUVA444P10LE, true);
        let sample = |plane: usize| u16::from_le_bytes([yuva.data(plane)[0], yuva.data(plane)[1]]);
        let [y, cb, cr] = [sample(0), sample(1), sample(2)].map(|v| f64::from(v) / 4.0);
        assert!((y - 83.2).abs() <= 1.0, "Y {y}");
        assert!((cb - 109.9).abs() <= 1.0, "Cb {cb}");
        assert!((cr - 207.1).abs() <= 1.0, "Cr {cr}");
    }

    #[test]
    fn swscale_defaults_to_bt601_without_it() {
        let nv12 = convert_red(format::Pixel::NV12, false);
        assert!(nv12.data(0)[0].abs_diff(96) <= 1);
    }
}
