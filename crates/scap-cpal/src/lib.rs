use cpal::{
    InputCallbackInfo, PauseStreamError, PlayStreamError, Stream, StreamConfig, StreamError,
    traits::StreamTrait,
};
use thiserror::Error;

#[derive(Clone, Error, Debug)]
pub enum CapturerError {
    #[error("NoDevice")]
    NoDevice,
    #[error("DefaultConfig: {0}")]
    DefaultConfig(String),
    #[error("BuildStream: {0}")]
    BuildStream(String),
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
    let config = supported_config.clone().into();

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
