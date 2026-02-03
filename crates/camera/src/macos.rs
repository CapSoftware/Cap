use super::*;

use cap_camera_avfoundation::*;
use cidre::*;
use objc2_av_foundation::*;

pub(super) fn list_cameras_impl() -> impl Iterator<Item = CameraInfo> {
    let devices = cap_camera_avfoundation::list_video_devices();
    devices
        .iter()
        .map(|d| CameraInfo {
            device_id: d.unique_id().to_string(),
            model_id: ModelID::from_avfoundation(d),
            display_name: d.localized_name().to_string(),
        })
        .collect::<Vec<_>>()
        .into_iter()
}

impl CameraInfo {
    pub(super) fn formats_impl(&self) -> Option<Vec<Format>> {
        let device = find_device(self)?;

        let mut ret = vec![];

        for format in device.formats().iter() {
            let desc = format.format_desc();
            let width = desc.dims().width as u32;
            let height = desc.dims().height as u32;

            for fr_range in format.video_supported_frame_rate_ranges().iter() {
                // SAFETY: trust me bro it crashes on intel mac otherwise
                let fr_range = unsafe {
                    &*(fr_range as *const av::capture::device::FrameRateRange)
                        .cast::<AVFrameRateRange>()
                };

                let min = unsafe { fr_range.minFrameDuration() };

                ret.push(Format {
                    native: format.retained(),
                    info: FormatInfo {
                        width,
                        height,
                        frame_rate: min.timescale as f32 / min.value as f32,
                    },
                })
            }
        }

        Some(ret)
    }
}

impl ModelID {
    fn from_avfoundation(device: &cidre::av::capture::Device) -> Option<Self> {
        let unique_id = device.unique_id().to_string();
        if unique_id.len() < 8 {
            return None;
        }

        let vid = unique_id[unique_id.len() - 2 * 4..unique_id.len() - 4].to_string();
        let pid = unique_id[unique_id.len() - 4..].to_string();

        if vid == "0000" && pid == "0001" {
            return None;
        }

        Some(Self { vid, pid })
    }
}

pub type NativeFormat = arc::R<av::capture::device::Format>;

pub type NativeCaptureHandle = AVFoundationRecordingHandle;

fn find_device(info: &CameraInfo) -> Option<arc::R<av::CaptureDevice>> {
    let devices = list_video_devices();
    devices
        .iter()
        .find(
            |d| match (ModelID::from_avfoundation(d).as_ref(), info.model_id()) {
                (Some(a), Some(b)) => a == b,
                (None, None) => d.unique_id().to_string() == info.device_id(),
                _ => false,
            },
        )
        .map(|v| v.retained())
}

pub(super) fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: impl FnMut(CapturedFrame) + 'static,
) -> Result<AVFoundationRecordingHandle, StartCapturingError> {
    let mut device = find_device(camera)
        .ok_or(StartCapturingError::DeviceNotFound)?
        .retained();

    let input =
        av::capture::DeviceInput::with_device(&device).map_err(AVFoundationError::Static)?;

    let queue = dispatch::Queue::new();
    let delegate =
        CallbackOutputDelegate::with(CallbackOutputDelegateInner::new(Box::new(move |data| {
            if data.sample_buf.image_buf().is_none() {
                return;
            };

            callback(CapturedFrame {
                native: NativeCapturedFrame(data.sample_buf.retained()),
                timestamp: data.timestamp,
            });
        })));

    let mut output = av::capture::VideoDataOutput::new();
    let mut session = av::capture::Session::new();

    session.configure(|s| {
        if s.can_add_input(&input) {
            s.add_input(&input);
        } else {
            panic!("can't add input");
        }

        s.add_output(&output);
    });

    output.set_sample_buf_delegate(Some(delegate.as_ref()), Some(&queue));

    // The device config must stay locked while running starts,
    // otherwise start_running can overwrite the active format on macOS
    // https://stackoverflow.com/questions/36689578/avfoundation-capturing-video-with-custom-resolution
    {
        let mut _lock = device.config_lock().map_err(AVFoundationError::Retained)?;

        _lock.set_active_format(format.native());

        session.start_running();
    }

    Ok(AVFoundationRecordingHandle {
        _delegate: delegate,
        session,
        _output: output,
        _input: input,
        _device: device,
    })
}

pub struct AVFoundationRecordingHandle {
    _delegate: arc::R<cap_camera_avfoundation::CallbackOutputDelegate>,
    session: arc::R<cidre::av::capture::Session>,
    _output: arc::R<av::CaptureVideoDataOutput>,
    _input: arc::R<av::CaptureDeviceInput>,
    _device: arc::R<av::CaptureDevice>,
}

impl AVFoundationRecordingHandle {
    pub fn stop_capturing(mut self) -> Result<(), String> {
        self.session.stop_running();
        Ok(())
    }
}

#[derive(thiserror::Error)]
pub enum AVFoundationError {
    #[error("{0}")]
    Static(&'static cidre::ns::Error),
    #[error("{0}")]
    Retained(cidre::arc::R<cidre::ns::Error>),
}

impl From<&'static cidre::ns::Error> for AVFoundationError {
    fn from(err: &'static cidre::ns::Error) -> Self {
        AVFoundationError::Static(err)
    }
}

impl From<cidre::arc::R<cidre::ns::Error>> for AVFoundationError {
    fn from(err: cidre::arc::R<cidre::ns::Error>) -> Self {
        AVFoundationError::Retained(err)
    }
}

impl Deref for AVFoundationError {
    type Target = cidre::ns::Error;

    fn deref(&self) -> &Self::Target {
        match self {
            AVFoundationError::Static(err) => err,
            AVFoundationError::Retained(err) => err,
        }
    }
}

impl Debug for AVFoundationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AVFoundationError::Static(err) => write!(f, "{err}"),
            AVFoundationError::Retained(err) => write!(f, "{err}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NativeCapturedFrame(arc::R<cm::SampleBuf>);

impl NativeCapturedFrame {
    pub fn image_buf(&self) -> Option<arc::R<cv::ImageBuf>> {
        self.0.image_buf().map(|b| b.retained())
    }

    pub fn sample_buf(&self) -> &arc::R<cm::SampleBuf> {
        &self.0
    }
}
