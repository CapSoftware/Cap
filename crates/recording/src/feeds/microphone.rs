use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cap_timestamp::Timestamp;
use cpal::{
    BufferSize, Device, InputCallbackInfo, SampleFormat, StreamError, SupportedStreamConfig,
    SupportedStreamConfigRange,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use flume::TrySendError;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use indexmap::IndexMap;
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
use std::{
    ops::Deref,
    sync::mpsc::{self, SyncSender},
};
use tracing::{debug, error, info, trace, warn};

pub type MicrophonesMap = IndexMap<String, (Device, SupportedStreamConfig)>;

#[derive(Clone)]
pub struct MicrophoneSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub info: InputCallbackInfo,
    pub timestamp: Timestamp,
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    input_id_counter: u32,
    state: State,
    senders: Vec<flume::Sender<MicrophoneSamples>>,
    error_sender: flume::Sender<StreamError>,
}

enum State {
    Open(OpenState),
    Locked { inner: AttachedState },
}

impl State {
    fn try_as_open(&mut self) -> Result<&mut OpenState, FeedLockedError> {
        if let Self::Open(open_state) = self {
            Ok(open_state)
        } else {
            Err(FeedLockedError)
        }
    }
}

struct OpenState {
    connecting: Option<ConnectingState>,
    attached: Option<AttachedState>,
}

impl OpenState {
    fn handle_input_connected(&mut self, data: InputConnected) {
        if let Some(connecting) = &self.connecting
            && data.id == connecting.id
        {
            self.attached = Some(AttachedState {
                id: data.id,
                label: data.label.clone(),
                config: data.config.clone(),
                buffer_size_frames: data.buffer_size_frames,
                done_tx: data.done_tx,
            });
            self.connecting = None;
        }
    }
}

struct ConnectingState {
    id: u32,
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
}

struct AttachedState {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: mpsc::SyncSender<()>,
}

impl MicrophoneFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            input_id_counter: 0,
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            error_sender,
        }
    }

    pub fn default_device() -> Option<(String, Device, SupportedStreamConfig)> {
        let host = cpal::default_host();
        host.default_input_device().and_then(get_usable_device)
    }

    pub fn list() -> MicrophonesMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        if let Some((name, device, config)) =
            host.default_input_device().and_then(get_usable_device)
        {
            device_map.insert(name, (device, config));
        }

        match host.input_devices() {
            Ok(devices) => {
                for (name, device, config) in devices.filter_map(get_usable_device) {
                    device_map.entry(name).or_insert((device, config));
                }
            }
            Err(error) => {
                error!("Could not access audio input devices: {}", error);
            }
        }

        device_map
    }
}

fn get_usable_device(device: Device) -> Option<(String, Device, SupportedStreamConfig)> {
    let device_name_for_logging = device.name().ok();

    let preferred_rate = cpal::SampleRate(48_000);

    let result = device
        .supported_input_configs()
        .map_err(|error| {
            error!(
                "Error getting supported input configs for device {:?}: {}",
                device_name_for_logging, error
            );
            error
        })
        .ok()
        .and_then(|configs| {
            let mut configs = configs.collect::<Vec<_>>();

            configs.sort_by(|a, b| {
                b.sample_format()
                    .sample_size()
                    .cmp(&a.sample_format().sample_size())
                    .then(b.max_sample_rate().cmp(&a.max_sample_rate()))
            });

            // First try to find a config that natively supports 48 kHz so we
            // don't have to rely on resampling later.
            if let Some(config) = configs.iter().find(|config| {
                ffmpeg_sample_format_for(config.sample_format()).is_some()
                    && config.min_sample_rate().0 <= preferred_rate.0
                    && config.max_sample_rate().0 >= preferred_rate.0
            }) {
                return Some(config.with_sample_rate(preferred_rate));
            }

            configs.into_iter().find_map(|config| {
                ffmpeg_sample_format_for(config.sample_format())
                    .map(|_| config.with_sample_rate(select_sample_rate(&config)))
            })
        });

    result.and_then(|config| device.name().ok().map(|name| (name, device, config)))
}

fn select_sample_rate(config: &SupportedStreamConfigRange) -> cpal::SampleRate {
    const PREFERRED_RATES: [u32; 2] = [48_000, 44_100];

    for rate in PREFERRED_RATES {
        if config.min_sample_rate().0 <= rate && config.max_sample_rate().0 >= rate {
            return cpal::SampleRate(rate);
        }
    }

    cpal::SampleRate(config.max_sample_rate().0)
}

const TARGET_LATENCY_MS: u32 = 35;
const MIN_LATENCY_MS: u32 = 10;
const MAX_LATENCY_MS: u32 = 120;
const ABS_MIN_BUFFER_FRAMES: u32 = 128;

fn stream_config_with_latency(config: &SupportedStreamConfig) -> (cpal::StreamConfig, Option<u32>) {
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    let buffer_size_frames = desired_buffer_size_frames(config);

    if let Some(frames) = buffer_size_frames {
        stream_config.buffer_size = BufferSize::Fixed(frames);
    }

    (stream_config, buffer_size_frames)
}

fn desired_buffer_size_frames(config: &SupportedStreamConfig) -> Option<u32> {
    match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => {
            let sample_rate = config.sample_rate().0;

            if sample_rate == 0 || *max == 0 {
                return None;
            }

            let desired = latency_ms_to_frames(sample_rate, TARGET_LATENCY_MS);
            let min_latency_frames = latency_ms_to_frames(sample_rate, MIN_LATENCY_MS);
            let max_latency_frames = latency_ms_to_frames(sample_rate, MAX_LATENCY_MS);

            let desired = desired.clamp(min_latency_frames, max_latency_frames);
            let device_max = *max;
            let device_min = ABS_MIN_BUFFER_FRAMES.min(device_max).max(*min);

            Some(desired.clamp(device_min, device_max))
        }
        cpal::SupportedBufferSize::Unknown => None,
    }
}

fn latency_ms_to_frames(sample_rate: u32, milliseconds: u32) -> u32 {
    let frames = (sample_rate as u64 * milliseconds as u64) / 1_000;
    frames.max(1) as u32
}

#[derive(Reply)]
pub struct MicrophoneFeedLock {
    actor: ActorRef<MicrophoneFeed>,
    config: SupportedStreamConfig,
    audio_info: AudioInfo,
    buffer_size_frames: Option<u32>,
    drop_tx: Option<oneshot::Sender<()>>,
}

impl MicrophoneFeedLock {
    pub fn config(&self) -> &SupportedStreamConfig {
        &self.config
    }

    pub fn audio_info(&self) -> AudioInfo {
        self.audio_info
    }

    pub fn buffer_size_frames(&self) -> Option<u32> {
        self.buffer_size_frames
    }
}

impl Deref for MicrophoneFeedLock {
    type Target = ActorRef<MicrophoneFeed>;

    fn deref(&self) -> &Self::Target {
        &self.actor
    }
}

impl Drop for MicrophoneFeedLock {
    fn drop(&mut self) {
        if let Some(drop_tx) = self.drop_tx.take() {
            let _ = drop_tx.send(());
        }
    }
}

// Public Requests

pub struct SetInput {
    pub label: String,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<MicrophoneSamples>);

pub struct Lock;

// Private Events

struct InputConnected {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: SyncSender<()>,
}

struct LockedInputReconnected {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: mpsc::SyncSender<()>,
}

struct InputConnectFailed {
    id: u32,
}

struct Unlock;

// Impls

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("FeedLocked")]
pub struct FeedLockedError;

#[derive(Clone, Debug, thiserror::Error)]
pub enum SetInputError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("DeviceNotFound")]
    DeviceNotFound,
    #[error("BuildStreamCrashed")]
    BuildStreamCrashed,
    // we use strings for these as the cpal errors aren't Clone
    #[error("BuildStream: {0}")]
    BuildStream(String),
    #[error("PlayStream: {0}")]
    PlayStream(String),
}

impl Message<SetInput> for MicrophoneFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.SetInput('{}')", &msg.label);

        match &mut self.state {
            State::Open(state) => {
                let id = self.input_id_counter;
                self.input_id_counter += 1;

                let label = msg.label.clone();
                let Some((device, config)) = Self::list().swap_remove(&label) else {
                    return Err(SetInputError::DeviceNotFound);
                };

                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) = stream_config_with_latency(&config);

                let (ready_tx, ready_rx) = oneshot::channel::<Result<Option<u32>, SetInputError>>();
                let (done_tx, done_rx) = mpsc::sync_channel(0);

                let actor_ref = ctx.actor_ref();
                let ready = {
                    let config_for_ready = config.clone();
                    ready_rx
                        .map(move |v| {
                            let config = config_for_ready.clone();
                            v.map_err(|_| SetInputError::BuildStreamCrashed)
                                .and_then(|inner| inner)
                                .map(|buffer_size| (config, buffer_size))
                        })
                        .shared()
                };
                let error_sender = self.error_sender.clone();

                state.connecting = Some(ConnectingState {
                    id,
                    ready: {
                        let done_tx = done_tx.clone();
                        ready
                            .clone()
                            .map({
                                let label = label.clone();
                                move |v| {
                                    let label = label.clone();
                                    v.map(|(config, buffer_size_frames)| InputConnected {
                                        id,
                                        label,
                                        config,
                                        buffer_size_frames,
                                        done_tx,
                                    })
                                }
                            })
                            .boxed()
                    },
                });

                std::thread::spawn({
                    let config = config.clone();
                    let stream_config = stream_config.clone();
                    let device_name_for_log = device.name().ok();
                    move || {
                        if let Some(ref name) = device_name_for_log {
                            info!("Device '{}' available configs:", name);
                            for config in device.supported_input_configs().into_iter().flatten() {
                                info!(
                                    "  Format: {:?}, Min rate: {}, Max rate: {}, Sample size: {}",
                                    config.sample_format(),
                                    config.min_sample_rate().0,
                                    config.max_sample_rate().0,
                                    config.sample_format().sample_size()
                                );
                            }
                        }

                        let buffer_size_description = match &stream_config.buffer_size {
                            BufferSize::Default => "default".to_string(),
                            BufferSize::Fixed(frames) => format!(
                                "{} frames (~{:.1}ms)",
                                frames,
                                (*frames as f64 / config.sample_rate().0 as f64) * 1000.0
                            ),
                        };

                        info!(
                            "🎤 Building stream for '{:?}' with config: rate={}, channels={}, format={:?}, buffer_size={}",
                            device_name_for_log,
                            config.sample_rate().0,
                            config.channels(),
                            sample_format,
                            buffer_size_description
                        );

                        let stream = match device.build_input_stream_raw(
                            &stream_config,
                            sample_format,
                            {
                                let actor_ref = actor_ref.clone();
                                let mut callback_count = 0u64;
                                move |data, info| {
                                    if callback_count == 0 {
                                        info!(
                                            "🎤 First audio callback - data size: {} bytes, format: {:?}",
                                            data.bytes().len(),
                                            data.sample_format()
                                        );
                                    }
                                    callback_count += 1;

                                    let _ = actor_ref
                                        .tell(MicrophoneSamples {
                                            data: data.bytes().to_vec(),
                                            format: data.sample_format(),
                                            info: info.clone(),
                                            timestamp: Timestamp::from_cpal(info.timestamp().capture),
                                        })
                                        .try_send();
                                }
                            },
                            move |e| {
                                error!("Microphone stream error: {e}");

                                let _ = error_sender.send(e).is_err();
                            },
                            None,
                        ) {
                            Ok(stream) => stream,
                            Err(e) => {
                                let _ = ready_tx.send(Err(SetInputError::BuildStream(e.to_string())));
                                return;
                            }
                        };

                        if let Err(e) = stream.play() {
                            let _ = ready_tx.send(Err(SetInputError::PlayStream(e.to_string())));
                            return;
                        }

                        let _ = ready_tx.send(Ok(buffer_size_frames));

                        match done_rx.recv() {
                            Ok(_) => info!("Microphone actor shut down, ending stream"),
                            Err(_) => info!("Microphone actor unreachable, ending stream"),
                        }
                    }
                });

                tokio::spawn({
                    let ready = ready.clone();
                    let actor = ctx.actor_ref();
                    let done_tx = done_tx;
                    let label = label.clone();
                    async move {
                        match ready.await {
                            Ok((config, buffer_size_frames)) => {
                                let _ = actor
                                    .tell(InputConnected {
                                        id,
                                        label,
                                        config,
                                        buffer_size_frames,
                                        done_tx,
                                    })
                                    .await;
                            }
                            Err(_) => {
                                let _ = actor.tell(InputConnectFailed { id }).await;
                            }
                        }
                    }
                });

                let ready_for_return = ready.clone().map(|result| result.map(|(config, _)| config));

                Ok(ready_for_return.boxed())
            }
            State::Locked { inner } => {
                if inner.label != msg.label {
                    return Err(SetInputError::Locked(FeedLockedError));
                }

                let label = msg.label.clone();
                let Some((device, config)) = Self::list().swap_remove(&label) else {
                    return Err(SetInputError::DeviceNotFound);
                };

                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) = stream_config_with_latency(&config);

                let (ready_tx, ready_rx) = oneshot::channel::<Result<Option<u32>, SetInputError>>();
                let (done_tx, done_rx) = mpsc::sync_channel(0);

                let actor_ref = ctx.actor_ref();
                let ready = {
                    let config_for_ready = config.clone();
                    ready_rx
                        .map(move |v| {
                            let config = config_for_ready.clone();
                            v.map_err(|_| SetInputError::BuildStreamCrashed)
                                .and_then(|inner| inner)
                                .map(|buffer_size| (config, buffer_size))
                        })
                        .shared()
                };
                let error_sender = self.error_sender.clone();

                let new_id = self.input_id_counter;
                self.input_id_counter += 1;

                let _ = inner.done_tx.send(());

                std::thread::spawn({
                    let config = config.clone();
                    let stream_config = stream_config.clone();
                    let device_name_for_log = device.name().ok();
                    move || {
                        if let Some(ref name) = device_name_for_log {
                            info!("Device '{}' available configs:", name);
                            for config in device.supported_input_configs().into_iter().flatten() {
                                info!(
                                    "  Format: {:?}, Min rate: {}, Max rate: {}, Sample size: {}",
                                    config.sample_format(),
                                    config.min_sample_rate().0,
                                    config.max_sample_rate().0,
                                    config.sample_format().sample_size()
                                );
                            }
                        }

                        let buffer_size_description = match &stream_config.buffer_size {
                            BufferSize::Default => "default".to_string(),
                            BufferSize::Fixed(frames) => format!(
                                "{} frames (~{:.1}ms)",
                                frames,
                                (*frames as f64 / config.sample_rate().0 as f64) * 1000.0
                            ),
                        };

                        info!(
                            "🎤 Rebuilding stream for '{:?}' with config: rate={}, channels={}, format={:?}, buffer_size={}",
                            device_name_for_log,
                            config.sample_rate().0,
                            config.channels(),
                            sample_format,
                            buffer_size_description
                        );

                        let stream = match device.build_input_stream_raw(
                            &stream_config,
                            sample_format,
                            {
                                let actor_ref = actor_ref.clone();
                                let mut callback_count = 0u64;
                                move |data, info| {
                                    if callback_count == 0 {
                                        info!(
                                            "🎤 First audio callback - data size: {} bytes, format: {:?}",
                                            data.bytes().len(),
                                            data.sample_format()
                                        );
                                    }
                                    callback_count += 1;

                                    let _ = actor_ref
                                        .tell(MicrophoneSamples {
                                            data: data.bytes().to_vec(),
                                            format: data.sample_format(),
                                            info: info.clone(),
                                            timestamp: Timestamp::from_cpal(info.timestamp().capture),
                                        })
                                        .try_send();
                                }
                            },
                            move |e| {
                                error!("Microphone stream error: {e}");
                                let _ = error_sender.send(e).is_err();
                            },
                            None,
                        ) {
                            Ok(stream) => stream,
                            Err(e) => {
                                let _ = ready_tx.send(Err(SetInputError::BuildStream(e.to_string())));
                                return;
                            }
                        };

                        if let Err(e) = stream.play() {
                            let _ = ready_tx.send(Err(SetInputError::PlayStream(e.to_string())));
                            return;
                        }

                        let _ = ready_tx.send(Ok(buffer_size_frames));

                        match done_rx.recv() {
                            Ok(_) => info!("Microphone actor shut down, ending stream"),
                            Err(_) => info!("Microphone actor unreachable, ending stream"),
                        }
                    }
                });

                tokio::spawn({
                    let ready = ready.clone();
                    let actor = ctx.actor_ref();
                    let done_tx = done_tx.clone();
                    let label = label.clone();
                    async move {
                        if let Ok((config, buffer_size_frames)) = ready.await {
                            let _ = actor
                                .tell(LockedInputReconnected {
                                    id: new_id,
                                    label,
                                    config,
                                    buffer_size_frames,
                                    done_tx,
                                })
                                .await;
                        }
                    }
                });

                let ready_for_return = ready.clone().map(|result| result.map(|(config, _)| config));

                Ok(ready_for_return.boxed())
            }
        }
    }
}

impl Message<RemoveInput> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.RemoveInput");

        let state = self.state.try_as_open()?;

        state.connecting = None;

        if let Some(AttachedState { done_tx, .. }) = state.attached.take() {
            let _ = done_tx.send(());
        }

        Ok(())
    }
}

impl Message<AddSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(msg.0);
    }
}

impl Message<MicrophoneSamples> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: MicrophoneSamples,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let mut to_remove = vec![];

        for (i, sender) in self.senders.iter().enumerate() {
            if let Err(TrySendError::Disconnected(_)) = sender.try_send(msg.clone()) {
                warn!("Audio sender {} disconnected, will be removed", i);
                to_remove.push(i);
            };
        }

        if !to_remove.is_empty() {
            debug!("Removing {} disconnected audio senders", to_remove.len());
            for i in to_remove.into_iter().rev() {
                self.senders.swap_remove(i);
            }
        }
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum LockFeedError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("NoInput")]
    NoInput,
    #[error("InitializeFailed/{0}")]
    InitializeFailed(#[from] SetInputError),
}

impl Message<Lock> for MicrophoneFeed {
    type Reply = Result<MicrophoneFeedLock, LockFeedError>;

    async fn handle(&mut self, _: Lock, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Lock");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &mut state.connecting {
            let ready = &mut connecting.ready;
            let data = ready.await?;

            state.handle_input_connected(data);
        }

        let Some(attached) = state.attached.take() else {
            return Err(LockFeedError::NoInput);
        };

        let config = attached.config.clone();
        let buffer_size_frames = attached.buffer_size_frames;

        self.state = State::Locked { inner: attached };

        let (drop_tx, drop_rx) = oneshot::channel();

        let actor_ref = ctx.actor_ref();
        tokio::spawn(async move {
            let _ = drop_rx.await;
            let _ = actor_ref.tell(Unlock).await;
        });

        Ok(MicrophoneFeedLock {
            audio_info: AudioInfo::from_stream_config_with_buffer(&config, buffer_size_frames),
            actor: ctx.actor_ref(),
            config,
            buffer_size_frames,
            drop_tx: Some(drop_tx),
        })
    }
}

impl Message<InputConnected> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnected");

        let state = self.state.try_as_open()?;

        state.handle_input_connected(msg);

        Ok(())
    }
}

impl Message<InputConnectFailed> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnectFailed");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &state.connecting
            && connecting.id == msg.id
        {
            state.connecting = None;
        }

        Ok(())
    }
}

impl Message<LockedInputReconnected> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: LockedInputReconnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if let State::Locked { inner } = &mut self.state
            && inner.label == msg.label
        {
            inner.id = msg.id;
            inner.config = msg.config;
            inner.buffer_size_frames = msg.buffer_size_frames;
            inner.done_tx = msg.done_tx;
        }
    }
}

impl Message<Unlock> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, _: Unlock, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Unlock");

        replace_with_or_abort(&mut self.state, |state| {
            if let State::Locked { inner } = state {
                State::Open(OpenState {
                    connecting: None,
                    attached: Some(inner),
                })
            } else {
                state
            }
        });
    }
}
