#![cfg(target_os = "macos")]

use cidre::{
    av::capture::{VideoDataOutputSampleBufDelegate, VideoDataOutputSampleBufDelegateImpl},
    cv::{PixelBuf, pixel_buffer::LockFlags},
    *,
};
use std::{
    fmt::Display,
    time::{Duration, Instant},
};
use tracing::warn;

pub fn list_video_devices() -> arc::R<ns::Array<av::CaptureDevice>> {
    let mut device_types = vec![av::CaptureDeviceType::built_in_wide_angle_camera()];

    if api::macos_available("13.0")
        && let Some(typ) = unsafe { av::CaptureDeviceType::desk_view_camera() }
    {
        device_types.push(typ);
    }

    if api::macos_available("14.0") {
        if let Some(typ) = unsafe { av::CaptureDeviceType::external() } {
            device_types.push(typ);
        }
        if let Some(typ) = unsafe { av::CaptureDeviceType::continuity_camera() } {
            device_types.push(typ);
        }
    } else {
        device_types.push(av::CaptureDeviceType::external_unknown());
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
            _ => return Err(()),
        })
    }
}

pub struct CallbackData<'a> {
    pub output: &'a av::CaptureOutput,
    pub sample_buf: &'a cm::SampleBuf,
    pub connection: &'a av::CaptureConnection,
    pub capture_begin_time: Instant,
    pub timestamp: Duration,
}

pub type OutputDelegateCallback = Box<dyn FnMut(CallbackData)>;

pub struct CallbackOutputDelegateInner {
    callback: OutputDelegateCallback,
    stream_start: Option<(Instant, Duration)>,
}

impl CallbackOutputDelegateInner {
    pub fn new(callback: Box<dyn FnMut(CallbackData)>) -> Self {
        Self {
            callback,
            stream_start: None,
        }
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
        output: &av::CaptureOutput,
        sample_buf: &cm::SampleBuf,
        connection: &av::CaptureConnection,
    ) {
        let pts = sample_buf.pts();

        let capture_begin_time = pts
            .is_valid()
            .then(|| mach_time_to_microseconds(cm::Clock::convert_host_time_to_sys_units(pts)));
        let pres_timestamp = capture_begin_time.unwrap_or(Duration::ZERO);

        let stream_start = self
            .inner_mut()
            .stream_start
            .get_or_insert_with(|| (Instant::now(), pres_timestamp));

        let Some(timestamp) = pres_timestamp.checked_sub(stream_start.1) else {
            warn!("PTS {pres_timestamp:?} less than stream start {stream_start:?}");

            return;
        };

        let capture_begin_time = stream_start.0 + capture_begin_time.unwrap_or(Duration::ZERO);

        (self.inner_mut().callback)(CallbackData {
            output,
            sample_buf,
            connection,
            capture_begin_time,
            timestamp,
        });
    }
}

fn mach_time_to_microseconds(mach_time: u64) -> Duration {
    let timebase_info = mach::TimeBaseInfo::new();
    if timebase_info.numer == timebase_info.denom {
        return Duration::from_nanos(mach_time);
    }
    let divisor = timebase_info.denom as u64 * 1000;
    let mut microseconds = mach_time / divisor;

    let mach_time_remainder = mach_time % divisor;

    microseconds = microseconds
        .checked_mul(timebase_info.numer as u64)
        .expect("Multiplication overflow");

    let least_significant_microseconds =
        (mach_time_remainder * timebase_info.numer as u64) / divisor;

    microseconds = microseconds
        .checked_add(least_significant_microseconds)
        .expect("Addition overflow");

    Duration::from_micros(microseconds)
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
