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

// Pool-wrapped: device polling calls this every few seconds from tokio threads
// that have no ambient NSAutoreleasePool, so the discovery session's
// autoreleased temporaries would otherwise leak for the process lifetime.
pub fn list_video_devices() -> arc::R<ns::Array<av::CaptureDevice>> {
    objc::ar_pool(|| {
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
    })
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
    dropped_frames: u64,
}

impl CallbackOutputDelegateInner {
    pub fn new(callback: Box<dyn FnMut(CallbackData)>) -> Self {
        Self {
            callback,
            stream_start: None,
            dropped_frames: 0,
        }
    }
}

define_obj_type!(
    pub CallbackOutputDelegate + VideoDataOutputSampleBufDelegateImpl + OutputDelegateDeallocation,
    CallbackOutputDelegateInner,
    OUTPUT_DELEGATE
);

trait OutputDelegateDeallocation {
    fn cls_add_methods(cls: &objc::Class<objc::Id>) {
        extern "C" fn dealloc(delegate: &mut CallbackOutputDelegate, selector: &objc::Sel) {
            let object = delegate as *mut CallbackOutputDelegate;
            unsafe {
                let superclass_dealloc: unsafe extern "C" fn(
                    *mut CallbackOutputDelegate,
                    &objc::Sel,
                ) = std::mem::transmute(objc::NS_OBJECT.method_impl(selector));
                std::ptr::drop_in_place(delegate.inner_mut());
                superclass_dealloc(object, selector);
            }
        }

        // The pinned cidre macro drops only the Rust payload. Its later
        // class_addMethod cannot replace this complete NSObject deallocator.
        let added = unsafe {
            objc::class_addMethod(
                cls,
                objc::sel_reg_name(c"dealloc".as_ptr().cast()),
                std::mem::transmute::<
                    extern "C" fn(&mut CallbackOutputDelegate, &objc::Sel),
                    extern "C" fn(),
                >(dealloc),
                c"v@:".as_ptr().cast(),
            )
        };
        assert!(added, "Camera delegate deallocator already registered");
    }

    fn cls_add_protocol(_: &objc::Class<objc::Id>) {}
}

impl OutputDelegateDeallocation for CallbackOutputDelegate {}

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
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        }));

        if result.is_err() {
            warn!("Suppressed panic in AVFoundation output delegate");
        }
    }

    extern "C" fn impl_capture_output_did_drop_sample_buf_from_connection(
        &mut self,
        _cmd: Option<&cidre::objc::Sel>,
        _output: &av::CaptureOutput,
        sample_buf: &cm::SampleBuf,
        _connection: &av::CaptureConnection,
    ) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let inner = self.inner_mut();
            inner.dropped_frames += 1;

            if inner.dropped_frames == 1 || inner.dropped_frames.is_multiple_of(100) {
                let reason = sample_buf
                    .attach(
                        cm::sample_buffer::buf_attach_keys::dropped_frame_reason(),
                        std::ptr::null_mut(),
                    )
                    .map(|value| value.desc().to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                warn!(
                    count = inner.dropped_frames,
                    reason = %reason,
                    "AVFoundation dropped camera sample buffer(s)"
                );
            }
        }));

        if result.is_err() {
            warn!("Suppressed panic in AVFoundation drop delegate");
        }
    }
}

fn mach_time_to_microseconds(mach_time: u64) -> Duration {
    let timebase_info = mach::TimeBaseInfo::new();
    if timebase_info.numer == timebase_info.denom {
        return Duration::from_nanos(mach_time);
    }
    if timebase_info.denom == 0 {
        warn!("Invalid mach timebase denominator");
        return Duration::ZERO;
    }

    let microseconds =
        (mach_time as u128 * timebase_info.numer as u128) / (timebase_info.denom as u128 * 1000);
    Duration::from_micros(microseconds.min(u64::MAX as u128) as u64)
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

#[cfg(test)]
mod deallocation_tests {
    use super::*;
    use std::{
        ffi::c_void,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    #[link(name = "objc")]
    unsafe extern "C" {
        #[link_name = "objc_setAssociatedObject"]
        fn set_associated_object(
            object: *const c_void,
            key: *const c_void,
            value: *const c_void,
            policy: usize,
        );
    }

    static ASSOCIATION_KEY: u8 = 0;

    struct DropCounter(Arc<AtomicUsize>);

    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn delegate(counter: DropCounter) -> arc::R<CallbackOutputDelegate> {
        CallbackOutputDelegate::with(CallbackOutputDelegateInner::new(Box::new(move |_| {
            let _ = &counter;
        })))
    }

    #[test]
    fn final_release_drops_payload_and_native_associated_objects_once() {
        let drops = Arc::new(AtomicUsize::new(0));
        for cycle in 0..100 {
            let outer = delegate(DropCounter(drops.clone()));
            let associated = delegate(DropCounter(drops.clone()));
            unsafe {
                set_associated_object(
                    std::ptr::from_ref(outer.as_ref()).cast(),
                    std::ptr::from_ref(&ASSOCIATION_KEY).cast(),
                    std::ptr::from_ref(associated.as_ref()).cast(),
                    1,
                );
            }
            drop(associated);
            assert_eq!(drops.load(Ordering::SeqCst), cycle * 2);
            drop(outer);
            assert_eq!(drops.load(Ordering::SeqCst), (cycle + 1) * 2);
        }
    }
}
