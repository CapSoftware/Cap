use std::{fmt::Display, ops::Deref, time::Duration};

use cap_camera::{CameraInfo, Format};
use cap_camera_ffmpeg::CapturedFrameExt;

fn main() {
    let cameras = cap_camera::list_cameras().map(CameraSelectOption).collect();

    let selected_camera = inquire::Select::new("Select a device", cameras)
        .prompt()
        .unwrap();

    let formats = selected_camera
        .formats()
        .unwrap()
        .into_iter()
        .map(FormatSelectOption)
        .collect();

    let selected_format = inquire::Select::new("Select a format", formats)
        .prompt()
        .unwrap();

    let _handle = selected_camera
        .start_capturing(selected_format.0, |frame| {
            let Ok(ff_frame) = frame.as_ffmpeg() else {
                eprintln!("Failed to convert frame to FFmpeg");
                return;
            };

            ff_frame.width();
            ff_frame.height();
            ff_frame.format();
        })
        .unwrap();

    std::thread::sleep(Duration::from_secs(5));
}

pub struct CameraSelectOption(CameraInfo);

impl Display for CameraSelectOption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.display_name())
    }
}

pub struct FormatSelectOption(Format);

impl Display for FormatSelectOption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}x{} {}fps",
            self.0.width(),
            self.0.height(),
            self.0.frame_rate()
        )
    }
}

impl Deref for CameraSelectOption {
    type Target = CameraInfo;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Deref for FormatSelectOption {
    type Target = Format;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
