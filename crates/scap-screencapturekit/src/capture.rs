use cidre::{
    arc, cm, cv, define_obj_type, dispatch, ns, objc,
    sc::{self, StreamDelegate, StreamDelegateImpl, StreamOutput, StreamOutputImpl},
};

define_obj_type!(
    pub CapturerCallbacks + StreamOutputImpl + StreamDelegateImpl + CapturerCallbacksDeallocation,
    CapturerCallbacksInner,
    CAPTURER
);

trait CapturerCallbacksDeallocation {
    fn cls_add_methods(cls: &objc::Class<objc::Id>) {
        extern "C" fn dealloc(callbacks: &mut CapturerCallbacks, selector: &objc::Sel) {
            let object = callbacks as *mut CapturerCallbacks;
            unsafe {
                let superclass_dealloc: unsafe extern "C" fn(*mut CapturerCallbacks, &objc::Sel) =
                    std::mem::transmute(objc::NS_OBJECT.method_impl(selector));
                std::ptr::drop_in_place(callbacks.inner_mut());
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
                    extern "C" fn(&mut CapturerCallbacks, &objc::Sel),
                    extern "C" fn(),
                >(dealloc),
                c"v@:".as_ptr().cast(),
            )
        };
        assert!(added, "Capture delegate deallocator already registered");
    }

    fn cls_add_protocol(_: &objc::Class<objc::Id>) {}
}

impl CapturerCallbacksDeallocation for CapturerCallbacks {}

unsafe impl Send for CapturerCallbacks {}
unsafe impl Sync for CapturerCallbacks {}

impl sc::stream::Output for CapturerCallbacks {}

#[objc::add_methods]
impl sc::stream::OutputImpl for CapturerCallbacks {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _: &sc::Stream,
        sample_buf: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(cb) = &mut self.inner_mut().did_output_sample_buf_cb {
                let sample_buf = sample_buf.retained();
                let frame = match kind {
                    sc::OutputType::Screen => {
                        if sample_buf.image_buf().is_none() {
                            return;
                        }

                        Frame::Screen(VideoFrame { sample_buf })
                    }
                    sc::OutputType::Audio => Frame::Audio(AudioFrame { sample_buf }),
                    sc::OutputType::Mic => Frame::Mic(AudioFrame { sample_buf }),
                };
                (cb)(frame);
            }
        }));

        if result.is_err() {
            tracing::warn!("Suppressed panic in ScreenCaptureKit output callback");
        }
    }
}

impl sc::stream::Delegate for CapturerCallbacks {}

#[objc::add_methods]
impl sc::stream::DelegateImpl for CapturerCallbacks {
    extern "C" fn impl_stream_did_stop_with_err(
        &mut self,
        _cmd: Option<&objc::Sel>,
        stream: &sc::Stream,
        error: &ns::Error,
    ) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(cb) = &mut self.inner_mut().did_stop_with_err_cb {
                (cb)(stream, error)
            }
        }));

        if result.is_err() {
            tracing::warn!("Suppressed panic in ScreenCaptureKit stop callback");
        }
    }
}

type DidOutputSampleBufCallback = Box<dyn FnMut(Frame)>;
type StreamDidStopwithErrCallback = Box<dyn FnMut(&sc::Stream, &ns::Error)>;

#[derive(Default)]
pub struct CapturerCallbacksInner {
    did_output_sample_buf_cb: Option<DidOutputSampleBufCallback>,
    did_stop_with_err_cb: Option<StreamDidStopwithErrCallback>,
}

pub struct Capturer {
    _queue: arc::R<dispatch::Queue>,
    stream: arc::R<sc::Stream>,
    // READING THIS IS NOT THREAD SAFE, IT JUST HAS TO EXIST
    _callbacks: arc::R<CapturerCallbacks>,
}

impl Capturer {
    pub fn builder(
        target: arc::R<sc::ContentFilter>,
        config: arc::R<sc::StreamCfg>,
    ) -> CapturerBuilder {
        CapturerBuilder {
            target,
            config,
            callbacks: CapturerCallbacksInner::default(),
        }
    }

    pub async fn start(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.start().await
    }

    pub async fn stop(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.stop().await
    }
}

pub struct VideoFrame {
    sample_buf: arc::R<cm::SampleBuf>,
}

unsafe impl Send for VideoFrame {}

impl VideoFrame {
    pub fn sample_buf(&self) -> &cm::SampleBuf {
        self.sample_buf.as_ref()
    }

    pub fn sample_buf_mut(&mut self) -> &mut cm::SampleBuf {
        self.sample_buf.as_mut()
    }

    pub fn image_buf(&self) -> Option<&cv::ImageBuf> {
        self.sample_buf.image_buf()
    }
}

pub struct AudioFrame {
    sample_buf: arc::R<cm::SampleBuf>,
}

impl AudioFrame {
    pub fn sample_buf(&self) -> &cm::SampleBuf {
        self.sample_buf.as_ref()
    }

    pub fn sample_buf_mut(&mut self) -> &mut cm::SampleBuf {
        self.sample_buf.as_mut()
    }
}

pub enum Frame {
    Screen(VideoFrame),
    Audio(AudioFrame),
    Mic(AudioFrame),
}

impl Frame {
    pub fn sample_buf(&self) -> &cm::SampleBuf {
        match self {
            Frame::Screen(frame) => frame.sample_buf(),
            Frame::Audio(frame) => frame.sample_buf(),
            Frame::Mic(frame) => frame.sample_buf(),
        }
    }

    pub fn sample_buf_mut(&mut self) -> &mut cm::SampleBuf {
        match self {
            Frame::Screen(frame) => frame.sample_buf_mut(),
            Frame::Audio(frame) => frame.sample_buf_mut(),
            Frame::Mic(frame) => frame.sample_buf_mut(),
        }
    }

    pub fn output_type(&self) -> sc::OutputType {
        match self {
            Frame::Screen(_) => sc::OutputType::Screen,
            Frame::Audio(_) => sc::OutputType::Audio,
            Frame::Mic(_) => sc::OutputType::Mic,
        }
    }
}

pub struct CapturerBuilder {
    target: arc::R<sc::ContentFilter>,
    config: arc::R<sc::StreamCfg>,
    callbacks: CapturerCallbacksInner,
}

impl CapturerBuilder {
    pub fn with_output_sample_buf_cb(mut self, cb: impl FnMut(Frame) + 'static) -> Self {
        self.callbacks.did_output_sample_buf_cb = Some(Box::new(cb));
        self
    }

    pub fn with_stop_with_err_cb(
        mut self,
        cb: impl FnMut(&sc::Stream, &ns::Error) + 'static,
    ) -> Self {
        self.callbacks.did_stop_with_err_cb = Some(Box::new(cb));
        self
    }

    pub fn build(self) -> Result<Capturer, arc::R<ns::Error>> {
        let callbacks = CapturerCallbacks::with(self.callbacks);

        let stream = sc::Stream::with_delegate(&self.target, &self.config, callbacks.as_ref());

        let queue = dispatch::Queue::serial_with_ar_pool();

        if crate::is_system_audio_supported() && unsafe { self.config.captures_audio() } {
            stream
                .add_stream_output(callbacks.as_ref(), sc::OutputType::Audio, Some(&queue))
                .map_err(|e| e.retained())?;
        }

        stream
            .add_stream_output(callbacks.as_ref(), sc::OutputType::Screen, Some(&queue))
            .map_err(|e| e.retained())?;

        Ok(Capturer {
            _queue: queue,
            stream,
            _callbacks: callbacks,
        })
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

    fn delegate(counter: DropCounter) -> arc::R<CapturerCallbacks> {
        CapturerCallbacks::with(CapturerCallbacksInner {
            did_output_sample_buf_cb: Some(Box::new(move |_| {
                let _ = &counter;
            })),
            did_stop_with_err_cb: None,
        })
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
