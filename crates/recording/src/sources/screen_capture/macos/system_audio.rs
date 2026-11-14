use crate::output_pipeline::{self, AudioFrame, AudioSource, SetupCtx};
use anyhow::{Context, ensure};
use cap_media_info::AudioInfo;
use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};
use cidre::{cat, cf, core_audio as ca, ns, os};
use futures::channel::mpsc;
use std::time::Duration;
use tokio::sync::oneshot;

pub struct OutputAudioSource {
    commands: flume::Sender<Command>,
    info: AudioInfo,
    capturer: super::Capturer,
}

enum Command {
    Start(oneshot::Sender<Result<(), String>>),
    Stop(oneshot::Sender<()>),
}

impl AudioSource for OutputAudioSource {
    type Config = super::OutputAudioSourceConfig;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + Send + 'static {
        let (commands, receiver) = flume::unbounded();
        let (ready_tx, ready_rx) = oneshot::channel();
        let health = ctx.health_tx().clone();
        let cancel = ctx.stop_token();
        ctx.tasks().spawn_thread("output-device-audio", move || {
            let mut capture = match OutputCapture::new(tx.clone(), health.clone()) {
                Ok(capture) => capture,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return Err(error);
                }
            };
            let info = capture.context.info;
            if ready_tx.send(Ok(info)).is_err() {
                return Ok(());
            }
            let mut started = false;
            loop {
                if cancel.is_cancelled() {
                    return Ok(());
                }
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(Command::Start(reply)) => {
                        let result = capture.start();
                        started = result.is_ok();
                        let _ = reply.send(result.map_err(|error| error.to_string()));
                    }
                    Ok(Command::Stop(reply)) => {
                        drop(capture);
                        let _ = reply.send(());
                        return Ok(());
                    }
                    Err(flume::RecvTimeoutError::Disconnected) => return Ok(()),
                    Err(flume::RecvTimeoutError::Timeout) if started => {
                        let device = ca::System::default_output_device()
                            .context("Read the system audio output device")?;
                        let format = capture.tap.asbd().context("Read system audio format")?;
                        if device.0 != capture.output_device.0 || format != capture.format {
                            drop(capture);
                            capture = OutputCapture::new(tx.clone(), health.clone())?;
                            capture.start()?;
                        }
                    }
                    Err(flume::RecvTimeoutError::Timeout) => {}
                }
            }
        });

        async move {
            let info = ready_rx
                .await
                .context("System audio setup stopped")?
                .map_err(anyhow::Error::msg)?;
            config.capturer.start().await?;
            Ok(Self {
                commands,
                info,
                capturer: config.capturer,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        self.capturer.start().await?;
        let (reply, result) = oneshot::channel();
        self.commands.send(Command::Start(reply))?;
        result.await?.map_err(anyhow::Error::msg)
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        let (reply, result) = oneshot::channel();
        if self.commands.send(Command::Stop(reply)).is_ok() {
            let _ = result.await;
        }
        self.capturer.stop().await
    }
}

struct CallbackContext {
    info: AudioInfo,
    tx: mpsc::Sender<AudioFrame>,
    health: output_pipeline::HealthSender,
}

struct OutputCapture {
    running: Option<ca::hardware::StartedDevice<ca::Device>>,
    device: ca::AggregateDevice,
    proc_id: ca::DeviceIoProcId,
    context: Box<CallbackContext>,
    tap: ProcessTap,
    output_device: ca::Device,
    format: cat::AudioStreamBasicDesc,
}

impl OutputCapture {
    fn new(
        tx: mpsc::Sender<AudioFrame>,
        health: output_pipeline::HealthSender,
    ) -> anyhow::Result<Self> {
        let output_device = ca::System::default_output_device()
            .context("No system audio output device is available")?;
        let output_uid = output_device
            .uid()
            .context("Read system audio output UID")?;
        // Enabling mixdown makes this tap global again, including hidden microphone sinks.
        let mut description = ca::TapDesc::alloc().init_excluding_processes_and_device(
            &ns::Array::new(),
            output_uid.as_ns(),
            0,
        );
        description.set_private(true);
        let tap = ProcessTap::new(&description)?;
        let format = tap.asbd().context("Read system audio tap format")?;
        ensure!(
            format.format == cat::AudioFormat::LINEAR_PCM
                && format
                    .format_flags
                    .contains(cat::AudioFormatFlags::IS_FLOAT)
                && format.bits_per_channel == 32
                && format.channels_per_frame > 0
                && format.sample_rate > 0.0,
            "Unsupported system audio output format: {format:?}"
        );
        let sample_type = if format.is_interleaved() {
            ffmpeg::format::sample::Type::Packed
        } else {
            ffmpeg::format::sample::Type::Planar
        };
        let info = AudioInfo::new_raw(
            ffmpeg::format::Sample::F32(sample_type),
            format.sample_rate as u32,
            format.channels_per_frame.try_into()?,
        );
        tracing::info!(output_uid = %output_uid, sample_rate = info.sample_rate, channels = info.channels, "Capturing system playback from the output device");

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap
                .id
                .cf_prop::<cf::String>(&ca::PropSelector::TAP_UID.global_addr())?
                .as_type_ref()],
        );
        let taps = cf::ArrayOf::from_slice(&[sub_tap.as_ref()]);
        let uid = cf::Uuid::new().to_cf_string();
        let properties = cf::DictionaryOf::with_keys_values(
            &[
                ca::aggregate_device_keys::name(),
                ca::aggregate_device_keys::uid(),
                ca::aggregate_device_keys::is_private(),
                ca::aggregate_device_keys::tap_auto_start(),
                ca::aggregate_device_keys::tap_list(),
            ],
            &[
                cf::str!(c"Cap System Audio").as_type_ref(),
                uid.as_type_ref(),
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_true().as_type_ref(),
                taps.as_type_ref(),
            ],
        );
        let device = ca::AggregateDevice::with_desc(&properties)
            .context("Create system audio tap device")?;
        let mut context = Box::new(CallbackContext { info, tx, health });
        let proc_id = device
            .create_io_proc_id(capture_audio, Some(context.as_mut()))
            .context("Create system audio callback")?;
        Ok(Self {
            running: None,
            device,
            proc_id,
            context,
            tap,
            output_device,
            format,
        })
    }

    fn start(&mut self) -> anyhow::Result<()> {
        if self.running.is_none() {
            self.running = Some(
                ca::device_start(ca::Device(self.device.0), Some(self.proc_id))
                    .context("Start system audio output capture")?,
            );
        }
        Ok(())
    }
}

struct ProcessTap {
    id: ca::Obj,
    destroy: unsafe extern "C-unwind" fn(ca::Obj) -> os::Status,
}

impl ProcessTap {
    fn new(description: &ca::TapDesc) -> anyhow::Result<Self> {
        // Resolve these at runtime so Cap can still launch on macOS 12.3–14.1.
        let create = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"AudioHardwareCreateProcessTap".as_ptr(),
            )
        };
        let destroy = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"AudioHardwareDestroyProcessTap".as_ptr(),
            )
        };
        ensure!(
            !create.is_null() && !destroy.is_null(),
            "System audio output taps are unavailable"
        );
        let create: unsafe extern "C-unwind" fn(&ca::TapDesc, &mut ca::Obj) -> os::Status =
            unsafe { std::mem::transmute(create) };
        let destroy = unsafe {
            std::mem::transmute::<
                *mut libc::c_void,
                unsafe extern "C-unwind" fn(ca::Obj) -> os::Status,
            >(destroy)
        };
        let mut id = ca::Obj::UNKNOWN;
        unsafe { create(description, &mut id) }
            .result()
            .context("Create system audio output tap")?;
        Ok(Self { id, destroy })
    }

    fn asbd(&self) -> os::Result<cat::AudioStreamBasicDesc> {
        self.id.prop(&ca::PropSelector::TAP_FORMAT.global_addr())
    }
}

impl Drop for ProcessTap {
    fn drop(&mut self) {
        let status = unsafe { (self.destroy)(self.id) };
        if status.is_err() {
            tracing::warn!(?status, "Failed to release the system audio tap");
        }
    }
}

impl Drop for OutputCapture {
    fn drop(&mut self) {
        drop(self.running.take());
        let status = unsafe { AudioDeviceDestroyIOProcID(self.device.0, self.proc_id) };
        if status != 0 {
            tracing::warn!(status, "Failed to release the system audio callback");
        }
    }
}

extern "C" fn capture_audio(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input: &cat::AudioBufList<1>,
    input_time: &cat::AudioTimeStamp,
    _output: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    context: Option<&mut CallbackContext>,
) -> os::Status {
    let Some(context) = context else {
        return os::Status::NO_ERR;
    };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let count = input.number_buffers as usize;
        if count == 0 {
            return;
        }
        let buffers = unsafe { std::slice::from_raw_parts(input.buffers.as_ptr(), count) };
        let first = &buffers[0];
        let bytes_per_frame = context.info.sample_format.bytes() * first.number_channels as usize;
        if bytes_per_frame == 0 || first.data_bytes_size == 0 {
            return;
        }
        let frame = if context.info.sample_format.is_packed() {
            if first.data.is_null() {
                return;
            }
            let data = unsafe {
                std::slice::from_raw_parts(first.data.cast::<u8>(), first.data_bytes_size as usize)
            };
            context
                .info
                .wrap_frame_with_max_channels(data, AudioInfo::MAX_AUDIO_CHANNELS as usize)
        } else {
            let samples = first.data_bytes_size as usize / bytes_per_frame;
            let mut frame = context.info.empty_frame(samples);
            for (index, buffer) in buffers.iter().take(frame.planes()).enumerate() {
                let bytes = buffer.data_bytes_size as usize;
                if buffer.data.is_null() || bytes > frame.data(index).len() {
                    return;
                }
                let data = unsafe { std::slice::from_raw_parts(buffer.data.cast::<u8>(), bytes) };
                frame.data_mut(index)[..bytes].copy_from_slice(data);
            }
            frame
        };
        let timestamp =
            Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(input_time.host_time));
        output_pipeline::send_with_stall_budget_futures(
            &mut context.tx,
            AudioFrame::new(frame, timestamp),
            "output-device-audio",
            &context.health,
        );
    }));
    os::Status::NO_ERR
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioDeviceDestroyIOProcID(device: ca::Obj, proc_id: ca::DeviceIoProcId) -> i32;
}
