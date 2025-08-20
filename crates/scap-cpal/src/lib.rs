use cpal::{
    InputCallbackInfo, PlayStreamError, Stream, StreamConfig, StreamError, traits::StreamTrait,
};

pub fn create_capturer(
    mut data_callback: impl FnMut(&cpal::Data, &InputCallbackInfo, &StreamConfig) + Send + 'static,
    error_callback: impl FnMut(StreamError) + Send + 'static,
) -> Result<Capturer, &'static str> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let output_device = host.default_output_device().ok_or("Device not available")?;
    let supported_config = output_device
        .default_output_config()
        .map_err(|_| "Failed to get default output config")?;
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
        .map_err(|_| "failed to build input stream")?;

    Ok(Capturer { stream, config })
}

pub struct Capturer {
    stream: Stream,
    config: StreamConfig,
}

impl Capturer {
    pub fn play(&self) -> Result<(), PlayStreamError> {
        self.stream.play()
    }

    pub fn config(&self) -> &StreamConfig {
        &self.config
    }
}
