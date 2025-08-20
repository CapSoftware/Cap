#![cfg(windows)]

pub fn create_capturer(
    data_callback: impl FnMut(&cpal::Data, &cpal::InputCallbackInfo) + Send + 'static,
    error_callback: impl FnMut(cpal::StreamError) + Send + 'static,
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
            move |data, _: &cpal::InputCallbackInfo| {
                dbg!(data.len());
            },
            move |e| {
                dbg!(e);
            },
            None,
        )
        .map_err(|_| "failed to build input stream")?;

    Ok(Capturer { stream })
}

pub struct Capturer {
    stream: cpal::Stream,
}

impl Capturer {
    pub fn play(&self) -> Result<(), cpal::PlayStreamError> {
        use cpal::traits::StreamTrait;

        self.stream.play()
    }
}
