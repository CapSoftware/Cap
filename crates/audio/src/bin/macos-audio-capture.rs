#[tokio::main]
pub async fn main() {
    #[cfg(target_os = "macos")]
    macos::main().await;
    #[cfg(not(target_os = "macos"))]
    panic!("This example is only supported on macOS");
}

#[cfg(target_os = "macos")]
mod macos {

    use std::{sync::mpsc::Sender, time::Duration};

    use cidre::{
        cm, define_obj_type, ns, objc,
        sc::{
            self,
            stream::{Output, OutputImpl},
        },
    };
    use ffmpeg::ChannelLayout;
    use ffmpeg::frame as avframe;

    #[repr(C)]
    struct DelegateInner {
        tx: Sender<avframe::Audio>,
    }

    define_obj_type!(Delegate + OutputImpl, DelegateInner, FRAME_COUNTER);

    impl Output for Delegate {}

    #[objc::add_methods]
    impl OutputImpl for Delegate {
        extern "C" fn impl_stream_did_output_sample_buf(
            &mut self,
            _cmd: Option<&cidre::objc::Sel>,
            _stream: &sc::Stream,
            sample_buf: &mut cm::SampleBuf,
            kind: sc::OutputType,
        ) {
            match kind {
                sc::OutputType::Screen => {}
                sc::OutputType::Audio => {
                    let buf_list = sample_buf.audio_buf_list::<2>().unwrap();
                    let slice = buf_list.block().as_slice().unwrap();

                    let mut frame = ffmpeg::frame::Audio::new(
                        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                        sample_buf.num_samples() as usize,
                        ChannelLayout::STEREO,
                    );
                    assert!(!frame.is_planar());
                    let asdb = sample_buf.format_desc().unwrap();
                    frame.set_rate(asdb.stream_basic_desc().unwrap().sample_rate as u32);
                    frame.data_mut(0).copy_from_slice(slice);
                    self.inner_mut().tx.send(frame).unwrap();
                }
                sc::OutputType::Mic => {}
            }
        }
    }

    pub async fn main() {
        let mut cfg = sc::StreamCfg::new();
        cfg.set_captures_audio(true);
        cfg.set_excludes_current_process_audio(false);

        let content = sc::ShareableContent::current().await.expect("content");
        let display = &content.displays().get(0).unwrap();
        let filter = sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new());
        let stream = sc::Stream::new(&filter, &cfg);

        let (tx, rx) = std::sync::mpsc::channel();
        let delegate = Delegate::with(DelegateInner { tx });

        stream
            .add_stream_output(delegate.as_ref(), sc::OutputType::Audio, None)
            .unwrap();

        stream.start().await.unwrap();

        tokio::time::sleep(Duration::from_secs(5)).await;

        let _ = stream.stop().await;

        let mut samples = vec![];
        while let Ok(s) = rx.try_recv() {
            samples.push(s)
        }

        let bytes = samples
            .iter()
            .flat_map(|s| s.data(0).to_vec())
            .collect::<Vec<_>>();

        std::fs::write("./bruh.raw", &bytes).unwrap();
    }
}
