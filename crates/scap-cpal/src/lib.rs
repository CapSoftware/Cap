use cpal::{
    BufferSize, InputCallbackInfo, PauseStreamError, PlayStreamError, Stream, StreamConfig,
    StreamError, SupportedBufferSize, traits::StreamTrait,
};
use thiserror::Error;

const DEFAULT_BUFFER_FRAMES: u32 = 4096;
const MIN_BUFFER_FRAMES: u32 = 256;
const MAX_BUFFER_FRAMES: u32 = 16384;

#[derive(Clone, Error, Debug)]
pub enum CapturerError {
    #[error("NoDevice")]
    NoDevice,
    #[error("DefaultConfig: {0}")]
    DefaultConfig(String),
    #[error("BuildStream: {0}")]
    BuildStream(String),
}

fn safe_buffer_size(supported: &SupportedBufferSize, sample_rate: u32) -> BufferSize {
    match supported {
        SupportedBufferSize::Range { min, max } => {
            let target_frames = if sample_rate > 0 {
                let target_ms = 80u64;
                let frames = (sample_rate as u64 * target_ms) / 1000;
                frames.clamp(MIN_BUFFER_FRAMES as u64, MAX_BUFFER_FRAMES as u64) as u32
            } else {
                DEFAULT_BUFFER_FRAMES
            };

            let clamped = target_frames.clamp(*min, *max);

            BufferSize::Fixed(clamped)
        }
        SupportedBufferSize::Unknown => BufferSize::Default,
    }
}

/// WASAPI loopback capture only receives packets while some client is
/// rendering to the endpoint: with nothing playing, the capture event never
/// fires, the track's first packet arrives at the first sound (not at
/// recording start) and long silent stretches produce no frames at all.
/// Keep a silent render stream open on the captured device for the lifetime
/// of the capturer so packets flow continuously (the same workaround OBS
/// uses for desktop audio).
#[cfg(windows)]
fn build_silence_keepalive(device: &cpal::Device) -> Option<Stream> {
    use cpal::traits::DeviceTrait;

    let supported_config = device.default_output_config().ok()?;
    let mut config: StreamConfig = supported_config.clone().into();
    config.buffer_size = BufferSize::Default;

    device
        .build_output_stream_raw(
            &config,
            supported_config.sample_format(),
            |data, _| {
                data.bytes_mut().fill(0);
            },
            |_| {},
            None,
        )
        .ok()
}

pub fn create_capturer(
    mut data_callback: impl FnMut(&cpal::Data, &InputCallbackInfo, &StreamConfig) + Send + 'static,
    error_callback: impl FnMut(StreamError) + Send + 'static,
) -> Result<Capturer, CapturerError> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let output_device = host
        .default_output_device()
        .ok_or(CapturerError::NoDevice)?;
    let supported_config = output_device
        .default_output_config()
        .map_err(|e| CapturerError::DefaultConfig(e.to_string()))?;

    let buffer_size = safe_buffer_size(
        supported_config.buffer_size(),
        supported_config.sample_rate().0,
    );

    let mut config: StreamConfig = supported_config.clone().into();
    config.buffer_size = buffer_size;

    let stream = output_device
        .build_input_stream_raw(
            &config,
            supported_config.sample_format(),
            {
                let config = config.clone();
                move |data, info: &InputCallbackInfo| data_callback(data, info, &config)
            },
            error_callback,
            None,
        )
        .map_err(|e| CapturerError::BuildStream(e.to_string()))?;

    // A failed keepalive is non-fatal: capture still works whenever other
    // clients render audio (the pre-keepalive behavior).
    #[cfg(windows)]
    let keepalive = build_silence_keepalive(&output_device);

    Ok(Capturer {
        stream,
        #[cfg(windows)]
        keepalive,
        config,
        _output_device: output_device,
        _host: host,
        _supported_config: supported_config,
    })
}

unsafe impl Send for Capturer {}

pub struct Capturer {
    stream: Stream,
    #[cfg(windows)]
    keepalive: Option<Stream>,
    config: StreamConfig,
    _output_device: cpal::Device,
    _host: cpal::Host,
    _supported_config: cpal::SupportedStreamConfig,
}

impl Capturer {
    pub fn play(&self) -> Result<(), PlayStreamError> {
        #[cfg(windows)]
        if let Some(keepalive) = &self.keepalive
            && let Err(e) = keepalive.play()
        {
            // Non-fatal: capture continues whenever other clients render.
            tracing::warn!("loopback silence keepalive failed to start: {e}");
        }
        self.stream.play()
    }

    pub fn pause(&self) -> Result<(), PauseStreamError> {
        let result = self.stream.pause();
        #[cfg(windows)]
        if let Some(keepalive) = &self.keepalive {
            let _ = keepalive.pause();
        }
        result
    }

    pub fn config(&self) -> &StreamConfig {
        &self.config
    }

    /// Whether the silent keepalive render stream is active (Windows only).
    /// Without it, loopback capture only produces packets while other
    /// applications play audio.
    pub fn has_silence_keepalive(&self) -> bool {
        #[cfg(windows)]
        {
            self.keepalive.is_some()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}
