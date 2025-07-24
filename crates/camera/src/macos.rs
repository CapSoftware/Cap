use super::*;

use cidre::{
    cv::{PixelBuf, pixel_buffer::LockFlags},
    *,
};

pub(super) fn list_cameras_impl() -> Vec<CameraInfo> {
    let devices = cap_camera_avfoundation::list_video_devices();
    devices
        .iter()
        .filter_map(|d| {
            Some(CameraInfo {
                model_id: ModelID::from_avfoundation(d)?,
                display_name: d.localized_name().to_string(),
            })
        })
        .collect::<Vec<_>>()
}

impl ModelID {
    pub(super) fn formats_impl(&self) -> Option<Vec<Format>> {
        let devices = cap_camera_avfoundation::list_video_devices();

        let device = devices
            .iter()
            .find(|d| ModelID::from_avfoundation(d).as_ref() == Some(self))?;

        let mut ret = vec![];

        for format in device.formats().iter() {
            let desc = format.format_desc();
            let width = desc.dimensions().width as u32;
            let height = desc.dimensions().height as u32;
            // let pixel_format = match cidre::cv::PixelFormat(desc.media_sub_type()) {
            //     cidre::cv::PixelFormat::_420V => ffmpeg::format::Pixel::NV12,
            //     cidre::cv::PixelFormat::_2VUY => ffmpeg::format::Pixel::UYVY422,
            //     _ => match cidre::cm::PixelFormat(desc.media_sub_type()) {
            //         cidre::cm::PixelFormat::_422_YP_CB_CR_8_YUVS => {
            //             ffmpeg::format::Pixel::YUYV422
            //         }
            //         // TODO: support MJPEG
            //         _ => continue,
            //     },
            // };

            for fr_range in format.video_supported_frame_rate_ranges().iter() {
                let min = fr_range.min_frame_duration();

                ret.push(Format {
                    native: format.retained(),
                    info: FormatInfo {
                        width,
                        height,
                        // pixel_format,
                        frame_rate: min.scale as f32 / min.value as f32,
                    },
                })
            }
        }

        Some(ret)
    }

    fn from_avfoundation(device: &cidre::av::capture::Device) -> Option<Self> {
        let unique_id = device.unique_id().to_string();
        if unique_id.len() < 8 {
            return None;
        }

        let vid = unique_id[unique_id.len() - 2 * 4..unique_id.len() - 4].to_string();
        let pid = unique_id[unique_id.len() - 4..].to_string();

        Some(Self { vid, pid })
    }
}

pub type NativeFormat = arc::R<av::capture::device::Format>;

pub type NativeRecordingHandle = AVFoundationRecordingHandle;

pub(super) fn start_capturing_impl(
    camera: &CameraInfo,
    format: Format,
    mut callback: impl FnMut(CapturedFrame) + 'static,
) -> Result<AVFoundationRecordingHandle, StartCaptureError> {
    let devices = list_video_devices();
    let mut device = devices
        .iter()
        .find(|d| ModelID::from_avfoundation(d).as_ref() == Some(camera.model_id()))
        .ok_or(StartCaptureError::DeviceNotFound)?
        .retained();

    let input =
        av::capture::DeviceInput::with_device(&device).map_err(AVFoundationError::Static)?;

    let queue = dispatch::Queue::new();
    let delegate = CallbackOutputDelegate::with(CallbackOutputDelegateInner::new(Box::new(
        move |_output, sample_buf, _connection| {
            let Some(image_buf) = sample_buf.image_buf() else {
                return;
            };

            callback(CapturedFrame(NativeCapturedFrame(
                image_buf.retained(),
                sample_buf.retained(),
            )));
        },
    )));

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

        _lock.set_active_format(&format.native());

        session.start_running();
    }

    Ok(AVFoundationRecordingHandle { delegate, session })
}

pub struct AVFoundationRecordingHandle {
    delegate: cidre::arc::R<cap_camera_avfoundation::CallbackOutputDelegate>,
    session: cidre::arc::R<cidre::av::capture::Session>,
}

impl AVFoundationRecordingHandle {
    pub fn stop_capturing(mut self) {
        self.session.stop_running();
    }
}

pub trait ImageBufExt {
    fn base_addr_lock<'a>(
        &'a mut self,
        flags: LockFlags,
    ) -> cidre::os::Result<BaseAddrLockGuard<'a>>;
}

impl ImageBufExt for PixelBuf {
    fn base_addr_lock<'a>(
        &'a mut self,
        flags: LockFlags,
    ) -> cidre::os::Result<BaseAddrLockGuard<'a>> {
        unsafe { self.lock_base_addr(flags) }.result()?;

        Ok(BaseAddrLockGuard(self, flags))
    }
}

pub struct BaseAddrLockGuard<'a>(&'a mut PixelBuf, LockFlags);

impl<'a> BaseAddrLockGuard<'a> {
    pub fn plane_data(&self, index: usize) -> &[u8] {
        let base_addr = self.0.plane_base_address(index);
        let plane_size = self.0.plane_bytes_per_row(index);
        unsafe { std::slice::from_raw_parts(base_addr, plane_size * self.0.plane_height(index)) }
    }
}

impl<'a> Drop for BaseAddrLockGuard<'a> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.unlock_lock_base_addr(self.1) };
    }
}

#[derive(thiserror::Error)]
pub enum AVFoundationError {
    #[error("{0}")]
    Static(&'static cidre::ns::Error),
    #[error("{0}")]
    Retained(cidre::arc::R<cidre::ns::Error>),
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

impl From<AVFoundationError> for StartCaptureError {
    fn from(err: AVFoundationError) -> Self {
        StartCaptureError::Native(err)
    }
}

impl Debug for AVFoundationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AVFoundationError::Static(err) => write!(f, "{}", err),
            AVFoundationError::Retained(err) => write!(f, "{}", err),
        }
    }
}

pub struct NativeCapturedFrame(
    cidre::arc::R<cidre::cv::ImageBuf>,
    cidre::arc::R<cidre::cm::SampleBuf>,
);

impl Deref for NativeCapturedFrame {
    type Target = cidre::cv::ImageBuf;

    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}
