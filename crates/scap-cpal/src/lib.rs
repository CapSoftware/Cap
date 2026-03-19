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

    Ok(Capturer {
        stream,
        config,
        _output_device: output_device,
        _host: host,
        _supported_config: supported_config,
    })
}

unsafe impl Send for Capturer {}

pub struct Capturer {
    stream: Stream,
    config: StreamConfig,
    _output_device: cpal::Device,
    _host: cpal::Host,
    _supported_config: cpal::SupportedStreamConfig,
}

impl Capturer {
    pub fn play(&self) -> Result<(), PlayStreamError> {
        self.stream.play()
    }

    pub fn pause(&self) -> Result<(), PauseStreamError> {
        self.stream.pause()
    }

    pub fn config(&self) -> &StreamConfig {
        &self.config
    }
}
