use crate::{
    data::AudioInfo,
    pipeline::{task::PipelineSourceTask, RawNanoseconds, RealTimeClock},
};
use ffmpeg::frame as avframe;

pub trait SystemAudioSource {
    fn info() -> Result<AudioInfo, String>
    where
        Self: Sized;
}

#[cfg(target_os = "macos")]
pub mod macos {
    use crate::{
        data::{AudioInfo, PlanarData},
        pipeline::control::Control,
    };

    use super::*;

    use cidre::{
        arc, cm, define_obj_type, ns, objc,
        sc::{
            self,
            stream::{Output, OutputImpl},
        },
    };
    use ffmpeg::ChannelLayout;
    use flume::{Receiver, Sender};

    #[repr(C)]
    struct DelegateInner {
        tx: Sender<Result<avframe::Audio, String>>,
    }

    impl DelegateInner {
        fn new() -> (Self, Receiver<Result<avframe::Audio, String>>) {
            let (tx, rx) = flume::bounded(8);

            (Self { tx }, rx)
        }
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
                    frame.set_rate(48_000);
                    let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                    for i in 0..frame.planes() {
                        frame.plane_data_mut(i).copy_from_slice(
                            &slice
                                [i * data_bytes_size as usize..(i + 1) * data_bytes_size as usize],
                        );
                    }

                    frame.set_pts(Some(sample_buf.pts().value));

                    self.inner_mut().tx.send(Ok(frame));
                }
                sc::OutputType::Mic => {}
            }
        }
    }

    pub struct Source {
        content: arc::R<sc::ShareableContent>,
        delegate: arc::R<Delegate>,
        rx: flume::Receiver<Result<avframe::Audio, String>>,
    }

    impl Source {
        pub async fn init() -> Result<Self, String> {
            let content = sc::ShareableContent::current()
                .await
                .map_err(|e| format!("System Audio / {e}"))?;

            let (inner, rx) = DelegateInner::new();
            let delegate = Delegate::with(inner);

            Ok(Self {
                content,
                delegate,
                rx,
            })
        }
    }

    impl SystemAudioSource for Source {
        fn info() -> Result<AudioInfo, String> {
            Ok(AudioInfo::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                48_000,
                2,
            )
            .unwrap())
        }
    }

    impl PipelineSourceTask for Source {
        type Clock = RealTimeClock<RawNanoseconds>;
        type Output = ffmpeg::frame::Audio;

        fn run(
            &mut self,
            mut clock: Self::Clock,
            ready_signal: crate::pipeline::task::PipelineReadySignal,
            mut control_signal: crate::pipeline::control::PipelineControlSignal,
            output: flume::Sender<Self::Output>,
        ) {
            let mut cfg = sc::StreamCfg::new();
            cfg.set_captures_audio(true);
            cfg.set_excludes_current_process_audio(false);

            let display = &self.content.displays().get(0).unwrap();
            let filter =
                sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new());

            let stream = sc::Stream::new(&filter, &cfg);

            stream
                .add_stream_output(self.delegate.as_ref(), sc::OutputType::Audio, None)
                .unwrap();

            futures::executor::block_on(stream.start()).unwrap();

            let _ = ready_signal.send(Ok(()));

            loop {
                match control_signal.last() {
                    Some(Control::Play) => match self.rx.recv() {
                        Ok(Ok(mut samples)) => {
                            let ts = RawNanoseconds(samples.pts().unwrap() as u64);
                            samples.set_pts(clock.timestamp_for(ts));

                            let _ = output.send(samples);
                        }
                        _ => {
                            break;
                        }
                    },
                    Some(Control::Shutdown) | None => {
                        futures::executor::block_on(stream.stop()).unwrap();
                        break;
                    }
                }
            }
        }
    }
}

pub mod windows {
    use crate::{
        data::AudioInfo,
        pipeline::{control::Control, task::PipelineSourceTask, RealTimeClock},
    };
    use cpal::{
        traits::{DeviceTrait, HostTrait, StreamTrait},
        *,
    };

    use super::SystemAudioSource;

    pub struct Source;

    impl Source {
        pub fn info() -> Result<AudioInfo, String> {
            let host = cpal::default_host();

            let output_device = host
                .default_output_device()
                .ok_or_else(|| "No default output device".to_string())?;
            let supported_config = output_device
                .default_output_config()
                .map_err(|e| format!("Default Stream / {e}"))?;

            Ok(AudioInfo::from_stream_config(&supported_config))
        }
    }

    impl SystemAudioSource for Source {
        fn info() -> Result<AudioInfo, String>
        where
            Self: Sized,
        {
            Self::info()
        }
    }

    impl PipelineSourceTask for Source {
        type Clock = RealTimeClock<StreamInstant>;
        type Output = ffmpeg::frame::Audio;

        fn run(
            &mut self,
            mut clock: Self::Clock,
            ready_signal: crate::pipeline::task::PipelineReadySignal,
            mut control_signal: crate::pipeline::control::PipelineControlSignal,
            output: flume::Sender<Self::Output>,
        ) {
            let host = cpal::default_host();

            let (tx, rx) = flume::bounded(8);

            let init = || {
                let output_device = host
                    .default_output_device()
                    .ok_or_else(|| "No default output device".to_string())?;
                let supported_config = output_device
                    .default_output_config()
                    .map_err(|e| format!("Default Stream / {e}"))?;
                let config = supported_config.clone().into();

                let stream = output_device
                    .build_input_stream_raw(
                        &config,
                        supported_config.sample_format(),
                        {
                            let tx = tx.clone();
                            move |data, info: &cpal::InputCallbackInfo| {
                                tx.send(Ok((data.bytes().to_vec(), info.clone()))).unwrap();
                            }
                        },
                        move |e| {
                            let _ = tx.send(Err(e));
                        },
                        None,
                    )
                    .map_err(|e| format!("Build Input Stream / {e}"))?;

                stream.play().map_err(|e| format!("Play Stream / {e}"))?;

                Ok::<_, String>((supported_config, stream))
            };

            let (supported_config, _) = match init() {
                Ok(v) => v,
                Err(e) => {
                    let _ = ready_signal.send(Err(crate::MediaError::TaskLaunch(e)));
                    return;
                }
            };

            let audio_info = AudioInfo::from_stream_config(&supported_config);

            loop {
                match control_signal.last() {
                    Some(Control::Play) => match rx.recv() {
                        Ok(Ok((data, info))) => match clock.timestamp_for(info.timestamp().capture)
                        {
                            None => {
                                eprintln!("Clock is currently stopped. Dropping frames.");
                            }
                            Some(timestamp) => {
                                let frame = audio_info.wrap_frame(&data, timestamp);
                                if let Err(_) = output.send(frame) {
                                    break;
                                }
                            }
                        },
                        _ => {
                            break;
                        }
                    },
                    Some(Control::Shutdown) | None => {
                        return;
                    }
                }
            }
        }
    }
}
