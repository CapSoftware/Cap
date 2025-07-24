#![cfg(target_os = "macos")]
use std::fmt::Display;

use cidre::{
    av::capture::{VideoDataOutputSampleBufDelegate, VideoDataOutputSampleBufDelegateImpl},
    *,
};

pub fn list_video_devices() -> arc::R<ns::Array<av::CaptureDevice>> {
    let mut device_types = vec![
        av::CaptureDeviceType::built_in_wide_angle_camera(),
        av::CaptureDeviceType::desk_view_camera(),
    ];

    if api::macos_available("14.0") {
        device_types.push(unsafe { av::CaptureDeviceType::external().unwrap() })
    } else {
        device_types.push(av::CaptureDeviceType::external_unknown())
    }

    let device_types = ns::Array::from_slice(&device_types);

    let video_discovery_session =
        av::CaptureDeviceDiscoverySession::with_device_types_media_and_pos(
            &device_types,
            Some(av::MediaType::video()),
            av::CaptureDevicePos::Unspecified,
        );

    video_discovery_session.devices()
}

#[derive(Clone, Copy)]
pub enum YCbCrMatrix {
    Rec601,
    Rec709,
    Rec2020,
}

impl Display for YCbCrMatrix {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rec601 => write!(f, "Rec601"),
            Self::Rec709 => write!(f, "Rec709"),
            Self::Rec2020 => write!(f, "Rec2020"),
        }
    }
}

impl TryFrom<&cf::String> for YCbCrMatrix {
    type Error = ();

    fn try_from(s: &cf::String) -> Result<Self, Self::Error> {
        Ok(match s {
            s if s == cv::image_buf_attachment::ycbcr_matrix::itu_r_601_4() => Self::Rec601,
            s if s == cv::image_buf_attachment::ycbcr_matrix::itu_r_709_2() => Self::Rec709,
            s if s == cv::image_buf_attachment::ycbcr_matrix::itu_r_2020() => Self::Rec2020,
            s => return Err(()),
        })
    }
}

pub type OutputDelegateCallback =
    Box<dyn FnMut(&av::CaptureOutput, &cm::SampleBuf, &av::CaptureConnection)>;

pub struct CallbackOutputDelegateInner {
    callback: OutputDelegateCallback,
}

impl CallbackOutputDelegateInner {
    pub fn new(
        callback: Box<dyn FnMut(&av::CaptureOutput, &cm::SampleBuf, &av::CaptureConnection)>,
    ) -> Self {
        Self { callback }
    }
}

define_obj_type!(
    pub CallbackOutputDelegate + VideoDataOutputSampleBufDelegateImpl,
    CallbackOutputDelegateInner,
    OUTPUT_DELEGATE
);

impl VideoDataOutputSampleBufDelegate for CallbackOutputDelegate {}

#[objc::add_methods]
impl VideoDataOutputSampleBufDelegateImpl for CallbackOutputDelegate {
    extern "C" fn impl_capture_output_did_output_sample_buf_from_connection(
        &mut self,
        _cmd: Option<&cidre::objc::Sel>,
        _output: &av::CaptureOutput,
        sample_buf: &cm::SampleBuf,
        _connection: &av::CaptureConnection,
    ) {
        (self.inner_mut().callback)(_output, sample_buf, _connection);
    }
}
