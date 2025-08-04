use std::{ops::Deref, time::Duration};

use cap_camera_windows::*;

fn main() {
    let devices = get_devices()
        .unwrap()
        .into_iter()
        .map(DeviceSelection)
        .collect::<Vec<_>>();

    let selected_device = inquire::Select::new("Select a device", devices)
        .prompt()
        .unwrap();

    let format = inquire::Select::new("Select a format", selected_device.formats().clone())
        .prompt()
        .unwrap();

    let _handle = selected_device
        .0
        .start_capturing(&format.inner, |frame| {
            let Ok(bytes) = frame.bytes() else {
                return;
            };
            dbg!(bytes.len(), frame.pixel_format);
        })
        .unwrap();

    std::thread::sleep(Duration::from_secs(10));
}

pub struct DeviceSelection(pub VideoDeviceInfo);

impl Deref for DeviceSelection {
    type Target = VideoDeviceInfo;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Display for DeviceSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} ({})",
            self.0.name(),
            &match self.0.is_mf() {
                true => "Media Foundation",
                false => "DirectShow",
            },
        )
    }
}

pub struct FormatSelection(VideoFormat);
