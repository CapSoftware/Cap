use crate::*;

pub(super) fn list_cameras_impl() -> impl Iterator<Item = CameraInfo> {
    let devices = cap_camera_windows::get_devices().unwrap_or_default();

    devices.into_iter().map(|d| CameraInfo {
        device_id: d.id().to_string_lossy().to_string(),
        model_id: ModelID::from_windows(&d),
        display_name: d.name().to_string_lossy().to_string(),
    })
}

fn find_device(
    info: &CameraInfo,
) -> Result<Option<cap_camera_windows::VideoDeviceInfo>, cap_camera_windows::GetDevicesError> {
    let devices = cap_camera_windows::get_devices()?;
    Ok(devices.into_iter().find(
        |d| match (ModelID::from_windows(d).as_ref(), info.model_id()) {
            (Some(a), Some(b)) => a == b,
            (None, None) => d.id() == info.device_id(),
            _ => false,
        },
    ))
}

impl CameraInfo {
    pub(super) fn formats_impl(&self) -> Option<Vec<Format>> {
        let device = find_device(self).ok()??;

        let mut ret = vec![];

        for format in device.formats() {
            ret.push(Format {
                info: FormatInfo {
                    width: format.width(),
                    height: format.height(),
                    frame_rate: format.frame_rate(),
                },
                native: format.inner,
            })
        }

        Some(ret)
    }
}

impl ModelID {
    fn from_windows(device: &cap_camera_windows::VideoDeviceInfo) -> Option<Self> {
        let model_id = device.model_id()?;

        let vid = &model_id[0..4];
        let pid = &model_id[5..9];

        Some(Self {
            vid: vid.to_string(),
            pid: pid.to_string(),
        })
    }
}

#[derive(Debug)]
pub struct NativeCapturedFrame(cap_camera_windows::Frame);

pub type NativeCaptureHandle = WindowsCaptureHandle;

pub(super) fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: impl FnMut(CapturedFrame) + 'static,
) -> Result<WindowsCaptureHandle, StartCapturingError> {
    let device = find_device(camera)?.ok_or(StartCapturingError::DeviceNotFound)?;

    Ok(WindowsCaptureHandle {
        inner: device.start_capturing(format.native(), move |frame| {
            callback(CapturedFrame {
                // reference_time: frame.reference_time,
                // capture_begin_time: frame.capture_begin_time,
                timestamp: frame.timestamp,
                native: NativeCapturedFrame(frame),
            });
        })?,
    })
}

pub struct WindowsCaptureHandle {
    inner: cap_camera_windows::CaptureHandle,
}

impl WindowsCaptureHandle {
    pub fn stop_capturing(self) -> Result<(), String> {
        self.inner.stop_capturing().map_err(|e| e.to_string())
    }
}

impl Deref for NativeCapturedFrame {
    type Target = cap_camera_windows::Frame;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
