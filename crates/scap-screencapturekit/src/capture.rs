use cidre::{
    arc, cm, cv, define_obj_type, dispatch, ns, objc,
    sc::{self, StreamDelegate, StreamDelegateImpl, StreamOutput, StreamOutputImpl},
};
use tracing::warn;

define_obj_type!(
    pub CapturerCallbacks + StreamOutputImpl + StreamDelegateImpl, CapturerCallbacksInner, CAPTURER
);

impl sc::stream::Output for CapturerCallbacks {}

#[objc::add_methods]
impl sc::stream::OutputImpl for CapturerCallbacks {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        stream: &sc::Stream,
        sample_buf: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        if let Some(cb) = &mut self.inner_mut().did_output_sample_buf_cb {
            let frame = match kind {
                sc::OutputType::Screen => {
                    let Some(image_buf) = sample_buf.image_buf().map(|v| v.retained()) else {
                        warn!("Screen sample buffer has no image buffer");
                        return;
                    };

                    Frame::Screen(VideoFrame {
                        stream,
                        sample_buf,
                        image_buf,
                    })
                }
                sc::OutputType::Audio => Frame::Audio(AudioFrame { stream, sample_buf }),
                sc::OutputType::Mic => Frame::Mic(AudioFrame { stream, sample_buf }),
            };
            (cb)(frame);
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
        if let Some(cb) = &mut self.inner_mut().did_stop_with_err_cb {
            (cb)(stream, error)
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
    target: arc::R<sc::ContentFilter>,
    config: arc::R<sc::StreamCfg>,
    _queue: arc::R<dispatch::Queue>,
    stream: arc::R<sc::Stream>,
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

    pub fn config(&self) -> &sc::StreamCfg {
        &self.config
    }

    pub fn target(&self) -> &sc::ContentFilter {
        &self.target
    }

    pub async fn start(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.start().await
    }

    pub async fn stop(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.stop().await
    }
}

pub struct VideoFrame<'a> {
    stream: &'a sc::Stream,
    sample_buf: &'a mut cm::SampleBuf,
    image_buf: arc::R<cv::ImageBuf>,
}

impl<'a> VideoFrame<'a> {
    pub fn stream(&self) -> &sc::Stream {
        self.stream
    }

    pub fn sample_buf(&self) -> &cm::SampleBuf {
        self.sample_buf
    }

    pub fn sample_buf_mut(&mut self) -> &mut cm::SampleBuf {
        self.sample_buf
    }

    pub fn image_buf(&self) -> &cv::ImageBuf {
        &self.image_buf
    }

    pub fn image_buf_mut(&mut self) -> &mut cv::ImageBuf {
        &mut self.image_buf
    }
}

pub struct AudioFrame<'a> {
    stream: &'a sc::Stream,
    sample_buf: &'a mut cm::SampleBuf,
}

pub enum Frame<'a> {
    Screen(VideoFrame<'a>),
    Audio(AudioFrame<'a>),
    Mic(AudioFrame<'a>),
}

impl<'a> Frame<'a> {
    pub fn stream(&self) -> &sc::Stream {
        match self {
            Frame::Screen(frame) => frame.stream,
            Frame::Audio(frame) => frame.stream,
            Frame::Mic(frame) => frame.stream,
        }
    }

    pub fn sample_buf(&self) -> &cm::SampleBuf {
        match self {
            Frame::Screen(frame) => frame.sample_buf,
            Frame::Audio(frame) => frame.sample_buf,
            Frame::Mic(frame) => frame.sample_buf,
        }
    }

    pub fn sample_buf_mut(&mut self) -> &mut cm::SampleBuf {
        match self {
            Frame::Screen(frame) => frame.sample_buf,
            Frame::Audio(frame) => frame.sample_buf,
            Frame::Mic(frame) => frame.sample_buf,
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

        if self.config.captures_audio() {
            stream
                .add_stream_output(callbacks.as_ref(), sc::OutputType::Audio, Some(&queue))
                .map_err(|e| e.retained())?;
        }

        stream
            .add_stream_output(callbacks.as_ref(), sc::OutputType::Screen, Some(&queue))
            .map_err(|e| e.retained())?;

        Ok(Capturer {
            target: self.target,
            config: self.config,
            _queue: queue,
            stream,
            _callbacks: callbacks,
        })
    }
}
