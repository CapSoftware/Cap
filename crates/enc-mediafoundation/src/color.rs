#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessorColorWords {
    pub output: u32,
    pub stream: u32,
}

pub(crate) fn bt709_processor_color_words(input_full_range: bool) -> ProcessorColorWords {
    let _ = input_full_range;
    ProcessorColorWords {
        output: 1 | 2,
        stream: 1 | 1,
    }
}

pub(crate) fn bt709_limited_yuv(rgb: [u8; 3]) -> [u8; 3] {
    const Y: [i32; 3] = [11966, 40254, 4064];
    const CB: [i32; 3] = [-6596, -22189, 28785];
    const CR: [i32; 3] = [28785, -26145, -2640];
    let [r, g, b] = rgb.map(i32::from);
    let luma = (16 + fixed_16(Y, r, g, b)).clamp(16, 235) as u8;
    let cb = (128 + fixed_16(CB, r, g, b)).clamp(16, 240) as u8;
    let cr = (128 + fixed_16(CR, r, g, b)).clamp(16, 240) as u8;
    [luma, cb, cr]
}

fn fixed_16(row: [i32; 3], r: i32, g: i32, b: i32) -> i32 {
    (row[0] * r + row[1] * g + row[2] * b + (1 << 15)) >> 16
}

#[cfg(test)]
mod tests {
    use super::{ProcessorColorWords, bt709_limited_yuv, bt709_processor_color_words};

    fn fields(word: u32) -> (u32, u32, u32, u32) {
        (
            word & 1,
            (word >> 1) & 1,
            (word >> 2) & 1,
            (word >> 4) & 0b11,
        )
    }

    #[test]
    fn processor_words_are_bt709_limited_out_and_match_the_input_range() {
        let ProcessorColorWords { output, stream } = bt709_processor_color_words(true);
        assert_eq!(fields(output), (1, 0, 1, 1), "output {output:#x}");
        assert_eq!(
            fields(stream),
            (1, 0, 1, 2),
            "full-range stream {stream:#x}"
        );
        assert_eq!(output & !0b11_0111, 0, "output {output:#x}");
        assert_eq!(stream & !0b11_0111, 0, "full-range stream {stream:#x}");

        let ProcessorColorWords {
            output: limited_out,
            stream: limited_stream,
        } = bt709_processor_color_words(false);
        assert_eq!(fields(limited_out), (1, 0, 1, 1), "output {limited_out:#x}");
        assert_eq!(
            fields(limited_stream),
            (1, 0, 1, 1),
            "limited stream {limited_stream:#x}"
        );
    }

    #[test]
    fn limited_yuv_matches_the_bt709_chart() {
        assert_eq!(bt709_limited_yuv([0, 0, 0]), [16, 128, 128]);
        assert_eq!(bt709_limited_yuv([255, 255, 255]), [235, 128, 128]);
        assert_eq!(bt709_limited_yuv([255, 0, 0]), [63, 102, 240]);
        assert_eq!(bt709_limited_yuv([0, 255, 0]), [173, 42, 26]);
        assert_eq!(bt709_limited_yuv([0, 0, 255]), [32, 240, 118]);
        assert_eq!(bt709_limited_yuv([220, 40, 40]), [83, 110, 207]);
        assert_eq!(bt709_limited_yuv([125, 62, 93]), [83, 135, 154]);
    }
}
