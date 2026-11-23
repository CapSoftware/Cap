#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessorColorWords {
    pub output: u32,
    pub stream: u32,
}

const USAGE_VIDEO_PROCESSING: u32 = 1;
const MATRIX_BT709: u32 = 1 << 2;
const NOMINAL_SHIFT: u32 = 4;
const NOMINAL_STUDIO: u32 = 1;
const NOMINAL_FULL: u32 = 2;
const SD_SHORT_SIDE: u32 = 576;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum YuvMatrix {
    Bt601,
    Bt709,
}

/// Camera frames carry a pixel format and a size, not a matrix. A frame whose
/// shorter side is at most 576 is SD, and SD YUV defaults to BT.601. The
/// processor then converts that input to the BT.709 output. RGB is already
/// full-range and converts with BT.709 at every size. HD YUV stays BT.709.
pub(crate) fn source_matrix(rgb: bool, width: u32, height: u32) -> YuvMatrix {
    if rgb || width.min(height) > SD_SHORT_SIDE {
        YuvMatrix::Bt709
    } else {
        YuvMatrix::Bt601
    }
}

pub(crate) fn processor_color_words(
    source: YuvMatrix,
    input_full_range: bool,
) -> ProcessorColorWords {
    let nominal = if input_full_range {
        NOMINAL_FULL
    } else {
        NOMINAL_STUDIO
    };
    let stream_matrix = match source {
        YuvMatrix::Bt709 => MATRIX_BT709,
        YuvMatrix::Bt601 => 0,
    };
    ProcessorColorWords {
        output: USAGE_VIDEO_PROCESSING | MATRIX_BT709 | (NOMINAL_STUDIO << NOMINAL_SHIFT),
        stream: USAGE_VIDEO_PROCESSING | stream_matrix | (nominal << NOMINAL_SHIFT),
    }
}

pub(crate) fn bt709_processor_color_words(input_full_range: bool) -> ProcessorColorWords {
    processor_color_words(YuvMatrix::Bt709, input_full_range)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColorTag {
    YuvMatrix,
    Primaries,
    TransferFunction,
    NominalRange,
}

impl ColorTag {
    pub(crate) const ALL: [ColorTag; 4] = [
        ColorTag::YuvMatrix,
        ColorTag::Primaries,
        ColorTag::TransferFunction,
        ColorTag::NominalRange,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            ColorTag::YuvMatrix => "yuv_matrix",
            ColorTag::Primaries => "primaries",
            ColorTag::TransferFunction => "transfer_function",
            ColorTag::NominalRange => "nominal_range",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TagProbe {
    committed: Vec<ColorTag>,
    cursor: usize,
}

impl TagProbe {
    pub(crate) fn new() -> Self {
        Self {
            committed: Vec::new(),
            cursor: 0,
        }
    }

    pub(crate) fn next_attempt(&self) -> Option<Vec<ColorTag>> {
        let tag = ColorTag::ALL.get(self.cursor).copied()?;
        let mut attempt = self.committed.clone();
        attempt.push(tag);
        Some(attempt)
    }

    pub(crate) fn observe(&mut self, accepted: bool) {
        let Some(tag) = ColorTag::ALL.get(self.cursor).copied() else {
            return;
        };
        if accepted {
            self.committed.push(tag);
        }
        self.cursor += 1;
    }

    pub(crate) fn accepted(&self) -> &[ColorTag] {
        &self.committed
    }

    pub(crate) fn rejected(&self) -> Vec<ColorTag> {
        ColorTag::ALL
            .into_iter()
            .take(self.cursor)
            .filter(|tag| !self.committed.contains(tag))
            .collect()
    }
}

pub(crate) fn format_tag_list(tags: &[ColorTag]) -> String {
    if tags.is_empty() {
        "none".to_owned()
    } else {
        tags.iter()
            .map(|tag| tag.name())
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub(crate) fn color_tag_report(output: &TagProbe, input: &TagProbe) -> String {
    format!(
        "output_accepted={} output_rejected={} input_accepted={} input_rejected={}",
        format_tag_list(output.accepted()),
        format_tag_list(&output.rejected()),
        format_tag_list(input.accepted()),
        format_tag_list(&input.rejected()),
    )
}

pub(crate) fn accepted_after_two_passes<'a>(
    results: &'a [(&'a str, bool, bool)],
) -> (Vec<&'a str>, Vec<&'a str>) {
    let mut set = Vec::new();
    let mut rejected = Vec::new();
    for (name, early, late) in results {
        if *early || *late {
            set.push(*name);
        } else {
            rejected.push(*name);
        }
    }
    (set, rejected)
}

#[cfg(windows)]
pub(crate) fn apply_color_tags(
    media_type: &windows::Win32::Media::MediaFoundation::IMFMediaType,
    tags: &[ColorTag],
) -> windows::core::Result<()> {
    use windows::Win32::Media::MediaFoundation::{
        MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
        MF_MT_YUV_MATRIX, MFNominalRange_16_235, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
        MFVideoTransferMatrix_BT709,
    };
    unsafe {
        for tag in tags {
            match tag {
                ColorTag::YuvMatrix => {
                    media_type
                        .SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
                }
                ColorTag::Primaries => {
                    media_type
                        .SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
                }
                ColorTag::TransferFunction => {
                    media_type
                        .SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
                }
                ColorTag::NominalRange => {
                    media_type
                        .SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn probe_color_tags<E>(
    mut try_set: impl FnMut(&[ColorTag]) -> Result<(), E>,
    is_unsupported: impl Fn(&E) -> bool,
) -> Result<TagProbe, E> {
    let mut probe = TagProbe::new();
    while let Some(attempt) = probe.next_attempt() {
        match try_set(&attempt) {
            Ok(()) => probe.observe(true),
            Err(error) if is_unsupported(&error) => probe.observe(false),
            Err(error) => return Err(error),
        }
    }
    if let Err(error) = try_set(probe.accepted())
        && !is_unsupported(&error)
    {
        return Err(error);
    }
    Ok(probe)
}

#[cfg(windows)]
pub(crate) fn media_type_is_unsupported(error: &windows::core::Error) -> bool {
    error.code() == windows::Win32::Media::MediaFoundation::MF_E_INVALIDMEDIATYPE
}

#[cfg(windows)]
pub(crate) fn codec_color_passes(
    transform: &windows::Win32::Media::MediaFoundation::IMFTransform,
) -> Vec<(&'static str, bool)> {
    use windows::Win32::{
        Media::MediaFoundation::{
            CODECAPI_AVEncVideoInputColorNominalRange, CODECAPI_AVEncVideoInputColorPrimaries,
            CODECAPI_AVEncVideoInputColorTransferFunction,
            CODECAPI_AVEncVideoInputColorTransferMatrix,
            CODECAPI_AVEncVideoOutputColorNominalRange, CODECAPI_AVEncVideoOutputColorPrimaries,
            CODECAPI_AVEncVideoOutputColorTransferFunction,
            CODECAPI_AVEncVideoOutputColorTransferMatrix, ICodecAPI,
            eAVEncVideoColorNominalRange_16_235, eAVEncVideoColorPrimaries_BT709,
            eAVEncVideoColorTransferFunction_22_709, eAVEncVideoColorTransferMatrix_BT709,
        },
        System::Variant::{VARIANT, VARIANT_0_0, VT_UI4},
    };
    use windows::core::Interface;
    const PROPERTIES: &[(&str, windows_core::GUID, i32)] = &[
        (
            "output_primaries",
            CODECAPI_AVEncVideoOutputColorPrimaries,
            eAVEncVideoColorPrimaries_BT709.0,
        ),
        (
            "output_transfer",
            CODECAPI_AVEncVideoOutputColorTransferFunction,
            eAVEncVideoColorTransferFunction_22_709.0,
        ),
        (
            "output_matrix",
            CODECAPI_AVEncVideoOutputColorTransferMatrix,
            eAVEncVideoColorTransferMatrix_BT709.0,
        ),
        (
            "output_nominal_range",
            CODECAPI_AVEncVideoOutputColorNominalRange,
            eAVEncVideoColorNominalRange_16_235.0,
        ),
        (
            "input_primaries",
            CODECAPI_AVEncVideoInputColorPrimaries,
            eAVEncVideoColorPrimaries_BT709.0,
        ),
        (
            "input_transfer",
            CODECAPI_AVEncVideoInputColorTransferFunction,
            eAVEncVideoColorTransferFunction_22_709.0,
        ),
        (
            "input_matrix",
            CODECAPI_AVEncVideoInputColorTransferMatrix,
            eAVEncVideoColorTransferMatrix_BT709.0,
        ),
        (
            "input_nominal_range",
            CODECAPI_AVEncVideoInputColorNominalRange,
            eAVEncVideoColorNominalRange_16_235.0,
        ),
    ];
    let Ok(codec) = transform.cast::<ICodecAPI>() else {
        return PROPERTIES
            .iter()
            .map(|(name, _, _)| (*name, false))
            .collect();
    };
    PROPERTIES
        .iter()
        .map(|(name, guid, value)| {
            let mut variant = VARIANT::default();
            unsafe {
                let header =
                    std::ptr::addr_of_mut!(variant.Anonymous.Anonymous).cast::<VARIANT_0_0>();
                (*header).vt = VT_UI4;
                (*header).Anonymous.ulVal = *value as u32;
                (*name, codec.SetValue(guid, &variant).is_ok())
            }
        })
        .collect()
}

#[cfg(windows)]
pub(crate) fn codec_color_report(early: &[(&str, bool)], late: &[(&str, bool)]) -> String {
    let results = early
        .iter()
        .zip(late)
        .map(|((name, early_ok), (_, late_ok))| (*name, *early_ok, *late_ok))
        .collect::<Vec<_>>();
    let (set, rejected) = accepted_after_two_passes(&results);
    format!(
        "codec_api_set={} codec_api_rejected={}",
        join_names(&set),
        join_names(&rejected),
    )
}

#[cfg(windows)]
fn join_names(names: &[&str]) -> String {
    if names.is_empty() {
        "none".to_owned()
    } else {
        names.join(",")
    }
}

#[cfg(test)]
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

#[cfg(test)]
fn fixed_16(row: [i32; 3], r: i32, g: i32, b: i32) -> i32 {
    (row[0] * r + row[1] * g + row[2] * b + (1 << 15)) >> 16
}

#[cfg(test)]
mod tests {
    use super::{
        ColorTag, ProcessorColorWords, TagProbe, YuvMatrix, accepted_after_two_passes,
        bt709_limited_yuv, bt709_processor_color_words, color_tag_report, format_tag_list,
        probe_color_tags, processor_color_words, source_matrix,
    };

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
        assert_eq!(output, 21, "output {output:#x}");
        assert_eq!(stream, 37, "full-range stream {stream:#x}");
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
        assert_eq!(limited_out, 21, "output {limited_out:#x}");
        assert_eq!(limited_stream, 21, "limited stream {limited_stream:#x}");
        assert_eq!(fields(limited_out), (1, 0, 1, 1), "output {limited_out:#x}");
        assert_eq!(
            fields(limited_stream),
            (1, 0, 1, 1),
            "limited stream {limited_stream:#x}"
        );
    }

    #[test]
    fn sd_yuv_converts_from_bt601_while_rgb_and_hd_stay_bt709() {
        assert_eq!(source_matrix(true, 1280, 720), YuvMatrix::Bt709);
        assert_eq!(source_matrix(true, 640, 480), YuvMatrix::Bt709);
        assert_eq!(source_matrix(false, 1280, 720), YuvMatrix::Bt709);
        assert_eq!(source_matrix(false, 1920, 1080), YuvMatrix::Bt709);
        assert_eq!(source_matrix(false, 1080, 1920), YuvMatrix::Bt709);
        assert_eq!(source_matrix(false, 640, 480), YuvMatrix::Bt601);
        assert_eq!(source_matrix(false, 720, 576), YuvMatrix::Bt601);
        assert_eq!(source_matrix(false, 480, 640), YuvMatrix::Bt601);
        assert_eq!(source_matrix(false, 854, 480), YuvMatrix::Bt601);

        let ProcessorColorWords { output, stream } = processor_color_words(YuvMatrix::Bt601, false);
        assert_eq!(output, 21, "converted output stays BT.709 limited");
        assert_eq!(stream, 17, "SD YUV input stays BT.601 studio");
        assert_eq!(
            processor_color_words(source_matrix(true, 1280, 720), true),
            bt709_processor_color_words(true)
        );
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum TagFailure {
        Unsupported,
        Unexpected,
    }

    fn drive_probe(
        steps: &[Result<(), TagFailure>],
    ) -> (Result<TagProbe, TagFailure>, Vec<Vec<ColorTag>>) {
        let mut calls = Vec::new();
        let mut index = 0;
        let result = probe_color_tags(
            |tags| {
                calls.push(tags.to_vec());
                let outcome = steps.get(index).copied().unwrap_or(Ok(()));
                index += 1;
                outcome
            },
            |error| *error == TagFailure::Unsupported,
        );
        (result, calls)
    }

    #[test]
    fn probe_keeps_an_accepted_tag() {
        let (result, calls) = drive_probe(&[
            Ok(()),
            Err(TagFailure::Unsupported),
            Err(TagFailure::Unsupported),
            Err(TagFailure::Unsupported),
            Ok(()),
        ]);
        let probe = result.expect("accepted tag");
        assert_eq!(probe.accepted(), [ColorTag::YuvMatrix].as_slice());
        assert_eq!(calls.last().map(Vec::as_slice), Some(probe.accepted()));
    }

    #[test]
    fn probe_accepts_the_tag_after_a_rejection() {
        let (result, calls) = drive_probe(&[
            Err(TagFailure::Unsupported),
            Ok(()),
            Ok(()),
            Err(TagFailure::Unsupported),
            Ok(()),
        ]);
        let probe = result.expect("tag after rejection");
        assert_eq!(
            probe.accepted(),
            [ColorTag::Primaries, ColorTag::TransferFunction].as_slice()
        );
        assert_eq!(
            calls[..calls.len() - 1],
            [
                vec![ColorTag::YuvMatrix],
                vec![ColorTag::Primaries],
                vec![ColorTag::Primaries, ColorTag::TransferFunction],
                vec![
                    ColorTag::Primaries,
                    ColorTag::TransferFunction,
                    ColorTag::NominalRange
                ],
            ]
        );
        assert_eq!(calls.last().map(Vec::as_slice), Some(probe.accepted()));
    }

    #[test]
    fn probe_returns_an_unexpected_error() {
        let (result, calls) = drive_probe(&[Ok(()), Err(TagFailure::Unexpected)]);
        assert_eq!(result, Err(TagFailure::Unexpected));
        assert_eq!(
            calls,
            [
                vec![ColorTag::YuvMatrix],
                vec![ColorTag::YuvMatrix, ColorTag::Primaries],
            ]
        );
    }

    #[test]
    fn probe_finishes_by_setting_the_accepted_tags() {
        let (result, calls) = drive_probe(&[Ok(()), Ok(()), Ok(()), Ok(())]);
        let probe = result.expect("final set");
        assert_eq!(probe.accepted(), ColorTag::ALL.as_slice());
        assert_eq!(
            calls.last().map(Vec::as_slice),
            Some(ColorTag::ALL.as_slice())
        );
        assert_eq!(calls.len(), ColorTag::ALL.len() + 1);
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

    fn drive(results: &[bool]) -> TagProbe {
        let mut probe = TagProbe::new();
        for accepted in results {
            assert!(probe.next_attempt().is_some());
            probe.observe(*accepted);
        }
        assert!(probe.next_attempt().is_none());
        probe
    }

    #[test]
    fn tag_probe_keeps_every_accepted_attribute() {
        let probe = drive(&[true, true, true, true]);
        assert_eq!(probe.accepted(), ColorTag::ALL.as_slice());
        assert!(probe.rejected().is_empty());
        assert_eq!(
            format_tag_list(probe.accepted()),
            "yuv_matrix,primaries,transfer_function,nominal_range"
        );
    }

    #[test]
    fn tag_probe_drops_a_rejected_attribute_and_keeps_the_rest() {
        let probe = drive(&[true, false, true, false]);
        assert_eq!(
            probe.accepted(),
            [ColorTag::YuvMatrix, ColorTag::TransferFunction].as_slice()
        );
        assert_eq!(probe.next_attempt(), None);
        let mut partial = TagProbe::new();
        partial.observe(true);
        assert_eq!(
            partial.next_attempt().as_deref(),
            Some([ColorTag::YuvMatrix, ColorTag::Primaries].as_slice())
        );
        partial.observe(false);
        assert_eq!(
            partial.next_attempt().as_deref(),
            Some([ColorTag::YuvMatrix, ColorTag::TransferFunction].as_slice())
        );
        assert_eq!(
            color_tag_report(&probe, &partial),
            "output_accepted=yuv_matrix,transfer_function output_rejected=primaries,nominal_range input_accepted=yuv_matrix input_rejected=primaries"
        );
    }

    #[test]
    fn codec_api_keeps_a_property_that_succeeds_on_either_pass() {
        let (set, rejected) = accepted_after_two_passes(&[
            ("output_primaries", false, true),
            ("output_transfer", true, false),
            ("output_matrix", false, false),
        ]);
        assert_eq!(set, ["output_primaries", "output_transfer"]);
        assert_eq!(rejected, ["output_matrix"]);
    }
}
