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
const MF_VIDEO_TRANSFER_MATRIX_BT709: u32 = 1;
const MF_VIDEO_TRANSFER_MATRIX_BT601: u32 = 2;
const MF_NOMINAL_RANGE_0_255: u32 = 1;
const MF_NOMINAL_RANGE_16_235: u32 = 2;
const MF_NOMINAL_RANGE_48_208: u32 = 3;
const MF_NOMINAL_RANGE_64_127: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YuvMatrix {
    Bt601,
    Bt709,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputColorSpace {
    pub matrix: Option<YuvMatrix>,
    pub full_range: Option<bool>,
}

impl InputColorSpace {
    pub const fn screen_rgb() -> Self {
        Self {
            matrix: Some(YuvMatrix::Bt709),
            full_range: Some(true),
        }
    }

    pub fn from_media_type(matrix: Option<u32>, nominal_range: Option<u32>) -> Self {
        Self {
            matrix: matrix.and_then(yuv_matrix_from_mf),
            full_range: nominal_range.and_then(full_range_from_mf),
        }
    }
}

fn yuv_matrix_from_mf(value: u32) -> Option<YuvMatrix> {
    match value {
        MF_VIDEO_TRANSFER_MATRIX_BT709 => Some(YuvMatrix::Bt709),
        MF_VIDEO_TRANSFER_MATRIX_BT601 => Some(YuvMatrix::Bt601),
        _ => None,
    }
}

fn full_range_from_mf(value: u32) -> Option<bool> {
    match value {
        MF_NOMINAL_RANGE_0_255 => Some(true),
        MF_NOMINAL_RANGE_16_235 | MF_NOMINAL_RANGE_48_208 | MF_NOMINAL_RANGE_64_127 => Some(false),
        _ => None,
    }
}

pub(crate) fn resolve_input_color(
    rgb: bool,
    width: u32,
    height: u32,
    source: InputColorSpace,
) -> (YuvMatrix, bool) {
    if rgb {
        return (YuvMatrix::Bt709, source.full_range.unwrap_or(true));
    }
    let matrix = source
        .matrix
        .unwrap_or(if width.min(height) <= SD_SHORT_SIDE {
            YuvMatrix::Bt601
        } else {
            YuvMatrix::Bt709
        });
    (matrix, source.full_range.unwrap_or(false))
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

pub(crate) fn resolved_processor_words(
    rgb: bool,
    width: u32,
    height: u32,
    source: InputColorSpace,
) -> ProcessorColorWords {
    let (matrix, full_range) = resolve_input_color(rgb, width, height, source);
    processor_color_words(matrix, full_range)
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
        ColorTag, InputColorSpace, MF_NOMINAL_RANGE_0_255, MF_NOMINAL_RANGE_16_235,
        MF_VIDEO_TRANSFER_MATRIX_BT601, MF_VIDEO_TRANSFER_MATRIX_BT709, ProcessorColorWords,
        TagProbe, YuvMatrix, accepted_after_two_passes, bt709_limited_yuv, color_tag_report,
        format_tag_list, probe_color_tags, resolved_processor_words,
    };

    fn fields(word: u32) -> (u32, u32, u32, u32) {
        (
            word & 1,
            (word >> 1) & 1,
            (word >> 2) & 1,
            (word >> 4) & 0b11,
        )
    }

    fn words(rgb: bool, width: u32, height: u32, source: InputColorSpace) -> (u32, u32) {
        let ProcessorColorWords { output, stream } =
            resolved_processor_words(rgb, width, height, source);
        (output, stream)
    }

    #[test]
    fn rgb_screen_capture_stays_bt709_limited_from_full_range() {
        let (output, stream) = words(true, 1280, 720, InputColorSpace::screen_rgb());
        assert_eq!(output, 21);
        assert_eq!(stream, 37);
        assert_eq!(fields(output), (1, 0, 1, 1));
        assert_eq!(fields(stream), (1, 0, 1, 2));
        assert_eq!(
            words(true, 640, 480, InputColorSpace::screen_rgb()),
            (21, 37)
        );
    }

    #[test]
    fn mf_nominal_range_names_match_the_media_foundation_enum() {
        assert_eq!(MF_NOMINAL_RANGE_0_255, 1);
        assert_eq!(MF_NOMINAL_RANGE_16_235, 2);
        assert_eq!(MF_VIDEO_TRANSFER_MATRIX_BT709, 1);
        assert_eq!(MF_VIDEO_TRANSFER_MATRIX_BT601, 2);
    }

    #[test]
    fn explicit_bt601_hd_yuv_converts_to_bt709() {
        let source = InputColorSpace::from_media_type(
            Some(MF_VIDEO_TRANSFER_MATRIX_BT601),
            Some(MF_NOMINAL_RANGE_16_235),
        );
        assert_eq!(source.matrix, Some(YuvMatrix::Bt601));
        assert_eq!(source.full_range, Some(false));
        assert_eq!(words(false, 1280, 720, source), (21, 17));
        assert_eq!(words(false, 1920, 1080, source), (21, 17));
    }

    #[test]
    fn explicit_bt709_yuv_stays_bt709() {
        let source = InputColorSpace::from_media_type(
            Some(MF_VIDEO_TRANSFER_MATRIX_BT709),
            Some(MF_NOMINAL_RANGE_16_235),
        );
        assert_eq!(source.matrix, Some(YuvMatrix::Bt709));
        assert_eq!(source.full_range, Some(false));
        assert_eq!(words(false, 1280, 720, source), (21, 21));
        assert_eq!(words(false, 1920, 1080, source), (21, 21));
    }

    #[test]
    fn explicit_nominal_range_selects_full_or_studio() {
        let full = InputColorSpace::from_media_type(
            Some(MF_VIDEO_TRANSFER_MATRIX_BT709),
            Some(MF_NOMINAL_RANGE_0_255),
        );
        let studio = InputColorSpace::from_media_type(
            Some(MF_VIDEO_TRANSFER_MATRIX_BT709),
            Some(MF_NOMINAL_RANGE_16_235),
        );
        assert_eq!(full.full_range, Some(true));
        assert_eq!(studio.full_range, Some(false));
        assert_eq!(words(false, 1920, 1080, full), (21, 37));
        assert_eq!(words(false, 1920, 1080, studio), (21, 21));
        let full_601 = InputColorSpace::from_media_type(
            Some(MF_VIDEO_TRANSFER_MATRIX_BT601),
            Some(MF_NOMINAL_RANGE_0_255),
        );
        assert_eq!(words(false, 1280, 720, full_601), (21, 33));
    }

    #[test]
    fn unset_matrix_uses_sd_bt601_and_hd_bt709() {
        for reported in [None, Some(0)] {
            let source = InputColorSpace::from_media_type(reported, reported);
            assert_eq!(source, InputColorSpace::default());
            assert_eq!(words(false, 640, 480, source), (21, 17));
            assert_eq!(words(false, 720, 576, source), (21, 17));
            assert_eq!(words(false, 854, 480, source), (21, 17));
            assert_eq!(words(false, 1280, 720, source), (21, 21));
            assert_eq!(words(false, 1920, 1080, source), (21, 21));
        }
    }

    #[cfg(windows)]
    #[test]
    fn media_foundation_enum_values_match_the_attribute_decoder() {
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255, D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235,
        };
        use windows::Win32::Media::MediaFoundation::{
            MFNominalRange_0_255, MFNominalRange_16_235, MFVideoTransferMatrix_BT601,
            MFVideoTransferMatrix_BT709,
        };
        assert_eq!(MFNominalRange_0_255.0 as u32, 1);
        assert_eq!(MFNominalRange_16_235.0 as u32, 2);
        assert_eq!(MFVideoTransferMatrix_BT709.0 as u32, 1);
        assert_eq!(MFVideoTransferMatrix_BT601.0 as u32, 2);
        assert_eq!(
            D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235.0 as u32,
            super::NOMINAL_STUDIO
        );
        assert_eq!(
            D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255.0 as u32,
            super::NOMINAL_FULL
        );
        let limited = InputColorSpace::from_media_type(
            Some(MFVideoTransferMatrix_BT601.0 as u32),
            Some(MFNominalRange_16_235.0 as u32),
        );
        assert_eq!(limited.matrix, Some(YuvMatrix::Bt601));
        assert_eq!(limited.full_range, Some(false));
        let full = InputColorSpace::from_media_type(
            Some(MFVideoTransferMatrix_BT709.0 as u32),
            Some(MFNominalRange_0_255.0 as u32),
        );
        assert_eq!(full.matrix, Some(YuvMatrix::Bt709));
        assert_eq!(full.full_range, Some(true));
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
