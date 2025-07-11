use std::{fmt::Display, str::FromStr};

use cidre::*;

pub fn list_video_devices() -> arc::R<ns::Array<av::CaptureDevice>> {
    let device_types = ns::Array::from_slice(&[
        av::CaptureDeviceType::built_in_wide_angle_camera(),
        av::CaptureDeviceType::external(),
        av::CaptureDeviceType::desk_view_camera(),
    ]);

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
