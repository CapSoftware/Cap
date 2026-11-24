//! Which D3D11 `sw_format` FFmpeg 7.1 will actually encode.
//!
//! `hwcontext_d3d11va.c` `supported_formats` accepts NV12 and BGRA and rejects
//! RGBA (`Unsupported pixel format`). `amfenc.c` `format_map` accepts NV12 and
//! has `BGR0`, not `BGRA`, so a BGRA frames context fails with
//! `Format of input frames context (bgra) is not supported by AMF`.
//! `ff_nvenc_pix_fmts` includes `AV_PIX_FMT_D3D11` and maps NV12 through.
//! `qsvenc_h264.c` lists only NV12 and QSV, so QSV is a derived `AV_PIX_FMT_QSV`
//! context on those same NV12 frames. `mfenc.c` lists NV12 and YUV420P and is
//! not a D3D11 texture input.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum D3d11SwFormat {
    Nv12,
}

impl D3d11SwFormat {
    pub fn name(self) -> &'static str {
        match self {
            Self::Nv12 => "nv12",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum D3d11TexturePath {
    D3d11Nv12,
    QsvFromD3d11Nv12,
}

pub fn d3d11_texture_path(encoder: &str) -> Option<D3d11TexturePath> {
    match encoder {
        "h264_amf" | "hevc_amf" | "av1_amf" | "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => {
            Some(D3d11TexturePath::D3d11Nv12)
        }
        "h264_qsv" | "hevc_qsv" | "av1_qsv" => Some(D3d11TexturePath::QsvFromD3d11Nv12),
        _ => None,
    }
}

pub fn d3d11_sw_format(encoder: &str) -> Option<D3d11SwFormat> {
    d3d11_texture_path(encoder).map(|_| D3d11SwFormat::Nv12)
}

pub fn shared_d3d11_sw_format(encoders: &[&str]) -> Option<D3d11SwFormat> {
    let mut chosen = None;
    for encoder in encoders {
        let format = d3d11_sw_format(encoder)?;
        match chosen {
            None => chosen = Some(format),
            Some(existing) if existing == format => {}
            Some(_) => return None,
        }
    }
    chosen
}

pub fn capture_texel_feeds_nv12(format_name: &str) -> bool {
    matches!(format_name, "rgba" | "bgra" | "nv12")
}

pub const H264_TEXTURE_ENCODERS: &[&str] = &["h264_amf", "h264_nvenc", "h264_qsv"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amf_and_nvenc_share_nv12_and_reject_rgba_and_bgra() {
        assert_eq!(D3d11SwFormat::Nv12.name(), "nv12");
        assert_eq!(d3d11_sw_format("h264_amf"), Some(D3d11SwFormat::Nv12));
        assert_eq!(d3d11_sw_format("hevc_amf"), Some(D3d11SwFormat::Nv12));
        assert_eq!(d3d11_sw_format("av1_amf"), Some(D3d11SwFormat::Nv12));
        assert_eq!(
            d3d11_texture_path("h264_nvenc"),
            Some(D3d11TexturePath::D3d11Nv12)
        );
        assert_eq!(
            d3d11_texture_path("hevc_nvenc"),
            Some(D3d11TexturePath::D3d11Nv12)
        );
        assert_eq!(d3d11_sw_format("rgba"), None);
        assert_eq!(d3d11_sw_format("bgra"), None);
        assert_eq!(
            shared_d3d11_sw_format(H264_TEXTURE_ENCODERS),
            Some(D3d11SwFormat::Nv12)
        );
    }

    #[test]
    fn qsv_derives_from_nv12_and_mf_and_libx264_stay_off_the_texture_path() {
        assert_eq!(
            d3d11_texture_path("h264_qsv"),
            Some(D3d11TexturePath::QsvFromD3d11Nv12)
        );
        assert_eq!(d3d11_sw_format("hevc_qsv"), Some(D3d11SwFormat::Nv12));
        assert_eq!(d3d11_texture_path("h264_mf"), None);
        assert_eq!(d3d11_texture_path("hevc_mf"), None);
        assert_eq!(d3d11_texture_path("libx264"), None);
        assert_eq!(shared_d3d11_sw_format(&["h264_amf", "libx264"]), None);
    }

    #[test]
    fn rgba_and_bgra_capture_convert_to_nv12() {
        assert!(capture_texel_feeds_nv12("rgba"));
        assert!(capture_texel_feeds_nv12("bgra"));
        assert!(capture_texel_feeds_nv12("nv12"));
        assert!(!capture_texel_feeds_nv12("rgba64"));
        assert!(!capture_texel_feeds_nv12("other"));
    }
}
