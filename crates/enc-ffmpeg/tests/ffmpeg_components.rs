//! Fails when the FFmpeg libraries Cap links are missing a component Cap uses.
//! The list lives in scripts/ffmpeg/components.sh, which also drives the build.

use std::ffi::{CStr, CString};

unsafe extern "C" {
    fn av_bsf_get_by_name(name: *const std::ffi::c_char) -> *const std::ffi::c_void;
}

const COMPONENTS: &str = include_str!("../../../scripts/ffmpeg/components.sh");

fn list(name: &str) -> Vec<&'static str> {
    let start = format!("{name}=(");
    let body = COMPONENTS
        .split_once(&start)
        .unwrap_or_else(|| panic!("{name} missing from components.sh"))
        .1;
    let body = &body[..body.find(')').unwrap()];
    body.lines()
        .map(|line| line.split('#').next().unwrap())
        .flat_map(str::split_whitespace)
        .collect()
}

fn platform_encoders() -> Vec<&'static str> {
    let mut encoders = list("CAP_ENCODERS_ALL");
    if cfg!(target_os = "macos") {
        encoders.extend(list("CAP_ENCODERS_DARWIN"));
    } else if cfg!(target_os = "windows") {
        encoders.extend(list("CAP_ENCODERS_WINDOWS"));
    } else {
        encoders.extend(list("CAP_ENCODERS_LINUX"));
        if cfg!(target_arch = "x86_64") {
            encoders.extend(list("CAP_ENCODERS_LINUX_X86_64"));
        }
    }
    encoders
}

fn missing(names: Vec<&'static str>, present: impl Fn(&CStr) -> bool) -> Vec<&'static str> {
    names
        .into_iter()
        .filter(|name| !present(&CString::new(*name).unwrap()))
        .collect()
}

#[test]
fn every_component_cap_uses_is_available() {
    ffmpeg::init().unwrap();
    use ffmpeg::ffi;

    let mut problems = Vec::new();
    let mut check = |kind: &str, absent: Vec<&'static str>| {
        if !absent.is_empty() {
            problems.push(format!("{kind}: {}", absent.join(", ")));
        }
    };

    check(
        "encoders",
        missing(platform_encoders(), |name| unsafe {
            !ffi::avcodec_find_encoder_by_name(name.as_ptr()).is_null()
        }),
    );
    let mut decoders = list("CAP_REQUIRED_DECODERS");
    if cfg!(target_os = "windows") {
        decoders.extend(list("CAP_REQUIRED_DECODERS_WINDOWS"));
    }
    check(
        "decoders",
        missing(decoders, |name| unsafe {
            !ffi::avcodec_find_decoder_by_name(name.as_ptr()).is_null()
        }),
    );
    check(
        "muxers",
        missing(list("CAP_MUXERS"), |name| unsafe {
            let format = ffi::av_guess_format(name.as_ptr(), std::ptr::null(), std::ptr::null());
            !format.is_null() && CStr::from_ptr((*format).name) == name
        }),
    );
    check(
        "demuxers",
        missing(list("CAP_REQUIRED_DEMUXERS"), |name| unsafe {
            !ffi::av_find_input_format(name.as_ptr()).is_null()
        }),
    );
    check(
        "filters",
        missing(list("CAP_FILTERS"), |name| unsafe {
            !ffi::avfilter_get_by_name(name.as_ptr()).is_null()
        }),
    );
    check(
        "bitstream filters",
        missing(list("CAP_REQUIRED_BSFS"), |name| unsafe {
            !av_bsf_get_by_name(name.as_ptr()).is_null()
        }),
    );
    check(
        "parsers",
        missing(list("CAP_REQUIRED_PARSERS"), |name| unsafe {
            let decoder = ffi::avcodec_find_decoder_by_name(name.as_ptr());
            if decoder.is_null() {
                return false;
            }
            let parser = ffi::av_parser_init((*decoder).id as i32);
            if parser.is_null() {
                return false;
            }
            ffi::av_parser_close(parser);
            true
        }),
    );
    check(
        "protocols",
        missing(list("CAP_PROTOCOLS"), |name| unsafe {
            let mut opaque = std::ptr::null_mut();
            loop {
                let protocol = ffi::avio_enum_protocols(&mut opaque, 0);
                if protocol.is_null() {
                    return false;
                }
                if CStr::from_ptr(protocol) == name {
                    return true;
                }
            }
        }),
    );

    assert!(
        problems.is_empty(),
        "FFmpeg is missing components Cap uses:\n{}",
        problems.join("\n")
    );
}
