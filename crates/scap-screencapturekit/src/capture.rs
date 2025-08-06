use cidre::{
    arc, cf, cg, cm, cv, define_obj_type, dispatch, ns, objc,
    sc::{self, StreamDelegate, StreamDelegateImpl, StreamOutput, StreamOutputImpl},
};

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
            (cb)(stream, sample_buf, kind)
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

type DidOutputSampleBufCallback = Box<dyn FnMut(&sc::Stream, &mut cm::SampleBuf, sc::OutputType)>;
type StreamDidStopwithErrCallback = Box<dyn FnMut(&sc::Stream, &ns::Error)>;

pub struct CapturerCallbacksInner {
    did_output_sample_buf_cb: Option<DidOutputSampleBufCallback>,
    did_stop_with_err_cb: Option<StreamDidStopwithErrCallback>,
}

impl Default for CapturerCallbacksInner {
    fn default() -> Self {
        Self {
            did_output_sample_buf_cb: None,
            did_stop_with_err_cb: None,
        }
    }
}

pub struct Capturer {
    target: arc::R<sc::ContentFilter>,
    config: arc::R<sc::StreamCfg>,
    queue: arc::R<dispatch::Queue>,
    stream: arc::R<sc::Stream>,
    callbacks: arc::R<CapturerCallbacks>,
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

    pub async fn start(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.start().await
    }

    pub async fn stop(&self) -> Result<(), arc::R<ns::Error>> {
        self.stream.stop().await
    }
}

pub struct CapturerBuilder {
    target: arc::R<sc::ContentFilter>,
    config: arc::R<sc::StreamCfg>,
    callbacks: CapturerCallbacksInner,
}

impl CapturerBuilder {
    pub fn with_output_sample_buf_cb(
        mut self,
        cb: impl FnMut(&sc::Stream, &mut cm::SampleBuf, sc::OutputType) + 'static,
    ) -> Self {
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
            queue,
            stream,
            callbacks,
        })
    }
}
